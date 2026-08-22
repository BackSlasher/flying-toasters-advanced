# Flying Toasters! — RE notes, round 2 (class-level dig)

Companion to `BEHAVIOR.md`. All addresses are module RVAs (image base 0x400000).
Labels given decimal (hex). Cross-referenced against `assets/compound_22000.json`
and `assets/sprites/banks.json`.

## Conventions discovered (apply to everything below)

- **Vtable slot map** (all Flying* classes): +0x08 Reset(state→1), +0x0c Stop
  (state→3 + release), +0x10 GiveTime = dispatcher on state field
  (1→launch fn, 2/3→fly fn), +0x14 IsDone (state==3), +0x20 GetName,
  +0x28 Start(args…), +0x2c = **per-class "pick loop label"** hook (except
  BigGag, where +0x2c = SetStartParams). State field is +0x3c for
  FlyingToaster/BigGag-style objects, +0x30 for Food/Cloud/Intro.
- **Queued label = frame id, resolved to its containing sequence.** Values the
  code queues are consistently `JSON-label + 1` (e.g. queue 2969 → JSON seq
  2968 covering frames 2968–2970; queue 93 (0x5D) → JSON seq 92). The engine's
  GetLabelRange finds the sequence containing the frame. In a JS port: map
  queued value → the sequence whose frame range contains it.
- **Correction to BEHAVIOR.md**: the helpers called in Food/Cloud/Intro fly
  handlers at loop boundaries (0x179e7, 0x17a43, 0x17afb) are **offscreen
  tests** (object rect vs screen rect, ±35 px margin variant at 0x1798f), not
  IsSequenceQueued. Objects die when they drift offscreen.
- **Generic per-object loop shape** (Food/Cloud pattern):
  - state 1 (launch): each tick call entry-placement helper; when it returns a
    valid point (≠ (-1000,-1000) sentinel 0xfc18), pick loop label via own
    vtbl+0x2c → store at +0x34, MoveTo(control vtbl+0x98, point), attach
    channel, mark lane occupied → state 2.
  - state 2 (fly): every tick advance (control vtbl+0x94). When channel is at a
    sequence-loop boundary (byte [control+0x4a]): if offscreen (or kill flag
    +0x38) → state 3; else re-queue own +0x34 label (control vtbl+0x7c).
- **Entry placement, toaster/food/gag flavor** (0x171ad "PickEntryPosition"):
  - per-channel rate limit: returns sentinel until `now > [chan+0x3c] + 500 ms`.
  - picks lane = RandShort(totalLanes [chan+0x34]), up to 4 retries avoiding
    occupied lanes (occupancy checks 0x174dc / 0x1756d).
  - lane < [chan+0x38] → enter along **top edge**: x = base + (lane−split)·160
    + 240, y = top − 80. Else → **right edge**: x = right + 80,
    y = top + (lane−split)·80. (Objects fly left/down, so they enter from
    top/right.) Same formula reused by BigGag's 0x17378 with per-scenario lane
    count/anchor/min/range parameters.

---

## 1. FlyingFood (vtable 0x3a130) / FlyingBabyFood (0x3bf40)

Functions: Reset 0x182c5, Stop 0x182ed, GiveTime 0x18313, IsDone 0x18343,
launch 0x18355, fly 0x183d9, label picker (vtbl+0x2c) 0x18449.
BabyFood shares everything except its own picker 0x166d4 (Reset/Stop thunk to
the shared ones at 0x166b6/0x166c5).

State machine exactly as the generic loop above; state field +0x30; picked
label kept at +0x34 and re-queued at every loop boundary until offscreen.

### Adult food picker 0x18449 — `RandShort(9)` (seed global 0x37148)

