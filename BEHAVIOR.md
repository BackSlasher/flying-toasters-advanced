# Flying Toasters! — Behavioral Spec (recovered from disassembly)

Source: `Flying Toasters!.ad` (module, Borland C++) + `adxpl510.dll` (engine).
All addresses are RVAs. Companion data: `assets/compound_22000.json` (toaster
choreography), `assets/compound_22100.json` (karaoke layouts), `assets/sprites/`.

## Timing model

- Engine calls `DoDrawFrame` continuously; sprite drawing/karaoke poll every frame.
- **Logic tick**: `ToasterControl::Play` runs every `1000 / fps` ms with `fps = 10`
  (`GetControls` sets field +0x40 = 10, clamp 1..100). All object stepping
  (`FlyingObject::GiveTime` loop at the end of `Play`) happens at **10 Hz** —
  compound sequences advance one frame per tick. This is the authentic chunky cadence.

## Population (GetControls, 0x1c010)

- `density = screenArea / 480000` (long-double 1/480000 @0x1c46c). At 640×480: 0.64.
- Baby song active → `maxObjects = density × 22`, floor-min 5.
  Adult song → `maxObjects = density × 30`, floor-min 3.
- `maxClouds = density × 3`, `cloudCap2 = density × 5` (min 2).
- Objects setting tiers (slider values 0/25/50/75):
  - **Swarm (≥75)**: ×1 on everything
  - **Air Wing (≥50)**: objects ×0.5
  - **Squadron (≥25)**: objects ×0.25, clouds ×0.5 (cloudCap min 1)
  - **Flight (<25)**: objects = 3 (5 during baby song), **no clouds**
- Toasters setting (control 1): 0=Adults, 1=Babies, 2=Random → song type via table
  @0x43b72c; Random re-rolls `RandShort(2)` each song. Song type 1 (Babies) also
  clears flag +0x82c → baby object variants spawn and **BigGags are disabled**.
- Music setting (control 2) → replay interval; ≥0x50 = "Always" (-1).
- Karaoke checkbox (control 3) → field +0x50 → runs KaraokeControl::Play + screen area.

## Spawning (ToasterControl::Play 0x1dcd0 + RandomType 0x1e260)

Each 10Hz tick, if `activeCount < maxObjects`, spawn ONE object; kind from
`RandomType()`:

- If `cloudCount < maxClouds` and `now > lastCloudSpawn + 5000ms` → **type 3 = Cloud**
  (squadron; baby variant when in baby mode).
- Else roll `r = RandShort(5)` (0..4):
  - r=0: cloud check again vs `cloudCap2` → Cloud, else type 2 + reseed.
  - r=1: if `now > lastGag + 2000ms` and gag-pending flags and adult mode →
    **type 4 = BigGag** (one at a time; population-weighted).
  - r=2: `ratio = toasterCount / foodCount` (4.0 if no food):
    ratio > **2.0** → **type 1 = Food** else **type 2 = Toaster**.
  - r=3,4: ratio > **4.0** → Food else Toaster.
  (Net effect: toasters:food stabilizes ≈ 3–4 : 1.)
- Food/Toaster spawn baby variants in baby mode (`FlyingBabyFood`, and clouds
  `FlyingBabyCloud` — made by vtable-patching a Cloud).
- BigGag start params (+0x83c/+0x83e) are set by GetControls **500ms after music
  playback starts** (both =1 if flag @0x43b740 else one) — i.e. the big gag is
  scheduled at song start.
- Reserve pools: 7 single-object pools per class + 5 pools of 10 (cloud members);
  reserve budget `3.5n + 115 + 10` objects, `n = 30` baseline (IToasterControl arg).

## Motion & animation

**Motion is data-driven**: each object plays compound-sequence frames (per-frame
draw rects in `compound_22000.json`), chaining sequences with their `dx/dy` link
offsets. There is no separate velocity — the choreography rects ARE the motion.
Screen positions accumulate across sequence links (starting rect randomized at
spawn; sequence starter fns 0x1a276/0x1a3ea place via `MoveTo` with `RandShort`
spreads, e.g. label 0x453: x+40, y+200+RandShort(spread)).

