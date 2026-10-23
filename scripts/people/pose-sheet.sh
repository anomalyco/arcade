#!/bin/sh
# Posed close-ups on a render worker: bun pose-obj then Blender pose-render. Usage: pose-sheet.sh <out> <id> <frames> <look> <size> <view> [pose-obj flags]
OUT=$1; ID=$2; FR=$3; LOOK=$4; SIZE=$5; VIEW=$6; shift 6
TAG=""; case " $* " in *" --tag "*) TAG=$(echo " $* " | sed -E 's/.* --tag ([^ ]+) .*/\1/');; esac
bun scripts/people/pose-obj.ts $ID $OUT --frames $FR "$@" > /dev/null
for f in $(echo $FR | tr , ' '); do
  blender -b --factory-startup --python scripts/people/pose-render.py -- $OUT/$ID-$f$TAG-$VIEW $OUT/$ID-$f$TAG.obj --look $LOOK --size $SIZE --view $VIEW 2>&1 | grep -E "RENDERED|Error" | head -2
done