| roll | queued label | JSON seq | frames | content (art ids → bank) | net drift/loop |
|---|---|---|---|---|---|
| 0 | 3039 (0xbdf) | 3038 | 13 | pale/white toast tumble (arts 138–145, banks 22009/22010) | (−60,+24) |
| 1 | 3024 (0xbd0) | 3023 | 13 | **bagel** tumble (arts 112–124, bank 22008) | (−60,+24) |
| 2 | 3019 (0xbcb) | 3018 | 3 | toasted slice, static hold (art 125, 22009) | (−20,+8) |
| 3 | 3002 (0xbba) | 3001 | 13 | golden **toast** tumble (arts 126–137, 22009) | (−60,+24) |
| 4 | 2997 (0xbb5) | 2996 | 3 | **burnt** slice hold (art 146, 22010) | (−20,+8) |
| 5 | 2979 (0xba3) | 2978 | 13 | burnt tumble (arts 147–158, 22010) | (−60,+24) |
| 6 | 2969 (0xb99) | 2968 | 3 | winged plain-toast hold (art 358, bank 22022) | (−20,+8) |
| 7,8 | 2974 (0xb9e) | 2973 | 3 | winged **buttered** toast hold (art 347, 22022) | (−20,+8) |

So probabilities: buttered-winged 2/9; each of the other seven 1/9.
Note bank 22021 ("buttered", ids 309–326) is *not* used by the free-floating
food picker — it only appears inside choreographed sequences (BigGag/flight
gags, e.g. seqs around 273, 748, 806, 1371, 2271). Effective food mix on
screen: bagel 1/9, toast-ish 3/9 (light/golden/hold), burnt 2/9, winged toast
3/9. Drift ≈ −6.7,+2.7 px/tick (holds) or −4.6,+1.8 px/tick (tumbles) at 10 Hz.

### Baby food picker 0x166d4 — `RandShort(6)` (seed global 0x3382c)

Baby "food" is nursery objects, art bank 22031 (ids 467–484):

| roll | queued label | JSON seq | frames | content | net drift/loop |
|---|---|---|---|---|---|
| 0 | 3274 (0xcca) | 3273 | 3 | rubber duck, hold (art 473) | (−10,+4) |
| 1 | 3279 (0xccf) | 3278 | 5 | rubber duck wiggle (arts 474–476) | (−20,+8) |
| 2 | 3286 (0xcd6) | 3285 | 3 | baby bottle (art 477) | (−10,+4) |
| 3 | 3291 (0xcdb) | 3290 | 3 | pacifier (art 478) | (−10,+4) |
| 4 | 3296 (0xce0) | 3295 | 3 | teddy bear (art 479) | (−10,+4) |
| 5 | 3301 (0xce5) | 3300 | 3 | caged/crib toaster (art 480) | (−10,+4) |

All uniform 1/6. Baby food drifts at half adult speed.

---

## 2. FlyingCloud (vtable 0x3a160) / FlyingBabyCloud (0x3bf0c)

Functions: ctor 0x17e37, Start 0x17e64, Reset 0x17e89, Stop 0x17eb0, GiveTime
0x17ec6, launch 0x17f08, fly 0x17f85, adult picker (vtbl+0x2c) 0x17fdf.
BabyCloud shares GiveTime/launch/fly; own picker 0x165d6, Reset 0x1659d,
Stop 0x165ac (clears moon/cow flag), dtor 0x1653c.

**Big correction:** clouds are *not* toaster squadrons. They are single drifting
**cloud sprites** (dark puffs, bank 22030 arts 463–465 + art 466). "Formation"
lives only in the entry-lane system below. There are no member offsets.

### Adult picker 0x17fdf

Two-stage roll: `RandShort(4)` then `RandShort(4)` (four separate seed globals
0x34220/0x349fc/0x351d8/0x359b4 — one per first-roll value, all range 4);
index = first·4 + second → uniform 1/16 over jump table (@0x1808e):

idx→label: 0→3114(0xc2a) 1→3074(0xc02) 2→3094(0xc16) 3→3054(0xbee)
4→3119(0xc2f) 5→3079(0xc07) 6→3099(0xc1b) 7→3059(0xbf3) 8→3124(0xc34)
9→3084(0xc0c) 10→3104(0xc20) 11→3064(0xbf8) 12→3129(0xc39) 13→3089(0xc11)
14→3109(0xc25) 15→3069(0xbfd)

