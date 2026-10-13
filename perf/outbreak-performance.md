# Outbreak performance and frame-pacing autoresearch

Separate from release PR13. No approved geometry, material, lighting, resolution or post-processing detail is removed.

## Target and method

- **Primary metrics**:
  1. `p95` fresh-state GPU submission interval (`fresh_submit_p95_ms`) during a deterministic 2.0 s held-input traversal in both `street` (`x=30, y=41, zoom=46, hour=18`) and `interior` (`x=27.7, y=31, zoom=34, hour=19`) scenes at `1728×947` CSS (`3456×1894` backing pixels, DPR 2).
  2. Realtime simulation ratio (`simSeconds / wallSeconds`) and effective travel speed (`distance / wallSeconds`, target 3.40 m/s).
- **Secondary metrics**:
  - Fresh-state submission `p50` / `p99` and fresh submitted states/second (distinguished from `requestAnimationFrame` callbacks and simulation tick updates).
  - Non-overlapping deterministic spans: `cpuSimStepMs`, `cpuVisionStepMs`, `cpuPrepStepMs`, `stepToQueueCompleteMs`, and single dependent hardware GPU timestamp intervals (`gpuHwDependentIntervalMs` via `timestamp-query`, from polar compute start to composite end — never a sum of pass intervals).
  - Input latency to simulation (`keydownToSimMs`), submission (`keydownToSubmitMs`), and queue-completion callback (`keydownToGpuCompleteCallbackMs`). True physical display presentation latency is not measured.
- **Benchmark harness**: `games/outbreak/scripts/bench-outbreak.ts` (1 warmup + 7 measured runs per scene on Apple M5 Max Metal via `hivemind run --worker studio --kind render`) and `games/outbreak/scripts/performance-proof.ts` (1 warmup + 7 alternating before/after pairs with full-resolution 3456×2006 RGB pixel-parity verification).

## Baseline and bottleneck attribution

