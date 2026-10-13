# Getaway street clutter

Seed 7 places 1,281 props in 17 kinds. They use a separate random stream, so adding clutter does not change the city or
authoritative simulation. Cars hit props through their rendered position, heading, dimensions and velocity. The car
view is never modified. The three Lab controls are Street clutter, Explosions and Physics debug.

`src/game/props/physics.ts` uses 120 Hz substeps, a persistent spatial hash and an awake set. Ground support comes from
the rotated box; body pairs use rounded proxies and static city boxes stop pieces at walls. This is a decorative solver,
not a precision stacking or joint solver. The measured cost fits the main thread, so this version adds neither a worker
nor Rapier. It does not claim to outperform Rapier or GPU compute.

The prop meshes and procedural boards/chunks use the existing instanced mesh path. Water, paper, sparks, fire and smoke
share the sprite buffers. There are at most 384 chunks, 2,400 particles, 12 water sources and 48 reaction decals. Small
props/debris use contact decals instead of the hard-shadow pass. Damaged props recover after 35 seconds once both their
home and current positions are outside the camera frustum. Chunks shrink away at the end of their 10–15 second life.

## Measurements

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
