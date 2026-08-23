#!/usr/bin/env python3
"""Extract the BigGag per-scenario choreography from Flying Toasters!.ad.

Two passes:
 1. walk_dispatch(): recursively resolve the compiler's binary-search dispatch
    (cmp/sub eax,IMM + je/jg/jl) into {scenario_label: handler_rva}.
 2. extract_handler(): linear-sweep each handler until its tail-jump, pulling
    every QueueSequence(channel, label) — the per-channel choreography — plus
    the disperse targets and sounds.

Channel offsets: main=[ebx+0xc], sub1/2/3=[ebx+0x40/0x44/0x48].
QueueSequence = channel-vtbl+0x7c; CountLoopsOutOfView = +0xa0.
Glue drivers: family A/B glue 0x10efe (tail jmp 0x412712 / 0x412708),
family B 0x412719, family C 0x414cd7 (tail jmp 0x415beb). Each driver's
dispatch begins a few instructions in (after loading eax with the scenario).
"""
import sys

sys.path.insert(0, '/tmp/claude-1006/-home-isolationist-projects-afterdark-cc/e0face91-39d5-472e-a33a-aa0a1c653413/scratchpad')
from adis import load
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

MODULE = "After Dark Tenth Anniversary/Flying Toasters!.ad"
CH = {0xc: 'main', 0x40: 'sub1', 0x44: 'sub2', 0x48: 'sub3'}
TAILS = {0x412712, 0x412708, 0x415beb, 0x415bf1}

pe, base, data, exports, imports = load(MODULE)
md = Cs(CS_ARCH_X86, CS_MODE_32)

# disassemble the whole CODE section once, index by address
_ins = {i.address - base: i for i in md.disasm(data[0x10000:0x24000], base + 0x10000)}
_addrs = sorted(_ins)


def nxt(rva):
    """address of the instruction after rva"""
    i = _ins[rva]
    return rva + i.size


def imm(op):
    try:
        return int(op.split('0x')[1], 16) if '0x' in op else int(op)
    except (ValueError, IndexError):
        return None


def walk_dispatch(entry, limit=400, reg='eax'):
    """Return {scenario: handler_rva}. Walks cmp/sub REG + je/jg/jl tree."""
    out = {}
    seen = set()
    cpfx, spfx = f'{reg}, 0x', f'{reg}, 0x'

    def walk(rva, acc):
        # acc = total subtracted from reg on this path (reg = scenario - acc)
        pending_cmp = None          # value from a `cmp reg, V` (absolute)
        steps = 0
        while rva in _ins and steps < limit:
            if (rva, acc) in seen:
                return
            seen.add((rva, acc))
            ins = _ins[rva]
            m, o = ins.mnemonic, ins.op_str
            if m == 'cmp' and o.startswith(cpfx):
                pending_cmp = imm(o)
            elif m == 'sub' and o.startswith(spfx):
                acc += imm(o)          # reg mutated for fall-through
                pending_cmp = 0        # a following je tests reg==0 -> scen==acc
            elif m == 'je':
                scen = (pending_cmp if pending_cmp else 0) + acc
                tgt = imm(o) - base
                out.setdefault(scen, tgt)
                pending_cmp = None
            elif m in ('jg', 'jge', 'ja', 'jae'):
                walk(imm(o) - base, acc)       # the >  subtree
                # keep pending_cmp: the following `je` uses the same compare
            elif m in ('jl', 'jle', 'jb', 'jbe'):
                walk(imm(o) - base, acc)       # the <  subtree
            elif m == 'jmp':
                rva = imm(o) - base
                continue
            elif (m in ('push', 'call', 'ret') or (m == 'cmp' and 'ebx' in o)
                  or (m == 'mov' and 'ptr [' in o and reg not in o.split(',')[0])):
                return                         # reached a handler / non-dispatch
            rva = nxt(rva)
            steps += 1
    walk(entry, 0)
    return out


