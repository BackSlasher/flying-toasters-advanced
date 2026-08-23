#!/usr/bin/env python3
"""Decoder for After Dark 4.x RLID sprite resources (type-8000 'CSTM' RLE format).

Format recovered by disassembling adxpl510.dll (RLESequence class):
  - Container = sequential chunks. 16-byte chunk header, all fields big-endian:
      +0  tag      ('RLID' file header, 'IHDR' frame header, 'CSTM'/'BSTM' pixel
                    strips, 'CTAB' color table, 0x0AEDF8F8 sentinel)
      +4  param    (IHDR: low word = frame id;
                    CSTM: high byte = depth bitmask, low word = frame id;
                    CTAB: byte1/byte0 -> aux codes)
      +8  flags    (nonzero = last chunk)
      +C  size     (chunk size incl. header; next chunk at +size)
    payload at +0x10.
  - IHDR payload: +0 dword (BE), then 4 LE words: rect (t?, l?, b?, r?).
  - CSTM payload: row-oriented RLE stream, one stream of `height` rows.
    Opcode byte: low nibble = op, high nibble = H:
      0: row terminator, sub-dispatched on H (row-table builder @0x431d7b):
         H==1 end of row; H==0 end of sprite (last row only);
         H==3 row reference (next 2 bytes BE = 0-based row index to copy);
         H==2/H>=4 no-op (continue current row)
      1: skip H transparent px (H==0: count = next byte)
      2: run of ctab[H], count = next byte
      3: 1px ctab[H]      4: 2px ctab[H]      5: 3px ctab[H]
      6: run of ctab[next byte], count = H (H==0: count = byte after color)
      7: H==0: packed 4-bit literals (count = next byte, then nibble pairs)
         H==1: 8-bit literals (count = next byte, then count ctab indices)
      8: dither pair from one nibble-packed byte, count = H (H==0: next byte)
      9: dither pair from two color bytes, count = H (H==0: next byte)
      (low nibble A-F: ignored/padding)
"""
import struct
import sys

SENTINEL = 0x0AEDF8F8


def be32(b, o):
    return struct.unpack_from('>I', b, o)[0]


def chunks(data):
    """Yield (tag, param, flags, payload) for each chunk."""
    pos = 0
    while pos + 16 <= len(data):
        tag = data[pos:pos + 4]
        param = be32(data, pos + 4)
        flags = be32(data, pos + 8)
        size = be32(data, pos + 12) & 0xFFFF
        if size < 16:
            break
        yield tag, param, flags, data[pos + 16:pos + size]
        if flags != 0:
            break
        pos += size


