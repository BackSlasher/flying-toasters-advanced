# Flying Toasters! — FlyingToaster sequence-transition state machine

Recovered from `Flying Toasters!.ad` (all addresses RVA). Machine-readable
version: `assets/transitions.json`. Labels given as `hex (decimal)`; all are
frame numbers in compound bank 22000 (`assets/compound_22000.json`). Most code
labels are `runStart+1` of their sequence run (the engine resolves the
containing run), e.g. 0x3D7 (983) lives in run 982–984.

## Object fields (FlyingToaster)

| field | meaning |
|---|---|
| +0x3c | lifecycle state: 1 = waiting to launch, 2 = flying, 3 = dead |
| +0x40 | **kind**: 1/2 = adult flight families, 3 = baby/special family |
| +0x44 | current **state label** (dispatch key — may differ from the sequence actually playing; this is how the heading ladder walks) |
| +0x48 | "scripted" flag: 1 → next boundary dispatches on +0x44; 0 → next boundary rolls a fresh label from the per-kind picker |
| +0x4a | "plain flight" flag: 1 = interruptible loop, 0 = locked special act (query fn 0x1a444 returns `+0x4a==0`) |
| +0x4c | "not started" (ctor only; cleared at launch) |
| +0x58 | adult-song flag, copied at spawn (0x1e01a) from `ToasterControl+0x82c`: 1 = adult song, 0 = baby song |
| +0x6c | count of times kind-1 default loop (label 3) was queued |

Tick flow (`GiveTime` 0x18697 → 0x1886b, 10 Hz): if the object's bbox is fully
past the **left** edge (0x179e7) or fully below the **bottom** edge (0x17a43)
→ state 3 (die). Otherwise, when `ToasterControl` byte +0x4a signals the
sequence queue needs refill, run the transition handler 0x188cf. **Nothing
else kills a toaster** — locked acts repeat until the choreography carries the
sprite off screen.

## Queue helpers

- `QueueSequenceWithGlue` 0x19cc1(obj, L): if current +0x44 ∈ {0x73 (115),
  0x69 (105)} (turn-around sequences) and L ∉ {0x73, 0x7a (122)} → queue
  [0x7a, L] (turn-completion glue first); else queue [L]. Sets +0x44 := L.
- `QueueList` 0x19d10(obj, l1, …, −1): same glue test for **l1 only**;
  the rest are appended raw; +0x44 := last label.
