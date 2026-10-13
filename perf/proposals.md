# Next performance work for Getaway and Blackout

Start with a lossless binary snapshot format, a Getaway resolution budget, and reusable frame-building buffers. Keep delta snapshots conditional on the negotiated compression mode. Raw JSON makes deltas look much better than they do with compression history enabled.

These are proposals. The branch adds offline codecs, measurement scripts, and query-gated inspection handles; it does not change the games' normal renderer, simulation, or network protocol.

## Measurement scope

- Base: `e4625886e34b6d61f724784571e77615f689ec59`. Both games installed with `bun install --frozen-lockfile`.
- Hivemind routed the work to the shared M5 Max Studio. Chromium used `--enable-unsafe-webgpu --use-angle=metal`; every browser result records Apple `metal-3`, timestamp-query support, and `fallback: false`.
- Production Vite builds served by worker-local `vite preview`, with minification disabled and source maps enabled for profiling. No dev server or HMR. The runner closes its browser and preview afterward.
- Rendering: one warmup block plus seven measured blocks, each with 30 settling frames and 90 measured frames. Variant order reverses each block. CSS viewport is 1280×720. Getaway follows its seeded chase hook; Blackout runs `?practice&map=office` and `?practice&map=downtown` with seeded browser randomness. The driving follow-up enters the first downtown vehicle and holds W; it moves 8.17 m during the fixture.
- Each intervention is applied alone. DPR, MSAA and sprite deletion are cost probes that change the image, not accepted visual changes. The variants measure different amounts of GPU work; their CPU differences are not optimization claims.
- CPU timing repeats with the same block discipline. Separate 1,200-frame CDP CPU/heap/GC profiles disable per-pass measurement logging. Heap sampling includes collected objects. Practice CPU includes local bots and simulation; online clients will not pay that whole cost.
- Network: the existing deterministic 1,000-tick multiplayer benchmark uses one warmup and nine measured runs. Codec tests use one warmup and seven measured runs over 4,000 Getaway or 5,000 Blackout snapshots. Byte counts repeat exactly; timing medians and MADs are retained. Compression sizes are deterministic modeled outputs, not edge traffic measurements.
- Numbers below are median ± median absolute deviation (MAD). Large shared-machine outliers remain in the raw data. Independent pass medians need not add up to the median of their total.

## 12 ranked proposals

### 1. Use an exact binary snapshot format in both games

**Problem/evidence:** Getaway sends 6,519 bytes/snapshot; Blackout sends 2,925 in the office and 3,504 downtown. Most keys and enum strings repeat. Even with DEFLATE context takeover, modeled JSON snapshots average 745 / 577 / 619 bytes.

**Change:** Version the snapshot codec, use integer tags and a bounded string/schema dictionary, and retain Float64 values for exact reconstruction. Keep reconnect dictionary initialization explicit. Set client `binaryType = "arraybuffer"` and update protocol validation together.

**Measured win:** `scripts/perf/codecs.ts` produces 1,879 / 1,080 / 1,336 raw bytes, a 71.2% / 63.1% / 61.9% reduction. With compression history, it produces 569 / 397 / 498 bytes, a 23.7% / 31.2% / 19.7% reduction. Downtown driving also saves 62.0% raw and 19.8% with history. Every reconstructed snapshot is JSON-string-identical to the original, including numeric values, optional fields and entity order. Simulation input/state is never altered.

**Risk/effort:** Medium, 2–3 days. The prototype is an offline codec, not a hardened parser. Production needs bounded dictionaries, length validation, malformed-input tests, version negotiation and reconnect coverage. The exact prototype adds about 6.6 µs encode and 4.8 µs decode per Getaway snapshot on this Bun workload; browser/workerd codec CPU needs its own confirmation.

**Files:** both `shared/protocol.ts`, `src/game/net.ts`, Getaway `server/core.ts`, Blackout `server/room.ts`; prototype `scripts/perf/codecs.ts`, `network.ts`.

### 2. Give Getaway an explicit pixel budget

**Problem/evidence:** The current DPR cap is 2, so a 1280×720 window can render 2560×1440. GPU union time rises from 2.503 ± 0.115 ms at DPR 1 to 5.278 ± 1.110 ms at DPR 2. Geometry, lights and instance counts are identical.

**Change:** Add a render-scale option or bounded dynamic resolution, with a native-resolution HUD. Test 1.5 before choosing a default. Use hysteresis so render scale does not oscillate.

