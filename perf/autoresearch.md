# Performance experiments — 2026-10-12

Primary metrics: hardware GPU milliseconds for rendering, and milliseconds for 1,000 simulation ticks including per-recipient snapshot serialization. Preserve geometry, materials, cutaways, lighting and wire output.

Rendering: one warmup and seven measured runs, sequential isolated Metal Chromium instances against existing loopback previews. Simulation: one warmup and nine measured runs on the Studio through `hivemind run --kind render`. Every completed experiment's raw runs, median, MAD and p95 are in `results.jsonl`. No preview service was restarted or deployed.

## Decisions

| Experiment | Before → after (median ms) | Decision |
| --- | --- | --- |
| Blackout visual restoration | correctness prerequisite | Removed monitor lights/bounce, door leaves, chair casters, AO changes, cutaway reshaping, shadow-height/opacity changes and back-face culling. Kept input, animation hysteresis and polar second-occluder fixes. Restored transparent geometry and draw order. |
| H1: Blackout discard-free opaque level shader | 12.972 → 5.007 GPU | Keep. Separate fragment entry point with no reachable `discard`; conservative projected bounds select the cutaway pipeline without reordering draws. Instances retain the general shader. |
| H2: center-ray shortcut / cone-ray culling | correctness rejection | Discard. An unoccluded center ray does not establish visibility of the other four penumbra taps; rays just outside a cone may still be sampled by receivers inside it. Exact per-tap early-outs and the inherited single slab pass remain; no independent speedup is attributed to them. |
| H3: static occluder caching | already implemented | `LightCuller.cache` already stores static packed slices per light, with people appended per frame. Did not duplicate this cache. `Game.build` allocation reuse was deferred while that function was being substantially edited concurrently. |
| H4: static Getaway shadow cache | 180 distinct matrices / 180 frames, all seven runs | Reject before adding a texture/copy. X/Y translation is snapped, but depth translation changes continuously. Exact matrix invalidation cannot reuse a frame on this path. Existing camera-frustum-dependent caster selection would also need invalidation or a larger static pass. |
| H5: Getaway opaque/cutaway pipelines + alpha-separated chunks | 38.254 → 37.308 GPU; CPU 0.659 → 0.756 | Discard. GPU delta is within combined MAD (0.769 / 0.980); CPU submission regressed. Restored all three experimental render files exactly. |
| Blackout shared snapshot entities | 43.531 → 32.816 / 1,000 ticks | Keep. Public player/grenade/claymore views built once per broadcast; mode, ack and inventory remain per recipient. Identical SHA-256 over all serialized output. |
| Getaway shared view preparation | 65.981 → 45.037 / 1,000 ticks | Keep. Shared car fields and standings built once; fog, own-sight, gadgets, props, repairs and spectators retain per-viewer filtering. Identical serialized output SHA-256. |
| Getaway collision AABB precheck | 45.037 → 47.940 | Discard. No win; output identical. |
| Blackout reusable bot intent | 32.816 → 29.579; control rerun 29.670 | Discard. Reversion matched the candidate within MAD; initial improvement was runtime/load variation. Output identical. |
| H6: skip moon shadow sampling on back-facing Getaway surfaces | 1.693 → 1.858 GPU on Studio | Discard. Seven alternating pairs; median paired delta +0.339 ms, MAD 0.406 ms. The final screenshot was byte-identical. No production change. |

Blackout already has a cached uniform-grid raycast broadphase in `shared/geom.ts`. Getaway already rejects cop/cop contacts and uses nearby building candidates; replacing these with a second spatial layer is not justified by this benchmark. No interpolation or protocol format changes.

## Why `final-vanilla` was 10.016 ms while H1 was 5.007 ms

The 10.016 ms result is not evidence that a particular later change removed H1. Its seven six-view means were
`10.027, 8.998, 10.346, 10.026, 10.016, 5.989, 4.917` ms. The same run returned to H1's range at the end.
The following confirmation measured `5.608, 5.541, 5.294, 6.061, 9.353, 7.523, 5.849` ms (median 5.849,
MAD 0.308), without a recorded performance fix between those two measurement rounds. Queue-wait timings rose and fell
with the GPU timings. This is consistent with competing work/clock variation, not a persistent 2× code regression.

The cutaway split is still present: `src/render/renderer.ts` selects the discard-free opaque entry point outside
conservative projected cutaway bounds; `vanilla` does not select a different pipeline. The 10.016 ms run predates
the restored monitor-light follow-up. That run used `vanilla=1`, and the current harness also passes `monitors=0`
unless explicitly enabled. The later cyan pools therefore cannot explain that historical number.

The old records do not include exact source hashes or GPU-load/clock traces, so they cannot identify a single
causal change or prove which competing workload caused the slowdown. Do not claim a recovered 10→5 ms code win,
or compare these M2 Max results with the new M5 Max results. The final package remeasures untouched main and the
integrated build on the same Studio. H1's earlier 5.007 ms is an experiment result, not the final build's promise.

## Original measurement round

