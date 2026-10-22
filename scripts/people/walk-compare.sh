#!/bin/sh
# Side-by-side walk clip on a render worker: procedural rig | mocap on the mesh | mocap reference (sticks).
# Usage: walk-compare.sh <out-dir> <cast-id> <reference label> [walk-compare.ts flags]   ->  <out-dir>/walk.mp4 and walk-sheet.png
OUT=$1; ID=$2; LABEL=$3; shift 3
rm -rf "$OUT"; mkdir -p "$OUT"
N=$(bun scripts/people/walk-compare.ts "$ID" "$OUT" "$@" | grep '^{' | sed -E 's/.*"frames":([0-9]+).*/\1/')
blender -b --factory-startup --python scripts/people/walk-render.py -- "$OUT" "$N" proc mocap ref 2>&1 | grep -E "WALK RENDERED|Error" | head -3
i=0
while [ $i -lt "$N" ]; do
  magick "$OUT/proc-$i.png" "$OUT/mocap-$i.png" "$OUT/ref-$i.png" +append -font /System/Library/Fonts/Helvetica.ttc \
    -fill white -pointsize 22 -gravity northwest -annotate +20+12 "procedural rig (before)" -annotate +540+12 "mocap gait (after)" \
    -annotate +1060+12 "$LABEL" "$OUT/sbs-$(printf %03d $i).png"
  i=$((i + 1))
done
# Three loops of the cycle, at its own rate (30 fps).
ffmpeg -y -loglevel error -stream_loop 2 -framerate 30 -i "$OUT/sbs-%03d.png" -c:v libx264 -pix_fmt yuv420p -crf 20 "$OUT/walk.mp4"
magick "$OUT"/sbs-000.png "$OUT"/sbs-007.png "$OUT"/sbs-014.png "$OUT"/sbs-021.png -append -resize 50% "$OUT/walk-sheet.jpg"
rm -f "$OUT"/*.obj
echo "WALK CLIP $OUT/walk.mp4 ($N frames)"
