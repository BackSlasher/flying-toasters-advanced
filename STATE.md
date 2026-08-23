# After Dark — Flying Toasters! Recreation

**Goal:** Extract sprites, sounds, music, karaoke, intro slideshow, and behavioral logic from
`Flying Toasters!.ad` (© 1996 Berkeley Systems, After Dark 4.0) and recreate the screensaver in
HTML/JS/CSS for personal use.

**Target module:** `ad-source/After Dark/After Dark Tenth Anniversary/Flying Toasters!.ad`
(PE32 DLL, Borland C++, symbols intact). *Explicitly out of scope:* Toaster 2k (user: uninteresting),
AD 2.0 / Pro modules (older art).

## Status

- [x] Inventory the CD, identify all toaster modules and their formats
- [x] Extract AD 2.0 sprites (plain BMPs) — proof of concept only, not the deliverable
- [x] Map `Flying Toasters!.ad` PE resources (see below)
- [x] Recover class architecture from Borland mangled symbols
- [x] **Crack RLID/CSTM sprite compression** — done, format documented in `tools/rlid.py`
- [x] Decode all 40 sprite banks → transparent PNGs (`assets/sprites/<bank>/`) + `banks.json`;
      cast overview at `assets/cast_overview.png`
- [x] Extract karaoke syllable/timing data — ms-accurate tables for both songs (see BEHAVIOR.md)
- [x] Map animation scripts — `tools/compound.py` → `assets/compound_*.json`
      (2905-frame toaster choreography, 165 sequences; karaoke line layouts)
- [x] Lift core behavior constants — 10Hz tick, population formulas, spawn mix,
      flight state machine, art wiring → **BEHAVIOR.md**
- [ ] Remaining class-level details (see BEHAVIOR.md "Still TODO"): food doneness pick,
      cloud formation, intro slideshow order, BigGag choreography ← next
- [ ] Convert 13 WAVs (IMA ADPCM → wav/ogg), pick music (`Music/*.mid`)
- [ ] Build HTML/JS/CSS recreation
- [ ] Validate against original running under Wine

## Resource map — `Flying Toasters!.ad` (.rsrc = 1.73 MB of 1.88 MB file)

| Type | Count | Meaning |
|---|---|---|
| 8000 | 40 | RLID/CSTM compressed sprite banks (IDs 22000–22035, 22100–22103) |
| 8001 | 40 | Per-bank header: buffer sizes, w, h, ?, frame count |
| 8100/8101/8102 | 3/2/2 | Sidecar data for 22000/22001/22100 — suspect frame tables / karaoke sync |
| WAV | 13 | RIFF, IMA ADPCM 22 kHz (sound effects; already ripped in `ad-source/extracted/`) |
| PAL | 1 | LOGPALETTE, 234 colors (id 22000) |
| STRINGLIST | 6 | Error strings + joke lines ("Grey Jelly", …) |
| 1000 | 4 | Settings UI: Objects (Flight/Squadron/Air Wing/Swarm = 25/50/75), Toasters (Adults/Babies/Random), Music interval, Display Karaoke checkbox |
| 2000 | 1 | RTF module description (baby-toasters theme) |
| 2 (RT_BITMAP) | 1 | 152×112 preview thumbnail |

Bank 22100 is 365×28 (karaoke text banner); 22101–22103 likely lyric strips too.

## Key findings

- **RLID format fully reversed** (see `tools/rlid.py` docstring for the spec): big-endian
  chunk container (`RLID`/`IHDR`/`CSTM`/`BSTM`/`CTAB`), nibble-packed row-RLE with 10 opcodes,
  per-bank CTAB color tables (direct RGB — no palette lookup needed). Recovered by
  disassembling `RLESequence::DrawFrame` → blitters at RVA 0x31014+ in `adxpl510.dll`.
- **Cast identified** (assets/cast_overview.png): adult flap cycles at ~14 flight attitudes
  (22000–22005, 22011–22020, 22024–22025), baby toasters (22006–22007), bagel/toast/burnt/
  buttered (22008–22010, 22021–22022), power cord gag (22026), **evolution intro slideshow**
  stills + caption cards (22027–22033), wingless toaster (22034), police-beacon toaster (22035),
  karaoke banners/words (22100–22103).
