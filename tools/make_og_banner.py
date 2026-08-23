#!/usr/bin/env python3
"""Generate web/og-banner.png — the 1200x630 OpenGraph share image.

Composes the real After Dark toaster sprites over a starfield, so the
link preview on WhatsApp/Facebook/Slack/etc. looks like the actual site.
Deterministic (seeded RNG); rerun after art changes: python3 tools/make_og_banner.py
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SPRITES = ROOT / "assets" / "sprites"
OUT = ROOT / "web" / "og-banner.png"

W, H = 1200, 630
FONT = "/usr/share/fonts/liberation/LiberationSans-Bold.ttf"

img = Image.new("RGB", (W, H), (0, 0, 8))
draw = ImageDraw.Draw(img)

# Starfield — same flavor as the player's background.
rng = random.Random(42)
for _ in range(220):
    x, y = rng.randrange(W), rng.randrange(H)
    b = rng.randrange(70, 230)
    if rng.random() < 0.12:
        draw.rectangle((x - 1, y - 1, x + 1, y + 1), fill=(b, b, b))
    else:
        draw.point((x, y), fill=(b, b, b))

def sprite(sid: str, frame: str) -> Image.Image:
    return Image.open(SPRITES / sid / f"{frame}.png").convert("RGBA")

def paste(im: Image.Image, scale: int, cx: int, cy: int) -> None:
    im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    img.paste(im, (cx - im.width // 2, cy - im.height // 2), im)

# A flight of toasters heading down-left, different flap frames for life.
paste(sprite("22000", "f006"), 3, 1100, 90)    # far, high
paste(sprite("22000", "f003"), 4, 660, 120)    # mid, top-center
paste(sprite("22000", "f000"), 6, 890, 330)    # hero toaster, wings up
paste(sprite("22022", "f340"), 4, 1060, 540)   # golden toast drifting along
paste(sprite("22022", "f340"), 2, 690, 560)    # smaller toast trailing behind
paste(sprite("22000", "f006"), 2, 170, 90)     # tiny one over the title

# Title block.
title = ImageFont.truetype(FONT, 96)
sub = ImageFont.truetype(FONT, 34)
tx, ty = 64, 250
for dx, dy in ((3, 3), (0, 0)):
    color = (40, 40, 60) if (dx, dy) == (3, 3) else (255, 244, 214)
    draw.text((tx + dx, ty + dy), "Flying Toasters!", font=title, fill=color)
draw.text((tx + 4, ty + 118), "The classic After Dark screensaver,",
          font=sub, fill=(168, 178, 210))
draw.text((tx + 4, ty + 162), "flapping in your browser.",
          font=sub, fill=(168, 178, 210))

img.save(OUT, optimize=True)
print(f"{OUT} {img.size} {OUT.stat().st_size / 1024:.0f}KB")
