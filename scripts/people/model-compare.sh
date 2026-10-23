#!/bin/sh
# Model assessment on a render worker: fetches Rocketbox avatars (MIT) into a scratch dir, renders them beside a cast
# member with scripts/people/model-compare.py (one run per figure), deletes the downloads. Usage: model-compare.sh <out-prefix> <cast-id> <avatar path>...
#   e.g. model-compare.sh captures/people/models/cmp a-woods Adults/Male_Adult_05 Adults/Male_Adult_18
OUT=$1; ID=$2; shift 2
TMP=$(mktemp -d)
RAW=https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/Avatars
LFS=https://media.githubusercontent.com/media/microsoft/Microsoft-Rocketbox/master/Assets/Avatars
DIRS=""
for a in "$@"; do
  n=$(basename "$a"); d="$TMP/$n"; mkdir -p "$d/Export" "$d/Textures"
  curl -sfL "$LFS/$a/Export/$n.fbx" -o "$d/Export/$n.fbx" || curl -sfL "$RAW/$a/Export/$n.fbx" -o "$d/Export/$n.fbx"
  for t in $(gh api "repos/microsoft/Microsoft-Rocketbox/contents/Assets/Avatars/$a/Textures" --jq '.[].name' 2>/dev/null || curl -s "https://api.github.com/repos/microsoft/Microsoft-Rocketbox/contents/Assets/Avatars/$a/Textures" | grep '"name"' | sed -E 's/.*"name": "([^"]+)".*/\1/'); do
    curl -sfL "$LFS/$a/Textures/$t" -o "$d/Textures/$t" || curl -sfL "$RAW/$a/Textures/$t" -o "$d/Textures/$t"
  done
  DIRS="$DIRS $d"
done
mkdir -p "$(dirname "$OUT")"
blender -b --factory-startup --python scripts/people/model-compare.py -- "$OUT-ours" "packages/kit/people/assets/$ID.glb" 2>&1 | grep -E "COMPARED|rror" | head -3
for d in $DIRS; do
  blender -b --factory-startup --python scripts/people/model-compare.py -- "$OUT-$(basename "$d")" "$d" 2>&1 | grep -E "COMPARED|rror" | head -3
done
du -sh "$TMP"
rm -rf "$TMP"
