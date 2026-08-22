# Flying Toasters! — Engine internals (act-chaining & the gag system)

Overnight dig answering: how the engine chains acts, coordinates multi-actor
gags, handles persistent transforms (bagel-eyes), the morph, and sounds.
All RVAs are module `Flying Toasters!.ad`, image base 0x400000.

## TL;DR — the answers

1. **Act-chaining is real, hardcoded engine logic** — not something to guess.
   Each BigGag *scenario* has a driver that, at each phase boundary, queues
   specific follow-on sequences onto each of its channels. My old `enter(93)`
   ("after any act, return to plain flight") was an invention that discarded
   this. The truth lives in the glue drivers.
2. **Persistence (bagel-eyes) = a follow-on sequence, not runtime state.**
   The bagel-eyes scenario queues act seq 878, then queues bagel-*cruise*
   seq 912 (a flap loop carrying the bagel art 332) — so the toaster keeps
   flying with the bagel on its face until it drifts offscreen. Confirmed in
   code at 0x13df3 (queue 0x36f=879) → 0x13e53 (queue 0x391=913=seq 912).
3. **Gags never spawn independent objects.** `GetObjectReserve` (the
   FlyingObject allocator) is called *only* from `ToasterControl::Play`
   (7 sites, all in Play). A gag is a self-contained bundle of up to **4
   compound channels** (+3 follower helpers). The "toast that flies off on its
   own" is one of the gag's own sub-channels dispersing to plain flight — it
   only looks independent. → In the web port, a gag = N coordinated Players,
   no separate spawn pool needed.
4. **No emergent reactivity.** Spawn kind is `RandomType()` (random); flight
   acts (133/172/209/…) are random picker rolls. Toasters never react to each
   other's proximity. All apparent "interaction" (leapfrog, chase, go-around)
   is *inside* a pre-choreographed gag. The narrative reactions are the gag
   illusion, not engine logic.
5. **The morph is seq 1232** (regular→futuristic, 53 frames). My "evolution
   1288" button played 1287 (already-futuristic loop) — wrong. Real chain +
   sounds below.

## The gag object (FlyingBigGag)

- Fields: main channel +0x10; sub-channels +0x40 / +0x44 / +0x48 (0x94-byte
  compound channel objects, allocated in Start); follower helpers +0x4c/+0x50/
  +0x54 (re-pinned to sub rects each tick — attachment sprites/sound anchors,
  ignorable for a visual port). Scenario label at +0x34; phase at +0x88.
- **Launch (0x1077b):** call entry-placement 0x417378 with per-scenario lane
  params (+0x90/+0x94/+0x9c/+0xa0) → get a spawn point (sentinel 0xfc18 =
  retry); MoveTo main channel (vtbl+0x98); stamp start time +0x64; arm the
  whoosh sound flag +0x84; → state 2.
- **Run loop (0x10839):** each tick, when every started channel's loop-boundary
  flag [chan+0x4a] is set AND its "expect" word agrees, call the glue driver
  `0x10efe(gag, phase)` to advance. Two sound behaviors:
  - Whoosh: when `now > startTime(+0x64) + delay(+0xac) − 250ms` and flag
    +0x84 → PlayNoise(WAV 22010) once (0x109da).
  - On teardown/complete, scenario-specific stops (see sounds).
- **Population weight** [gag+0xa4] (1/2/4) is added to the active-object count
  in Play (cord gag counts as 4 toasters) and removed on death; gag dies /
  clears latch [ctl+0x840] when done.

## The glue driver (0x10efe) — how chains are queued

A big `switch(scenario)` (falls to family-B driver 0x412719 / family-C
0x414cd7 for their scenarios). Per case, at each phase it:
- queues a companion sequence onto each active sub-channel via
  `QueueSequence` (vtbl+0x7c) — the hardcoded follow-on labels;
- checks `CountLoopsOutOfView` (vtbl+0xa0) to know when a channel has flown
  offscreen;
- ends by queuing plain flight **3** or **93** on each channel (disperse).

Extracted scenario → queued-label chains (sample; label = runStart+1, engine
resolves to the containing sequence):

