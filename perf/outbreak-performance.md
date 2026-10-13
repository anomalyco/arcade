# Outbreak performance follow-up

Separate from release PR13. Baseline: integration commit `846a9f6`. No approved geometry,
material, lighting, resolution or post-processing detail is removed.

## Target and method

Primary metric: median moving frame's CPU-to-queue-completion span, not FPS or a sum of GPU pass timestamps.
One warmup plus seven alternating before/after pairs, seed 7, fixed hour/zoom and identical 60 Hz movement.
Each pair starts from the same street or interior pose. Retain raw samples, pose agreement and dimensions.

`games/outbreak/scripts/performance-proof.ts` runs an isolated headless Metal Vite fixture through hivemind.
It substitutes only this optimization's routing choices for BEFORE, never edits a checkout, verifies Metal,
and records dependent whole-frame GPU intervals separately from CPU/queue spans. Its default output is
`captures/outbreak-performance/` (override with `PERF_OUT`). Do not edit source while capturing.

`performance-visible.js` runs through the browser-control CLI against private owned previews.
It substitutes original main/level/shader modules from the unchanged integration preview, rewrites their
workspace import roots, and instruments CPU vision and frame preparation. Browser privacy can mask adapter
identity; these samples alone do **not** establish a Metal backend. A Vite timestamp query suffix must be
included in route matching. Browser status-overlay pixels are excluded from gameplay parity.

## Diagnosis

- The shared preview's Vite startup was 120 ms; observed browser DOM/load was 154.5/165.5 ms.
- Retina backing resolution was 3456×2006 initially, then 3456×1894 after a browser resize. Never mix those
  dimensions into a paired result. The completed routing comparison used only 3456×1894.
- CPU frame preparation was roughly 1–1.5 ms, vision 0.7–1.3 ms. M1 has no NPC/pathfinding hot loop.
- Mesh generation/upload occurs at reset/generation, not per frame. Door changes rebuild blockers.
- Hidden tabs skip simulation and drawing; their rAF loop remains browser-throttled. The two-frame renderer
  queue is bounded. The Lab's FPS counts attempted frames, not confirmed display presentations.
- A diagnostic removing scene draws left about 6 ms of queue-completed work versus roughly 100+ ms with
  scene draws. Skipping polar compute did not establish a useful saving; these ablations are not GPU pass times.
- `makeSceneShader` included Outbreak's roof `discard` in **fsSolid**. Even when its condition is false,
  this prevents Metal's hidden-surface removal for that opaque pipeline.

## Experiments

1. **Discarded: per-light conservative blocker lists.** Exact seeded CPU ray intersections passed, but
   seven-pair medians were street 95.9→95.7 ms, interior 126.3→129.7 ms. Not a measurable win. Original
   blocker packing is restored. Raw evidence: `visible-paired.json` in the dated private artifacts.
2. **Keep candidate: separate custom-cuttable triangles and a genuinely opaque entry point.** A triangle
   containing any roof vertex or vertex above 2.8 m stays cuttable; all vertices/attributes are retained.
   Shared shader hooks preserve their old default. Initial conservative routing measured street 97.8→66.1 ms
   (32%), interior 124.9→124.6 ms (inside noise). Movement matched in every pair, and captured gameplay RGB
   matched exactly outside the browser-control overlay.
3. **Discarded: active-building routing:** custom high/roof chunks require the discard pipeline only where the
   player's active building overlaps them. Standard screen-space wall cutaway remains independently active.
   A conservative CPU threshold includes f32 rounding; no roof removal condition is changed. This extra
   policy did not establish an additional win and was removed.
4. **Kept: three-way triangle routing.** Pure opaque triangles do not get screen cutaway bounds. Wall/lamp
   triangles retain the existing screen-space cutaway; roof/high triangles always retain custom cutaway.
   Final visible-browser seven-pair medians at 3456×1894: street **103.25→60.65 ms (41.3%)**, interior
   **135.40→84.90 ms (37.3%)**. Paired median savings: 42.25 ms street (MAD 4.30), 48.20 ms interior
   (MAD 7.20). Every pair improved both scenes. CPU remains ~1–1.7 ms. All movement poses matched;
   full captured gameplay RGB matched exactly, excluding only the browser-control overlay rectangle
   `[840,0,890,40]` in the 1728×947 CSS screenshot. No resolution change was made.

## Evidence and limits

Private evidence lives under `~/code/home/artifacts/2026-10-13-outbreak-performance/`.
The Studio proof transfer stalled for ten minutes and was canceled without restarting shared services;
the first whole-tree Mini transfer also stalled and was canceled. A small clean archive excluding unrelated
concept art is the follow-up hardware/check fixture; no shared services were restarted.
Hivemind requires a Git worktree, so the exported 23 MiB fixture is initialized as a private scratch repository
after export, recording the original source revision separately. It is not the working branch or a release checkout.
The first archive check omitted Getaway's 20 KiB `perf/fx-baseline` test fixture; adding that archived directory
fixed the fixture setup. Shared package checks, Outbreak and Blackout checks/builds and dry-runs passed on Mini.
Mini's headless Chrome then crashed before creating a page (`CVDisplayLinkCreateWithCGDisplay` failure and
SIGSEGV); no GPU result is claimed from that host. The small hardware fixture is routed to Studio's existing
logged-in graphics session, without opening a window on Kit's Mac or changing a service.
The first active-building browser run was invalidated by our own Vite HMR during a flag rename and is not
a measurement. Keep the subsequent frozen-source result distinct.

## Final verification and handoff

The clean archive passes root frozen install, shared package checks (42 tests), and each game's complete
typecheck/test/build: Outbreak 17 tests, Blackout 356, Getaway 200 with its 12 existing skips, Carrier 359.
All four Wrangler dry-runs pass; none deploy. Carrier's optional Naga validation was skipped because Naga
is absent. Seed-7 geometry retains all 196,722 vertices, and the new test checks every opaque vertex plus
the genuinely discard-free shader entry point.

Verified Metal GPU intervals remain blocked. Studio fails its SSH/rsync transport; Mini's Chrome crashes
before creating a page. One attempt with `--disable-gpu-vsync` produced the same display-init failure and
SIGBUS, so that unhelpful flag was discarded. No software-renderer benchmark is substituted. The complete
check log and hardware failure are saved as `clean-checks-and-metal-failure.log` beside the runtime proof.
Native production smoke/Metal runtime validation still needs Studio recovery; no services were restarted.

The real-browser runtime win and exact visual/pose agreement are established, but 60–85 ms Retina spans
remain too slow for a 60 FPS target. Any further pass should profile fragment/material/light costs on a
working Metal host before choosing tiled light culling or another larger change. Resolution and appearance
were not reduced. The owned benchmark tab and preview are closed; the shared review preview is untouched.

The source change is committed on `followup/outbreak-performance`, based on `846a9f6`. PR13 is untouched;
open/rebase the follow-up only after release/main, with the hardware limit explicit until it is verified.
No deployment, public sharing, Slack or audio is part of this task. Release PR13 must not wait for it.
