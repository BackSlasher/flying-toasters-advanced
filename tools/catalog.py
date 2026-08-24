#!/usr/bin/env python3
"""Generate catalog.html — a small reference page of every squadron member and
gag scenario, built from the extracted data at build time.

Sources: assets/gags.json (choreography/cfg), assets/compound_22000.json +
assets/sprites/banks.json (label -> thumbnail sprite), web/player.js (the
debug-menu display names, parsed so they stay in sync).

Usage: catalog.py OUTPUT_HTML [ASSETS_PREFIX]

FUTURE IMPROVEMENTS (agreed 2026-08-24):
 - better highlight frames: some picks are not the gag's most indicative pose
   (the hold/template heuristic misses gags whose signature moment is mid-chain;
   consider a hand-curated per-scenario frame override map, or animated thumbs
   that play the highlight sequence on hover)
 - descriptive names + a one-line description per gag (the debug-menu names are
   terse working labels; write proper prose per scenario)
 - per-gag deep link into the repo for the curious: point each row at the
   scenario's ground truth (its handler RVA in RE-ENGINE.md / the gags.json
   entry / the gagmap extraction), e.g. a GitHub link to the exact lines
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'catalog.html')
PREFIX = sys.argv[2] if len(sys.argv) > 2 else 'assets'

gags = json.load(open(os.path.join(ROOT, 'assets', 'gags.json')))
comp = json.load(open(os.path.join(ROOT, 'assets', 'compound_22000.json')))
banks = json.load(open(os.path.join(ROOT, 'assets', 'sprites', 'banks.json')))
player = open(os.path.join(ROOT, 'web', 'player.js')).read()

# ---- names from the debug menu (kept in sync with the UI) ----
names = {}
for m in re.finditer(r"\['([^']+?)\s*\((\d+)\)',\s*\{\s*g:\s*(\d+)", player):
    names[m.group(3)] = m.group(1)

# ---- label -> thumbnail path (main banks only: karaoke banks >= 22100 reuse
# the same art-id space and would shadow the sprites) ----
art_file = {}
for bank, meta in banks.items():
    if int(bank) >= 22100:
        continue
    for fid in meta.get('frames', {}):
        art_file[int(fid)] = f'{PREFIX}/sprites/{bank}/f{int(fid):03d}.png'

frames = comp['frames']
seq_of = {}
for s in comp['sequences']:
    for f in s['frames']:
        seq_of[f] = s['frames']


def thumb(label):
    """First drawable art of the label's sequence (art id -> file id-1)."""
    for fn in seq_of.get(label, [label]):
        fr = frames.get(str(fn))
        if not fr:
            continue
        for it in fr['items']:
            p = art_file.get(it['art'] - 1)
            if p:
                return p
    return None


def first_real(chain):
    for l in chain:
        if l not in (3, 93):
            return l
    return chain[0] if chain else None


def last_real(chain):
    for l in reversed(chain):
        if l not in (3, 93, 983):
            return l
    return None


