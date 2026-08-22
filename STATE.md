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
