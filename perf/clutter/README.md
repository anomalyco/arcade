# Getaway street clutter

Seed 7 places 1,281 props in 17 kinds. They use a separate random stream, so adding clutter does not change the city or
authoritative simulation. Cars hit props through their rendered position, heading, dimensions and velocity. The car
view is never modified. The three Lab controls are Street clutter, Explosions and Physics debug.

`src/game/props/physics.ts` uses 120 Hz substeps, a persistent spatial hash and an awake set. Ground support comes from
rotated boxes or authored convex/compound points; body pairs use rounded proxies and static city boxes stop pieces at walls. This is a decorative solver,
not a precision stacking or joint solver. The measured cost fits the main thread, so this version adds neither a worker
nor Rapier. It does not claim to outperform Rapier or GPU compute.

The prop meshes and procedural boards/chunks use the existing instanced mesh path. Water, paper, sparks, fire and smoke
share the sprite buffers. There are at most 384 chunks, 2,400 particles, 12 water sources and 48 reaction decals. Small
props/debris use contact decals instead of the hard-shadow pass. Damaged props recover after 35 seconds once both their
home and current positions are outside the camera frustum. Chunks shrink away at the end of their 10–15 second life.

## Measurements

These measurements describe the initial implementation at `c905717`, before the furniture scale correction.

All figures below use one warmup and seven measured runs. Raw runs are in `cpu.json` and `gpu-paired.json`.

| Workload | CPU ms per 60 Hz frame, median of run medians | Range of run medians |
| --- | ---: | ---: |
| All 1,281 props asleep, complete prop update | 0.00254 | 0.00194–0.00396 |
| 512 awake thrown bodies, solver only | 1.0203 | 0.9855–1.1349 |
| 2,400 flutter particles, update only | 0.07073 | 0.06848–0.39423 |

CPU measurements ran in Bun 1.4.2 on the M2 Max. All 512 bodies remained awake for the 90 measured frames in each
crash run. The particle timing includes an early slow run; it is retained rather than removed as an outlier. These
figures exclude mesh packing and rendering.

The GPU runs used headless Chromium on the M5 Max with `--use-angle=metal --enable-unsafe-webgpu`, a 1,000 × 720
viewport, and the reported Apple `metal-3` adapter. Each of seven runs alternates 12 on/off pairs at one frozen scene
state. Every sample spans the beginning of the first render pass to the end of the final composite pass, and the script
waits for the mapped readback. It never sums overlapping pass timings.

| GPU workload | Median paired total-frame delta | Paired interquartile range |
| --- | ---: | ---: |
| Natural seeded city, visible props/contact decals on versus off | +0.01554 ms | −0.02772 to +0.03641 ms |
| 320 moving props and a 2,400-particle burst on versus off | +0.13239 ms | +0.11212 to +0.15946 ms |

The resting-city difference is inside the noise. The stress comparison shows a small positive cost. Neither is an
isolated per-pass timestamp. `gpu-local-paired.json` retains an earlier M2 Max run whose negative deltas and wide spread
were inconclusive; those samples do not establish a speedup.

## Proof

`reactions.json` records clean Metal runs for cones/barriers, bins/benches, a hydrant, and a four-prop chain explosion.
The bench drives a cloned car view through isolated fixtures; it does not change the shared simulation. The contact
sheet also includes the natural seeded city. The portrait clip is 720 × 1,100, 14 seconds, H.264 Main/yuv420p, 6,042,007
bytes, with faststart and no audio. Both requested artifacts were sent to Kit.

`bun run check` passed 114 tests with 12 existing skips, both TypeScript checks and the production build. Tests cover
fixed-step agreement, bounce and sleeping, wake propagation, wall contacts, deterministic placement and complete road
clearance, bounded particle lifetimes, ghost/airborne rejection, explosion disabling, chain reactions, unchanged car
views and off-screen-only recovery.

## Scale audit

The follow-up uses metres throughout. `src/game/props/dimensions.ts` supplies collider sizes; mesh bounds tests check
every vertex against those sizes, including feet, lids and handles. Legacy and interactive benches/hydrants share
the same mesh helpers. Debris size and spawn offsets now follow the source prop dimensions.

| Prop | Width × height × depth (m) |
| --- | --- |
| Cone | 0.40 × 0.70 × 0.40 |
| Barrier | 2.00 × 1.10 × 0.70 |
| Sawhorse | 1.20 × 0.80 × 0.60 |
| Bin | 0.60 × 1.00 × 0.65 |
| Dumpster | 1.80 × 1.20 × 1.20 |
| Newspaper box | 0.50 × 1.00 × 0.45 |
| Bench | 1.80 × 0.85 × 0.55, seat at 0.45 |
| Small planter, including foliage | 0.60 × 0.60 × 0.60 |
| Crate | 0.80 × 0.80 × 0.80 |
| Pallet | 1.20 × 0.15 × 1.00 |
| Portable sign | 0.60 × 1.20 × 0.60 |
| Hydrant | 0.30 × 0.75 × 0.30 |
| Meter | 0.24 × 1.30 × 0.20 |
| Mailbox | 0.50 × 1.10 × 0.45 |
| Propane cylinder | 0.32 × 0.50 × 0.32 |
| Fuel canister | 0.35 × 0.47 × 0.18 |
| Fuel drum | 0.60 × 0.90 × 0.60 |