- Guards: 0x1987f(obj, L) — simulate half then full step (quarter step for
  label 3) of L's travel delta; returns an **edge object pointer** if the
  endpoint lands offscreen (0 = ok). 0x19b0b(obj, l1…ln, −1) — true if the
  cumulative travel of the listed sequences leaves the screen ("no room for
  this act").

## Launch (state 1 → 2, handler 0x186d9)

1. `pos = 0x4171ad(compound)` random spawn point; if either coordinate is
   −1000 (0xFC18) stay in state 1 and retry next tick.
2. `+0x38 = pos`, `+0x64 = compound.currentStore`.
3. **Kind roll** 0x19d8d: baby (+0x58 == 0) → always **kind 3**.
   Adult → `RandShort(11)`: 0 → kind 3 (1/11), 1–5 → kind 2 (5/11),
   6–10 → kind 1 (5/11).
4. Start:
   - kind 1 → `StartPlain` 0x1a3ea(obj, **0x03 (3)**, pos)
   - kind 2 → `StartPlain` 0x1a3ea(obj, **0x5D (93)**, pos)
   - kind 3 → label from 0x19e80: **adult → always 0x3D7 (983)**; baby →
     `RandShort(24)`: 0–7 → jump table
     `[0x40E, 0x453, 0x457, 0x957, 0x472, 0x482, 0x495, 0x4A8]`
     (1/24 each ⇒ specials 1/3 total), 8–23 → 0x3D7 (2/3).
5. `+0x5c = now()`, return state 2.

`StartPlain` 0x1a3ea: queueWithGlue(L); flags +0x48=0, +0x4a=1, +0x4c=0;
`MoveTo(pos)`. `StartSpecial` 0x1a276: queueWithGlue(L); flags **+0x48=1,
+0x4a=0**, +0x4c=0; `MoveTo(pos)`; then placement overrides:

- **0x453 (1107)**: additionally queue **0x429 (1065)** (39-frame act);
  reposition to `x = screen.right + 40`,
  `y = screen.top + 200 + RandShort(max(1, screenHeight − 200))`;
  +0x44 := 0x453. (Enters from the right edge.)
- **0x457 (1111)**: reposition to `y = screen.bottom + 40`,
  `x = screenWidth/2 − 150 + RandShort(300)`. (Enters from below.)
- **0x957 (2391)**: reposition to `(word[ctl+0x44] + 20, word[ctl+0x46] − 8)`
  — anchored to a ToasterControl point, not the random spawn (semantics of the
  anchor uncertain).
- All others (0x40E, 0x472, 0x482, 0x495, 0x4A8): random spawn pos.

## Boundary pickers (when +0x48 == 0)

The flight handler first computes the dispatch label: if +0x48 is set it uses
+0x44, otherwise it **rolls a fresh label** (current label ignored):

| kind | fn | roll | results |
|---|---|---|---|
| 1 | 0x19dd4 | RandShort(35) | 1→0x85, 2→0xAC, 3→0xD1 (1/35 each); 10–19→0x21 (10/35); 20–29→0x25A (10/35); else→0x03 (12/35) |
| 2 | 0x19e34 | RandShort(30) | 2–3→0xE7 (2/30); 5–6→0xFC (2/30); 10–19→0x27E (10/30); else→0x5D (16/30) |
| 3 | 0x19f14 | RandShort(80) | 0→0x3DC, 1→0x3F6, 2→0x3F1, 3→0x3FB (1/80 each); else→0x3D7 (76/80) |

## Flight handler 0x188cf — per-label cases

Notation: `rand10` = `RandShort(10)==0` (10%); `g(L)` = endpoint-offscreen
guard 0x1987f; `room(l…)` = travel guard 0x19b0b. "→ default" = fall through
to the kind's default block.

### Kind 3 (baby song; also 1-in-11 adult spawns, which only ever see 0x3D7)

Ladder loops (all runs are 3–7 frame flap loops): 0x3D7 (983) default glide,
trio 0x3DC/0x3E5/0x3EB (988/997/1003), climb pair 0x3F1/0x3F6 (1009/1014),
swoop pair 0x3FB/0x401 (1019/1025).

- **0x3D7 (983)** — no case → default: `g(0x3D7)` ok → queue 0x3D7,
  +0x48=0, +0x4a=1. Since +0x48=0, each boundary re-rolls the picker:
  95% stay 0x3D7, 1.25% each enter 0x3DC/0x3F1/0x3F6/0x3FB (fresh, +0x48==0
  flavor).
- **0x3F1 (1009)**, +0x48 set: `rand10` (10%) and `!g(0x3FB)` → queue
  **0x3FB (1019)**, **+0x44 := 0x3F6** (state and playing sequence diverge —
  after the swoop the machine is in state 0x3F6), flags 1/1. Else second
  `rand10` (net 9%) and `!g(0x3F1)` → re-queue 0x3F1 (stay). Else (81%)
  → default (back to 0x3D7).
  +0x48 clear (picker, 1/80): `room(0x3F1×3)` → queue [0x3F1, 0x3F1, 0x3F1],
  flags 1/1; else default.
- **0x3F6 (1014)**, +0x48 set: `rand10` and `!g(0x401)` → queue **0x401
  (1025)**, +0x44 := 0x3F1. **No jump follows** — control falls into an
  independent second `rand10`: if it also hits (and `!g(0x3F6)`) queue 0x3F6,
  +0x44 := 0x3F6. (Both rolls can fire in one boundary → net queue
  [0x401, 0x3F6]; likely a fall-through bug, recorded as-is.) Both miss (81%)
  → default.
  +0x48 clear: `room(0x3F6×3)` → queue 0x3F6 ×3, flags 1/1.
- **0x3FB (1019) / 0x401 (1025)** (shared case): `g(0x3FB)` ok → QueueList
  **[0x3FB, 0x401]** (swoop down-up pair), +0x48=0, +0x4a=1 → then release
  to the picker. Else default.
- **0x3DC/0x3E5/0x3EB (988/997/1003)** (shared case), +0x48 set:
  pick `RandShort(3)` → one of the trio; `RandShort(5)==0` (20%) → default
  (exit to 0x3D7); else (80%) `!g(pick)` → queueWithGlue(pick), flags 1/1
  (wander among the trio uniformly). +0x48 clear (picker 1/80): `!g(0x3DC)` →
  queue 0x3DC, flags 1/1 (enter the trio).

Special acts (launch-only entries; **locked**: +0x4a=0, +0x48=1, so they
re-queue themselves every boundary until the sprite exits screen):

- **0x40E (1038)** — run 1038–1062 (25 fr): always re-queue 0x40E.
- **0x453 (1107)** — run 1106–1108 + launch-queued 0x429 (1065–1103, 39 fr):
  always re-queue 0x453.
- **0x457 (1111)** — run 1111–1134 (24 fr, entry from bottom): queue
  **0x3D7** (983), +0x48=1, +0x4a=0 → next boundary state 0x3D7 → default →
  plain flight. (The only special that hands back to normal flight.)
- **0x472 (1138)** — run 1137–1148: +0x48 set → re-queue 0x472. The +0x48==0
  flavor (window test on +0x2c < +0x64 < +0x1c−2, else fall into 0x482 case)
  is **unreachable** — the kind-3 picker never returns 0x472.
- **0x482 (1154)** — run 1153–1169: both flavors identical → re-queue 0x482.
- **0x495 (1173)** — run 1172–1188: re-queue 0x495.
- **0x4A8 (1192)** — run 1191–1207: re-queue 0x4A8.
- **0x957 (2391)** — run 2390–2402: +0x48 set → re-queue 0x957. The +0x48==0
  flavor (check global word[0x43A072]; if clear, queue 0x957 and set the flag;
  if set, fall into the 0x40E case) is **unreachable dead code** — so the
  "unique act" flags 0x43A070 (for 0x472) / 0x43A072 (for 0x957) are never
  set at runtime. They are only **cleared** in the destructor (0x18540) and
  retire (0x18647) when the object dies with that label. Uniqueness is not
  actually enforced in this binary.

Default (kind 3): `g(0x3D7)` ok → queueWithGlue(0x3D7), +0x48=0, +0x4a=1;
else recovery (below).

### Kind 2 (adult, 5/11) — handler 0x18fc8

- **0xE7 (231)** — run 230–248: `g` ok → re-queue 0xE7, +0x48=0, +0x4a=1
  (play once, then fresh pick). Else default.
- **0xFC (252)** — run 251–270: same shape.
- **0x27E (638)** — 3-frame loop, chain **entry 0x26E (622) → loop 0x27E →
  exit 0x283 (643)**. +0x48 set: `rand10` (10%) → queue 0x283, +0x48=0;
  else `room(0x27E, 0x283)` ok → re-queue 0x27E (flags 1/1, keep looping),
  no room → queue 0x283 (bail out). +0x48 clear (picker 10/30):
  `room(0x26E, 0x27E)` → queue 0x26E, **+0x44 := 0x27E**, flags 1/1; else
  default.
- Default: `g(0x5D)` ok → queueWithGlue(**0x5D (93)**), +0x48=0, +0x4a=1;
  else recovery.

### Kind 1 (adult, 5/11) — handler 0x19198

- **0x85 (133)** — run 132–168 (37 fr): `g` ok → re-queue, +0x48=0, +0x4a=1.
- **0xAC (172)** — run 171–205 (35 fr): same.
- **0xD1 (209)** — run 208–227 (20 fr): same.
- **0x21 (33)** — chain **entry 0x12 (18) → loop 0x21 → exit 0x30 (48)**.
  +0x48 set: `rand10` → queue 0x30 (flags 1/1); else `room(0x21, 0x30)` ok →
  re-queue 0x21 (flags 1/1); no room → queue 0x30. +0x48 clear (picker
  10/35): `room(0x12, 0x30)` → queue 0x12, **+0x44 := 0x21**, flags 1/1.
  (State 0x30 has no case → default at its end.)
- **0x25A (602)** — chain **entry 0x24A (586) → loop 0x25A → exit 0x25F
  (607)**: same shape as 0x21 (10% exit, room-guarded loop; picker 10/35
  enters via 0x24A with +0x44 := 0x25A; exits with +0x48=0).
- Default: `g(3)` ok → queueWithGlue(**0x03 (3)**, run 2–14), +0x48=0,
  +0x4a=1, and `++obj[+0x6c]` (loop counter, apparently only bookkeeping).
  Else recovery.

### Recovery 0x1948a — "default flight would leave the screen"

Called with the edge object returned by `g`. Computes
`mask = DirMask(obj → edge)` (0x19f5e, see below) and `e = edge->vtbl+0x24()`.

- kind 1: if `mask&1 || e`: try 0x85, then 0xAC, then 0xD1 (each guarded,
  +0x48=0, +0x4a=1). All fail → if `mask&1` **turn around**: +0x44 :=
  (current ∈ {0x73, 0x69} ? 0x73 (115) : 0x69 (105)) and raw-queue it; else
  if `e` +0x44 := 3 and raw-queue; else raw re-queue current.
- kind 2: if `mask&1 || e`: if `mask&4` try 0xFC then 0xE7, else 0xE7 then
  0xFC (+0x48=0, +0x4a=1). All fail → turn-around as above, **and** if
  current already ∈ {0x73, 0x69} it sets +0x44 := 0x73 and **kind := 1**
  (a completed turn converts the toaster to the other adult family); else if
  `e` +0x44 := 0x5D; raw-queue.
- kind 3: if `mask&1` try 0x3F1 then 0x3F6 (+0x48=1, +0x4a=1); else
  +0x44 := 0x3D7, +0x48=0, +0x4a=1, queueWithGlue(0x3D7). (No turn-arounds
  in the kind-3 family.)

## Direction quantizer 0x19f5e (used by recovery; wrappers 0x1a246 = mask&4, 0x1a25e = mask&1)

Computes the angle from object A to object B (via both objects' centers,
y-axis flipped to math convention, atan at 0x4214f0), producing θ ∈ [0, 2π).
Then **rotates by −(π + 0.3805)** and re-normalizes. The constant table is
built at 0x1a457: 0x43A074 = π, and

| global | value |
|---|---|
| 0x43A07C | 0.25π |
| 0x43A084 | 0.5π |
| 0x43A08C | 0.75π |
| 0x43A094 | 1.25π |
| 0x43A09C | 1.5π |
| 0x43A0A4 | 1.75π |
| 0x43A0AC | 2π |
| 0x43A0B4 | π + 0.3805063771124 |

0.3805063771124 = **atan(2/5)** exactly — π + atan(0.4) is the canonical
toaster glide heading (down-left at slope 5:2), so sector 0 of the rotated
angle means "straight along the flight path". Returned bitmask (θ′ = rotated
angle):

- bit 0 (1): θ′ ∈ [0, π/2) ∪ [3π/2, 2π] — target roughly ahead
- bit 1 (2): otherwise (behind)
- bit 2 (4): θ′ ∈ [0, π) — upper half; bit 3 (8): lower half
- bits 4–11 (0x10…0x800): octant flags for [0,¼π), [¼π,½π), [½π,¾π),
  [¾π,π), [π,1¼π), [1¼π,1½π), [1½π,1¾π), [1¾π,2π)

Recovery only consumes bits 0 and 4 ("ahead" / "above").

## Cross-check against compound_22000.json

Every queued label exists in the bank. Clusters:

- **Adult kind 1**: 3 (run 2–14, default flap), 18/33/48 (17–29, 32–44,
  47–59: entry/loop/exit chain), 133 (132–168), 172 (171–205), 209 (208–227),
  586/602/607 (585–598, 601–603, 606–618: entry/loop/exit chain).
- **Adult kind 2**: 93 (92–101, default), 231 (230–248), 252 (251–270),
  622/638/643 (621–634, 637–639, 642–654: entry/loop/exit chain).
- **Turn/glue** (shared by adult recovery): 105 (104–111), 115 (114–118),
  122 (121–129).
- **Kind 3 / baby-song cluster** (982–1207 + 2390–2402): 983 (982–984,
  default flap), trio 988/997/1003, ladder 1009/1014/1019/1025, specials
  1038 (1038–1062), 1107+1065 (1106–1108, 1065–1103), 1111 (1111–1134),
  1138 (1137–1148), 1154 (1153–1169), 1173 (1172–1188), 1192 (1191–1207),
  and 2391 (2390–2402) — the last sits out in the 1212+ region but is
  choreography for the anchored special act.

## Uncertain / noteworthy

- 0x3F6 double-roll fall-through (can queue [0x401, 0x3F6] in one boundary)
  looks like a missing `jmp` — recorded faithfully.
- The +0x48==0 flavors of the special cases (0x472 window test, 0x957 unique
  flag) are unreachable; the unique-act globals are vestigial.
- `ctl+0x44/+0x46` anchor used by 0x957's start and by guard 0x1987f is
  assumed to be the control's current placement cursor (per given helper
  semantics "center + travel distance").
- Handler is assumed to run only when the control's sequence queue drains
  (`ctl` byte +0x4a); this matches the flag protocol but the setter is
  engine-side and was not traced here.