- **Class architecture** (from mangled Borland exports — huge win, near-source-level naming):
  - `FlyingToastersModule` : `PortableModule` — DoDrawFrame, DisplayStartupBanner, UpdateKaraokeScreenArea
  - `ToasterControl` — FlyingObject pool (`GetObjectReserve`/`ReturnObjectReserve`), `RandomType()`,
    `SetPlayIntro(ushort)`, `SetSongType(int)`, GiveTime/Play/Reset
  - `KaraokeControl` — `DisplayText(Syllable, Event)` (syllable-timed!), `PlayBagel()` (easter egg),
    SetSongType, BlankBackground
  - `CompoundSequence` — multi-channel sprite sequences with **labels** (`GetLabelRange`),
    per-channel rects/colors → animation sequencing is data-driven
  - Engine (`adxpl510.dll`): `Background` (sprite list, z-order, mix/save canvases), `Sprite`,
    `XNoiseMaker` (PlayNoise/PlaySongID, LoadMidiOS), `XPalette`, `XTimer`, `RandShort(range)`
- Music: module calls `XNoiseMaker::LoadMidiOS` — song is external MIDI
  (`Music/Fttheme.mid` / `Flying Toasters.mid` / `Baby Toasters.mid`); Music setting = play interval.
- `Toaster 2k.ad` (©1999, MSVC) confirmed later but rejected by user.
- CODE section is only 78 KB (much of it runtime) → full behavior lift is tractable.

## Plan

1. Disassemble `a64KRLESequence::DrawFrame` / `SetRLESequenceData` in `adxpl510.dll`
   (capstone + pefile installed in scratchpad `pylibs/`) → write Python RLID decoder.
2. Batch-decode all 40 banks with PAL 22000 → `sprites/` PNGs + `banks.json`
   (per-frame rects, labels from CompoundSequence data).
3. Decode 8100/8102 sidecars (karaoke sync + frame tables) — correlate with
   `KaraokeControl::DisplayText`.
4. Ghidra-style pass over module CODE: `ToasterControl::GiveTime`/`RandomType`/intro state
   machine → constants table (spawn %, speeds, doneness, easter eggs).
5. Build web recreation (canvas loop; WebAudio for WAVs; MIDI via small JS synth or
   pre-rendered audio; karaoke banner; intro slideshow; settings panel).
6. Wine side-by-side validation.

## Notes

- VCS: jj repo; commit at milestones, not every step.
- IP: Berkeley Systems assets, rights orphaned — extraction for personal use only, don't publish rips.
- `ad-source/extracted/` = earlier partial rip (provenance unknown, matches PE resources exactly).

## Overnight dig (autonomous) — engine internals

Goal (user request): decode the engine's remaining secrets, especially act-chaining
and the multi-actor gag system. Findings → RE-ENGINE.md.

Questions to answer:
1. How does an act chain to a persistent follow-on? (test case: bagel-eyes 878 → 912
   bagel-cruise, art 332 = bagel). Where is 912 queued after 878?
2. Family-A glue driver (0x10efe / 0x412719 / 0x414cd7): how sub-actors are created,
   positioned, and coordinated; how follow-on sequences are chosen.
3. Do gags spawn INDEPENDENT objects (toast pops → flies off as its own food)? Mechanism?
4. Are one-shots 133/172/209 reactive (proximity to other toasters) or random?
   (transitions.json says random pickers — verify no proximity check exists.)
5. The morph (evolution gag 1288): regular→futuristic transition + sound.
6. Sound triggers per act (fire crackling on burnt, morph whoosh, etc.).

## Overnight session results (2026-08-23)

