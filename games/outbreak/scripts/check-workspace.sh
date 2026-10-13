#!/bin/sh
set -eu
# Run from the repository root, including from a clean archive export.
bun install --frozen-lockfile
bun run check:packages
for game in outbreak getaway blackout; do
  bun run --cwd "games/$game" check
  (cd "games/$game" && bunx --no-install wrangler deploy --dry-run)
  (cd "games/$game" && bun ../../scripts/smoke.mjs)
done
