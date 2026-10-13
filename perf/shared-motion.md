# Shared motion — integrated main

M5 Max, Chromium WebGPU / Metal, 2560×1440. Timings span first shadow/polar work through a dependent offscreen
final-composite marker; no pass sums. HUDs are DOM-rendered after the canvas.

| Host / fixture | Median delta | MAD | Default |
| --- | ---: | ---: | --- |
| Getaway nitro drift | +0.233 ms | 0.002 ms | On, strength .65 / shutter .5 |
| Blackout office | +0.229 ms | 0.004 ms | Off, strength 1 / shutter 1 |
| Blackout downtown | +0.813 ms | 0.212 ms | Off, strength 1 / shutter 1 |

The 0.5 ms target is met in the Getaway and office fixtures, not downtown. The full-resolution four-sample velocity
MRT has a larger bandwidth cost there. Earlier short Getaway samples were noisy under concurrent work; the final
run uses four settling frames per member and 32 measured frames, nine alternating pairs plus a warmup pair.
Blackout replays the same 48 camera/instance poses for each member, discards 24 warmups and takes a median of 24.

Both adapters use the shared eight-tap depth-aware gather and stable history helpers. Getaway uses half-resolution
camera reprojection with instance/particle overrides; Blackout gathers in the existing composite. No tile-max or
colour-history feedback. Thin silhouettes and overlapping transparent layers have conservative motion coverage.
Tyre smoke inherits camera motion; sparks and Blackout transient geometry have persistent object histories.

Checks: identity/reorder/missing-frame/teleport tests; fast tracer emission-point history; live Blackout move/fire;
Getaway moving frame changes and reset frame byte-identical on/off. The isolated tyre extraction is byte-identical
to main `bf5f627` in the matched seeded drift capture. The grenade volume fills 123 cells with its default on.

- `getaway-motion.json`: raw paired GPU intervals and matching poses.
- `blackout-shared-motion.json`: raw paired GPU intervals, two environments.
- `fx-integration.json`: tyre parity, grenade volume and live Blackout motion.
- `media/getaway-motion.jpg`: matched nitro-drift off/on.

Commands: `bun games/getaway/scripts/prove-motion-blur.ts`,
`bun games/blackout/scripts/prove-shared-motion.ts`, `bun games/getaway/scripts/prove-fx-integration.ts`.