**Expected win:** The measured DPR 2→1 endpoints save 2.78 ms, or 52.6%, in this chase. A 1.5 setting has not been measured. Blackout already caps DPR at 1.5; its downtown DPR 1→1.5 probe rises from 0.775 ± 0.213 to 1.514 ± 0.076 ms, but office results are dominated by clock/load variation.

**Risk/effort:** Low implementation effort, about half a day, with a visual review required for thin geometry and distant lights. Do not present lower resolution as a look-preserving optimization.

**Files:** both `src/main.ts` resize functions and debug-overlay controls; render target resizing in both `src/render/renderer.ts`.

### 3. Reuse Getaway's frame-building temporaries

**Problem/evidence:** `Scene.draw` is 0.411 ± 0.050 ms inclusive, versus 0.186 ± 0.022 ms in `Renderer.render`. The separate allocation profile attributes about 41.5 MB to functions named `draw` across 1,200 frames, with another 14.5 MB under `render`. Source inspection finds temporary vectors, beam mesh construction, batch/range objects and effect records. Major GC slices reach 2.72 ms in that diagnostic.

**Change:** Reuse scratch vectors and range arrays, write beam vertices directly into the existing reusable buffer, and pool the highest-allocation short-lived effect records. Start with the frame builder, then measure each change independently.

**Expected win:** Allocation and GC reduction is plausible; no speedup prototype is claimed. The measured difference between inclusive scene and renderer time is about 0.23 ms/frame and bounds the immediate CPU opportunity. Heap totals aggregate equal function names and include scene effects; use the saved profile stacks before selecting the first allocation site.

**Risk/effort:** Medium, 1–2 days. Reused buffers must not change sprite order or outlive the queued GPU upload incorrectly.

**Files:** Getaway `src/game/scene.ts`, `src/game/fx.ts`, `src/render/mesh.ts`, `src/render/renderer.ts`.

### 4. Pack Blackout's actors directly into reusable arrays

**Problem/evidence:** Downtown `Game.build` costs 0.168 ± 0.013 ms; driving costs 0.190 ± 0.034 ms. It creates a fresh parts map, numeric arrays and typed-array views each frame. The 1,200-frame allocation profiles record 27.1 MB under `build` downtown and 30.4 MB while driving. The driving profile contains a 4.95 ms major-GC slice. These are sampled allocations, not a measured heap leak.

**Change:** Keep per-model writers across frames, reset counts, and emit vehicle/soldier parts straight into the existing contiguous instance slab. Reuse caster and dynamic-light lists. Preserve the existing contiguous single instance upload.

**Expected win:** Unmeasured speedup; the initial target is reducing the 0.17–0.19 ms build cost and GC tails. Packing/upload work is only about 0.024–0.030 ms/frame, so replacing the GPU upload API is a lower priority than eliminating producer allocations.

**Risk/effort:** Medium, 1–2 days. Preserve alpha ordering, ragdoll lifetime and instance range offsets. Practice pathfinding also allocates substantially; that cost belongs to local bots rather than online rendering.

**Files:** Blackout `src/game/game.ts` (`build`), `src/game/vehicles.ts`, `src/game/rig.ts`, `anim.ts`, `src/render/renderer.ts`.

### 5. Add deltas selectively, after establishing compression behavior

**Problem/evidence:** Stable fields and parked vehicles recur in every snapshot. Raw JSON deltas reduce Getaway 6,519→2,355 bytes, office 2,925→1,689, downtown 3,504→1,771. Compression history already removes much of that redundancy: JSON deltas improve 745→685, 577→571 and 619→600 bytes respectively.

**Change:** Use recipient-specific base sequence numbers, a full keyframe every 30 snapshots, and full state on reconnect/map change. Prefer entity-ID schemas to the prototype's generic structural patches. For downtown, test deltas on top of binary; avoid imposing a delta cache on office solely for raw JSON savings.

**Measured win:** Binary plus deltas yields 1,099 / 908 / 953 raw bytes. With history it yields 562 / 402 / 413 bytes. Relative to already-compressed binary, downtown saves another 17.0%; office gets 1.2% larger. The driving case improves 529→442 bytes with history. All reconstructed snapshots remain exact; full-keyframe costs are included.