These are 16 aliases of just **4 sequences worth of art** (JSON seqs
3053–3128, step 5; 3-frame holds): art 463, 464, 465, 466 — each cloud shape
appears with probability 4/16. All drift **(+2,+2) per 3-frame loop**
(≈ +0.67,+0.67 px/tick — clouds crawl right/down).

### Baby picker 0x165d6 — `RandShort(10)` (seed 0x3304c)

| roll | label | JSON seq | content |
|---|---|---|---|
| 0 | 3199 (0xc7f) | 3198 | dark cloud (art 463) |
| 1 | 3204 (0xc84) | 3203 | dark cloud (464) |
| 2 | 3209 (0xc89) | 3208 | dark cloud (465) |
| 3 | 3214 (0xc8e) | 3213 | dark cloud (466) |
| 4 | 3239 (0xca7) | 3238 | **crescent moon w/ face** (art 468) — unique |
| 5 | 3244 (0xcac) | 3243 | **cow jumping over moon** (art 469) — unique |
| 6 | 3249 (0xcb1) | 3248 | small stars (470) |
| 7 | 3254 (0xcb6) | 3253 | stars (471) |
| 8 | 3259 (0xcbb) | 3258 | big star w/ face (472) |
| 9 | 3264 (0xcc0) | 3263 | small stars (470) |

