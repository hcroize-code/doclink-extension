#!/usr/bin/env bash
# Generates PNG icons from an inline SVG using Inkscape or rsvg-convert.
# Run once during development: ./icons/generate-icons.sh
# If neither tool is available, placeholder PNGs are created instead.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SVG_CONTENT='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="10" fill="#1a73e8"/>
  <text x="50%" y="55%" font-family="Google Sans,system-ui,sans-serif"
        font-size="28" font-weight="700" fill="white"
        text-anchor="middle" dominant-baseline="middle">D</text>
</svg>'

TMP_SVG="$SCRIPT_DIR/tmp_icon.svg"
echo "$SVG_CONTENT" > "$TMP_SVG"

for SIZE in 16 48 128; do
  OUT="$SCRIPT_DIR/icon${SIZE}.png"
  if command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w $SIZE -h $SIZE "$TMP_SVG" -o "$OUT"
  elif command -v inkscape &>/dev/null; then
    inkscape --export-png="$OUT" --export-width=$SIZE --export-height=$SIZE "$TMP_SVG" 2>/dev/null
  elif command -v convert &>/dev/null; then
    convert -background none -resize "${SIZE}x${SIZE}" "$TMP_SVG" "$OUT" 2>/dev/null
  else
    # Fallback: 1x1 transparent PNG
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "$OUT"
    echo "Warning: No SVG converter found. Placeholder created for icon${SIZE}.png"
  fi
  echo "Created icon${SIZE}.png"
done

rm -f "$TMP_SVG"
echo "Done."
