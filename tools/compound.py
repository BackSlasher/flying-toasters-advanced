#!/usr/bin/env python3
"""Parse After Dark 4.x CompoundSequence resources (types 8100/8101/8102).

Layout recovered from CompoundSequence::ICompoundSequence / GetFrameData /
GetChannelRect in adxpl510.dll:

  8101 (id = bank): header; word @+0x0E = channel count.
        Channel k's frame script = resource 8100 id (bank + k).
  8102 (id = bank): directory. 14-byte header (word @+0x02 = max frame number,
        word @+0x0C = record count), then 10-byte records:
          +0 frameNo  +2 byteOffset(into channel script)  +4 channel
          +6 dx  +8 dy   (link offset applied when entering at this frame)
  8100 (id = bank + k): channel script; frame records at directory offsets:
          +0 rect (4 LE words: l,t,r,b)
          +8 itemCount (word)
          +0x0A items, 14 bytes each:
              +0 artFrame (word)   frame within the art RLE bank
              +2 artChannel (signed byte)  which art sequence to draw from
              +3..+5 pad
              +6 rect (4 LE words)  where to draw, in compound-local coords

  Sequences are maximal runs of consecutive frameNos; a gap starts a new
  sequence ("label" = first frameNo of the run).

Usage: compound.py <module.ad> <bankid> [out.json]
"""
import json
import os
import struct
import sys

sys.path.insert(0, '/tmp/claude-1006/-home-isolationist-projects-afterdark-cc/e0face91-39d5-472e-a33a-aa0a1c653413/scratchpad/pylibs')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pefile


def pe_res(pe, rtype, rid):
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if entry.id != rtype:
            continue
        for res in entry.directory.entries:
            if res.id == rid:
                lang = res.directory.entries[0]
                return pe.get_memory_mapped_image()[
                    lang.data.struct.OffsetToData:
                    lang.data.struct.OffsetToData + lang.data.struct.Size]
    return None


def words(b, o, n):
    return struct.unpack_from(f'<{n}h', b, o)


def parse_compound(pe, bank):
    hdr = pe_res(pe, 0x1FA5, bank)
    directory = pe_res(pe, 0x1FA6, bank)
    if hdr is None or directory is None:
        return None
    nchannels = struct.unpack_from('<h', hdr, 0x0E)[0]
    channels = [pe_res(pe, 0x1FA4, bank + k) for k in range(nchannels)]
    nrec = struct.unpack_from('<h', directory, 0x0C)[0]
    frames = {}
    for i in range(nrec):
        o = 0x0E + i * 10
        fno, off, ch, dx, dy = struct.unpack_from('<5h', directory, o)
        script = channels[ch]
        l, t, r, b, nitems = struct.unpack_from('<5h', script, off)
        items = []
        for j in range(nitems):
            io = off + 0x0A + j * 14
            art_frame = struct.unpack_from('<h', script, io)[0]
            art_ch = struct.unpack_from('<b', script, io + 2)[0]
            il, it, ir, ib = struct.unpack_from('<4h', script, io + 6)
            items.append({'art': art_frame, 'artch': art_ch,
                          'rect': [il, it, ir, ib]})
        frames[fno] = {'rect': [l, t, r, b], 'ch': ch,
                       'dx': dx, 'dy': dy, 'items': items}
    # sequences = runs of consecutive frame numbers
    seqs = []
    for fno in sorted(frames):
        if seqs and fno == seqs[-1][-1] + 1:
            seqs[-1].append(fno)
        else:
            seqs.append([fno])
    return {'bank': bank, 'nchannels': nchannels,
            'sequences': [{'label': s[0], 'frames': s} for s in seqs],
            'frames': frames}


def main():
    module, bank = sys.argv[1], int(sys.argv[2])
    pe = pefile.PE(module)
    data = parse_compound(pe, bank)
    if data is None:
        print(f'bank {bank}: no compound resources')
        return
    print(f"bank {bank}: {data['nchannels']} channels, "
          f"{len(data['frames'])} frames, {len(data['sequences'])} sequences")
    for s in data['sequences'][:40]:
        f0 = data['frames'][s['label']]
        arts = {(it['artch'], ) for f in s['frames']
                for it in data['frames'][f]['items']}
        print(f"  seq @{s['label']:5} len={len(s['frames']):4} "
              f"link=({f0['dx']},{f0['dy']}) artchs={sorted(a[0] for a in arts)} "
              f"rect0={f0['rect']}")
    if len(sys.argv) > 3:
        with open(sys.argv[3], 'w') as f:
            json.dump(data, f)
        print('wrote', sys.argv[3])


if __name__ == '__main__':
    main()
