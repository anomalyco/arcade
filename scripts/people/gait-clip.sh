#!/bin/sh
# The gait hand-over clip on a render worker: gait-clip.ts frames, Blender (three-quarter view, pelvis-relative),
# ffmpeg. Usage: gait-clip.sh <out-dir> <cast-id>   ->  <out-dir>/gait.mp4 and gait-sheet.jpg
OUT=$1; ID=$2
rm -rf "$OUT"; mkdir -p "$OUT"
N=$(bun scripts/people/gait-clip.ts "$ID" "$OUT" | grep '^{' | tee "$OUT/gait.json" | sed -E 's/.*"frames":([0-9]+).*/\1/')
blender -b --factory-startup --python scripts/people/walk-render.py -- "$OUT" "$N" gait --view three 2>&1 | grep -E "WALK RENDERED|Error" | head -3
ffmpeg -y -loglevel error -framerate 30 -i "$OUT/gait-%d.png" -c:v libx264 -pix_fmt yuv420p -crf 21 -movflags +faststart "$OUT/gait.mp4"
magick "$OUT/gait-15.png" "$OUT/gait-45.png" "$OUT/gait-70.png" "$OUT/gait-100.png" "$OUT/gait-150.png" "$OUT/gait-195.png" "$OUT/gait-240.png" "$OUT/gait-280.png" +append -resize 50% "$OUT/gait-sheet.jpg"
rm -f "$OUT"/*.obj "$OUT"/*.png
echo "GAIT CLIP $OUT/gait.mp4 ($N frames)"