Moon and cow are **globally unique**: flag word @0x433828 — if already active,
roll 4/5 degrade to label 3249 (stars). Flag cleared by BabyCloud
Stop/dtor when the dying instance was playing 3239/3244 (0x165ac / 0x1653c).
All baby-sky sequences also drift (+2,+2)/3f. (JSON seqs 3218–3233 are unused
alias copies; label 3269 (0xcc5) is the picker's unreachable default.)

### Cloud entry placement 0x1813b (shared, both variants)

- lanes: sx = screenW/100, sy = screenH/100, n = sx+sy+1; k = RandShort(n),
  stored at [obj+0x3c].
- k < sy → enter at **left edge**: (−50, 100·k + 50). Else → **top edge**:
  (100·(k−sx) − 50, −50) — note for sy ≤ k < sx this gives negative x
  (spawns off the top-left corner; harmless since drift is right/down).
- **Lane cooldown**: launch allowed only if lanes k−1, k, k+1 all have
  `now > lastLaunch + 20000 ms` (timestamps array @0x43d0a0, checked at
  0x181d8, stamped at 0x18223). Combined with ToasterControl's global
  5000 ms cloud-spawn spacing (BEHAVIOR.md).

---

## 3. FlyingIntro (vtable 0x3a190) — evolution slideshow

Functions: ctor 0x17c70, Start 0x17c94, Reset 0x17cb8, Stop 0x17cd6, GiveTime
0x17cec, launch 0x17d2e, fly 0x17dba.

**Trigger:** `SetPlayIntro(1)` (0x1e38c) is called from GetControls (call site
0x1c34b) on first run (guarded so it happens once: [ctl+0x42] latch).
In `ToasterControl::Play` (0x1dcd0): while intro flag [ctl+0x40] is set, Play
spawns *only* a `FlyingIntro` (name string @0x43bdb9) via GetObjectReserve and
runs *only* that object each tick — **no other spawning/stepping happens until
the intro object reports done**, then flag clears and the swarm begins.

**Choreography:**
- launch (0x17d2e): compute screen center ((r−l)/2, (b−t)/2), queue label
  **3133 (0xc3d)** on its channel (control vtbl+0x7c), MoveTo center,
  slide counter +0x34 = 0.
- Sequence 3133 = the whole slideshow, 63 frames @10 Hz ≈ 6.3 s, stationary
  (dx/dy 0). Two items per frame: big 150×150 still at (245,165)–(395,315) and
  a caption strip at y 317–337. Item art timeline (10 ticks = 1.0 s per still):

  | frames | still art (ch1) | caption art (ch3) | caption text |
  |---|---|---|---|
  | 0–9 | 444 | 456 | "Late Jurassic" (fossil toaster) |
  | 10–19 | 450 | 460 | "100 B.C." |
  | 20–29 | 446 | 457 | "A.D. 600" |
  | 30–39 | 447 | 458 | "1508" (da Vinci sketch) |
  | 40–49 | 449 | 459 | "1847" |
  | 50–58 | 452 | 461 | "Today" (modern toaster on sky) |
  | 59 | 453 | 461 | sky still, toaster gone dim |
  | 60–62 | 454/455 + flap arts 191–193 (ch2, bank 22013) | 461 | toaster pops out of the card and starts flapping |

  Stills/captions live in banks 22027 (fossil, parchment), 22028 (Bosch bird
  toaster, helmet toaster), 22029 (modern stills, fades, caption strips).
  UNCERTAIN: exact art-id→bank-frame mapping is off by one in places (the
  compound references ids like 444/447/450 that fall in the extractor's
  inter-bank gap slots); resolve visually when wiring the port — order and
  timing above are solid.
- fly handler (0x17dba): at the first loop boundary after 3133 ends, queue-multi
  (control vtbl+0x80) labels **115, 122** (JSON seqs 114 → 5-frame hover,
  then 121 → 9-frame flap-away, net (+13,+10)); thereafter at each boundary, if
  onscreen queue flight loop **93 (0x5d)** (JSON seq 92, the standard
  swooping flap, net (−218,+190) per 10 frames) until offscreen → done.

Banks 22032/22033 are *not* in the intro: they belong to BigGag scenario
1288 (seqs 1232/1287/1302 — see below).

---

## 4. FlyingBigGag (vtable 0x3301c)

Functions: ctor tail 0x10100, dtor 0x101d4, Start (vtbl+0x28) 0x1031a,
Reset 0x10524, SetStartParams (vtbl+0x2c) 0x1064d (writes shorts +0xa8/+0xaa),
Stop 0x1066b, GiveTime 0x10739, IsDone 0x10769, launch 0x1077b, run 0x10839.
Scenario pick 0x10c24; family pickers 0x10cd2 / 0x10d85 / 0x10e51; scenario
config (weights/lanes/delay) 0x15bf1; glue drivers 0x10efe (family A),
0x412719 (family C), 0x414cd7 (family B). GetName → "FlyingBigGag" @0x3300c.

### Architecture

A BigGag owns **4 compound channels**: its main channel (+0x10) plus three
sub-channels (+0x40/+0x44/+0x48, 0x94-byte channel objects allocated in Start)
— i.e. up to 4 coordinated actors — and three 0x38-byte "follower" helper
objects (+0x4c/+0x50/+0x54) whose positions are re-pinned every tick to the
sub-actors' rect centers (run handler 0x10a52–0x10c09). UNCERTAIN: followers
look like attachment sprites/sound anchors; visuals are already fully present
in the sequences, so a port can ignore them.

### Scenario selection (0x10c24, done in Start/Reset when +0x88 == 0)

- If both start params (+0xa8, +0xaa) nonzero → returns 0 ("no forced pick";
  the glue driver's default path then just runs the label-driven default).
- Else roll `RandShort(3)`:
  - **0 → family C** if `now > lastC + 15000 ms` (global 0x432ff4) or +0xa8
    set; else fall to case 1.
  - **1 → family B** if `now > lastB + 6000 ms` (global 0x432ff0) or +0xa8
    set; else family A.
  - **2 → family A** always.
- So +0xa8 (set ≈500 ms after music start, per BEHAVIOR.md) bypasses the
  family rate gates — the "song-start gag" fires immediately.
- Family C picks also bump counter 0x432fec and stamp their timer;
  family B stamps its timer.

### Family label tables (label = scenario id queued on main channel; weight =
population weight [obj+0xa4] read by Play; delay = +0xac ms hold before the
run loop advances; lanes/anchor = entry width params to 0x17378)

**Family A — 0x10cd2, `RandShort(13)`** (multi-actor "toaster games", weight
noted, lanes×anchor in parens):

| roll | label | weight | notes (JSON seq, art) |
|---|---|---|---|
| 0 | 1782 (0x6f6) | 2 (3 lanes) | 2-toaster formation start card (22001); subs chain 1786 & 1852 |
| 1 | 1928 (0x788) | 2 (2 lanes) | variant; subs chain 1933 & 2004 |
| 2 | 792 (0x318) | 2 | toast toss (22000/22001 + 22022); glue also queues food label 2969 (0xb99) |
| 3 | 807 (0x327) | 2 | 30f juggling w/ buttered toast (22016/22021/22022); glue queues 2974 (0xb9e) |
| 4 | 749 (0x2ed) | 1 | 41f toast relay (22022/22023) |
| 5 | 861 (0x35d) | 1 | toast + upside-down toaster (22024), glue re-queues 861 & 846 (0x34e) |
| 6 | 274 (0x112) | 1 (3 lanes) | baby-feeding chase (22005/22006/22020/22021); glue: 622 (0x26e), 643 (0x283) |
| 7 | 295 (0x127) | 1 | loop-the-loop pair (22005/22006); glue: 307 (0x133) |
| 8 | 312 (0x138) | 1 | dive variant; glue: 324 (0x144) |
| 9 | 329 (0x149) | 1 | climb variant; glue: 339 (0x153) |
| 10 | 558 (0x22e) | 1 (3 lanes) | 26f barrel-roll train (22012–22014) |
| 11 | 456 (0x1c8) | 1 (3 lanes) | 25f chase (22011/22012); glue: 483 (0x1e3), 424 (0x1a8) |
| 12+ | 380 (0x17c) | 1 | 13f mirror pair (22023); glue: 395 (0x18b), 344 (0x158) |

Family A scenarios are the ones with hand-written glue in 0x10efe: the main +
sub toasters get companion sequences queued at staggered loop boundaries
(constants above extracted from the driver; e.g. scenario 1782: sub1 queues
1786 (0x6fa), sub2 1852 (0x73c); scenario 1928: sub1 1933 (0x78d), sub2
2004 (0x7d4); all end by queuing flight 93 (0x5d) to disperse). Exact
stagger order is data-plus-glue; for a port, starting the companion sequences
at the same time and dispersing to label 93 when each finishes reproduces the
look. Flagged UNCERTAIN at the fine-detail level.

**Family B — 0x10d85, `RandShort(14)`** (single-channel choreographies, 6 s gate):

| roll | label | weight/delay | content (JSON seq, banks) |
|---|---|---|---|
| 0 | 2391 (0x957) | 2 / 1000 | mother toaster + 3 babies (2390; 22006) — also a FlyingToaster special-entry, globally unique flag @0x43a072 |
| 1 | 2406 (0x966) | 2 / 1000 | mother + 2 babies (2405) |
| 2 | 1213 (0x4bd) | 1 | toast + upside-down toaster (1212; 22009/22010+22024) |
| 3 | 1227 (0x4cb) | 1 | toast + toaster hold (1227) |
| 4 | 1288 (0x508) | 1 | **"evolution props" fly-by** (1287; banks 22032/22033 — knight/armor toasters etc.); stops WAV 22000 (0x55f0) at teardown |
| 5 | 658 (0x292) | 1 | solo stunt (657; 22017) |
| 6 | 928 (0x3a0) | 1 | **police chase**: cop-beacon toaster pursues wingless toaster (927; 22034+22035+22024); stops WAV 22001 (0x55f1) |
| 7 | 1361 (0x551) | 1 | upside-down glide (1360; 22024) |
| 8 | 1372 (0x55c) | 1 | 4-item toast juggling (1371; 22021/22022/22024) |
| 9 | 2239 (0x8bf) | 2 / 4000 | head-on pass (2238; 22000/22004) |
| 10 | 1387 (0x56b) | 1 / 4000 | bagel/toast + toaster (1386; 22008/22009+22024) |
| 11 | 2272 (0x8e0) | 1 | 24f 4-actor crossing (2271; 22016/22017) |
| 12 | 2298 (0x8fa) | 1 | 21f pair (2297) |
| 13+ | 2349 (0x92d) | 1 | mirror flight (2348; 22011/22012) |

**Family C — 0x10e51, `RandShort(11)`** (15 s gate; the "big" set-pieces):

| roll | label | weight/delay | content |
|---|---|---|---|
| 0 | 2421 (0x975) | **4** / 1000 | **power-cord gag**: 35f, up to 8 items — squadron towing the cord/plug (2420; 22025+22026+22013) |
| 1 | 2458 (0x99a) | **4** / 1000 | 4-toaster diamond formation start (2458 → chains onward) |
| 2 | 2736 (0xab0) | 1* | 3-toaster wedge (2735) |
| 3 | 2910 (0xb5e) | 1* | 52f 3-actor aerobatics finale (2909; 22005/22011) |
| 4 | 1402 (0x57a) | 2 / 1000 | pair start card (1402 → chain) |
| 5 | 1672 (0x688) | 2 / 1000 | toaster + adult flap + upside-down (1671; 22002+22024) |
| 6 | 2080 (0x820) | 2 / 1000 | pair start (2080 → chain) |
| 7 | 679 (0x2a7) | 1 / 1000 | **police intro card** (679; 22035+22017) → chases via 674 (art 537, net (−220,+88)/3f) |
| 8 | 1349 (0x545) | 2 / 1000 | toaster + police escort (1348; 22035); stops WAV 22005 (0x55f5) |
| 9 | 879 (0x36f) | 2 / 1000 | 32f multi-prop routine (878; 22015/22022/22023/22024) |
| 10+ | 946 (0x3b2) | 2 / 1000 | 35f solo mega-routine (945; 22015/22016/22023/22024) |

\* not present in the 0x15bf1 weight chain → default weight 1, delay 0.
(0x8d1/2257 also has a config leaf (w=2) but no picker roll — dead entry.)

### Run behavior (0x10839)

- Waits until every started channel hits a loop boundary and its "expect" flags
  agree, then advances phase via glue driver 0x10efe(+0x88).
- Sound: when `now > startTime(+0x64) + delay(+0xac) − 250 ms` and the
  play-sound flag +0x84 is set → `PlayNoise(id 0x55fa = WAV 22010, 5, 1, 200)`
  (likely the gag whoosh/siren). On teardown (Stop 0x1066b) it stops WAVs
  0x55f1, 0x55f5, 0x55f0 (22001/22005/22000); the run loop's per-scenario stop
  map: scenario 928→stop 22001, 1288→stop 22000, 1349→stop 22005.
- Population: Play adds/removes **weight** [gag+0xa4] (1/2/4 per tables) to the
  active-object count (read sites 0x1ddf4, 0x1dfe8) — the cord gag counts as 4
  toasters. Gag death clears the gag-active latch [ctl+0x840].
- Adult-only: spawned only when [ctl+0x82c] (adult mode) — confirmed in Play's
  spawn switch (class name pushes @0x1de99+: FlyingBigGag / Cloud / BabyCloud /
  Food / BabyFood / FlyingToaster strings @0x43be22…0x43be65).
- FlyingToaster's globally-unique specials tie in here: 1138 (0x472) = 12-frame
  5-item mother-toaster-with-babies formation (seq 1137, bank 22006), flag
  @0x43a070; 2391 (0x957) = family-B scenario 0 above, flag @0x43a072.

---

## 5. KaraokeControl::PlayBagel (0x1b31f) — validation vs BEHAVIOR.md

**PlayBagel *is* the karaoke event pump**: `KaraokeControl::Play` (0x1b16e) is
just a wrapper that calls it (call @0x1b17b) every DoDrawFrame. Not an easter
egg. Runs only when +0x64/+0x66 (karaoke enabled / song playing) flags allow.

Syllable entry = 4 dwords `(lineFrame, wordSlot, duration, event)` (confirmed
at 0x1b38c+; matches BEHAVIOR's 16-byte layout read as words).

Confirmations / corrections:

- **Durations are deltas** (relative). +0x40 accumulates an absolute deadline:
  `deadline += entry.duration` per entry; +0x44 is the sub-step deadline. The
  pump loops `while (now >= subDeadline)` — no drift.
- entry[0] special-case confirmed: `(0, 1, dur, 0)` = intro delay →
  deadline += dur, BlankBackground(), no draw (0x1b3a9).
- **event 4** = end-of-line: deadline += dur (the line gap), BlankBackground()
  (0x1b3d2). Confirmed.
- **End-of-table sentinel** (new): entry `(0, 10, ?, 4)` → KaraokeControl::
  Reset() — table terminator, restarts state (0x1b38c).
- **event 0** (show line) and **events 1/2** (advance/hold highlight) confirmed
  via DisplayText dispatch (0x1b1f0): Event 0 draws the line with no
  highlight; 1 draws with highlight on the current word; 2 redraws only the
  word's rect (hold/extra syllable); 4 passes wordSlot through as the
  highlight bound. **New: internal Event 3** — two sub-steps after an event-1
  hop, DisplayText is re-invoked with Event 3 (settle/redraw; global
  counter @0x43b614, table index @0x43b618).
- **The bouncing bagel** (new, the function's namesake): a winged-bagel sprite
  (its own channel +0x14) hops word to word. Per entry: target = center of the
  next word's item rect (channel vtbl+0x94 GetItemRect), hop is split into
  N sub-steps where **N = [ctl+0x38]** = frame count of the bagel hop
  sequence (queried at SetSongType via channel vtbl+0x90); per sub-step the
  bagel moves `(targetX−curX)/N` horizontally and the pump waits
  `duration/N` ms; the hop queues label **3305 (0xce9)** (JSON seq 3304,
  6 frames, arts 550–552 in bank 22035 = winged bagel flapping); the "hop
  finished" label is **3308 (0xcec)** (checked vs channel current-label
  vtbl+0x74). Bagel y sits at `karaokeBottom − 31` (0x1b46c: area height −
  0x1f). So: draw the line, and animate a 6-frame winged bagel gliding to
  each highlighted word in sync with the syllable timing.

Nothing in the tables contradicts BEHAVIOR.md's per-entry semantics; the only
substantive addition is the delta-time accumulation and the bagel pointer.

---

## 6. STRINGLIST 22000 jokes ("Grey Jelly" lines)

`FlyingToastersModule::DisplayStartupBanner` (0x1bfe3):
`DoBlankScreen(); BlankOtherMonitors(GetDeepestMonitor()); PortableModule::
ShowMessage(canvas [this+0xc], 0x55F0 = 22000)`. The **engine** (adxpl510)
picks and renders a line from STRINGLIST 22000. So the jokes are the standard
After Dark startup quip: shown **once, by the module, at activation** (the
banner over the just-blanked screen) — no in-saver actor displays them, and no
randomization logic lives in this module. Frequency = once per activation.

---

## Misc extras picked up on the way

- **Music-interval mapping** (GetControls 0x1c2d5): slider ≥0x50 → −1
  ("Always"), ≥0x40 → 1,800,000 ms (30 min), ≥0x30 → 300,000 (5 min),
  ≥0x20 → 120,000 (2 min), ≥0x10 → 60,000 (1 min), else 0.
- Toaster spawn writes adult/baby flag [ctl+0x82c] into [toaster+0x58]
  (0x1e011).
- FlyingToaster Stop (0x18647) clears unique-label flags: if current label
  dword +0x44 == 0x957 → clear @0x43a072; == 0x472 → clear @0x43a070.
- Channel-reuse rate limit: any launch waits 500 ms since the channel's last
  use (0x171e8) — this naturally staggers spawns beyond the 10 Hz tick.
