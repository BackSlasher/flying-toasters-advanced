#!/usr/bin/env python3
"""Render all RLID sprite banks from an After Dark module to transparent PNGs.

Usage: render.py <module.ad> <outdir> [bankid ...]
Writes <outdir>/<bankid>/f<NNN>.png plus <outdir>/<bankid>/sheet.png contact
sheet and <outdir>/banks.json with frame metadata.
"""
import json
import os
import struct
import sys

sys.path.insert(0, '/tmp/claude-1006/-home-isolationist-projects-afterdark-cc/e0face91-39d5-472e-a33a-aa0a1c653413/scratchpad/pylibs')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pefile
from PIL import Image

from rlid import Bank, decode_rows

RT_SPRITE = 8000


def pe_resources(path, rtype):
    """Return {resource_id: bytes} for a numeric resource type."""
    pe = pefile.PE(path)
    out = {}
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if entry.id != rtype:
            continue
        for res in entry.directory.entries:
            lang = res.directory.entries[0]
            rva = lang.data.struct.OffsetToData
            size = lang.data.struct.Size
            out[res.id] = pe.get_memory_mapped_image()[rva:rva + size]
    return out


def ctab_colors(payload):
    """CTAB payload = N quads of (aux, r, g, b)."""
    return [tuple(payload[i + 1:i + 4]) for i in range(0, len(payload), 4)]


def render_frame(fr, colors):
    top, left, bottom, right = fr['rect']
    w, h = right - left, bottom - top
    img = Image.new('RGBA', (max(w, 1), max(h, 1)), (0, 0, 0, 0))
    px = img.load()
    depthmask, tag, payload = fr['strips'][0]
    rows = decode_rows(payload, expected_rows=h)
    for y, row in enumerate(rows[:h]):
        for x0, indices in row:
            for dx, ci in enumerate(indices):
                if x0 + dx < w and ci < len(colors):
                    px[x0 + dx, y] = (*colors[ci], 255)
    return img


def contact_sheet(images, cols=None, scale=1, bg=(32, 32, 48, 255)):
    if not images:
        return None
    cols = cols or min(len(images), 12)
    rows = (len(images) + cols - 1) // cols
    cw = max(im.width for im in images) + 2
    ch = max(im.height for im in images) + 2
    sheet = Image.new('RGBA', (cols * cw, rows * ch), bg)
    for i, im in enumerate(images):
        sheet.paste(im, ((i % cols) * cw + 1, (i // cols) * ch + 1), im)
    if scale > 1:
        sheet = sheet.resize((sheet.width * scale, sheet.height * scale),
                             Image.NEAREST)
    return sheet


def main():
    module, outdir = sys.argv[1], sys.argv[2]
    only = {int(a) for a in sys.argv[3:]} or None
    resources = pe_resources(module, RT_SPRITE)
    meta = {}
    for rid, data in sorted(resources.items()):
        if only and rid not in only:
            continue
        bank = Bank(data)
        bdir = os.path.join(outdir, str(rid))
        os.makedirs(bdir, exist_ok=True)
        colors = ctab_colors(bank.ctabs[0][2]) if bank.ctabs else []
        images, frames_meta = [], {}
        for fid, fr in sorted(bank.frames.items()):
            if 'rect' not in fr or not fr['strips']:
                continue
            img = render_frame(fr, colors)
            img.save(os.path.join(bdir, f'f{fid:03}.png'))
            images.append(img)
            t, l, b, r = fr['rect']
            frames_meta[fid] = {'rect': [t, l, b, r], 'w': r - l, 'h': b - t}
        sheet = contact_sheet(images)
        if sheet:
            sheet.save(os.path.join(bdir, 'sheet.png'))
        meta[rid] = {'frames': frames_meta, 'nctabs': len(bank.ctabs),
                     'ctab_aux': [c[:2] for c in bank.ctabs]}
        print(f'bank {rid}: {len(images)} frames -> {bdir}')
    with open(os.path.join(outdir, 'banks.json'), 'w') as f:
        json.dump(meta, f, indent=1)


if __name__ == '__main__':
    main()
