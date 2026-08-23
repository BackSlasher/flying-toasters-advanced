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


# vtbl sequence-queue methods: 0x7c NextSequence + 0x80 NextSequences (sibling;
# e.g. 1349's police car main=675 is queued ONLY via 0x80). 0xc4 = Merge(other,s)
# = other.NextSequence(0); this.NextSequence(s) — so it queues `s` on THIS channel
# too (792's sub1 gets the toast-insert 792 this way — a synchronized pair).
QUEUE = ('7c', '80', 'c4')


def block_leaders(rva, end):
    """Addresses that begin a basic block in [rva, end): every branch target
    plus the instruction after every conditional/unconditional branch."""
    leaders = set()
    a = rva
    while a in _ins and a < end:
        ins = _ins[a]
        if ins.mnemonic[0] == 'j':
            t = imm(ins.op_str)
            if t is not None:
                leaders.add(t - base)
            leaders.add(nxt(a))
        a = nxt(a)
    return leaders


def extract_handler(rva, end=None, limit=400):
    """Linear sweep a handler; return list of (channel, value, kind, loop).

    Uses a per-call push stack: the channel is the last `[ebx+off]` pushed and
    the label the last immediate pushed before the vtbl call (matches the
    cdecl arg order). Bounded by `end` (next handler) and the tail-jump.

    `loop` (seq entries only): the per-sequence repeat count the handler writes
    to the channel's [+0x4e] field right after queuing it — 'offscreen' when it
    is set from CountLoopsOutOfView(0xa0) (loop until the sprite drifts out of
    view = a persistent transform), an int for a fixed loop count, else 1 (play
    once, since NextSequence zeroes 0x4e). This is the engine's ground-truth
    persist signal, replacing the old trailing-disperse proxy.
    """
    out = []
    real80 = set()             # channels queued a REAL transform via NextSequences
    nseq_lists = {}            # channel -> [full NextSequences label lists]
    polled = set()             # channels the handler polls with CountLoopsOutOfView
    onscreen = [False]         # handler polls the sprite-on-screen helper 0x417b57
    ONSCREEN_HELPER = base + 0x17b57
    stack = []
    eax = None
    steps = 0
    leaders = block_leaders(rva, end if end is not None else rva + 0x400)
    ax_loops = False           # eax currently holds a CountLoopsOutOfView result
    pending = []               # indices into `out` of seqs awaiting a 0x4e store
    while rva in _ins and steps < limit:
        if end is not None and rva >= end:
            break
        if steps and rva in leaders:      # new basic block: unresolved seqs = once
            pending = []
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
        elif m == 'mov' and '+ 0x4e]' in o and o.startswith('word ptr'):
            # store to [channel+0x4e] = the loop count for the last queued seq
            src = o.split('],')[1].strip()
            if src in ('ax', 'dx', 'cx'):
                lp = 'offscreen' if ax_loops else '?'
            elif src.startswith('0x') or src.lstrip('-').isdigit():
                lp = imm(src) if src.startswith('0x') else int(src)
            else:
                lp = '?'
            if pending:
                i = pending.pop()
                ch, val, kind, _ = out[i]
                out[i] = (ch, val, kind, lp)
        elif m == 'call' and imm(o) == ONSCREEN_HELPER:
            onscreen[0] = True                       # sprite-still-on-screen predicate
            ax_loops = False
            stack = []
        elif m == 'call' and 'ptr [eax + 0x' in o:
            off = o.split('[eax + 0x')[1].split(']')[0]
            if off == 'a0':                          # CountLoopsOutOfView -> eax
                ax_loops = True
                ch = next((v for t, v in reversed(stack) if t == 'ch'), None)
                if ch:
                    polled.add(ch)
            else:
                ax_loops = False
            if off in QUEUE:
                ch = next((v for t, v in reversed(stack) if t == 'ch'), None)
                im = next((v for t, v in reversed(stack) if t == 'imm'), None)
                if ch and im is not None:
                    if 0x5500 < im < 0x5600:
                        out.append((ch, im, 'snd', None))
                    # keep real labels + the disperse markers (3, 93); drop the
                    # tiny control args (0/1/6 = flags/counts, not sequences)
                    elif im >= 0x100 or im in (3, 93):
                        out.append((ch, im, 'seq', 1))   # 0x4e stays 0 => play once
                        pending.append(len(out) - 1)
                        # NextSequences (0x80) of a REAL transform = a driver-looped
                        # persistent state (police 1349's main re-queues 675 each
                        # tick until out of view); disperse 3/93 via 0x80 is not.
                        if off == '80' and im >= 0x100:
                            real80.add(ch)
                    if off == '80':
                        # NextSequences takes a full varargs label LIST: pushes are
                        # (propLabel...) -1(term), labelN..label1(first), this. The
                        # imms in ARG order are reverse-of-push; take up to the -1
                        # terminator. Emitting only the first label truncates gags
                        # (274/380/456 -> bare flight); keep the whole list.
                        imms = [v for t, v in stack if t == 'imm']
                        lst = []
                        for a in reversed(imms):
                            if a is None:
                                continue
                            if a < 0:
                                break
                            lst.append(a)
                        if ch and len(lst) > 1:
                            nseq_lists.setdefault(ch, []).append(lst)
            elif off == 'fc':                        # GetChannelRect(this, slot)
                im = next((v for t, v in reversed(stack) if t == 'imm'), None)
                if im is not None and 1 <= im <= 8:
                    out.append(('main', im, 'getrect', None))
            elif off == '98':                        # SetCenterPoint(this, ...)
                ch = next((v for t, v in reversed(stack) if t == 'ch'), None)
                out.append((ch, None, 'setcenter', None))
            elif off == 'c8':
                # Split(this, subCh, contLabel, propLabel) — the copy helper 0xdc
                # clones this-channel's transform to subCh, then NextSequence(subCh,
                # prop) and NextSequence(this, cont). cdecl push order is
                # propLabel, contLabel, subCh, this -> imms=[prop, cont]. The prop
                # (a real sprite: golden toast 2974 for 807, rider 1734 for 1672)
                # becomes a broken-off entity; the cont continues THIS channel.
                # NOTE: cont (this-channel's post-split continuation) is queued in
                # the ONGOING branch, which the linear sweep visits BEFORE the INIT
                # branch, so appending it here would mis-order the chain. Emit only
                # the prop (unordered set, safe); the cont awaits execution-ordered
                # extraction. (1672's [1672,1686] order still needs its boot patch.)
                ims = [v for t, v in stack if t == 'imm']
                thisch = next((v for t, v in reversed(stack) if t == 'ch'), None)
                prop = ims[0] if ims else None
                if thisch and prop is not None and prop >= 0x100:
                    out.append((thisch, prop, 'prop', None))
            stack = []
        rva = nxt(rva)
        steps += 1
    return out, real80, polled, onscreen[0], nseq_lists