**Flight state machine** (FlyingToaster handler 0x188cf): dispatch on current
sequence label. Heading ladder: labels 0x3F1 ↔ 0x3F6 ↔ 0x3FB ↔ 0x401 (climb…dive
variants; default flight = 0x3D7, alt start = 0x5D=93, kind 3 start = specials).
At loop boundaries roll `RandShort(10)`: on 0 (10%) queue a transition to the
adjacent heading (guarded by IsSequenceQueued 0x41987f / QueueSequence 0x419cc1).
Special-entry starting labels (launch dispatch 0x186d9): current-label→start-label
pairs {0x40E→0x40E, +0x45→0x453, +4→0x457, 0x4AF?→0x957, +0x1B→0x472, 0x482→0x482,
0x495→0x495, +0x13→0x4A8, default→0x3D7}. Labels **0x472 (1138)** and **0x957
(2391)** are globally unique (one instance at a time; flags @0x43a070/0x43a072).

**Heading quantization** (0x19f5e..0x1a23f): computed motion angle is compared
against thresholds π×{0.25,0.5,0.75,1.25,1.5,1.75,2} and π+0.3805 (globals built
@0x1a457 from base π @0x43a074) to select the flap-loop matching a direction.

**Art wiring**: compound art channel 1 = bank 22000 (attached via ICompound
wrapper with base id 22000). 29 label-specific art attachments
(label→bank, params (1,5,1,200)) — see table below; resolves items with artch ≥ 2
in those sequences (bagels, babies, toast, variants):

```
281→22008  287→22007  683→22011  761→22008  781→22008  802→22007  819→22008
852→22008  893→22011  960→22011  971→22003 1330→22003 1490→22009 1645→22003
1885→22009 1894→22003 2037→22009 2046→22003 2116→22006 2134→22003 2284→22008
2292→22007 2421→22002 2438→22002 2498→22009 2518→22003 2571→22009 2632→22009
```

## Karaoke (KaraokeControl)

- Songs: type 0 = `Music\Flying Toasters.mid` (PlaySongID 0x55F0), type 1 =
  `Music\Baby Toasters.mid` (0x55F1). Loaded via XNoiseMaker::LoadMidiOS.
- **Syllable tables** in module DATA: song0 @0x3A21C (159×16B), song1 @0x3AC0C
  (160×16B). Entry = `(lineFrame, 0, wordSlot, 0, duration_ms, 0, event, 0)`:
  - event 0: show line `lineFrame` (compound 22100), duration = delay
  - event 1: advance highlight to item `wordSlot`
  - event 2: hold (extra syllable) on same word
  - event 4: end of line (duration = gap to next line)
  - entry[0] duration = intro delay (song0: 7800ms, song1: 5500ms)
- Line layouts + word rects: `compound_22100.json`. Karaoke frame item 1 = full
  banner strip; items 2+ = per-word overlay sprites (highlight variants).
- Word/banner art: single global frame-id space across banks
  22100 (ids 1–15), 22101 (17–62), 22102 (64–109), 22103 (111–160).
- Karaoke area = bottom band (lines at y≈264–293 of 640×480); song1 also uses a
  12-line full-screen sheet (y 93–383) — title/verse card.
- `PlayBagel()` = the karaoke player loop (event pump).

## Sounds

13 WAVs (RIFF IMA-ADPCM 22kHz) in resources / `ad-source/extracted/*_WAV.bin`;
pairs with sprite banks by resource id (22000..22012).

## Sprite banks (assets/sprites/)

Adults flap loops (multiple headings): 22000–22005, 22011–22020, 22024–22025.
Babies: 22006–22007. Food: 22008 bagel, 22009 toast, 22010 burnt, 22021 buttered,
22022 flat toast. Cord gag: 22026. Evolution intro stills/captions: 22027–22033.
Wingless: 22034. Police/beacon: 22035. Karaoke: 22100–22103.

## Still TODO (next dig)

- FlyingFood handlers: doneness/food-type distribution (banks 22008/22009/22010/22021/22022 pick).
- FlyingCloud: formation offsets + member count.
- FlyingIntro: slideshow sequence order/timing (`SetPlayIntro`, DisplayStartupBanner).
- FlyingBigGag: which sequences (police chase choreography labels; likely 0x472/0x957 involved).
- KaraokeControl::PlayBagel event pump details (validate table semantics).
- STRINGLIST joke usage (which object shows "Grey Jelly" lines, when).
