#!/usr/bin/env bash
# Assemble the static site GitHub Pages can serve: index.html, player.js, style.css
# and the assets/ tree side by side at the root. player.js resolves ASSETS
# relative to the page, so no path rewriting is needed — just copy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${1:-$ROOT/dist}"

rm -rf "$DIST"
mkdir -p "$DIST"
cp "$ROOT/web/index.html" "$ROOT/web/player.js" "$ROOT/web/style.css" "$ROOT/web/og-banner.png" "$DIST/"
cp -r "$ROOT/assets" "$DIST/assets"
# GitHub Pages runs Jekyll by default, which skips files/dirs it doesn't like;
# .nojekyll serves the tree verbatim.
touch "$DIST/.nojekyll"

echo "Built site → $DIST ($(du -sh "$DIST" | cut -f1))"
