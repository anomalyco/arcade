#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Hivemind's cached base can contain other worktrees' untracked files. Stage only
# the source manifest produced on the originating checkout before checking.
if [ -f vehicle-check-files.txt ]; then
  clean=$(mktemp -d)
  trap 'rm -rf "$clean"' EXIT
  tar -cf - -T vehicle-check-files.txt | tar -xf - -C "$clean"
  cd "$clean"
fi
for game in getaway blackout; do
  (cd "games/$game" && bun install --frozen-lockfile && bun run check)
done