# --------------------------------------------------------------------------
# State-machine interpreter (execution-ordered choreography).
#
# The handlers are re-entrant per-tick coroutines: each tick they run
# top-to-bottom, branch on the gag object's phase flags ([ebx+off] words) and
# each channel's "sequence complete" flag ([ch+0x4a]), queue sequences, and
# advance the flags. The linear sweep sees the ONGOING branch before INIT
# (reverse of execution). We recover true order by SIMULATING the handler tick
# by tick, evaluating flag compares concretely, until the state repeats.
# RandShort -> 0 (collapse random durations); on-screen helper -> true.
#
# Scope: used for SINGLE-body gags. Formations (multi-channel slot assemblies)
# exercise semantics this doesn't model — cross-channel [0x4a] gating, 0x80
# queue-replacement, the GetChannelRect/SetCenterPoint slot machinery — so they
# (and the global-phase morph 1288) keep the flattened extraction, whose output
# for them is visually verified. TODO: model those, then unify.

RANDSHORT = 0x22f51


def _chan_off(o):
    if '[ebx + 0x' in o:
        try:
            return int(o.split('[ebx + 0x')[1].split(']')[0], 16)
        except ValueError:
            return None
    return None


def _run_tick(h, end, st, log):
    """One handler tick. Mutates st {flags, mem, done}; appends ('seq',ch,[L])
    / ('prop',ch,L) events to log in execution order. Returns channels queued."""
    flags, mem, done = st['flags'], st['mem'], st['done']
    eax = None                       # tagged: ('ch',name)/('imm',v)/None
    cmp_lhs = cmp_rhs = cf = None
    stack = []
    queued = set()
    rva = h
    steps = 0
    while rva in _ins and steps < 600:
        steps += 1
        if end is not None and rva >= end:
            break
        ins = _ins[rva]
        m, o = ins.mnemonic, ins.op_str
        if m == 'jmp':
            t = imm(o)
            if t is None or (t - base) in TAILS:
                break
            rva = t - base
            continue
        if m == 'ret':
            break
        if m == 'mov':
            dst, _, src = o.partition(', ')
            if dst in ('eax', 'ax'):
                if src.startswith('0x') or src.lstrip('-').isdigit():
                    eax = ('imm', imm(src) if src.startswith('0x') else int(src))
                elif 'ptr [ebx + 0x' in src:
                    off = _chan_off(src)
                    eax = ('ch', CH.get(off)) if off in CH else ('flag', off)
                elif 'ptr [0x' in src:
                    addr = int(src.split('[0x')[1].split(']')[0], 16)
                    eax = ('imm', mem.get(addr, 0))
                elif src == 'dword ptr [eax]':
                    pass                       # vtbl load; keep channel tag
                else:
                    eax = None
            elif 'word ptr [ebx + 0x' in dst:
                off = _chan_off(dst)
                if off is not None and (src.startswith('0x') or src.lstrip('-').isdigit()):
                    flags[off] = imm(src) if src.startswith('0x') else int(src)
            elif 'ptr [0x' in dst:
                addr = int(dst.split('[0x')[1].split(']')[0], 16)
                if src.startswith('0x') or src.lstrip('-').isdigit():
                    mem[addr] = imm(src) if src.startswith('0x') else int(src)
                elif src == 'eax' and eax and eax[0] == 'imm':
                    mem[addr] = eax[1]
            elif '+ 0x4a]' in dst and eax and eax[0] == 'ch':
                if src.strip() in ('0', '0x0'):
                    done[eax[1]] = 0           # explicit done-flag clear
        elif m == 'dec' and eax and eax[0] == 'imm':
            orig = eax[1]; eax = ('imm', orig - 1)
            cf = orig < 1; cmp_lhs, cmp_rhs = eax[1], 0
        elif m == 'inc' and eax and eax[0] == 'imm':
            eax = ('imm', eax[1] + 1)
        elif m in ('inc', 'dec') and 'ptr [0x' in o:
            addr = int(o.split('[0x')[1].split(']')[0], 16)
            mem[addr] = mem.get(addr, 0) + (1 if m == 'inc' else -1)
        elif m == 'sub' and o.startswith('eax,') and eax and eax[0] == 'imm':
            k = imm(o.split(', ')[1])
            if k is None:
                eax = None
            else:
                orig = eax[1]; eax = ('imm', orig - k)
                cf = orig < k; cmp_lhs, cmp_rhs = eax[1], 0
        elif m == 'add' and o.startswith('eax,') and eax and eax[0] == 'imm':
            k = imm(o.split(', ')[1])
            eax = ('imm', eax[1] + k) if k is not None else None
        elif m == 'cmp':
            lhs, _, rhs = o.partition(', ')
            rv = imm(rhs) if ('0x' in rhs or rhs.lstrip('-').isdigit()) else None
            if 'word ptr [ebx + 0x' in lhs:
                cmp_lhs, cmp_rhs = flags.get(_chan_off(lhs), 0), rv
            elif 'ptr [0x' in lhs:
                addr = int(lhs.split('[0x')[1].split(']')[0], 16)
                cmp_lhs, cmp_rhs = mem.get(addr, 0), rv
            elif '+ 0x4a]' in lhs and eax and eax[0] == 'ch':
                cmp_lhs, cmp_rhs = done.get(eax[1], 1), rv
            elif lhs == 'eax' and eax and eax[0] == 'imm':
                cmp_lhs, cmp_rhs = eax[1], rv
            else:
                cmp_lhs = cmp_rhs = None
        elif m == 'test' and o == 'eax, eax' and eax and eax[0] == 'imm':
            cmp_lhs, cmp_rhs = eax[1], 0
        elif m in ('je', 'jne', 'jg', 'jge', 'jl', 'jle',
                   'ja', 'jae', 'jb', 'jbe', 'jz', 'jnz'):
            t = imm(o)
            take = None
            if m in ('jb', 'jbe') and cf is not None:
                take = cf if m == 'jb' else (cf or cmp_lhs == cmp_rhs)
            elif m == 'jae' and cf is not None:
                take = not cf
            elif cmp_lhs is not None and cmp_rhs is not None:
                a, b = cmp_lhs, cmp_rhs
                take = {'je': a == b, 'jz': a == b, 'jne': a != b, 'jnz': a != b,
                        'jg': a > b, 'jge': a >= b, 'jl': a < b, 'jle': a <= b,
                        'ja': a > b, 'jae': a >= b, 'jb': a < b, 'jbe': a <= b}[m]
            if take is None:
                take = False                   # unknown compare: fall through
            if take and t is not None:
                rva = t - base
                cmp_lhs = cmp_rhs = cf = None
                continue
            cmp_lhs = cmp_rhs = cf = None
        elif m == 'push':
            if o == 'eax':
                stack.append(eax if eax else ('?', None))
            elif 'ptr [ebx + 0x' in o:
                off = _chan_off(o)
                stack.append(('ch', CH.get(off)) if off in CH else ('?', None))
            elif o.startswith('0x') or o.lstrip('-').isdigit():
                stack.append(('imm', imm(o) if o.startswith('0x') else int(o)))
            else:
                stack.append(('?', None))
        elif m == 'call':
            tgt = imm(o)
            if tgt is not None and tgt - base == RANDSHORT:
                eax = ('imm', 0)
            elif tgt is not None and tgt - base == 0x17b57:
                eax = ('imm', 1)               # on-screen helper -> true
            elif 'ptr [eax + 0x' in o:
                off = o.split('[eax + 0x')[1].split(']')[0]
                ch = next((v for t_, v in reversed(stack) if t_ == 'ch'), None)
                if off in QUEUE and ch:
                    if off == '80':
                        ims = [v for t_, v in stack if t_ == 'imm']
                        lst = []
                        for a in reversed(ims):
                            if a is None:
                                continue
                            if a < 0:
                                break
                            lst.append(a)
                        labels = [x for x in lst if x >= 0x100 or x in (3, 93)]
                    else:
                        im = next((v for t_, v in reversed(stack) if t_ == 'imm'), None)
                        labels = ([im] if im is not None
                                  and (im >= 0x100 or im in (3, 93)) else [])
                    if labels:
                        log.append(('seq', ch, labels))
                        done[ch] = 0
                        queued.add(ch)
                elif off == 'c8':              # Split(this, sub, cont, prop)
                    ims = [v for t_, v in stack if t_ == 'imm']
                    thisch = next((v for t_, v in reversed(stack) if t_ == 'ch'), None)
                    prop = ims[0] if ims else None
                    cont = ims[1] if len(ims) > 1 else None
                    if thisch and prop is not None and prop >= 0x100:
                        log.append(('prop', thisch, prop))
                    if thisch and cont is not None and (cont >= 0x100 or cont in (3, 93)):
                        log.append(('seq', thisch, [cont]))
                        done[thisch] = 0
                        queued.add(thisch)
                eax = None
            stack = []
        rva = nxt(rva)
    return queued