**Risk/effort:** Medium-high, 2–4 days. Per-recipient state, interest changes and dictionary resets must stay synchronized. Generic JSON delta encoding is roughly 3–4× JSON encoding CPU here. A broad rollout is not justified by the office result.

**Files:** both protocol/client transport files; Getaway `server/core.ts`, Blackout `server/room.ts`; prototypes `scripts/perf/codecs.ts`, `network.ts`.

### 6. Fix GPU telemetry before setting automatic budgets

**Problem/evidence:** `packages/kit/gpu-perf.ts` adds render-pass timestamp durations even when they overlap. In the validated baseline, cross-category overlap occupies 2.235 ms of Getaway's 2.503 ms union. Blackout office has 1.084 ms overlapping out of 1.302 ms. Adding those pass durations overstates GPU work.

**Change:** Report the interval union and enclosing span; expose overlapping categories as unattributed time. Keep exclusive pass diagnostics separately. The prototype does both and serializes passes only for diagnostic attribution.

**Expected win:** Correct measurements and thresholds; no runtime speedup claimed. This prevents dynamic resolution or a performance regression alert from responding to inflated totals.

**Risk/effort:** Low, half a day. Readback lifetime and in-flight query ownership still need protection. Keep queue-wait fallback labeled as latency.

**Files:** `packages/kit/gpu-perf.ts`, both debug overlays; prototype `scripts/perf/gpu-browser.js`, `render.ts`.

### 7. Test a smaller Getaway per-pixel light list

**Problem/evidence:** The chase packs 115.94 of 128 light slots on average, versus 8/64 in Blackout office, 7.26/64 downtown and 16.31/64 while driving. Getaway's shader loops over the packed count, rejecting by distance. At 720p that is up to 107 million light-distance checks per single opaque screen layer; DPR 2 quadruples that bound. It is a cost model, not a measured fragment counter or hardware SIMD occupancy.

**Change:** Prototype a small screen/world-tile light list, preserving conservative bounds and the current distance/cone tests. Keep car lights and helicopter lighting intact. Reuse Blackout's existing radius rejection and monitor-suffix ideas where applicable.

**Expected win:** Unmeasured. Getaway's serialized main+resolve pass is 2.189 ± 0.463 ms, versus 0.209 ± 0.034 ms for its shadow pass, so fragment work is a better first target than a new shadow cache. Smoke already limits its vertex-light loop to 48 lights.

**Risk/effort:** Medium-high, 2–3 days. List overflow and incorrect cone bounds can remove visible light. Require seeded image parity before retaining it.

**Files:** Getaway `src/game/scene.ts`, `src/render/shaders.ts`, `renderer.ts`; reference Blackout `src/render/lighting.ts` and `shaders.ts`.

### 8. Cull downtown vehicle parts before packing and drawing

**Problem/evidence:** The office fixture submits about 96,924 vertices and 32 draws/frame; downtown submits 507,079 and 48.9, while driving submits 517,324 and 51.8. The downtown map has five vehicles, and `Game.build` emits vehicle parts before packing all model batches. Downtown submits 94 dynamic instances versus 60 in the office. These differences also include map geometry; they are not all vehicle cost.

**Change:** Add conservative per-vehicle bounds to skip off-camera body/wheel parts, while retaining any headlight or shadow influence inside the view. Inspect large street chunks before changing their partitioning.

**Expected win:** Unmeasured, bounded by the currently submitted offscreen parts. The driving frame increases the light list to 16.31 and upload payload to 11.4 kB, so car geometry and light influence need separate culling rules. Polar compute itself is small in these views, about 0.014 ms serialized downtown.

**Risk/effort:** Medium, 1–2 days. Headlights, wreck effects and riders must not disappear at viewport edges.

**Files:** Blackout `src/game/vehicles.ts`, `src/game/game.ts`, `src/render/vehicle-mesh.ts`, `street-models.ts`, `renderer.ts`.

### 9. Offer lower MSAA only where the measured tradeoff pays

**Problem/evidence:** Both games allocate 4× HDR and depth targets. Getaway's corrected 1× probe measures 1.881 ± 0.162 ms versus 2.503 ± 0.115 ms at 4×. Blackout office measures 1.288 versus 1.302 ms; downtown 0.808 versus 0.775 ms. Blackout has no demonstrated win in this noisy run.

**Change:** Test a user-selectable 1× tier for Getaway, or investigate an edge-preserving resolve separately. Keep Blackout's current setting pending a repeatable result.