Delivered autonomously while user asleep:
- **RE-ENGINE.md** — decoded act-chaining, the gag glue driver, morph, sounds:
  - Persistence (bagel-eyes) = hardcoded follow-on sequence (878→912), confirmed
    at 0x13df3/0x13e53. Not runtime state.
  - Gags never spawn independent objects (GetObjectReserve only in Play); a gag
    = ≤4 coordinated compound channels.
  - No emergent reactivity — all random; interactions only inside gags.
  - Morph = seq 1232 (regular→futuristic, WAV 22012), 1287 loop, 1302 back.
  - Sound map: 22001 fire, 22012 morph, 22010 whoosh, 22005 police.
- **Fill-the-screen** — field = window size, native sprites, rate-limited spawns
  spread the swarm; live re-fit on resize (no reload; fixes F12).
- **Music** — rendered both karaoke MIDIs + theme to OGG (fluidsynth); WebAudio
  playback; karaoke clock synced to audio; Music toggle.
- **Sound effects** — all 13 WAVs; gag-specific SFX (fire/police/morph/whoosh).
- **Persistent-transform gags** — bagel-eyes (878→912 persists) and morph
  (1232→1287→1303) now chain correctly and appear in the live pool.
- **Catalog** — authoritative renames from the review batch, cloud fix (were all
  art 463), Transforms group with correct chains, debug loop toggle.

Still open (need user eyes / bigger lifts):
- Multi-channel family-A gags (leapfrog/donkey-hops 2239, etc.) render single-
  channel; self-contained ones look fine, others sparse.
- Food 2969/2974 are static holds (faithful to engine) — user wants jam/buttered
  variants surfaced (jam = arts 330/331; not used by the free-food picker).
- Audio playback unvalidated headless (needs real user gesture).
- Wine side-by-side validation.

## RE deep-dive session 2 (2026-08-23, cont.)

Built `tools/gagmap.py` — recursive dispatch-tree walker + bounded handler
extractor → `assets/gags.json` (complete per-scenario, per-channel gag
choreography). Player now renders multi-toaster gags data-driven via `MultiGag`.

Confirmed multi-channel gags: diamond 2458 (4ch), speeding/flip 946 (flip +
speeding 520), police 679 (3ch), 1402/2080 (long orphans), toast-juggle 792
(spawns food on sub), pairs 1782/1928. Full map in RE-ENGINE.md.

### Remaining RE targets (in progress)
- [x] Scenario config table (0x15bf1): weight/lanes/split/delay per scenario,
      merged into gags.json (tools/gagmap.py config()).
- [x] Entry placement (0x17378): lane<split=top edge, lane>=split=right edge
      (x=baseX+(lane-split)*160+240 / baseX+80; y=baseY-80 / baseY+(lane-split)*80).
      Wired into MultiGag — faithful formation geometry.
- [x] Phase-gate timing: barrier-sync in MultiGag (channels hold at their
      sequence boundary until all are ready, then advance together — engine
      run loop 0x10839). Keeps formations locked.
- [~] Conga: 1402 (long companions) is the candidate; reads as a following
      formation but not confirmed single-file. Needs user eyes on the original.


### Gag system fully unified (authentic)
Extracted the family picker tables (0x10cd2/0x10d85/0x10e51):
- FAM_A [1782,1928,792,807,749,861,274,295,312,329,558,456]
- FAM_B [2391,2406,1213,1227,1288,658,928,1361,1372,2239,1387,2272,2298]
- FAM_C [2421,2458,2736,2910,1402,1672,2080,679,1349,879]
spawnGag now = RandShort(3) family select (C>=15s / B>=6s gates / A always) →
RandShort into the family table → MultiGag(scen), driven entirely by gags.json
(chains + weight/lanes/split/delay). Removed all hardcoded gag pools.
Everything data-driven from the RE artifacts now.

## RE deep-dive session 3 (2026-08-23, cont.) — extract more, stop approximating

