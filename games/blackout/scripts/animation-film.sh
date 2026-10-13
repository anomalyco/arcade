#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)/captures/blackout-anim"
ffmpeg -hide_banner -loglevel warning -y -filter_complex_threads 1 \
  -framerate 30 -i "$root/game-old/%04d.png" \
  -framerate 30 -i "$root/game-new/%04d.png" \
  -framerate 30 -i "$root/close-old/%04d.png" \
  -framerate 30 -i "$root/close-new/%04d.png" \
  -filter_complex '[0:v][1:v]vstack=inputs=2[g];[2:v][3:v]vstack=inputs=2[c];[g][c]concat=n=2:v=1:a=0[out]' \
  -map '[out]' -an -c:v h264_videotoolbox -profile:v high -q:v 75 -b:v 16M \
  -pix_fmt yuv420p -movflags +faststart "$root/blackout-anim.mp4"