**Expected win:** Getaway's endpoint difference is 0.62 ms, about 24.9%, with individual runs from 1.25–3.41 ms. No default change is justified without paired confirmation on a quieter GPU and image review.

**Risk/effort:** Low code effort, half a day; medium visual risk. The probe changes raster samples, attachment storage and resolve together. It does not isolate resolve-only cost.

**Files:** both `src/render/renderer.ts` target/pipeline sample counts; prototype `scripts/perf/gpu-browser.js`.

### 10. Improve interpolation before reducing snapshot rate

**Problem/evidence:** Both rooms currently deliver snapshots at 15 Hz. Blackout's constant says 20, but `round(30 / 20) = 2` produces 15. Getaway buffers 100 ms, keeps 30 snapshots, and caps nearby-car proxy extrapolation at 500 ms. Blackout avatars have no bracketing buffer: they ease toward the latest position plus 50 ms velocity; remote vehicles extrapolate up to 250 ms.

**Change:** Make the actual send cadence explicit. Prototype adaptive buffering for Getaway and timestamped remote-avatar interpolation for Blackout, then try 10 Hz. Keep input and simulation ticks at 30 Hz and send events promptly.

**Measured constraint:** The ordered-jitter fixture at 15 Hz with 0–60 ms extra delay leaves Getaway unbracketed for 0.58% of frames; at 10 Hz it rises to 12.25%. A 150 ms stall every two seconds raises the 15 Hz result to 5.75%. At 10 m/s, Blackout's avatar formula has mean speed error 3.00 m/s at 15 Hz and 4.05 m/s at 10 Hz under that jitter. See the replay caveats below.

**Expected win:** 15→10 Hz saves one third of snapshot messages and approximately one third of snapshot bytes; it does not reduce event traffic or simulation CPU by one third. Current interpolation does not support claiming equal smoothness.

**Risk/effort:** High gameplay risk, 2–4 days. Test turns, collisions, respawns, head-of-line stalls and vehicle exits through real clients before selecting a rate.

**Files:** both `shared/config.ts`; Getaway `src/game/netcode.ts`, `interp.ts`, `server/core.ts`; Blackout `src/game/game.ts`, `vehicles.ts`, `server/room.ts`; `scripts/perf/jitter.ts`.

### 11. Add interest management on the larger maps

**Problem/evidence:** A recipient-centered 60 m radius reduces raw Getaway snapshot estimates from 6,519→4,089 bytes and downtown from 3,504→2,562. Office changes only 2,925→2,922. Getaway already applies viewer/fog rules; adding another filter must preserve them.

**Change:** Keep nearby cars/players at full rate, send coarse distant state where the HUD needs it, and maintain explicit enter/leave records with a margin around the interest radius. Keep objectives, relevant projectiles, riders and spectator targets available.

**Expected win:** The byte-only radius estimate suggests 37.3% Getaway and 26.9% downtown raw savings; driving downtown suggests 26.0%. These are not valid gameplay snapshots and compressed savings are unmeasured. Existing maps do not justify an office implementation.

**Risk/effort:** High, 3–5 days. Incorrect filtering can hide a collision threat or alter a mode's visibility. Do not feed filtered state back into simulation.

**Files:** Getaway `shared/sim/world.ts` (`view`), `server/core.ts`, netcode proxies; Blackout `shared/sim/view.ts`, `server/room.ts`, remote actor/vehicle ingestion.

### 12. Quantize only render-facing positions after the exact codec lands

**Problem/evidence:** Rounding positions/velocities to 0.01 units and headings to 1/4096 turn reduces raw JSON by 6.3% Getaway, 20.3% office and 18.7% downtown. Maximum measured position/velocity error is 0.005; heading error is 0.000767 radians, about 0.044°. JSON angle values still have long decimal representations, so a fixed binary schema is the better eventual consumer.

**Change:** Use bounded fixed-point fields for remote presentation state. Retain exact own-body reconciliation state, sequence numbers and simulation inputs. Consider a 16-bit modular heading and explicitly bounded position integers rather than silently casting doubles to Float32.

**Expected win:** Only the rounded-JSON byte estimates above are measured. A quantized binary protocol has not been implemented. The two lossless prototypes provide the exact-simulation result; quantization deliberately does not produce identical decoded views.

