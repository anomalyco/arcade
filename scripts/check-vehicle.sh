#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bun run check:packages
for game in getaway blackout; do
  (cd "games/$game" && bun run check && bunx --no-install wrangler deploy --dry-run && bun ../../scripts/smoke.mjs)
done