def mid_frame(label):
    """Middle frame of the label's sequence — the pose in full swing."""
    q = seq_of.get(label, [label])
    return q[len(q) // 2]


def max_items_frame(label):
    """The sequence's most-populated frame (formed wedge, full card)."""
    best, n = label, -1
    for fn in seq_of.get(label, [label]):
        fr = frames.get(str(fn))
        if fr and len(fr['items']) > n:
            best, n = fn, len(fr['items'])
    return best


def highlight(e, scen):
    """Pick the gag's most representative frame: the held transform mid-pose
    (burning, bagel-eyes, police...), else the formed template frame (the
    wedge AS a wedge), else the last real sequence's mid-pose."""
    chans = e.get('chans', {})
    hold = e.get('hold') or {}
    for ch in ('main', 'sub1', 'sub2', 'sub3'):
        if ch in hold and ch in chans:
            lab = last_real(chans[ch])
            if lab:
                return mid_frame(lab)
    if e.get('template'):
        return max_items_frame(e['template'])
    lab = last_real(chans.get('main', [])) or \
        next((last_real(v) for v in chans.values() if last_real(v)), None)
    if lab:
        return mid_frame(lab)
    return mid_frame(int(scen))


def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;')


# ---- squadron section (flight kinds + acts, extracted distributions) ----
# kinds 1 and 2 share the SAME toaster body (seq 93's arts are a subset of
# seq 3's) — they differ by flight pattern and act repertoire, not livery
SQUADRON = [
    ('Adult toaster, flight family A (kind 1)', 3,
     'Flight seq 3. Acts per flight loop (RandShort(35) @0x419dd4): wing-loop '
     '33 10/35, dive-loop 602 10/35, edge maneuvers 133/172/209 1/35 each. '
     'Edge-blocked flight cascades 133 -> 172 -> 209.'),
    ('Adult toaster, flight family B (kind 2)', 93,
     'Flight seq 93 — same body as kind 1, different behavior. Acts per flight '
     'loop (RandShort(30) @0x419e34): act-loop 638 10/30, edge maneuvers '
     '231/252 2/30 each. Edge cascade 252 -> 231.'),
    ('Baby toaster (kind 3)', 983,
     'Flight seq 983. Specials per flight loop (RandShort(80) @0x419f14): '
     '988 / 1014 / 1009 / 1019 at 1/80 each. Edge cascade 1009 -> 1014.'),
]

# food tables parsed straight from player.js so they stay in sync
def _rolls(name):
    m = re.search(name + r' = \[([0-9, ]+)\]', player)
    return sorted(set(int(x) for x in m.group(1).split(','))) if m else []

FOODS = [('Adult food', _rolls('FOOD_ROLLS')),
         ('Baby food', _rolls('BABYFOOD_ROLLS'))]

rows = []
for scen in sorted(gags, key=int):
    e = gags[scen]
    cfg = e.get('cfg', {})
    chans = e.get('chans', {})
    hf = highlight(e, scen)
    img = f'<canvas class="fr" data-frame="{hf}" width="90" height="70"></canvas>'
    name = names.get(scen, '')
    chain_txt = '<br>'.join(
        f'<b>{esc(k)}</b>: {" &rarr; ".join(str(x) for x in v)}'
        for k, v in chans.items())
    extras = []
    if e.get('hold'):
        extras.append('holds: ' + ', '.join(k for k in e['hold']))
    if e.get('template'):
        extras.append(f'template {e["template"]}')
    if e.get('props'):
        extras.append('props: ' + ', '.join(map(str, e['props'])))
    if e.get('repeat'):
        for r in e['repeat']:
            extras.append(f'repeat {r["label"]}&times;{{{",".join(map(str, r["counts"]))}}}')
    if e.get('slots'):
        extras.append('slots: ' + ', '.join(f'{k}&rarr;{v}' for k, v in e['slots'].items()))
    cfg_txt = ', '.join(f'{k}={v}' for k, v in cfg.items())
    rows.append(f'''<tr>
  <td class="th">{img}</td>
  <td><b>{esc(scen)}</b><br><span class="nm">{esc(name)}</span></td>
  <td class="ch">{chain_txt}</td>
  <td class="xx">{"<br>".join(extras)}</td>
  <td class="cf">{esc(cfg_txt)}</td>
</tr>''')

sq_rows = []
for title, flight, desc in SQUADRON:
    img = (f'<canvas class="fr" data-frame="{mid_frame(flight)}" '
           f'width="90" height="70"></canvas>')
    sq_rows.append(f'<tr><td class="th">{img}</td><td><b>{esc(title)}</b>'
                   f'<br>flight seq {flight}</td><td colspan=3>{desc}</td></tr>')
for title, labels in FOODS:
    cells = ' '.join(f'<img src="{thumb(l)}" alt="{l}" title="{l}" loading="lazy">'
                     for l in labels if thumb(l))
    sq_rows.append(f'<tr><td class="th"></td><td><b>{esc(title)}</b></td>'
                   f'<td colspan=3>{cells}</td></tr>')

html = f'''<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flying Toasters — squadron &amp; gag catalog</title>
<style>
  body {{ background:#0b0b10; color:#ccc; font:14px/1.45 system-ui, sans-serif;
         max-width: 980px; margin: 2em auto; padding: 0 1em; }}
  h1 {{ font-size: 20px; color:#eee; }} h2 {{ font-size:16px; color:#ddd; margin-top:2em; }}
  table {{ border-collapse: collapse; width: 100%; }}
  td {{ border-top: 1px solid #26262e; padding: 6px 8px; vertical-align: top; }}
  td.th {{ width: 96px; text-align:center; }} td.th img {{ max-width:90px; max-height:70px; }}
  canvas.fr {{ image-rendering: auto; }}
  .nm {{ color:#8a8; }} .ch {{ font-family: ui-monospace, monospace; font-size:12px; color:#aac; }}
  .xx {{ font-size:12px; color:#ca8; }} .cf {{ font-size:12px; color:#888; white-space:nowrap; }}
  p.note {{ color:#777; font-size:12px; }}
</style>
<h1>Flying Toasters! — squadron &amp; gag catalog</h1>
<p class="note">Generated at build time from the reverse-engineered choreography
data (assets/gags.json). Chains are sequence labels in engine execution order;
3/93/983 are the plain-flight loops.</p>
<h2>The squadron</h2>
<table>{''.join(sq_rows)}</table>
<h2>Gag scenarios ({len(rows)})</h2>
<table>
<tr><td class="th"></td><td>scenario</td><td>channel chains</td><td>behavior</td><td>config</td></tr>
{''.join(rows)}
</table>
<script>
// Composite each thumbnail from its HIGHLIGHT frame (all items of the frame,
// scaled to fit) using the same compound + banks data the player uses.
(async () => {{
  const [comp, banks] = await Promise.all([
    fetch('{PREFIX}/compound_22000.json').then(r => r.json()),
    fetch('{PREFIX}/sprites/banks.json').then(r => r.json()),
  ]);
  const artURL = {{}};
  for (const [bank, meta] of Object.entries(banks)) {{
    if (+bank >= 22100) continue;               // karaoke banks shadow art ids
    for (const fid of Object.keys(meta.frames))
      artURL[+fid] = `{PREFIX}/sprites/${{bank}}/f${{String(fid).padStart(3, '0')}}.png`;
  }}
  const imgCache = {{}};
  const load = src => imgCache[src] || (imgCache[src] = new Promise(res => {{
    const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null);
    im.src = src;
  }}));
  for (const cv of document.querySelectorAll('canvas.fr')) {{
    const fr = comp.frames[cv.dataset.frame];
    if (!fr) continue;
    const [l, t, r, b] = fr.rect, w = r - l, h = b - t;
    const s = Math.min(cv.width / w, cv.height / h, 1.4);
    const ox = (cv.width - w * s) / 2, oy = (cv.height - h * s) / 2;
    const g = cv.getContext('2d');
    for (const it of fr.items) {{
      const src = artURL[it.art - 1];             // art ids are 1-based
      if (!src) continue;
      const im = await load(src);
      if (im) g.drawImage(im, ox + (it.rect[0] - l) * s, oy + (it.rect[1] - t) * s,
                          im.width * s, im.height * s);
    }}
  }}
}})();
</script>
'''
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write(html)
print(f'catalog: {OUT} ({len(rows)} gags, {len(names)} names)')
