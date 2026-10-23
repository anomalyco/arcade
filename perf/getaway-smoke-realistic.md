# Wheel-driven smoke and exhaust

Default: `?smoke=6`. `?smoke=8` retains the raymarched alternative with the same new emission rules.
Cold exhaust is independent: `vehicleEffects.coldExhaust`, default false; `?coldExhaust=1` enables it for previews.

## Behaviour and visual proof

| Route | Evidence |
| --- | --- |
| Drift through turn | Two rear bands, merging older density, peak 312 particles, zero remaining at the end |
| Burnout and launch | Haze builds with heat, then a stationary cloud is left behind; peak 96, zero at end |
| Straight nitro | Zero tyre particles throughout; attached short blue exhaust flames |
| Shift / lift-off | Two orange pops at frames 30 and 100; 0.11 s duration and cooldown |
| Cold idle | Short thin condensation, zero tyre particles, independent setting |

All routes use the real solo simulation and scripted controls from `game/emission-study.ts`; only the initial
pose/speed is staged. The camera holds during drift/burnout so the car leaves while smoke disperses. Its cutaway
focus remains at the held camera target rather than following the car behind a foreground building.
Still and phone runs use the same seeded route. Their viewport/aspect differs, so camera framing is not identical.

The first burnout capture was too short to show its heated cloud clearly; the final sequence holds the brake for
2.67 s before launch. Initial drift follow-camera framing lost the lingering cloud behind a foreground building;
the held-focus study fixes that without changing the game camera or look settings. Style 6 reads softer at the tyre
sources than 8, so 6 remains default. Neither emits just because boost is active.

These are presentation approximations: specs currently lack drivetrain, wheel RPM/load, true tyre temperature
and gear state. Rear drive is the fallback; wheel-local heat is a proxy, launches and burnouts use local controls,
and shifts use speed bands. Remote snapshots cannot reliably convey stationary burnouts or lift-off. No snow
spray, snow traction, obstacle-filling fluid solve or car-wake interaction is claimed.

## Whole-GPU measurements

Apple M5 Max, Chromium `apple / metal-3`, 960×640, normal 4× MSAA and post pipeline, style 6. One route warmup,
then one warmup pair and nine alternating on/off pairs per pose. Each member takes eight frozen GPU frames.
Paired poses are checked exactly. On/off switches both tyre rendering and exhaust sprites/pop lights; simulation
and emission storage remain active. The metric therefore isolates the GPU render contribution, not CPU work.

The interval begins at the first shadow pass and ends after a dependent load/store of the **same composite target**.
That benchmark-only pass has identical overhead on both sides. It creates a resource dependency on the completed
composite; it is not a sum of render-pass times. The production frame has no additional marker pass.

| Route / frame | Median paired Δ | Delta MAD | Median total on / off |
| --- | ---: | ---: | ---: |
| Drift / 48 | 0.0662 ms | 0.0770 ms | 1.2242 / 2.2175 ms |
| Drift / 64 | 0.0870 ms | 0.0096 ms | 2.4611 / 2.3755 ms |
| Drift / 100 | 0.1770 ms | 0.0016 ms | 2.4830 / 2.3055 ms |
| Drift / 150, dispersing | 0.1056 ms | 0.0507 ms | 0.8617 / 0.6912 ms |
| Burnout / 48 | 0.0299 ms | 0.0160 ms | 2.3453 / 2.3117 ms |
| Burnout / 64 | 0.0079 ms | 0.0043 ms | 0.5365 / 0.5286 ms |
| Launch / 100 | 0.0665 ms | 0.0734 ms | 0.8334 / 0.6924 ms |
| Burnout cloud / 150 | 0.0412 ms | 0.0276 ms | 0.5954 / 0.5789 ms |
| Nitro / 48 | 0.0003 ms | 0.0024 ms | 0.5601 / 0.5670 ms |
| Nitro / 64 | -0.0115 ms | 0.0390 ms | 0.7141 / 0.7568 ms |
| Nitro off / 100 | 0.0115 ms | 0.0490 ms | 0.7212 / 0.8023 ms |
| Pops inactive / 48 | -0.0024 ms | 0.0143 ms | 0.5894 / 0.6196 ms |
| Pops inactive / 64 | 0.0006 ms | 0.1584 ms | 1.2842 / 0.9234 ms |
| Lift-off pop / 100 | 0.0182 ms | 0.0038 ms | 2.3315 / 2.3100 ms |
| Cold / 48 | 0.0117 ms | 0.0045 ms | 0.5440 / 0.5275 ms |
| Cold / 64 | 0.0082 ms | 0.0012 ms | 0.5266 / 0.5178 ms |
| Cold / 100 | 0.0083 ms | 0.0050 ms | 0.5315 / 0.5430 ms |

The median of paired differences is not necessarily the difference of the two marginal medians. Keep the pairs
when analysing these numbers. Several poses show substantial device-load/clock noise, including negative deltas
and individual outliers above 1 ms. Nitro is below reliable resolution, not a GPU saving. The densest drift pose
has a stable 0.177 ms paired median; all measured pose medians are below 0.3 ms, not every individual frame.
No phone-device, many-car or raymarched-style-8 performance claim is made by this measurement.

An initial offscreen-target run is retained locally as `timings-6-initial-offscreen.json`. An independent 1px
end-marker attempt was aborted on an invalid -0.00475 ms interval: its attachment did not depend on the scene,
so Metal could schedule it earlier. It provides no performance evidence. The dependent-target final run completed
with valid positive total intervals and no browser/GPU errors. Raw final data: `getaway-smoke-realistic.json`.

## Reproduce

From `games/getaway`, with the named `getaway-smoke` Nexus preview running for native captures:

```sh
hivemind run --worker pro --kind browser -- bun scripts/prove-smoke-realistic.ts
hivemind run --worker pro --kind browser -- bun scripts/prove-smoke-realistic.ts --video
python3 scripts/smoke-realistic-sheet.py
hivemind run --kind browser --fetch captures/getaway-smoke-realistic/timings-6.json -- bun scripts/prove-smoke-realistic.ts --timing --fixture
```

The bounded timing fixture is private loopback and closes on completion. All browser work is headless and muted.
Phone encoding uses `h264_videotoolbox`, Main, 1900 kbps, limited-range yuv420p and fast-start at 15 fps.
The result is 720×1280, 31.6 s, 7,435,113 bytes, with no audio. The sheet is 1440×1380.

Research rationale and citations are in `docs/research/game-notes.md`, under “Tyres, nitro and cold exhaust”.
The look integration seam and limits are described there. `getaway-smoke-merge.json` records the exact read-only
snapshot hashes used for the clean three-way compatibility merge; the combined project check passed.

## Verification

`bun run check` passed with 113 tests, 12 existing skips, zero failures, all typechecks and a production build.
The isolated smoke-plus-looks snapshot passed the same check with 116 tests and 12 existing skips. Behaviour tests
cover heat ramp, driven-wheel masks, airborne/popped tyres, immediate emission cutoff, stationary burnout,
straight gripping nitro, ordinary braking, world-space persistence, final dissipation, rate-limited pops and cold
exhaust switching. All five still/video routes had exactly matching poses and zero browser/GPU errors.