**Risk/effort:** Medium-high, 2–3 days. Prove error bounds through contact prediction, map bounds and angle wrap. Do not claim simulation determinism from a render-only byte experiment.

**Files:** both `shared/protocol.ts`, snapshot builders, client interpolation and reconciliation code; candidate estimator in `scripts/perf/network.ts`.

## GPU evidence and valid pass attribution

The native frame metric is the union of all timestamp intervals. The raw samples retain every start/end pair, draw count, submitted vertex count, blend count and target size. They do not add overlapping durations. Native union baselines are:

| Scene | GPU union ms | Range across blocks | Draws/frame | Submitted vertices/frame | Sprite instances/frame |
| --- | ---: | ---: | ---: | ---: | ---: |
| Getaway chase | 2.503 ± 0.115 | 2.115–2.748 | 47.1 | 1,081,344 | 676.9 |
| Blackout office | 1.302 ± 0.061 | 0.627–1.363 | 32.0 | 96,924 | 4.0 |
| Blackout downtown | 0.775 ± 0.213 | 0.541–1.873 | 48.9 | 507,079 | 9.0 |
| Downtown driving, separate follow-up | 0.987 ± 0.459 | 0.528–2.011 | 51.8 | 517,324 | 16.5 |

The CPU-follow-up control, with no renderer optimization, returned 1.182 ms Getaway, 1.054 ms office and 0.900 ms downtown. The shared worker's clock/load variation is large enough that cross-round comparisons cannot establish a speedup. Within the variant round, office DPR 1.5 even looked faster than DPR 1. That is a noise warning, not a resolution optimization.

For attribution, the `isolated` diagnostic submits one command buffer per pass, awaits completion between passes, and uses a persistent output texture because canvas textures expire across those waits. All 1,890 measured isolated pass sets have zero cross-category overlap. This changes GPU scheduling and tile behavior, so these values are diagnostic pass costs, not a decomposition of the native frame:

| Scene | Shadow ms | Polar compute ms | Main + implicit resolve ms | Bloom, 9 passes ms | Final post ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Getaway | 0.209 ± 0.034 | n/a | 2.189 ± 0.463 | 0.188 ± 0.033 | 0.055 ± 0.012 |
| Blackout office | n/a | 0.043 ± 0.004 | 0.800 ± 0.089 | 0.371 ± 0.056 | 0.114 ± 0.007 |
| Blackout downtown | n/a | 0.014 ± 0.002 | 0.758 ± 0.191 | 0.294 ± 0.078 | 0.072 ± 0.007 |

WebGPU exposes the MSAA resolve as part of the render pass, not an independently timestampable pass. The 1× probe measures its combined raster/storage/resolve tradeoff. A resolve-only number would require native GPU tooling or a different render path and is intentionally not invented here.

Fragment-cost drivers are the HDR pixel count, 4× attachments, full-screen bloom/grade passes, broad point-light loops, and transparent sprite coverage. Getaway also has beam and ghost blending. Sprite counts do not measure covered pixels or overdraw. Removing only six-vertex blended sprite draws yields 2.212 ± 0.211 ms Getaway, 0.728 ± 0.092 office and 0.827 ± 0.340 downtown. The varying results and small office sprite count do not establish a portable sprite-removal speedup. A retained optimization should reduce offscreen coverage or tighten quads while preserving the image.

## CPU evidence

CPU-follow-up timings include the production call plus lightweight counters; nested rows must not be added:

| Scene | Scene.draw / Game.build ms | Renderer submission ms | Packing + upload + cull ms | Upload calls / bytes per frame |
| --- | ---: | ---: | ---: | ---: |
| Getaway | 0.411 ± 0.050 | 0.186 ± 0.022 | 0.031 ± 0.003 | 15 / 43,458 |
| Office | 0.194 ± 0.109 | 0.211 ± 0.101 | 0.030 ± 0.013 | 7 / 9,244 |
| Downtown | 0.168 ± 0.013 | 0.203 ± 0.021 | 0.027 ± 0.002 | 8 / 7,838 |
| Driving | 0.190 ± 0.034 | 0.166 ± 0.034 | 0.024 ± 0.008 | 8 / 11,393 |

The packing interval begins at renderer entry and ends at command-encoder creation. It includes buffer writes and, in Getaway, frustum extraction; it is not a pure memory-copy measurement. Getaway currently uploads each instance batch separately; Blackout already uploads its contiguous slab once. Their packing intervals are too small to justify promising a large batching win.