- Blackout: 12.734 → **5.849 ms** hardware GPU median; all six viewpoint medians improved. Final MAD 0.308 ms. See `blackout.md` for tails and contaminated-run disclosure.
- Getaway: main-renderer control 58.295 → **38.445 ms** hardware GPU median; all three path-section GPU-wait medians improved. This includes the inherited city-culling work; H5 added no retained GPU change.
- Rebuilt both MP4s and sheets in `captures/preview/`, using `h264_videotoolbox -profile:v high -q:v 75`; encoding and image composition ran through Hivemind on the Studio.
- Blackout's static open-plan and breakroom PNGs match the archived BEFORE pixel-for-pixel. East room differs by mean absolute RGB 0.039/0.037/0.031 out of 255; animation by 0.243/0.224/0.190. The requested polar/animation bug fixes mean those two images are not bit-identical.
- Getaway's sheet retains the original composition and tight spotlight. The inherited renderer changes are not a pixel-exact match to `main`; this pass adds no retained Getaway rendering change.
- Concurrent optional visual-effects work is outside this pass. Captures use `vanilla=1`; the working game's default effects are not covered by the invariance claim.

## Harness limitations and failures

- The first final monitor-cost run stopped at 31/32 samples: queue completion did not imply asynchronous timestamp
  readback completion. The harness now awaits its readback promise before clearing samples and after each manual
  step. The complete replacement run kept all seven measured pairs; the failed run is not used as a result.
- H6's initial per-pass `post_ms` sum exceeds its total GPU span. Those per-pass totals are invalid for attribution
  and are retained only as diagnostics. Subsequent records report shadow and the remaining main/post span together,
  and check for overlapping timestamp ranges rather than summing potentially merged render-pass timestamps.
- `gpu_idle_ms` is queue-wait wall time, not pure GPU time. `gpu_hw_ms` comes from timestamp queries on Apple Metal. Blackout `stress4_gpu_estimated_ms` is first replay timing multiplied by four, inherited from the original harness; it is explicitly an estimate, not a full four-replay timestamp measurement.
- Two initial Getaway runs were interrupted by concurrent Vite reloads. Excluded incomplete runs; the proof browser now filters HMR update/reload messages without changing the server.
- Closing HMR sockets emitted Vite console errors in the capture runner. Replaced that with message filtering; no application errors are suppressed.
- The existing Getaway BEFORE preview no longer exposes the benchmark hook. For the seven-run control, `--main-renderer` serves `main`'s renderer and shaders only to the isolated proof browser, using the same current seeded scene/simulation. The archived BEFORE movie remains the original full-build capture (72.071 ms mean frame time).
- Simulation times are in-process workload timings. Transport mocks consume serialized packets; they do not measure real WebSocket latency, Durable Object scheduling, packet loss or backpressure.
- No claim of improved tail latency under competing GPU workloads. Keep the raw outliers visible.

## Commit scope and artifacts

The scoped performance commit includes the renderer, snapshot sharing, animation fixes, bot-practice menu entry, benchmark scripts and this ledger. Concurrent input multiplexing, sandbox, optional-effects and Getaway jump work stays in the working tree. The dev viewers' `vanilla` integration depends on that optional-effects work and stays with it; the committed original viewers have no optional effects to disable.

`captures/preview/blackout-before-after.mp4`, `getaway-before-after.mp4` and their `*-sheet.jpg` files are local review artifacts. Raw frames and videos are not committed. The Blackout labels were reassembled from the existing captures to remove the stale lighting claim and mark the four-replay timing as an estimate. The sheet's capture-run means are distinct from the repeated-run medians above.

To reassemble those Blackout labels without recapturing or touching a preview, run from `games/blackout`:

```sh
hivemind run --kind render --fetch captures/preview/blackout-before-after.mp4 --fetch captures/preview/blackout-before-after-sheet.jpg -- env ARCADE_ENCODE_LOCAL=1 bun scripts/compare.ts --phase=after --assemble-only
```

The first assembly attempt selected an installed Brave binary that crashed at launch on the worker. Selecting Playwright's matching Chromium executable fixed it; the second attempt completed on the Studio.

## Verification

Exported the staged tree and ran `bun install --frozen-lockfile` followed by `bun run check` in both games on the Studio. Blackout passed 182 tests; Getaway passed 98 with 12 existing skips. Both client/server/script typechecks and production builds passed. The exported tree excludes the concurrent gameplay files, so these results verify the scoped commit independently.

The ledger's 17 original raw records were parsed and checked against their run counts, medians, MADs and p95s. Nine explicit hypothesis decisions accompany them. The corrected Blackout video is H.264 High, 1920×600, 180 frames and six seconds; its regenerated sheet was inspected.

Both staged multiplayer benchmarks were rerun to verify that splitting out the concurrent gameplay edits preserved the baseline output. All ten digests per game matched, including warmup. These two `staged-confirmation` records are also retained: Blackout median 30.072 ms (MAD 0.814), Getaway 50.858 ms (MAD 3.487). Getaway ranged from 67.133 to 44.426 ms; this confirmation is an output check, not a new paired speedup claim.

## Latest monitor-cost confirmation

`blackout-final-monitor-cost.json` measures the current 1.65 m directional pools, including the current baked-light
toggle, on the shared M5 Max Studio. One warmup plus seven alternating OFF/ON pairs, 32 settled timestamp samples
per block, frozen at two seconds:

| View | Added GPU median | MAD | p95 across pairs |
| --- | ---: | ---: | ---: |
| Open-plan east | 0.10507 ms | 0.12639 ms | 0.24448 ms |
| Open-plan south | −0.01144 ms | 0.09084 ms | 0.16025 ms |

The requested reliable <0.05 ms ceiling is **not established**. Negative deltas reflect measurement noise. The
structural constraints hold: monitor `cnt = 0`, unchanged occluder buffers and shadow prefix, no monitor shadow
reads, no monitor polar dispatch, and conservative bounds produce byte-identical screenshots in both views.
This supersedes the pre-Lab marginal-cost estimates; it does not justify reducing monitor radius or changing style.
