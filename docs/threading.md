# Threading

Use workers to remove measured main-thread stalls. Start with pure, expensive preparation jobs and explicit
ownership of their inputs and outputs. Outbreak already has chunk and PCM workers; improve the remaining
synchronous work before adding more threads.

These are design guidelines and proposed experiments, not measured new optimizations. They apply
[Barry Genova's GDC 2015 Destiny talk](https://www.youtube.com/watch?v=v2Q_zHG3vqg) to Arcade's browser and server
runtimes. Read alongside [architecture.md](architecture.md), [game-notes.md](research/game-notes.md), and
[netcode.md](netcode.md).

## Design the data boundary first

- **List reads, writes, and lifetimes** ([06:14](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=374s)). Send seeds,
  settings and packed data, rather than a live simulation graph or callbacks. Keep one pure algorithm for the
  synchronous reference and worker path.
- **Make dependencies explicit** ([06:38](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=398s)). Start independent
  work early and join only when its result is needed. Keep cross-system ordering in one coordinator. A promise
  does not move CPU work off main.
- **Protect the critical path** ([13:28](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=808s)). Judge input latency,
  first playable frame and frame tails, not CPU utilization. Browser workers have no portable affinity or native
  thread-priority control. Begin with a small pool.
- **Measure job granularity** ([07:30](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=450s)). Destiny's 0.5–2 ms
  jobs reflected its scheduler; that is not a browser target. A pre-job time check cannot cap an indivisible job.
- **Version results and centralize acceptance** ([27:24](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=1644s)).
  Carry request identity, scene epoch and settings revision. Reject obsolete results and return or retire their
  buffers exactly once. Failure after transfer may leave no valid input for synchronous fallback.
- **Resolve conflicts deliberately** ([34:07](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=2047s)). Order jobs,
  snapshot reads, queue writes for a safe integration point, or change the algorithm. Separate pool
  creation/destruction from element updates. Group interacting objects and use disjoint writable ranges.
- **Extract only what consumers need** ([54:51](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=3291s)). Buffer
  render data rather than all game state. Track snapshot age and acknowledge consumption before buffer reuse.
- **Validate contracts, then experiment with schedules**
  ([22:51](https://www.youtube.com/watch?v=v2Q_zHG3vqg&t=1371s)). Destiny's access/overlap checks were diagnostics,
  not synchronization. Arcade can begin with boundary assertions and seeded output parity. Full race freedom
  cannot be inferred from stress tests or TypeScript `readonly`.

## Use transferables before shared memory

An `ArrayBuffer` transfer moves ownership and detaches the sender's views. Include the data in the message and
deduplicate backing stores in its transfer list. Cloning metadata, sampling callbacks, packing results and GPU
uploads still cost time. Bound in-flight jobs and completed-but-not-integrated bytes. Long synchronous worker
jobs cannot handle cancellation messages until they return; use cooperative boundaries or terminate and recover.

`SharedArrayBuffer` requires a secure, cross-origin-isolated deployment, normally COOP `same-origin` plus COEP
`require-corp` (or supported `credentialless`), and a compatible Permissions Policy. Check `crossOriginIsolated`.
SAB is shared, not transferable; use an explicit ownership/publication protocol with Atomics. Never busy-wait on
main, where `Atomics.wait` is unavailable. WASM pthreads use the same browser workers/shared-memory constraints;
they do not make an unpartitioned algorithm parallel.

On 2026-10-22, HTTP HEAD responses for `/arcade/outbreak/` and `/arcade/lab/` had neither COOP nor COEP. The shared
`packages/kit/server/worker.ts` forwards assets without adding them. Before changing isolation, check direct play
and Lab page stations: `packages/kit/lab/stations/workspace.ts` embeds game pages in iframes, so isolating only the
child cannot isolate a nonisolated top-level Lab. An isolated Lab also needs compatible child policies.
Cross-origin assets need suitable CORS/CORP behavior; COOP can sever cross-origin opener relationships.

## Keep GPU ownership in one context

Supporting browsers expose WebGPU in workers, and `OffscreenCanvas` can move canvas rendering there. Feature-test
the actual worker/device/canvas combination. `GPUDevice`, `GPUQueue` and `GPUCommandBuffer` are not transferable;
do not design independent workers that post native command buffers back to a shared main-thread device.

A render worker should own its device, resources, encoding and submission. CPU workers can return packed data
for upload. `queue.submit()` enqueues GPU work; its return does not mean execution finished. Do not introduce an
unmeasured completion barrier between every stage. Outbreak deliberately uses `onSubmittedWorkDone()` in its
single-in-flight `src/loop/frame-pacer.ts`; preserve that measured latency policy unless a comparison justifies
changing it. Moving encoding cannot fix GPU-bound rendering, and snapshot/resize/input/device-loss messages add
costs that belong in the measurement.

## Prioritize existing bottlenecks

The order below is a research recommendation. Gains are unmeasured.

| Priority | Current evidence and first experiment | Main risk and measurement |
| --- | --- | --- |
| 1. Outbreak streaming | `src/world-streamer.ts` already has two `world-worker.ts` workers, but inner-ring misses and teleports still compile synchronously. Instrument those fallbacks, then try earlier prefetch and staged visual integration. | Missing geometry, stale results and recovery. Measure synchronous fallback time, queue/compile/integration/upload stages, ready bytes and frame p95/p99. Keep authoritative collision correct. |
| 2. Woods startup | `packages/kit/forest/offthread.ts` uses a one-shot worker and transfers models out/back. Compare synchronous, current worker and earlier-dispatched worker with the same seed. | Detached inputs and preparation/upload costs. Measure request-to-playable time, startup, compute and parity; test a warm worker only if repeated initialization matters. The reported 1.4× slowdown is not a measured result of this research. |
| 3. Audio cold paths | Outbreak's `src/audio/weapons/bank.ts` and soundscape already bake PCM in workers. Compare bounded, prioritized prewarm and result registration. | Startup contention and PCM memory. Measure first-use fallback count, request-to-ready and main-thread registration time. Native Web Audio already handles DSP; AudioWorklet is for a demonstrated custom real-time need. |
| 4. Render-worker spike | Only after profiling CPU encoding pressure, compare one small scene on main against OffscreenCanvas worker ownership. | Broad ownership change and older displayed state. Measure input-to-display latency, snapshot bytes/age, encode/upload time, GPU duration and memory. |
| 5. AI and room headroom | `packages/kit/sim/flow-field.ts` already shares per-goal fields and budgets distinct goals per tick. Profile invalidation, AI and snapshot encoding before partitioning. | Authoritative results must not depend on worker readiness. Compare deterministic hashes/wire bytes and tick tails; optimize repeated work first. |

Historical notes put 12/16 awake ragdolls at 0.10/0.18 ms per frame in Bun on Studio. Their
`src/impact/bodies.ts` adapter also needs the exact death pose and terrain samples. That is a poor first threading
candidate unless target-device measurements or body counts change. Keep presentation bodies separate from
authoritative collision.

Server rooms use `packages/kit/server/room-object.ts` and each game's room core. Cloudflare Workers are not browser
Web Workers; this runtime does not provide a browser-style CPU worker pool inside a room. Keep synchronous tick
ordering and per-room state, account for interleaving at awaits, and scale independent rooms. Module globals can
be shared by multiple Durable Object instances. RPC across services is a separate latency/consistency design.

## Measure the whole path

Record `prepare → enqueue → start → compute → receive → integrate → upload → visible`. Separate cold and warm
runs; keep revision, seed, scene, settings, browser and device fixed. Include sample counts, p95/p99, memory,
backlog and output parity. Use per-context durations or align time origins before comparing worker timestamps.
Exercise settings changes, restart, disposal, delayed results and worker failure after transfer for the changed
boundary. A faster compute stage alone does not establish faster startup or smoother play.

## Platform references

- [Worker transferables](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
  and [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer).
- [Cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
  and [Emscripten pthreads](https://emscripten.org/docs/porting/pthreads.html).
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)
  and [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas).
- [Durable Object in-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).