The saved `*-cpu.json.gz`, `*-heap.json.gz` and `*-trace.json.gz` files can be loaded into Chromium tooling after decompression. Profiles retain function locations and stacks; the small `profile-summary.json` files group names for reading. GC slices are trace events, not guaranteed whole-frame stalls. CPU/heap sampling perturbs execution, so profiled blocks are excluded from the repeated timings.

## Network evidence

Both simulations tick at 30 Hz and currently emit snapshots every two ticks. The corpus sends at that actual cadence; `bench-multiplayer.ts` intentionally serializes every tick as a stress workload. Payload byte counts exclude WebSocket framing, TLS, packetization, roster updates and upstream input traffic.

| Scenario | Raw bytes/snapshot | Raw bytes/tick/player, amortized | Raw kB/s/player | Event messages/s/player | Raw event kB/s/player |
| --- | ---: | ---: | ---: | ---: | ---: |
| Getaway, 8 recipients | 6,519 | 3,260 | 97.79 | 0.84 | 0.10 |
| Office, 10 recipients | 2,925 | 1,462 | 43.87 | 11.49 | 6.98 |
| Downtown, 10 recipients | 3,504 | 1,752 | 52.57 | 11.85 | 6.83 |
| Downtown driving | 3,545 | 1,772 | 53.17 | 11.43 | 7.01 |

Each player also produces approximately 30 input messages/s while updating normally. Total server snapshot message rates are 120/s for eight recipients and 150/s for ten. Event packets are kept separate from snapshot savings. Fixture IDs/names are ASCII; the codec benchmark uses UTF-8 byte length, unlike the older stress benchmark's string-length counter.

The existing server workload measures 69.014 ± 5.445 ms/1,000 ticks Getaway, 54.215 ± 1.825 ms office and 83.998 ± 7.678 ms downtown. Per-tick means are about 0.069 / 0.054 / 0.084 ms. These are in-process simulation/snapshot preparation workloads, not Durable Object scheduling or socket CPU. Their nine-run ranges are 59.743–84.998, 50.679–92.769 and 69.133–104.689 ms. The old and new codecs decode the same precomputed corpus; no server-tick speedup is attributed to them.

Compression estimates below use zlib level 6 with raw DEFLATE and `Z_SYNC_FLUSH`, removing the four-byte flush trailer per RFC 7692. Context takeover keeps one compressor per recipient; no-context resets per message. Dictionary initialization and periodic delta keyframes are included. This is payload modeling, not the exact compression implementation or settings of Cloudflare's edge.

| Scenario / codec | Raw B/snapshot | DEFLATE, no history | DEFLATE, with history |
| --- | ---: | ---: | ---: |
| Getaway JSON | 6,519 | 1,620 | 745 |
| Getaway delta JSON | 2,355 | 843 | 685 |
| Getaway binary | 1,879 | 1,060 | 569 |
| Getaway delta binary | 1,099 | 669 | 562 |
| Office JSON | 2,925 | 1,161 | 577 |
| Office delta JSON | 1,689 | 683 | 571 |
| Office binary | 1,080 | 876 | 397 |
| Office delta binary | 908 | 585 | 402 |
| Downtown JSON | 3,504 | 1,359 | 619 |
| Downtown delta JSON | 1,771 | 715 | 600 |
| Downtown binary | 1,336 | 1,012 | 498 |
| Downtown delta binary | 953 | 611 | 413 |

Multiply any snapshot column by 15 for per-second payload bytes/player. For example, Getaway JSON with history is about 11.17 kB/s/player, not 97.79 kB/s on a compressed connection. Blackout driving with history is 659 B JSON, 529 B binary and 442 B delta binary.

