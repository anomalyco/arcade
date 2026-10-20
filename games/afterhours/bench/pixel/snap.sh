#!/bin/zsh
# Snapshot games/afterhours (src, html, configs; public symlinked) into $1 and build the play page (unminified, with
# source maps) into $2 and the pixel-capture page into $2-pixel.
#   bench/pixel/snap.sh <snapshot dir> <out dir>
set -e
GAME=${0:A:h:h:h}
SNAP=$1
OUT=$2
rm -rf $SNAP && mkdir -p $SNAP
rsync -a --exclude node_modules --exclude public --exclude captures --exclude dist --exclude bench --exclude concept --exclude scripts $GAME/ $SNAP/ || true
ln -s $GAME/public $SNAP/public
ln -s ${GAME:h:h}/node_modules $SNAP/node_modules
cp $GAME/bench/pixel/capture.html $GAME/bench/pixel/capture.ts $SNAP/
cp $GAME/bench/pixel/vite.config.ts $SNAP/pixel.vite.config.ts
cd $SNAP
bunx vite build --outDir $OUT --minify false --sourcemap --logLevel error
bunx vite build -c pixel.vite.config.ts --outDir $OUT-pixel --logLevel error