Initial baseline at `1ba93b4` (after `48b5286`'s initial `fsSolid` split, before clock, lighting, tree-cutaway, and queue-pacing fixes) on M5 Max Metal (`3456×1894`, thermal nominal):

- **Street baseline**: `fresh_submit_p95_ms = 109.60 ms` (MAD 18.40, pooled p95 130.60 ms, p50 76.70 ms, 15.41 states/s), `realtime_ratio = 0.6232` (MAD 0.0760, min 0.4538, speed 2.119 m/s), `gpu_hw_ms = 14.358 ms` (MAD 0.019), `queue_span_ms = 17.350 ms`, `cpu_prep_ms = 1.000 ms`.
- **Interior baseline**: `fresh_submit_p95_ms = 138.30 ms` (MAD 5.10, pooled p95 139.60 ms, p50 81.80 ms, 13.29 states/s), `realtime_ratio = 0.5462` (MAD 0.0531, min 0.4827, speed 1.857 m/s), `gpu_hw_ms = 22.071 ms` (MAD 0.027), `queue_span_ms = 24.550 ms`, `cpu_prep_ms = 0.550 ms`.
- Hardware timestamp ablations on the same baseline identified three dominant bottlenecks:
  1. **Clock clamp discarding visible wall time**: `main.ts` clamped `dt` at `0.05 s` without an accumulator, silently losing all elapsed time above 50 ms (`realtime_ratio = 0.55–0.62`).
  2. **False `discard` routing and 4× MSAA depth store**: `48b5286` routed all triangles with `y > 2.8` (including all 71 exterior trees and 12 streetlamps) and all 4 buildings' roofs into `customCutaway` (`fs` with `discard`), disabling Apple TBDR hidden-surface removal on ~90k foliage vertices and inactive roofs (`allOpaquePipe` ablation: 14.35→11.84 ms street, 22.18→11.24 ms interior). `Renderer` also used `depthStoreOp: "store"` on the 104.7 MB 4× MSAA depth buffer even when volumetric smoke was inactive.
  3. **Off-screen light submission and out-of-band queue double-submits**: `main.ts` submitted every lamp within 40 m of the player (28–30 lights) regardless of the camera frustum (`frustumLights` ablation: 28→11 lights in interior, saving 3.39 ms GPU). In `Renderer.schedule()`, `onSubmittedWorkDone` drained stale `pending` frames in a microtask outside `requestAnimationFrame`, causing 0.8–2.0 ms double-submissions followed by 130–148 ms swapchain/compositor stalls.

## Hypothesis loop

| # | Hypothesis | Change | Before → After | Decision |
| --- | --- | --- | --- | --- |
| H0 | Initial `fsSolid` split (`48b5286`) | Separate `solidCutaway: ""` entry point; 3-way triangle split | GPU `26.434→15.161 ms` street, `40.320→23.562 ms` interior | **Keep** (inherited foundation) |
| H1 | Fixed-tick accumulator with bounded substeps and timestamped input transitions fixes visible time loss without catch-up spirals or retroactive input replay | Add `FrameClock` (`shared/clock.ts`, 60 Hz `TICK_DT`, `MAX_SUBSTEPS = 12`, `MAX_HITCH_SECONDS = 0.5`, pause/blur/hidden anchor reset, timestamped move transitions) and substepped `Survivor.draw` | `realtime_ratio`: street `0.6232→0.9960` (MAD 0.0008), interior `0.5462→0.9950` (MAD 0.0017); speed `2.12/1.86→3.39/3.38 m/s`; p50 submit gap `76.7/81.8→66.7/71.7 ms` | **Keep** (7 unit tests in `tests/clock.test.ts` pass) |
| H2 | Restrict `customCutaway` to building footprints (`BUILDING_RECTS`) and active-building player bounds; skip 100%-interior chimney caps while inside | Keep exterior trees/streetlamps in `fsSolid`; activate building roof `customCutaway` only when player is inside `[b-0.1, b+0.1]`; skip strictly interior `y > 2.8` chimney triangles (`customCutaway: "outside"`) when inside | `gpu_hw_ms`: street `14.358→11.853 ms`, interior `22.071→16.589 ms`; `queue_span_ms`: `17.35→14.00 ms` street, `24.55→18.15 ms` interior | **Keep** (`RGBMatch = true`, 0 differing pixels across 6,932,736 pixels) |
| H3 | Frustum-cull lamps against `cam.groundRect(5.5)`, skip zero-power slot 0 in `lightSum`, reuse adjacent ray taps in `shadowAt`, and set `depthStoreOp: "discard"` when volumetric smoke is inactive | Filter lamps by `power > 0.001` and camera frustum overlap (`28→11` lights in interior, `30→22` in street); deduplicate `lo == prevLo` in `shadowAt`; discard 4× MSAA depth when `!hasSmoke` | `gpu_hw_ms`: street `11.853→11.177 ms`, interior `16.589→14.327 ms` (`queue_span_ms`: `16.000 ms` interior, `13.800 ms` street) | **Keep** (exact IEEE-754 ray reuse; `RGBMatch = true`) |
| H4 | Single-in-flight GPU queue with `onIdle` + 60 Hz frame-pacer prevents out-of-band microtask double-submissions and headless `BeginFrame` 133.3 ms (8-vsync) starvation | Cap `Renderer` to 1 in-flight frame, notify `onIdle` when the queue drains, pace draws at `>= 14.5 ms` (`~60 Hz`), and prevent duplicate `rafLoop` chains across `freeze` cycles | `fresh_submit_p95_ms`: street `109.60→32.40 ms` (MAD 0.40), interior `138.30→24.40 ms` (MAD 1.70); `fresh_submit_p50_ms`: `76.70→18.15 ms` street, `81.80→20.50 ms` interior; `states_per_s`: `15.41→48.26` street, `13.29→45.23` interior | **Keep** |
| H5a | Clipping roof slope triangles along `[b+0.45, b-0.45]` to omit the interior roof hole | Sutherland-Hodgman 4-plane clip on `MAT.roof` triangles | Reduced interior GPU time to `12.113 ms`, but altered barycentric `o.world.xz * 70` grain interpolation by 1 LSB on 2,737 eave pixels | **Discard** (violates zero-visual-drift rule; kept only unclipped `customCutaway: "outside"` chimney skip which has `diffPixels = 0`) |
| H5b | Splitting `screen` wall meshes into spatial sub-chunks with `y0 > 0` or across `2.8 m` partition wall caps | Spatial sub-chunks for `MAT.wall` | Triggered a 1-pixel seam (`diffPixels = 1541` at `y = 717`) where `o.world.y` perspective interpolation on `2.8 m` walls rounded up by 1 ULP (`2.80000019 > 2.8`) in `fs` vs `fsSolid` | **Discard** (restored single per-source `screen` chunk; `diffPixels = 0` on all 6,932,736 pixels) |

## Final measured comparison (Studio M5 Max, Metal)

| Metric | Origin `main` | Baseline (`1ba93b4`) | Final (`perf/outbreak-autoresearch`) |
| --- | ---: | ---: | ---: |
| Street dependent GPU interval (`3456×2006` paired median) | 26.434 ms | 14.358 ms | **11.535–11.623 ms** |
| Interior dependent GPU interval (`3456×2006` paired median) | 40.320 ms | 22.071 ms | **17.549–17.759 ms** |
| Street step-to-queue-completion span (`3456×2006` paired median) | 25.60 ms | 17.35 ms | **13.00 ms** |
| Interior step-to-queue-completion span (`3456×2006` paired median) | 35.85 ms | 24.55 ms | **19.40–20.90 ms** |
| Street fresh-state submission `p95` (`3456×1894`, 7 runs) | 73.4–130.6 ms | 109.60 ms (MAD 18.40) | **32.40 ms (MAD 0.40)** |
| Interior fresh-state submission `p95` (`3456×1894`, 7 runs) | 93.4–139.6 ms | 138.30 ms (MAD 5.10) | **24.40 ms (MAD 1.70)** |
| Street fresh-state submission `p50` / `p99` | 45.4 / 79.6 ms | 76.70 / 118.60 ms | **18.15 / 40.20 ms** |
| Interior fresh-state submission `p50` / `p99` | 62.1 / 99.1 ms | 81.80 / 139.60 ms | **20.50 / 29.10 ms** |
| Street fresh submitted states/s | 21.19 | 15.41 | **48.26** |
| Interior fresh submitted states/s | 15.81 | 13.29 | **45.23** |
| Street realtime simulation ratio (`sim / wall`) | 0.925 (0.626 under load) | 0.6232 (min 0.4538) | **0.9953 (min 0.9942)** |
| Interior realtime simulation ratio (`sim / wall`) | 0.895 (0.322 under load) | 0.5462 (min 0.4827) | **0.9941 (min 0.9928)** |
| Street / Interior held-input speed (target 3.400 m/s) | 3.15 / 3.04 m/s | 2.119 / 1.857 m/s | **3.384 / 3.380 m/s** |
| Interior keydown → GPU completion callback (median) | 120.1 ms | 146.7 ms | **75.1 ms** |
| Full-resolution 3456×2006 RGB pixel parity vs `main` | — | 100% (`0` diff px) | **100% (`0` diff px)** |

## Remaining limits and unexplained stalls

- **Earlier ~1 s stalls in `pacing-counter-fixed/`**: Root-caused to two interacting factors: (1) `Renderer.schedule()` previously submitted stale `pending` frames from `onSubmittedWorkDone` microtasks outside `BeginMainFrame`, causing 0.8 ms double-submissions that exhausted Chromium's swapchain buffers and triggered 8-vsync (`133.3 ms`) `BeginMainFrame` backoff; and (2) external multi-simulator test shards concurrently competing on the shared Studio worker. With single-in-flight pacing and `onIdle` scheduling (`final-clean-loop.json`), the maximum observed fresh-state submission gap across all 14 measured runs was **47.8 ms** (street) and **31.8 ms** (interior), with zero >100 ms stalls. True external OS/GPU contention on a shared machine remains outside the game's control and is bounded by `FrameClock`'s `MAX_HITCH_SECONDS = 0.5 s` cap.
- **Display presentation latency**: `keydownToGpuCompleteCallbackMs` measures to the `device.queue.onSubmittedWorkDone()` callback on the JS main thread, not physical scanout on a display.
- **Evidence**: Raw JSON runs, paired hardware timestamp traces, and downscaled review stills live under `~/code/home/artifacts/2026-10-13-outbreak-autoresearch/`.
