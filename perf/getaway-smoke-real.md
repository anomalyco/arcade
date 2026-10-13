# Connected smoke study

Three new candidates use the existing Smoke selector and `?smoke=6`, `7`, or `8`.
`0` remains the original; `1` is the earlier faceted reference. Default: 6.

| Style | Implementation | Launch ΔGPU | Turn ΔGPU | Lamps ΔGPU |
| --- | --- | ---: | ---: | ---: |
| 6 · Advected billows | Distance-spaced soft sprites, shared noise, curl drift | 0.026 ms | 0.092 ms | 0.132 ms |
| 7 · Directional billows | Same density with procedural scattering-gradient lighting | 0.030 ms | 0.105 ms | 0.147 ms |
| 8 · Raymarched cloud | Shallow combined density field, twelve integration steps | 0.054 ms | 0.091 ms | 0.099 ms |

Recommend 8 for a single connected volume, or 6 for a softer trail. Both read as smoke rather than a row of separate
objects in the inspected launch, turning, lamp and close-up frames. Style 7 has stronger lighting contrast. The
portrait sequence includes about three seconds after boost release so drift, growth and dissipation can be judged.

## Measurement

- Apple M5 Max, Chromium WebGPU `apple / metal-3`, 960×640, 4× MSAA, one seeded car trail.
- Hardware interval from first shadow-pass start to final composite end; no summation of pass timestamps.
  An equal-size, equal-format offscreen final target excludes swapchain presentation fences. CPU uploads precede
  this interval; it measures rendering, not all CPU work or end-to-end frame latency.
- All three pipelines/routes warm up first. At each frame 18/64/92, one warmup pair precedes nine measured pairs;
  each member renders eight frozen frames. Order alternates on/off. Pose equality is checked for every pair.
- Cost is the median of paired differences between each member's median total-GPU interval.
  Within-pose delta MAD: 6 = 0.0065/0.0034/0.0068 ms; 7 = 0.0059/0.0027/0.0024 ms;
  8 = 0.0028/0.0027/0.0005 ms. One style-7 lamps pair cost 1.502 ms; it remains in the raw data.
- Total on/off medians at launch/turn/lamps: 6 = 2.499/2.473, 2.513/2.422, 2.506/2.374 ms;
  7 = 2.500/2.471, 2.528/2.423, 2.519/2.373 ms;
  8 = 1.110/1.056, 1.129/1.038, 1.118/1.019 ms. Changing device load/clocks make cross-style totals
  unsuitable for ranking; use adjacent paired deltas. These are medians below 0.3 ms, not a worst-frame guarantee.
- Approximate whole-frame CPU submission medians: 0.1–0.2 ms for 6/7, 0.3–0.5 ms for 8. These include scene work;
  they do not isolate smoke CPU cost. Many-car behaviour and phone GPU performance are unmeasured.
- Initial M2 Max runs had 0.8–1.5 ms delta MAD, too noisy for this budget. Their JSON remains under
  `captures/getaway-smoke-real/timings-m2-noisy.json`; it does not support a sub-0.3 ms claim.

Raw final evidence: `perf/getaway-smoke-real.json`. Reproduce from `games/getaway`:

```sh
hivemind run --kind browser --fetch captures/getaway-smoke-real/timings.json -- bun scripts/prove-smoke-real.ts --timing --fixture
hivemind run --worker pro --kind browser -- bun scripts/prove-smoke-real.ts
hivemind run --worker pro --kind browser -- bun scripts/prove-smoke-real.ts --video
python3 scripts/smoke-real-sheet.py
```

The `pro` capture commands require the task's running Nexus preview; the fixture is loopback-only and shuts down
with the timing script. Browser runs are headless and muted. GPU measurements run sequentially.

## Research and scope

The cited two-to-three-line technique summaries, fit and estimated costs are in
`docs/game-notes.md`, under “Connected smoke research”. Key conclusions:

- [Valve's CS2 presentation](https://www.youtube.com/watch?v=_y9MpNcAitQ) establishes world-space, lit, connected
  smoke. Voxel flood fill and raymarching details come from [Gunnell's independent reconstruction](https://github.com/GarrettGunnell/CS2-Smoke-Grenades),
  not published Valve implementation details.
- [Distance emission](https://docs.unity3d.com/Manual/particle-emissions-emitters.html),
  [curl advection](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf), and coherent noise solve
  gaps and separate silhouettes before more expensive lighting is added.
- [Six-way lighting](https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@17.7/manual/six-way-lighting.html)
  needs baked directional responses. Style 7 instead uses an explicitly labelled procedural gradient approximation.
- [Offscreen particles](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-particles)
  reduce overdraw but add depth/compositing work. Not adopted: the single-pass candidates met the measured budget.
- [Volume integration](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids)
  works with a bounded shallow field here. Style 8 is not a full voxel fluid simulation; obstacle filling,
  bullet carving, depth-aware soft building intersections and fully integrated shadow transmittance are absent.

All new smoke is shadowless. Ground fading is analytic against y=0. Noise is a deterministic 32³ R8 texture,
sampled at multiple frequencies. Storage is fixed at 768 particles; the study peaked at 388. Overflow drops births.
The density field combines overlapping sources into one height/radius distribution, which is suitable for ground
trails but cannot represent vertically separated clouds. Sprite ordering approximates back-to-front by age.
Practical lighting checks up to 32 packed lights. Multiplayer load and unusual camera/obstacle cases need playtesting.

## Deliverables

- `captures/getaway-smoke-real/getaway-smoke-real.jpg`: 1440×1410, four matched views across five rows.
- `captures/getaway-smoke-real/getaway-smoke-real-phone.mp4`: 720×1280, 19.6 s, 7,171,693 bytes,
  H.264 Main, yuv420p, limited range, fast-start, silent. Each candidate receives 6.53 s.
- `proof.json`, `phone-proof.json`: matching seeded poses, peak counts, adapter identity and browser/GPU errors.
- `motion-inspection.jpg`: boost/release/dispersion/empty-road inspection frames.

The sheet's external reference is cropped from Valve's **Counter-Strike 2: Responsive Smokes** thumbnail,
`https://i.ytimg.com/vi/_y9MpNcAitQ/maxresdefault.jpg`; it is a game reference, not a real-world smoke photograph.
Concept crop: `games/getaway/concept/dir-d-lowpoly-1.png`.

## Verification

`bun run check` passed: 109 tests, 12 existing skips, no failures; client/server/script typechecks and production
build passed. Distance-emission tests cover 6 m frame steps, carried remainders, a sharp turn, teleport/inactive
gaps, fixed-capacity reuse and complete dissipation. All five still routes and all three phone routes matched
exactly within their capture runs; browser/GPU errors were empty. Live selector values 0/6/7/8 updated the URL.
