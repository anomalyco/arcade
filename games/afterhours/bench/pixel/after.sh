#!/bin/zsh
# "After" build for A/B: the base snapshot plus only this task's files (bench/pixel/mine.txt), so other agents' work
# in the tree since the snapshot doesn't leak into the comparison.
#   bench/pixel/after.sh <base snapshot> <after snapshot> <out dir> [<base out dir>: reuse its static assets]
set -e
GAME=${0:A:h:h:h}
rm -rf $2
rsync -a $1/ $2/
for f in $(cat $GAME/bench/pixel/mine.txt); do mkdir -p $2/${f:h}; cp $GAME/$f $2/$f; done
cp $GAME/bench/pixel/capture.ts $GAME/bench/pixel/capture.html $2/
cd $2
bunx vite build --outDir $3 --minify false --sourcemap --logLevel error
bunx vite build -c pixel.vite.config.ts --outDir $3-pixel --logLevel error
# Same static assets as the base build (public/ may have changed in the tree since): base output + after's code.
if [ -n "$4" ]; then
  for pair in "$3:$4" "$3-pixel:$4-pixel"; do
    A=${pair%%:*}; B=${pair#*:}
    rsync -a --delete --exclude assets --exclude '*.html' $B/ $A/
  done
fi
