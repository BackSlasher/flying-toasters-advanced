#!/usr/bin/env python3
"""Export the karaoke syllable tables from Flying Toasters!.ad DATA section.

Tables located via KaraokeControl::SetSongType disassembly:
  song 0 ("Flying Toasters" theme): RVA 0x3A21C, 159 entries
  song 1 ("Baby Toasters"):         RVA 0x3AC0C, 160 entries
Entry (16 bytes, LE): lineFrame, 0, wordSlot, 0, duration_ms, 0, event, 0
  event 0 = show line (duration = delay before/while shown)
  event 1 = advance highlight to item `wordSlot`
  event 2 = hold on same word (extra syllable)
  event 4 = end of line (duration = gap to next line)
Writes assets/karaoke.json.
"""
import json
import os
import struct
import sys

sys.path.insert(0, '/tmp/claude-1006/-home-isolationist-projects-afterdark-cc/e0face91-39d5-472e-a33a-aa0a1c653413/scratchpad/pylibs')
import pefile

MODULE = 'ad-source/After Dark/After Dark Tenth Anniversary/Flying Toasters!.ad'
TABLES = {0: (0x3A21C, 159, 'Flying Toasters.mid'),
          1: (0x3AC0C, 160, 'Baby Toasters.mid')}


def main():
    pe = pefile.PE(MODULE)
    img = pe.get_memory_mapped_image()
    out = {}
    for song, (rva, n, midi) in TABLES.items():
        events = []
        for i in range(n):
            line, _, word, _, dur, _, ev, _ = struct.unpack_from('<8h', img, rva + i * 16)
            events.append({'line': line, 'word': word, 'ms': dur, 'ev': ev})
        out[str(song)] = {'midi': midi, 'events': events}
    os.makedirs('assets', exist_ok=True)
    with open('assets/karaoke.json', 'w') as f:
        json.dump(out, f)
    print('wrote assets/karaoke.json:',
          {k: len(v['events']) for k, v in out.items()})


if __name__ == '__main__':
    main()