def extract_handler(rva, end=None, limit=400):
    """Linear sweep a handler; return list of (channel, label|'disp'|sound).

    Bounded by `end` (start of the next handler) so we don't bleed into the
    following scenario's code, and by the tail-jump to the shared epilogue.
    """
    out = []
    eax = None
    pch = None
    pim = None
    steps = 0
    while rva in _ins and steps < limit:
        if end is not None and rva >= end:
            break
        ins = _ins[rva]
        m, o = ins.mnemonic, ins.op_str
        if m == 'jmp' and (imm(o) - base) in TAILS:
            break
        if m == 'ret':
            break
        if m == 'mov' and (o.startswith('ax, 0x') or o.startswith('eax, 0x')):
            eax = imm(o)
        elif m == 'add' and o.startswith('eax, 0x') and eax is not None:
            eax += imm(o)
        elif m == 'push':
            if o == 'eax':
                pim = eax
            elif o.startswith('0x'):
                pim = imm(o)
            elif 'ptr [ebx + 0x' in o:
                off = int(o.split('[ebx + 0x')[1].split(']')[0], 16)
                if off in CH:
                    pch = CH[off]
        elif m == 'call' and '[eax + 0x7c]' in o:          # QueueSequence
            if pim is not None and pch:
                kind = 'snd' if 0x5500 < pim < 0x5600 else 'seq'
                out.append((pch, pim, kind))
            pim = None
        rva = nxt(rva)
        steps += 1
    return out


def choreography():
    """Return {scenario: {channel: [labels...], sounds: [...]}} across drivers."""
    table = {}
    for entry in (0x10f2d, 0x1272c, 0x14ce7):
        disp = walk_dispatch(entry)
        hstarts = sorted(set(disp.values()))
        for scen in sorted(disp):
            if not (0x100 <= scen <= 0xa00):
                continue
            h = disp[scen]
            nxt_h = next((a for a in hstarts if a > h), None)
            ops = extract_handler(h, end=nxt_h)
            chans = {}
            sounds = []
            for ch, val, kind in ops:
                if kind == 'snd':
                    sounds.append(val - 0x55f0 + 22000)
                else:
                    chans.setdefault(ch, [])
                    # skip pure disperse (93/3) duplicates; keep order, dedup
                    if not chans[ch] or chans[ch][-1] != val:
                        chans[ch].append(val)
            if chans:
                table[scen] = {'chans': chans, 'sounds': sounds}
    return table


def config():
    """Per-scenario config from 0x15bf1: weight(+0xa4), lanes(+0x90),
    split(+0x94), delay ms(+0xac)."""
    FIELDS = {0xa4: 'weight', 0x90: 'lanes', 0x94: 'split', 0xac: 'delay'}
    disp = walk_dispatch(0x15c1a, reg='edx')
    hstarts = sorted(set(disp.values()))
    out = {}
    for scen, h in disp.items():
        if not (0x100 <= scen <= 0xc00):
            continue
        end = next((a for a in hstarts if a > h), h + 60)
        cfg = {}
        rva = h
        while rva in _ins and rva < end:
            ins = _ins[rva]
            if ins.mnemonic == 'mov' and 'ptr [eax + 0x' in ins.op_str:
                off = int(ins.op_str.split('[eax + 0x')[1].split(']')[0], 16)
                if off in FIELDS:
                    v = imm(ins.op_str.split(', ')[-1])
                    if v is not None:
                        cfg[FIELDS[off]] = v
            if ins.mnemonic == 'jmp':
                break
            rva += ins.size
        if cfg:
            out[scen] = cfg
    return out


def main():
    import json
    t = choreography()
    cfg = config()
    for scen, c in cfg.items():
        if scen in t:
            t[scen]['cfg'] = c
    for scen in sorted(t):
        c = t[scen]
        subs = [k for k in c['chans'] if k != 'main']
        tag = '  <-- MULTI' if subs else ''
        parts = [f'{k}={v}' for k, v in c['chans'].items()]
        if c['sounds']:
            parts.append(f'snd={c["sounds"]}')
        print(f'  {scen:5} (0x{scen:x}): ' + ', '.join(parts) + tag)
    if '--json' in sys.argv:
        open('assets/gags.json', 'w').write(json.dumps(t, indent=1))
        print('\nwrote assets/gags.json')


if __name__ == '__main__':
    main()