| scenario | sub-channel chain (companions → disperse) |
|---|---|
| 329  | 339 → 93 |
| 558  | [643,558,622,93] (loop 558/622, then 93) |
| 603  | [643,274,622,93] |
| 624  | 307 → 93 |
| 641  | 324 → 93 |
| 861  | [861,861,846,3] (loop with companion 846, then 3) |
| 1021 | [395,344,622,93] |
| 1097 | [483,424,622,93] |
| 1610 | [3,3,749,3] (queues the toast-relay 749 onto a sub) |
| **879 (bagel-eyes)** | **879 (act) → 913 (=seq 912 bagel-cruise) → offscreen** |

So most scenarios disperse to plain flight; the bagel-eyes is the notable
*persistent transform* (keeps the bagel).

## The morph (evolution gag) — handler 0x15400

Sequences (compound_22000): **1232** = regular→futuristic morph (53f: body
f1232-37 → warp arts 66-71/514-523 f1238-52 → futuristic 501-513 f1253-65 →
full futuristic 481-500 f1266-84). **1287** = futuristic cruise loop.
**1302** = morph back (futuristic→body). Futuristic art banks 22032/22033.

Handler chain (in order):
```
queue 1233 (morph→future)  + PlayNoise WAV 22012   ← the morph/warp sound
queue 1288 (futuristic cruise)  + PlayNoise WAV 22000
queue 3    (a companion channel to plain flight)
RandShort  (random # of futuristic loops)
queue 1288 …  (loop futuristic)
queue 1288    + PlayNoise WAV 22000
queue 1303 (morph BACK)    + StopNoise WAV 22000
queue 3    (disperse to plain flight)
```
So: start regular → warp with morph sound → fly futuristic (random duration) →
morph back → resume normal. My port must START at 1232, not 1287.

## Sound map (WAV resource id → use), from PlayNoise/StopNoise call sites

| WAV | trigger | notes |
|---|---|---|
| 22010 | gag whoosh | every gag start (run loop 0x109da), PlayNoise(id,5,1,200) |
| 22012 | **morph / warp** | morph handler 0x15437 |
| 22001 | **fire / burning** | scenario 928 (burning toaster) plays 0x151ff & stops 0x10701/0x108f9 — this is the "fire crackling" the burnt toaster should have |
| 22005 | police siren / escort | scenario 1349 (0x14c5e), stops 0x10714/0x1090e |
| 22000 | theme sting | during morph + several stops (0x10727/0x10923/0x15653) |
| (0x16ac8) | one more PlayNoise | context TBD |

Sound-id encoding: PlayNoise takes `0x55F0 + (wav-22000)` (so 0x55F0=22000,
0x55F1=22001, 0x55F5=22005, 0x55FA=22010, 0x55FC=22012). The 13 WAVs are IMA
ADPCM 22 kHz; already PCM-converted in `assets/sounds/22000..22012.wav`.

## Implications for the web port

- **Gags**: implement a `GagActor` owning several `Player`s. Drive them off a
  per-scenario chain table (companions + disperse-to-93/3). Persistence
  (bagel-eyes) and morph are just the correct follow-on labels + sounds — no
  new engine concepts.
- **Sounds**: wire the map above (fire on burnt/scenario 928, morph WAV 22012,
  gag whoosh, police siren).
- **No reactive AI to build** — random spawn + random acts is faithful.
- **Evolution button/gag** must start at seq 1232.

## Open / lower-value

- Family-A fine stagger (exact per-boundary offsets of each sub-toaster) is in
  the glue but tedious; the disperse-to-93 model reproduces the look.
- The 0x16ac8 PlayNoise context (likely a UI/monitor sound).
- Full per-scenario chain table for all ~38 scenarios (have the mechanism +
  ~11 sampled; the rest are the same shape).

## Gag rendering fidelity (live pool)

Profiled the live-pool gags (GAG_B/GAG_C) by counting distinct toaster bodies
drawn per frame from the MAIN channel alone:
- **Self-contained multi-toaster** (both/all toasters drawn from one channel,
  render correctly with no sub-channels): 2391, 2406, 2239 (donkey-hops/leapfrog),
  2298, 2349, 1672.
- **Solo** (one toaster): 658, 1361, 946.
- **One toaster + prop** (toast/cord/police-light/waffles — correct as-is):
  1213, 928, 1372, 1387, 2272 (love waffles), 878, 1232, 2421, 2736, 2910, 1349.
So the live gags render their intended cast; the ones that truly needed separate
sub-channel toasters were the 1-frame start-cards (2458/1402/2080/679), already
filtered out. Full 4-channel coordination is only needed for family-A scenarios
(not in the live pool) → multi-channel GagActor is a nice-to-have, not required.
