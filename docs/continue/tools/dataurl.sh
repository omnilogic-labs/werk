#!/bin/bash
# usage: dataurl.sh <image> [maxwidth] [targetkb]  -> writes <image>.webp and prints data URI to <image>.datauri.txt
set -euo pipefail
ART=/home/mike/Development/is4co/agent-skills/plugins/artistic-vision/skills/artistic-vision/bin/art
IN="$1"; MW="${2:-1400}"; TK="${3:-160}"
OUT="${IN%.*}.webp"
"$ART" optimize "$IN" "$OUT" --format webp --max-width "$MW" --target-size "$TK" >/dev/null 2>&1
B64=$(base64 -w0 "$OUT")
printf 'data:image/webp;base64,%s' "$B64" > "${IN%.*}.datauri.txt"
echo "$OUT $(stat -c%s "$OUT") bytes -> ${IN%.*}.datauri.txt ($(stat -c%s "${IN%.*}.datauri.txt") chars)"
