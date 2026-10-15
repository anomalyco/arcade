# Requests to knobs

Arcade uses knobs as it ships (vendored in `packages/knobs`, synced with `bun packages/knobs/scripts/sync.ts`) in its
default look. When something is missing or wrong, Arcade doesn't patch or restyle it: send it to Kit's knobs session
with a capture and list it here until a sync brings the fix.

| Sent | What | Status |
| --- | --- | --- |
| 2026-10-15 | A chromeless inline panel (`--k-chrome: 0`) still dimmed what was behind it (backdrop brightness), drawing a darker box inside the host's card | Fixed in 458501e, vendored |
| 2026-10-15 | `tree()`: an option to turn type-ahead off or choose its keys. The Lab's Outliner wants letters as workbench shortcuts, so it catches them in capture and re-sends them to `window` (`packages/kit/lab/outliner.ts`) | Open |
| 2026-10-15 | Default density, narrow inline panel: a menu row with a long label and a long value cuts both ("Look & threat by ho…" beside "Dynamic (…", 270 px row). The label should keep its width and only the value be cut. `prove-knobs.ts` records rows whose cut value gets under 40% of the row (`narrowValues`) instead of failing | Open |