def _collapse_cycle(seq):
    """A looping state machine re-queues its cycle forever; keep one period
    ([A,B,C,A,B,C,A] -> [A,B,C])."""
    n = len(seq)
    for p in range(1, n // 2 + 1):
        if all(seq[i] == seq[i % p] for i in range(n)):
            return seq[:p]
    return seq


def interp_handler(h, end, max_ticks=120):
    """Simulate the handler; return ({channel: [labels]}, [props], {templates})
    in true execution order.

    Queue semantics (from the primitives): NextSequence(L) = next:=L, pending:=[]
    — vtbl 0x128 (@0x19df5) sets [ch+0x48] and 0x134 (@0x1ae17) clears the
    16-entry pending list at [ch+0x62]; NextSequences(L0..Ln) = next:=L0,
    pending:=[L1..Ln] (0x138 @0x1ae25 appends). So within one handler run the
    LAST queue call on a channel wins — REPLACE, not append. [ch+0x4a] (done)
    means the whole queue has drained; the driver acts on the handler when its
    channels go idle, so the simulation runs the handler only when every active
    channel's queue is empty (running mid-drain would wrongly wipe in-flight
    chains — 274's act chain died that way under a per-tick model).

    A real label REPLACED before it ever played is a placement TEMPLATE: the
    handler queues the formed multi-body sequence (2736 wedge, 879's 875) just
    long enough for GetChannelRect to read its authored slot rects, SetCenter-
    Points the channels there, then replaces the queue with each channel's real
    single-body chain. Formations are synchronized solo flyers, not one sprite.
    """
    st = {'flags': {}, 'mem': {}, 'done': {}}
    queue = {c: [] for c in CH.values()}          # [next, pending...]
    played = {c: [] for c in CH.values()}
    active = set()                                # channels ever queued
    templates = {}
    props = []
    seen_states = set()
    for _ in range(max_ticks):
        # advance channels: enter next queued seq; done = queue fully drained
        for c in CH.values():
            if queue[c]:
                played[c].append(queue[c].pop(0))
                st['done'][c] = 0 if queue[c] else 1
            else:
                st['done'][c] = 1
        if active and any(queue[c] for c in active):
            continue                              # wait for the drain
        log = []
        queued = _run_tick(h, end, st, log)
        for ev in log:
            if ev[0] == 'seq':
                ch, labels = ev[1], ev[2]
                if queue[ch] and not played[ch] and queue[ch][0] >= 0x100:
                    templates.setdefault(ch, queue[ch][0])
                queue[ch] = list(labels)          # REPLACE
                active.add(ch)
            elif ev[0] == 'prop' and ev[2] not in props:
                props.append(ev[2])
        state = (tuple(sorted(st['flags'].items())),
                 tuple(sorted(st['mem'].items())),
                 tuple((c, tuple(q)) for c, q in sorted(queue.items())))
        if (not queued and not any(queue.values())) or state in seen_states:
            break
        seen_states.add(state)
    for c in CH.values():                         # drain the remainder
        played[c].extend(queue[c])
    # NO interior consecutive-dedup: repeated labels inside a queued list are
    # REAL (e.g. [93,93,93,622,...] = three flight loops of fly-in before the
    # act — the engine's on-screen lead-in; [...,380,380,...] = the act played
    # twice). Only the TRAILING run of the final label collapses to one: those
    # repeats are the state machine re-queuing its hold/exit loop each drain,
    # which `hold` (loop till offscreen) and flight self-looping already model.
    chains = {}
    for c, seq in played.items():
        if not seq:
            continue
        seq = _collapse_cycle(seq)
        while len(seq) >= 2 and seq[-1] == seq[-2]:
            seq = seq[:-1]
        chains[c] = seq
    return chains, props, templates


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
            ops, real80, polled, onscreen, nseq_lists = extract_handler(h, end=nxt_h)
            chans = {}
            hold = {}                                # channels whose transform loops offscreen
            sounds = []
            props = []                               # Split() broken-off entities
            getrects = []                            # GetChannelRect slots, in order
            setcenters = []                          # SetCenterPoint channels, in order
            for ch, val, kind, loop in ops:
                if kind == 'snd':
                    sounds.append(val - 0x55f0 + 22000)
                elif kind == 'prop':
                    if val not in props:
                        props.append(val)
                elif kind == 'getrect':
                    getrects.append(val)
                elif kind == 'setcenter':
                    setcenters.append(ch)
                else:
                    # a REAL sequence (not disperse) whose 0x4e loop is 'offscreen'
                    # is a persistent transform: it re-plays until the sprite drifts
                    # out of view, then disperses. Record per-channel — this is the
                    # ground-truth persist signal (fire 928, police 1349, formation
                    # 2736, ...) that the flattened chain alone cannot express.
                    if val not in (3, 93) and loop == 'offscreen':
                        hold[ch] = True
                    chans.setdefault(ch, [])
                    # keep order, dedup consecutive. The trailing disperse (3/93)
                    # is SIGNIFICANT — a real sequence followed by a disperse loops
                    # until it drifts out of view (CountLoopsOutOfView) then resumes
                    # flight; a real sequence with none after it plays once — so
                    # keep one trailing disperse, don't collapse it away.
                    if not chans[ch] or chans[ch][-1] != val:
                        chans[ch].append(val)
            # Recover full NextSequences choreography: the per-seq emission above
            # kept only each 0x80 call's FIRST label, truncating whole-list gags
            # (274/380/456 collapsed to bare flight). For each channel take its
            # richest 0x80 list — collapsing the compiler's loop-unrolling (e.g.
            # [..380,380,395..]) via consecutive-dedup — and adopt it when it is
            # more complete than the flattened chain.
            for ch, lists in nseq_lists.items():
                best = []
                for lst in lists:
                    dd = []
                    for v in lst:
                        if not dd or dd[-1] != v:
                            dd.append(v)
                    if len(dd) > len(best):
                        best = dd
                # Adopt the full list ONLY when the channel's existing (flattened)
                # content is a SUBSET of it — i.e. that content came solely from
                # this NextSequences (274/380 truncated to their first label). If
                # the channel has other real content from 0x7c calls (2736's
                # formation body 324), the 0x80 list is a secondary phase, not the
                # primary chain, so leave it — replacing would drop the body.
                cur = chans.get(ch, [])
                if len(best) > len(cur) and set(cur) <= set(best):
                    chans[ch] = best

            # Signal B (driver-looped persistence): a channel that queued a real
            # transform via NextSequences AND polls CountLoopsOutOfView re-issues
            # that sequence every tick until the sprite drifts out of view (police
            # 1349's main). 0x4e-based holds (signal A) cover the self-looping
            # transforms; this covers the state-machine-driven ones.
            for ch in real80:
                if ch in polled or onscreen:
                    hold[ch] = True
            # Formation assembly: GetChannelRect(slot) results are consumed by
            # SetCenterPoint(channel) calls positionally — pair them to learn
            # which body-slot of the main's formed sequence each channel snaps
            # onto (2736: main/sub1/sub2 -> slots 1/2/3; 2406: sub1 -> slot 4).
            slots = {}
            for ch, slot in zip(setcenters, getrects):
                if ch and ch not in slots:
                    slots[ch] = slot
            # Execution-ordered chains from the state-machine interpreter (all
            # gags except the global-phase morph 1288, whose loop counter it
            # under-simulates with RandShort->0; that one stays hand-modeled in
            # the port). Formations come out as their engine truth: a placement
            # TEMPLATE (the formed sequence, queued just to read slot rects) plus
            # per-channel single-body chains.
            templates = {}
            if scen != 0x508:
                ichains, iprops, templates = interp_handler(h, nxt_h)
                if ichains:
                    chans = ichains
                    for p in iprops:
                        if p not in props:
                            props.append(p)
            if chans:
                e = {'chans': chans, 'sounds': sounds}
                if hold:
                    e['hold'] = hold
                if props:
                    e['props'] = props
                if slots:
                    e['slots'] = slots
                if templates.get('main'):
                    e['template'] = templates['main']
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
        # Entry-lane band (+0x9c top lane, +0xa0 band size), parsed symbolically:
        # gagobj +0x1c = total lanes, +0x2c = split threshold (both copied from
        # the field at 0x178da). Handler forms observed:
        #   mov [eax+0x9c], IMM                 -> top = IMM
        #   mov edx,[eax+0x2c]; mov [0x9c],edx  -> top = split threshold
        #   mov edx,[eax+0x1c]; sub edx,[0x9c]; add edx,-K; mov [0xa0],edx
        #                                       -> band = total - top - K
        # Unset -> full field (top 0, band total), the 0x1641e clamp defaults.
        edx = None
        rva = h
        while rva in _ins and rva < end:
            ins = _ins[rva]
            m, o = ins.mnemonic, ins.op_str
            if m == 'xor' and o == 'edx, edx':
                edx = {'kind': 'zero'}
            elif m == 'mov' and o.startswith('edx, dword ptr [eax + 0x'):
                src = int(o.split('[eax + 0x')[1].split(']')[0], 16)
                edx = {'kind': {0x1c: 'total', 0x2c: 'split'}.get(src)}
            elif m == 'sub' and o == 'edx, dword ptr [eax + 0x9c]':
                if edx and edx.get('kind') == 'total':
                    edx = {'kind': 'total-top', 'k': 0}
            elif m == 'add' and o.startswith('edx, ') and edx and edx.get('kind') == 'total-top':
                k = imm(o.split(', ')[1])
                if k is not None:
                    edx['k'] = -k
            elif m == 'mov' and 'ptr [eax + 0x' in o:
                off = int(o.split('[eax + 0x')[1].split(']')[0], 16)
                src = o.split(', ')[-1]
                if off in FIELDS:
                    # `xor edx,edx; mov [..],edx` = an explicit 0 the imm parser
                    # missed — split=0 scenarios were wrongly defaulting to 1.
                    v = 0 if (src == 'edx' and edx and edx.get('kind') == 'zero') else imm(src)
                    if v is not None:
                        cfg[FIELDS[off]] = v
                elif off == 0x9c:
                    if src == 'edx' and edx and edx.get('kind') == 'split':
                        cfg['laneTop'] = 'split'
                    else:
                        v = imm(src)
                        if v is not None:
                            cfg['laneTop'] = v
                elif off == 0xa0 and src == 'edx' and edx and edx.get('kind') == 'total-top':
                    cfg['laneBandK'] = edx['k']   # band = total - top - K
            if m == 'jmp':
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
