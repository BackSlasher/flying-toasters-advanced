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


def pushimm(o):
    """Value of a `push IMM` operand. capstone renders small immediates in
    DECIMAL (`push 3`) and larger ones in hex (`push 0x318`); handle both."""
    o = o.strip()
    try:
        return int(o, 16) if o.startswith('0x') else int(o)
    except ValueError:
        return None


# vtbl sequence-queue methods: 0x7c QueueSequence + 0x80 (its sibling; ~46 call
# sites, 21 with labels — e.g. 1349's police car main=675 is queued ONLY via
# 0x80, so 0x7c-only extraction dropped whole channels). 0xc8 = BreakOffProp.
QUEUE = ('7c', '80')


def extract_handler(rva, end=None, limit=400):
    """Linear sweep a handler; return list of (channel, label, kind).

    Uses a per-call push stack: the channel is the last `[ebx+off]` pushed and
    the label the last immediate pushed before the vtbl call (matches the
    cdecl arg order). Bounded by `end` (next handler) and the tail-jump.
    """
    out = []
    stack = []
    eax = None
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
                stack.append(('imm', eax))
            elif 'ptr [ebx + 0x' in o:
                off = int(o.split('[ebx + 0x')[1].split(']')[0], 16)
                stack.append(('ch', CH.get(off)))
            else:
                v = pushimm(o)
                stack.append(('imm', v) if v is not None else ('?', None))
        elif m == 'call' and 'ptr [eax + 0x' in o:
            off = o.split('[eax + 0x')[1].split(']')[0]
            if off in QUEUE:
                ch = next((v for t, v in reversed(stack) if t == 'ch'), None)
                im = next((v for t, v in reversed(stack) if t == 'imm'), None)
                if ch and im is not None:
                    if 0x5500 < im < 0x5600:
                        out.append((ch, im, 'snd'))
                    # keep real labels + the disperse markers (3, 93); drop the
                    # tiny control args (0/1/6 = flags/counts, not sequences)
                    elif im >= 0x100 or im in (3, 93):
                        out.append((ch, im, 'seq'))
            elif off == 'fc':                        # GetChannelRect(this, slot)
                im = next((v for t, v in reversed(stack) if t == 'imm'), None)
                if im is not None and 1 <= im <= 8:
                    out.append(('main', im, 'getrect'))
            elif off == '98':                        # SetCenterPoint(this, ...)
                ch = next((v for t, v in reversed(stack) if t == 'ch'), None)
                out.append((ch, None, 'setcenter'))
            stack = []
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
            # scenario-label range. Ceiling is 0xc00 (not 0xa00): family-C gags
            # 2736 (0xab0) and 2910 (0xb5e) live above 0xa00 and were being
            # dropped — that's why the 3-toaster wedge/finale fell back to a
            # single toaster.
            if not (0x100 <= scen <= 0xc00):
                continue
            h = disp[scen]
            nxt_h = next((a for a in hstarts if a > h), None)
            ops = extract_handler(h, end=nxt_h)
            chans = {}
            sounds = []
            getrects = []                            # GetChannelRect slots, in order
            setcenters = []                          # SetCenterPoint channels, in order
            for ch, val, kind in ops:
                if kind == 'snd':
                    sounds.append(val - 0x55f0 + 22000)
                elif kind == 'getrect':
                    getrects.append(val)
                elif kind == 'setcenter':
                    setcenters.append(ch)
                else:
                    chans.setdefault(ch, [])
                    # keep order, dedup consecutive. The trailing disperse (3/93)
                    # is SIGNIFICANT — a real sequence followed by a disperse loops
                    # until it drifts out of view (CountLoopsOutOfView) then resumes
                    # flight; a real sequence with none after it plays once — so
                    # keep one trailing disperse, don't collapse it away.
                    if not chans[ch] or chans[ch][-1] != val:
                        chans[ch].append(val)
            if chans:
                e = {'chans': chans, 'sounds': sounds}
                # Formation assembly: GetChannelRect(slot) results are consumed by
                # SetCenterPoint(channel) calls positionally — pair them to learn
                # which body-slot of the main's formed sequence each channel snaps
                # onto (2736: main/sub1/sub2 -> slots 1/2/3; 2406: sub1 -> slot 4).
                slots = {}
                for ch, slot in zip(setcenters, getrects):
                    if ch and ch not in slots:
                        slots[ch] = slot
                if slots:
                    e['slots'] = slots
                table[scen] = e
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


def soundmap():
    """label -> WAV id, bound in ToasterControl::IToasterControl (0x1ce51) via
    the art-registration call 0x41694a(chan, label, sound, ...). The engine fires
    the sound when that compound sequence plays."""
    insns = list(md.disasm(data[0x1ce51:0x1ce51 + 0x600], base + 0x1ce51))
    out = {}
    pushes = []
    for ins in insns:
        if ins.mnemonic == 'push':
            pushes.append(imm(ins.op_str) if ins.op_str.startswith('0x') else None)
        elif ins.mnemonic == 'call':
            if ins.op_str.endswith('41694a'):
                w = pushes[-7:]
                snd = next((v for v in w if v and 0x55f0 <= v <= 0x5600), None)
                if snd:
                    j = w.index(snd)
                    lab = w[j + 1] if j + 1 < len(w) else None
                    if lab and 0 < lab < 0xc00:
                        out.setdefault(lab, snd - 0x55f0 + 22000)
            pushes = []
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
        sm = soundmap()
        open('assets/soundmap.json', 'w').write(json.dumps(sm))
        print(f'\nwrote assets/gags.json and assets/soundmap.json ({len(sm)} sound bindings)')


if __name__ == '__main__':
    main()