The audit also covered `render/city/props.ts`, `parks.ts`, `shop.ts`, `streets.ts`, `outskirts.ts`, `building.ts` and
`harbor.ts`. Legacy roadwork drums are 0.90 m tall; garage oil drums are 0.60 m wide and 0.90 m tall. Garage tyres
are 0.72 m in diameter and 0.23 m wide, matching the muscle car's wheel radius. Tree planters and raised planting
beds now have 0.60 m walls; their wider footprints accommodate trees and shrubs. Wheel stops (0.13 m high), fences
(about 1.2 m), harbour railings and the 1.1 m workshop chest fit the existing car scale. Streetlamps retain the current
6.05 m head-height reference. Buildings, monuments and harbour structures retain their architectural dimensions.

The scale-check frame puts an unscaled muscle car beside a bench, hydrant and cone on the same pavement elevation.
Its mesh is 5.00 m long, 2.05 m wide including mirrors, with a roof at 1.30 m above its origin. The compact is 4.06 m
long and 1.84 m wide. These bracket the brief's roughly 4.5 × 1.8 m sedan reference. Vehicle art and authoritative
physics are unchanged. `prop-scale.test.ts` also checks the bench's upward-facing seat surface at 0.45 m.

The scale correction passed 117 tests with 12 existing skips, TypeScript checks and the production build. Fresh Metal
captures retain all four reaction scenarios and add `proof/scale.png` to the 1440 × 836 contact sheet. The refreshed
720 × 1100 portrait clip is 14 seconds, H.264 Main/yuv420p, 4,000,808 bytes, faststart and silent. Both refreshed
artifacts were sent to Kit. `scale-reactions.json` records the corrected-size reaction counts; the earlier
`reactions.json` and performance runs remain as the initial implementation's evidence.

## Resting-shape correction

The old ground solver treated a cone as a box and snapped slow contacts to quarter turns, including upside down.
`contact-shape.ts` now gives cones a tapered hull with a square rubber foot and a mass centre 0.105 m above the base.
Barriers, sawhorses, bins, hydrants, signs, meters and propane cylinders also have authored contact points and mass centres.
The convex envelope of a compound has the same support against a flat ground plane. Body-pair and wall contacts still
use the inexpensive rounded proxies; this is not a general convex stacking solver.

Supporting faces are compiled once per prop kind. A resting face must contain the projected mass centre with at least
12 mm clearance and a margin of 12% of its height above that face, excluding fragile tip/edge balances. Low-speed ground
contacts relax toward these supported faces instead of arbitrary box axes. Rotation preserves the world mass centre,
and sleep waits for the shape to reach its resting orientation. Exactly tip-first cones fall onto a side.

`prop-rest.test.ts` drops 256 seeded cone orientations, five exact/near-inverted cones, and 64 orientations for each of
the seven other shaped props. Every body must actually sleep, clear the ground, and resist small tilts that would lower
its mass centre. Tests also cover tapered support and matching results at 30/60 Hz. `bun run check` passed 122 tests,
12 existing skips, TypeScript checks and the build.

The new Metal clip opens with six seconds of close-up cone drops, then runs all four impact scenarios. The four dropped
cones sleep on their sloping sides with local-up Y = -0.2941, rather than inverted at -1. The file
`getaway-clutter-rest.mp4` is 720 × 1100, 20 seconds, H.264 Main/yuv420p, 4,269,972 bytes, faststart and silent.
`getaway-clutter-rest-sheet.jpg` is 1440 × 836. Both remain local for browser review. `rest-proof.json` records the result.
No new performance claim is made for this correction.

From `games/getaway`:

```sh
bun scripts/bench-clutter-cpu.ts
bun scripts/prove-clutter.ts stills
bun scripts/prove-clutter.ts paired
bun scripts/prove-clutter.ts video
python3 scripts/clutter-sheet.py ../../perf/clutter/proof ../../perf/clutter/getaway-clutter-sheet.jpg
```

The proof defaults to `http://getaway-clutter.localhost:1355`. For a remote fleet job, `--fixture` starts a bounded,
loopback-only Vite fixture. Run the browser/encoding job through `hivemind`; the local interactive preview remains
owned by Nexus. `CLUTTER_URL` and `CLUTTER_OUT` override the URL and artifact directory.