[Cloudflare's compatibility documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-compression) enables `web_socket_compression` by default from 2023-08-15. Both games use 2026-09-08 without a disabling flag. Compression support is therefore already configured; adding the flag is not a new optimization. The local Miniflare front door advertised `permessage-deflate` both with and without the flag, so that experiment cannot distinguish backend behavior. Production handshake parameters and edge CPU remain unmeasured. Inspect a real connection's extension response before selecting the relevant table column; do not assume HTTP gzip/Brotli settings describe WebSocket frames.

### Jitter replay limits

`jitter.ts` runs 24 synthetic schedules, each with one warmup and seven measured seeds: 15/10/7.5 Hz, 0/30/60/100 ms uniform positive jitter over a 50 ms base latency, with and without 150 ms ordered stalls every two seconds. The motion is constant-speed, 10 m/s for 20 seconds. Getaway uses its actual `NetClient` with `you: null` to isolate remote interpolation. Blackout reproduces the avatar and vehicle smoothing formulas rather than constructing the whole game. Getaway position error is measured against nominal 150 ms delayed truth; Blackout error is measured against current truth, so the scores must not be compared across games. Turning, reconciliation, collisions and perceived input latency still require integrated browser playtests.

## Dead ends and rejected claims

- Adding native pass durations is invalid on this Metal adapter. Splitting passes into separate command buffers without awaiting completion still overlapped. Serial completion plus a persistent output texture produced disjoint diagnostic spans, at the cost of changing scheduling.
- The first 1× MSAA probe changed textures/pipelines during warmup but only removed resolve targets after measurement started. Blackout's validation errors exposed that bug. The initial `proposals-render` series is superseded by `proposals-render-validated`; no early MSAA result is used above. Early post targets were also mislabeled as shadow when their canvas views were not in the texture registry.
- Initial browser readiness waited on intercepted rAF and timed out; fixed by explicit polling. An isolated-pass trial attempted to submit an expired canvas texture; fixed with a persistent offscreen output of the same format and size.
- “Enable Cloudflare compression” is not a demonstrated new win. The compatibility date already enables support, and local proxy negotiation did not distinguish the disabling flag.
- Generic JSON deltas add little on a compressed office connection. Quantization and interest estimates are lossy presentation changes, not exact codec proofs. Early interest estimates accidentally centered all recipients on human0; only `network-candidates.json` and `proposals-network-candidates-per-recipient` are used here.
- Lowering the send rate alone increased interpolation starvation. Lowering Blackout MSAA had no clear benefit. Transparent-sprite deletion is a diagnostic, not a proposed visual change.
- Prior exact-matrix Getaway shadow caching, center-ray shadow shortcuts and early-Z experiments remain rejected for the reasons in `autoresearch.md`; this branch does not repeat or claim those wins.
- A cached worker checkout contained an untracked Getaway chassis file absent from this branch. The final checks ran from a clean exported source tree. All 47 Getaway and 66 Blackout non-dependency, non-generated sources in the measured production entry bundles match the local source manifest, so that extra file did not enter the measured build.

## Reproduction and verification

From the repository root, inspect `hivemind check -- <command>` first; these Bun scripts currently classify as local-only, so use the explicit browser/render kind override. Examples:

```sh
hivemind run --kind render --fetch perf/results.jsonl --fetch perf/proposals-data -- bun scripts/perf/network.ts
hivemind run --kind render --fetch perf/results.jsonl --fetch perf/proposals-data -- bun scripts/perf/jitter.ts
hivemind run --kind browser --fetch perf/results.jsonl --fetch perf/proposals-data -- bun scripts/perf/render.ts --game=getaway --variants=baseline,isolated,msaa1,dpr2,no-sprites
hivemind run --kind browser --fetch perf/results.jsonl --fetch perf/proposals-data -- bun scripts/perf/render.ts --game=blackout --scenario=blackout-downtown --variants=baseline,isolated,msaa1,dpr2,no-sprites
hivemind run --kind browser --fetch perf/results.jsonl --fetch perf/proposals-data -- bun scripts/perf/render.ts --game=blackout --scenario=blackout-downtown-driving --experiment=cpu-followup
hivemind run --kind render --fetch perf/results.jsonl -- bun scripts/bench-multiplayer.ts --game=blackout --map=downtown --experiment=proposals-downtown
```

Raw block values and codec digests are appended to `results.jsonl`. Detailed pass ranges and profiles are in `proposals-data/`; historical, harness-proof and failed-round data are retained and labeled rather than silently removed. `source-manifest.json` and `compiled-source-proof.json` identify the measured code. New benchmark files typecheck with `bun games/blackout/node_modules/typescript/bin/tsc --noEmit -p scripts/perf/tsconfig.json` after both installs.

Clean-export `bun run check` passed both games: Getaway 106 passed / 12 existing skips; Blackout 258 passed. Both client/server/script typechecks and production builds passed. The additional benchmark TypeScript check passed. No deployment or merge was performed.
