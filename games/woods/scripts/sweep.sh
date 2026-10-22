#!/bin/sh
# Look sweep: one capture per look string (name=looks), same shots. Run after a build, through HiveMind.
out=$1; shots=$2; shift 2
for spec in "$@"; do
  name=${spec%%=*}; look=${spec#*=}
  bun scripts/capture.ts --out "$out" --shots "$shots" --look "$look" --tag "-$name" | grep -v "^\w* {"
done