def decode_rows(stream, expected_rows=None):
    """Decode a CSTM RLE stream into rows of (x_offset, [ctab indices...]) runs.

    Returns list of rows; each row is a list of (x, [indices]) visible runs.
    A stream may end mid-opcode past the last row (padding); reads are guarded.
    """
    rows = []
    row = []
    x = 0
    i = 0
    n = len(stream)

    def emit(indices):
        nonlocal x
        if indices:
            row.append((x, list(indices)))
            x += len(indices)

    try:
        while i < n:
            if expected_rows is not None and len(rows) >= expected_rows:
                break
            b = stream[i]; i += 1
            op, h = b & 0xF, b >> 4
            if op == 0:
                # op 0 is a row terminator sub-dispatched on the high nibble H
                # (row-table builder @0x431d7b in adxpl510.dll):
                #   H==1 -> end of row
                #   H==0 -> end of sprite (only valid on the last row)
                #   H==3 -> row reference: next 2 bytes (big-endian) are a 0-based
                #           row index; this row is a copy of that earlier row
                #   H==2 or H>=4 -> no-op, keep building the current row
                if h == 1:
                    rows.append(row)
                    row, x = [], 0
                elif h == 0:
                    rows.append(row)
                    row, x = [], 0
                    break
                elif h == 3:
                    ref = (stream[i] << 8) | stream[i + 1]; i += 2
                    src = rows[ref] if 0 <= ref < len(rows) else []
                    rows.append([(rx, list(px)) for rx, px in src])
                    row, x = [], 0
                continue
            if op > 9:
                continue
            if op == 1:
                cnt = h
                if not cnt:
                    cnt = stream[i]; i += 1
                x += cnt
            elif op == 2:
                cnt = stream[i]; i += 1
                emit([h] * cnt)
            elif op in (3, 4, 5):
                emit([h] * (op - 2))
            elif op == 6:
                c = stream[i]; i += 1
                cnt = h
                if not cnt:
                    cnt = stream[i]; i += 1
                emit([c] * cnt)
            elif op == 7:
                if h == 0:
                    cnt = stream[i]; i += 1
                    px = []
                    while cnt >= 2:
                        v = stream[i]; i += 1
                        px += [v >> 4, v & 0xF]
                        cnt -= 2
                    if cnt == 1:
                        px.append(stream[i] >> 4); i += 1
                    emit(px)
                elif h == 1:
                    cnt = stream[i]; i += 1
                    if i + cnt > n:
                        raise IndexError
                    emit(stream[i:i + cnt]); i += cnt
                # h >= 2: nothing
            elif op == 8:
                cnt = h
                if not cnt:
                    cnt = stream[i]; i += 1
                v = stream[i]; i += 1
                c1, c2 = v >> 4, v & 0xF
                px = [c1, c2] * (cnt // 2)
                if cnt & 1:
                    px.append(c1)
                emit(px)
            elif op == 9:
                cnt = h
                if not cnt:
                    cnt = stream[i]; i += 1
                c1 = stream[i]; i += 1
                c2 = stream[i]; i += 1
                px = [c1, c2] * (cnt // 2)
                if cnt & 1:
                    px.append(c1)
                emit(px)
    except IndexError:
        pass
    if row:
        rows.append(row)
    return rows


class Bank:
    """Parsed RLID resource: frames (id -> rect + rle stream) and color tables."""

    def __init__(self, data):
        self.header = None
        self.frames = {}      # id -> dict(rect=(a,b,c,d), strips=[(depthmask, bytes)])
        self.ctabs = []       # list of (aux1, aux2, payload)
        for tag, param, flags, payload in chunks(data):
            if tag == b'RLID':
                self.header = (be32(payload, 0), be32(payload, 8))
            elif tag == b'IHDR':
                fid = param & 0xFFFF
                head = be32(payload, 0)
                rect = struct.unpack_from('>4h', payload, 4)  # (t, l, b, r), big-endian
                self.frames.setdefault(fid, {'strips': []})
                self.frames[fid].update(head=head, rect=rect)
            elif tag in (b'CSTM', b'BSTM'):
                fid = param & 0xFFFF
                depthmask = param >> 24
                self.frames.setdefault(fid, {'strips': []})
                self.frames[fid]['strips'].append((depthmask, tag, payload))
            elif tag == b'CTAB':
                self.ctabs.append(((param >> 8) & 0xFF, param & 0xFF, payload))


def main(path):
    data = open(path, 'rb').read()
    bank = Bank(data)
    print(f'{path}: header={bank.header}')
    print(f'  {len(bank.frames)} frames, {len(bank.ctabs)} ctabs')
    for aux1, aux2, payload in bank.ctabs:
        print(f'  CTAB aux=({aux1},{aux2}) len={len(payload)} '
              f'head={payload[:24].hex(" ")}')
    for fid, fr in sorted(bank.frames.items()):
        rect = fr.get('rect')
        strips = ', '.join(f'{t.decode()}:{d:02x}:{len(p)}' for d, t, p in fr['strips'])
        line = f'  frame {fid}: rect={rect} strips=[{strips}]'
        if rect and fr['strips']:
            rows = decode_rows(fr['strips'][0][2])
            widths = [max((x + len(px) for x, px in r), default=0) for r in rows]
            line += f' -> decoded {len(rows)} rows, max width {max(widths, default=0)}'
        print(line)


if __name__ == '__main__':
    main(sys.argv[1])
