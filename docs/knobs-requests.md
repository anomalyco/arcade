# Requests to knobs

Arcade uses knobs as it ships (vendored in `packages/knobs`, synced with `bun packages/knobs/scripts/sync.ts`) in its
default look. When something is missing or wrong, Arcade doesn't patch or restyle it: send it to Kit's knobs session
with a capture and list it here until a sync brings the fix.

| Sent | What | Status |
| --- | --- | --- |
| 2026-10-15 | A chromeless inline panel (`--k-chrome: 0`) still dimmed what was behind it (backdrop brightness), drawing a darker box inside the host's card | Fixed in 458501e, vendored |
| 2026-10-15 | `tree()`: an option to turn type-ahead off or choose its keys. The Lab's Outliner wants letters as workbench shortcuts, so it catches them in capture and re-sends them to `window` (`packages/kit/lab/outliner.ts`) | Fixed in 94862f3 (`typeahead: false`), vendored |
| 2026-10-15 | Default density, narrow inline panel: a menu row with a long label and a long value cuts both ("Look & threat by ho…" beside "Dynamic (…", 270 px row). The label should keep its width and only the value be cut. `prove-knobs.ts` records rows whose cut value gets under 40% of the row (`narrowValues`) instead of failing | Fixed in 94862f3 (the label keeps its words, squeezed segments become a menu); `prove-knobs.ts` now fails on any cut choice label |
| 2026-10-15 | A height-bounded inline panel (a Lab station's controls card): keep the header (title and buttons) pinned while rows scroll beneath it, with the page header's edge, instead of the whole panel scrolling. Until then the Lab lets the knobs header scroll away with its rows (crop: `~/code/home/artifacts/arcade/knobs-inline-scroll-under-head.png`, Arcade's old fixed title with rows cut flush under it) | Open |