Driven by user feedback (broken gags: "frozen sprites at top", "6 toasters 3
frozen", formations not doing the described leader-follow; "link sounds by REing
the engine"; "extract more vs approximate"). Four concrete engine extractions:

1. **Sound → sequence binding** (`assets/soundmap.json`, 28 bindings).
   Sounds are registered against compound frames in `ToasterControl::
   IToasterControl` (0x1ce51 → art-reg call 0x41694a), fired when playback
   reaches a bound frame — NOT via PlayNoise in gag handlers. `Player._soundAt`
   fires them each frame (`saver.soundMap`). Conga drum 22002 binds to labels
   2421/2438 (power-cord gag) — the "missing conga" the user reported.

2. **Second queue method 0x80** (was: only 0x7c QueueSequence extracted).
   `[eax+0x80]` is a sibling queue method — 46 call sites, 21 with labels. Whole
   channels were being dropped: **1349 police-car main=675 is queued ONLY via
   0x80**, 679 sub2=683, 2349 main=2321, 2406's extra baby=988. gagmap.py now
   captures 0x7c+0x80 with a proper push-stack (was mis-attributing labels via a
   leaked pending-immediate). Also fixed: capstone renders small immediates in
   DECIMAL (`push 3`), so disperse markers (3) were silently dropped.

3. **Formation absolute-playback.** Sequences split into two populations:
   *actor* loops (short, small net motion — mother/babies; drift via common-art
   alignment; entry-lane placed) vs *formation arcs* (len>=40 & displacement>=250:
   authored absolute trajectories, e.g. 2473 sweeps (826,-44)->(428,228)).
   Formation arcs now play at their 640x480 authored coords, synchronized, and
   drift out on plain flight afterward — fixes the "frozen at top" / "6 toasters"
   reports. 2458 = 4-toaster diagonal echelon (not a "diamond"); 1402 = same-lane
   block; 1782/1928 = pair arcs 1933+2004 (share handler 0x10fc6).

4. **1-frame layout cards are templates, not actors.** Frames like 2458/679 hold
   one `artch` item per channel (the formation template); replaying one froze a
   toaster. Now dropped; the scenario-label fallback only fires for real
   multi-frame sequences. Every channel ends in disperse→plain-flight (3/93) so
   nothing loops in place. All 28 gags now self-terminate (verified headless).

CORRECTION to session 2: the barrier-sync ("channels hold until all ready") was
REMOVED — it froze sprites. Formations stay coherent via synchronized start +
absolute coords, not a per-tick barrier.

Debug catalog names de-guessed: gag labels now describe extracted composition
(channel count / formation-vs-actor / confirmed props), keeping only
user-confirmed names (kissing pair, hoola hoop, bagel ride, mother+babies, …).

### Session 3 cont. — five more engine extractions

5. **BreakOffProp signature reversed** (chan vtbl+0xc8, 2 sites):
   `main.Split(subCh, contLabel, propLabel)`. 807 = Split(sub1, 93, 2974) → toast
   2974 breaks off, main→flight; 1672 = Split(sub1, 1686, 1734) → rider 1734
   breaks off. Prop has NO explicit x/y: it detaches at the main toaster's LIVE
   position when main reaches the split frame. MultiGag now defers the prop spawn
   to main's gag-sequence-end transition, at main's live center, and lets the
   prop keep its OWN sequence (a toast tumbles/drifts as a toast — the earlier
   flight-append flapped it like a toaster).

6. **861 was faithful all along** — single-channel bagel-pop (main plays 861
   then disperses). The old "846 2nd element" was a parser artifact; the guessed
   "toast+upside-down" name was wrong (now "bagel from toaster"). The 0x98/0x10c
   methods it uses take no labels (engine state mgmt, not choreography).

7. **Scenario-range ceiling bug**: choreography() filtered `scen <= 0xa00`, so
   family-C **2736** (0xab0) and **2910** (0xb5e) were dropped → fell back to a
   single toaster. Raised to 0xc00 (matches config()). 2736's real 3-channel
   wedge (main 307→2736, sub1 638, sub2 324) now extracts.

8. **Self-contained multi-body formations.** Some "formed" sequences draw the
   whole group from ONE channel (frame item-count >=3): 2736 wedge (3 bodies),
   2406/2391 mother+3-babies (4 bodies), 2910 finale (3). Their single-body
   sub-channels are the pre-form fly-in / spurious extras (the review's "extra
   stuttering baby" on 2406). MultiGag now suppresses single-body subs when main
   plays a >=3-body sequence — but only counts PLAYABLE (>1 frame) main
   sequences, so 2458's 4-body layout CARD doesn't false-trigger and its four
   formation-arc subs survive.

9. **vtbl method census** (channel object): 0x7c/0x80 QueueSequence(+variant,
   labels), 0xa0 CountLoopsOutOfView, 0xc8 Split, 0xc4 (1 site, setup), and
   no-label state methods 0x98 (63x), 0xfc (43x, index arg 1-4 — generic
   property setter, NOT a formation-merge signal as first suspected), 0x10c,
   0xf4. Only 0x7c/0x80/0xc8 affect choreography; all captured.

10. **Gag→flight "flicker" fixed.** The universal 93-append made every gag end
    with a compound transition to plain flight; where the gag's last pose and the
    flight pose share a body art at very different positions, MoveThroughCommonArt
    snapped the sprite (e.g. power-cord 2421: a 164px teleport that read as
    "flickering out"). The engine doesn't transition here — it hands the toaster
    back to the flight state machine IN PLACE. MultiGag now `placeCenter`s on the
    sprite's current center when resuming 3/93, so flight continues seamlessly;
    other transitions (morph, formation) keep common-art continuity. (879's
    remaining ~179px steps are the real 538 dive — uniform fast motion, not a bug.)
    Debug: double-click identify overlay gained a copy-to-clipboard button.

11. **Flight act frequency corrected to the extracted RandShort(10)=10%.**
    Confirmed 0x422f51 = RandShort; the flight machine (kind1 @0x419198, kind2
    @0x418fc8, kind3 @0x188cf, split on [ebx+0x40]) rolls `push 0xa; RandShort`
    at each loop boundary and only breaks into an act on 0 (~10%), room-gated.
    `pickerRoll()` was a ~66% guess (arbitrary rand(35)/rand(30) ranges) — flight
    was far too busy. Now RandShort(10)-gated; measured ~10.6% act rate in the
    swarm. Adult act sets confirmed from the dispatch trees (kind1 33/133/172/
    209/602, kind2 638/231/252). Per-act sub-distribution (s44/s48 launch state)
    still uniform-approximated.

## Formation assembly — cooperative draw (2026-08-23, session 3 cont.)

Replaced the `bodies>=3` suppression heuristic with the real engine mechanism.
Corrected the channel vtable first (it's a CompoundSprite SUBCLASS, vtable
adxpl510 0x507b0, CompoundSprite methods at +0x78): 0x7c=NextSequence,
0x80=NextSequences, 0xa0=CountLoopsOutOfView (a query), 0xc4=Merge, 0xc8=Split,
0xfc=GetChannelRect. `DrawFrame` (0x418df7) draws only a sprite's OWNED channels
(per-channel visibility flag [sprite+0xbc]+ch*14+0xe). So formations are drawn
COOPERATIVELY. Extracted the GetChannelRect(slot)↔SetCenterPoint(channel) pairing
into gags.json `slots`. Player: main draws slots no sub owns; each sub draws its
own body and follows the main's live slot rect each tick; dissolves with main.
2736 = clean 3-wedge (no overlap), 2406 = mum+3 babies incl. the slot-4 baby.
Default on; `sv.assemble=false` reverts to suppression. All 35 gags terminate.

Heuristic status now: spawn=1/tick (engine), persist=queue trailing-disperse
(engine), formation=cooperative slot draw (engine). Remaining: `isFormation`
(absolute vs entry-lane placement — port artifact) and the flight heading system
(uniform down-left drift — architectural simplification).

## Gag persist rule — engine ground-truth (2026-08-23, session 3 cont.)

Replaced the `loopDrifts` heuristic (does the last seq drift when looped?) with
the engine's queue structure. Key: `CountLoopsOutOfView` (adxpl510.dll @0x41a020)
is a QUERY — it *counts* how many loops the sprite has while out of view (via the
out-of-view test 0x41fedc) — NOT a "loop forever" setter. The real persist signal
is the QUEUE:
- A real sequence FOLLOWED BY a disperse (3/93) loops until it drifts out of view
  then resumes flight (bagel-eyes 913, bagel-pop 861).
- A real sequence that is the LAST queue entry with no disperse after plays ONCE,
  then the queue empties and the toaster resumes plain flight (toast-insert 792,
  toast-toss 807 — the "keeps looping/spitting" bugs).
- SELF-CONTAINED gags (handler queues only computed scenario-relative labels, no
  explicit sequence) are the toaster's modified-flight loop and loop until off
  (fire 928, hoola 1361, rowing 658, leapfrog 2239, bagel-ride 1387, juggle 1372).
807's main queue is just disperse ([3,3]); its toss animation is the scenario's
own seq 807 (self-contained fallback, plays once) + a BreakOffProp toast — so the
[807,93] boot patch was dropped (kept only props). 1288 lost its trailing 3.
Verified: 792/807 play once, transforms persist, all 35 gags terminate.

## Serving + polish (2026-08-23, session 3 cont.)

- **Karaoke black box removed**: the line sprite is white/red text on an OPAQUE
  black box → a faint "tear" at its edges over the sky, and the red multiply
  reddened its transparent margins (needed a destination-in mask). Now the
  karaoke banks are loaded through `dropBlackBox()` (near-black → transparent),
  so only the glyphs render; clean on both black and white.
- **Baby mode on load**: settings.toasters defaulted to Adults regardless of the
  (browser-restored) dropdown. Boot now reads the controls' current values.
- **Preference changes restart**: `Screensaver.restart()` clears the field so a
  density-slider or adult/baby change takes effect immediately (slider restarts
  on release; dropdown on change).
- **Baby mode skips the intro** (engine-confirmed): SetPlayIntro is gated
  `cmp [ebx+0x48],0; jne` @0x1c340 — the evolution slideshow only plays for song
  type 0 (adult). We now set songType from the toasters setting and only
  playIntro() when songType===0.
- **Intro slide corruption**: arts 454/455 (bank 22029 f453/f454, the sky-
  transition frames near the end of the intro) are genuine RLID decode failures
  (horizontal noise); flash ~1 frame each. All other slides decode clean. TODO:
  debug the RLID path for these two photographic frames.
- **GitHub Pages build**: `tools/build.sh` assembles `dist/` (index.html +
  player.js + style.css + assets/ + .nojekyll); ASSETS resolves relative to the
  page (`../assets` in dev under /web/, `assets` when served at root, no rewrite).
  `.github/workflows/deploy.yml` builds + deploys to Pages on push to main.
  .gitignore covers ad-source/, dist/, __pycache__.

## Karaoke rewrite + UI (2026-08-23, session 3 cont.)

- **Karaoke red (final, readable)**: the extracted per-syllable RED glyph arts have
  overlapping/mis-tiled bounding boxes → stamping them garbled some lines ("When
  times of trouble…" all-red smush). New approach keeps the authentic font: the
  line is ONE clean WHITE sprite (white-on-opaque-black); draw it, then MULTIPLY a
  red fill over the sung region (left of the reveal cursor). Multiply turns white
  glyphs red and keeps the black box black — a clean left-to-right red wipe, no
  overlap/fringe/boxes. (source-atop reddened the whole box; erase-then-stamp
  garbled — multiply is the fix.)
- **Karaoke ↔ music drift**: karaoke wrapped on its event total (song0 84.3s) but
  the audio loops at the OGG duration (86.5s) — ~2s drift per loop, worse after a
  hidden tab. Now wraps on `music.dur` when a source is playing; the lyric-less
  tail shows no line, then wraps with the song. Combined with the audio-derived
  musicClock, karaoke stays locked to the music through tab hides.
- **UI**: Objects dropdown → authentic Density SLIDER (Flight/Squadron/Air Wing/
  Swarm, the original had density/speed/size/toast/flap sliders). Music, SFX, and
  Karaoke are now three independent top-bar toggle buttons (sfx = effects only, no
  longer forces music on); removed from the settings panel. Identify overlay got a
  ✕ close button + Esc-to-close.

## Playback fixes (2026-08-23, session 3 cont.)

- **Karaoke rendering (final)**: compose on an offscreen — draw the white line,
  then for each SUNG syllable ERASE the full line-height band under its x-span and
  paint the red glyph. White supplies inter-word spacing (red arts have no space
  glyphs → red-only smushed "Thesmell"); erase kills the white fringe; full-height
  erase removes the decorative overline peeking above red. Bagel lowered (gap
  31→6px). Mid-song start fixed (see lineEndAt below). Music/karaoke offscreen
  desync fixed: musicClock now slaved to audioContext.currentTime while a source
  plays (rAF throttles when hidden, WebAudio doesn't), tick-counted only when idle.
- **Karaoke stale lineEndAt**: a fast-forward (enabling karaoke mid-song, or a
  hidden-tab resume) that landed INSIDE a line blanked it with the previous line's
  end marker. ev-0 (line start) now clears lineEndAt.
- **Gag transform persistence**: the universal 93-append reverted every transform
  gag to a plain toaster at the end (879 bagel-eyes, 928 fire, 1387 bagel-ride,
  2421 power-cord all "became regular"). The engine loops the transform until it
  drifts out of view (CountLoopsOutOfView) THEN queues the disperse. Fix: for
  non-formation channels, strip the trailing disperse and — if the last real
  sequence is a drifting flight-LOOP (loopDrifts && len>=8, cached per label) —
  loop it so the transform persists and flies off. A brief maneuver (307, len3)
  still plays once then resumes plain flight. Formations still exit on flight
  (their arc ends mid-screen, doesn't loop-drift).
- **Intro "Today" caption**: legible anti-aliased text, correctly decoded; the
  odd "d" is the low-res 1996 source font (55x19), not a decode bug. Drawn at
  native size (no scaling).

- **Karaoke red/white fringing**: the compound line is artch-1 = full WHITE line
  (bank 22100), artch-2+ = per-syllable RED word overlays (banks 22101-3). We were
  drawing the white line always + red words on top; sub-pixel glyph/AA mismatch
  left a white fringe around the red. The engine (KaraokeControl::DisplayText
  0x1b1f0) reveals a syllable RANGE red via a compound reveal call [eax+0x94]
  (start,end) — a left-to-right wipe. Fix: draw the white line CLIPPED to the
  unsung tail (right of the reveal cursor = furthest sung word's right edge), red
  words for the sung part. Verified: 0 white pixels in the sung region; clean
  "Fly ing our"(red) / "of the sun"(white) split.


- **Gag→flight seam creep**: the flicker-fix placeCenter was firing on EVERY 93
  self-loop, cancelling the natural −17px/loop leftward step → toasters crept
  right each flap cycle (reported on gag 295). Now placeCenter only on the FIRST
  gag→flight seam (prevLabel not already 3/93); flight self-loops use natural
  common-art drift. Verified: 295 seam steady −17px, 2421 seam still teleport-free.
- **Intro handoff**: the swarm was blocked (introRunning) until the materialized
  intro toaster flew fully OFF screen — so others only appeared after it exited,
  and the field then popped in from empty (some already mid-screen). Now hands off
  to the swarm the instant the toaster materializes and reaches flight (Actor
  introDone flag); the intro toaster stays as the first swarm member and others
  fill in around it. Handoff at ~tick 74 instead of full-crossing.
- **Flicker hunt**: ran headless detection over 1500-tick mixed swarms — no
  teleports (>55px), vanishes (bodies→0), blank frames, missing arts, or
  cull-while-visible. Render loop is fixed-10Hz with clamped catch-up. Any
  residual "random flicker" is most likely the authentic 10Hz stepping on
  fast-moving sequences (e.g. the 538 dive, 179px/frame) or alpha-edge shimmer
  where sprites overlap — not a logic bug.

## Fidelity audit (2026-08-23) — engine-derived vs. genuinely approximated

Goal: everything except the HTML/CSS/debug scaffolding should trace to the
engine. Status of each subsystem:

CONFIRMED faithful (verified against the disassembly this pass):
- Sprite decode (RLID), sounds (event PlayNoise + frame-bound registration),
  music, karaoke timing, intro stills.
- **Free-food picker** — RandShort(9) jump table @0x18449 decodes EXACTLY to
  FOOD_ROLLS [3039,3024,3019,3002,2997,2979,2969,2974,2974]. (Butter/jam toast
  arts 309-360 aren't free food; they're used by toast-toss/juggle gag sequences
  792/807/1372/2272, which render them.)
- **Spawn toaster/food ratio** — RandomType @0x1e260: RandShort(5) + ratio gate
  with float consts @0x41e384=2.0, @0x41e388=4.0, default(no food)=4.0. Matches
  player.js exactly (self-balances ~4:1).
- **Gag family selection** — pickers 0x10cd2/0x10d85/0x10e51, C≥15s/B≥6s/A gates.
- **Flight state machine (whole subsystem verified)** — kind roll RandShort(11)
  @0x19d9a→[0x437924]=0xb (result 0→kind3, 1-5→kind2, 6+→kind1); cruise labels
  kind1=3 / kind2=93 (spawn @0x186d9); per-kind handlers (kind1 @0x419198, kind2
  @0x418fc8, kind3 @0x188cf) dispatch on current label; act FREQUENCY = the
  RandShort(10)=10% boundary gate (was a ~66% guess), room-gated; stunts loop
  while there's room then exit to plain flight (602→3, 638→93). The web
  loopAct/oneShot/dispatchK3 mirror these handlers; the extracted transition
  table (33/133/172/209/602, 231/252, baby 988-1025) matches.
- **Gag choreography** — per-channel QueueSequence 0x7c+0x80, Split 0xc8,
  formations, sound bindings, layout-card handling.
- Population formula density×22 (baby)/×30 (adult), floor-5 (GetControls 0x1c010,
  density @0x1c46c) — per BEHAVIOR.md.

ARCHITECTURAL SIMPLIFICATION (deliberate; the real boundary of the port):
- **Heading quantization** (0x19f5e..0x1a23f). The engine computes each toaster's
  MOTION ANGLE and quantizes it (thresholds π×{0.25,0.5,0.75,1.25,1.5,1.75,2}) to
  pick the flap-loop matching its direction AND to drive turn-arounds (labels
  105/115/122) and the stunt SELECTION (the 0x419700+ block sets s44 to a
  turn/heading label from the heading bits `edi`/`si`). Our recreation instead
  gives every sprite a uniform down-left glide (drift emerges from common-art
  alignment), so there is no per-toaster heading to key off. Consequence: we
  don't reproduce direction-matched flapping, banking, or turn-arounds, and the
  stunt pick is uniform rather than heading-driven. Largely invisible because the
  toasters predominantly fly one direction (down-left) in the original too. This
  is the one subsystem that is a design choice of the port, not an oversight —
  reproducing it means porting the whole angle→attitude heading system.
- **Gag internal phase TIMING** — engine gates phase advance + whoosh on a
  per-scenario `delay` timer (+0xac, 1000/4000ms; read @0x109b6 as
  time+delay-250). We pace by sequence completion instead (a proxy). NOTE:
  delay is NOT a per-channel spawn stagger — do not apply it as one.
- **Cloud cadence/max** — 5s spawn gap and density×3 max are our guess; the
  engine's cloud counting (RandomType type-3 path, flags 0x82c/0x83e) isn't
  traced. Low visibility.
- **Entry-lane exact geometry** — extracted from 0x17378 but only used for the
  non-formation actor channels now; formations use absolute coords.

CANNOT be RE'd (our scaffolding — expected):
- HTML/CSS shell, the debug sidebar + review panel, double-click identify +
  clipboard, the settings-panel wiring, canvas fit-to-window, WebAudio plumbing.

### (superseded) earlier "still approximate" list
- The self-contained form-up gags (2736/2910) skip the individual fly-in →
  merge animation; they show the FORMED sequence directly (faithful end state,
  simplified transition).
- Jam/buttered toast variants still not surfaced by the food picker.
- Per-channel `delay` (1000ms stagger in cfg) not applied — channels start
  together (correct for the synchronized formations; may matter for others).
