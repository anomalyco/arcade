# Shared FX proof

The Getaway tyre port is pixel-identical at the seeded drift frame. Blackout's new post-frag volume fills the
office room at (21, 35.8), follows its doorway and stops at the wall rectangles. The shared playground renders
all eight presets and all five debug modes on Apple's `metal-3` adapter without browser or GPU validation errors.
The visual result still needs Kit's playtest; this is a bounded CS2-inspired approximation.

## GPU cost

At 960×640, the final Blackout smoke volume added **0.947 ms median**, with **0.016 ms MAD** across nine alternating
pairs. Pair deltas ranged from 0.872 to 0.979 ms on the shared M5 Max. This is one room, not a budget for other
views or several active clouds. `fx-kit.json` retains all raw samples. `fx-kit-pre-cover.json` retains the earlier
all-rectangles-sealed version (0.657 ms median, 0.299 ms MAD); it incorrectly sealed low wrecks, preventing them
from emitting. The final version excludes low cover from the sealed grid and has a separate downtown wreck proof.

The timer covers the first polar compute start through a dependent load/store after the final composite.
The final target is an equal-size, equal-format offscreen texture, excluding presentation fences. Each member
contains eight frozen frames; one complete warmup pair is discarded. The legacy soot sprites remain suppressed
on both sides and only the volume renderer is toggled. No pass times are summed. Both sides retain readable
MSAA depth, so the delta measures the volume passes, not the cost of changing depth storage from the historical
renderer's discard mode. The screenshot comparison independently switches legacy sprites versus the new volume.

## Evidence

- `captures/fx-kit/blackout-{old,new}.png`: same frag and 1.6-second pose, with the real Lab checkbox switched.
- `captures/fx-kit/blackout-wreck.png`: a sustained downtown wreck plume, 85 occupied cells at the inspected pose.
- `captures/fx-kit/playground-*.png`: all presets, density, optical depth, lighting and bounds.
- `captures/fx-kit/getaway-{before,after}.png`: seed 7, style 6, drift frame 64, zero pixel difference.
- `captures/fx-kit/proof.json`: browser errors, adapter, room, matching tyre poses and raw paired intervals.
- `games/getaway/scripts/prove-fx-playwright.ts`: bounded headless harness using Metal and muted audio.

`bun run check` passed in both games: 133 Getaway tests, 12 existing skips, and 258 Blackout tests, plus each
game's client/server/script typechecks and production build. Four new tests cover sealed walls and doors,
carve/refill/expiry, frame-rate-independent emission, pool limits and bouncing sparks.
