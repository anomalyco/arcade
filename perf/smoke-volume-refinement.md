# Room smoke grows through filtered density

The room-smoke front now grows smoothly across cell boundaries and is rounder in open space. The same shared
class and shader serve Blackout and the Lab. Twelve controls expose shape, motion, appearance and lifetime.
Getaway's approved tyre simulation and shader are unchanged; the production tyre parity proof remains byte-identical.

## The nearest-density guard caused the square columns

At source `bb0eca4`, `density()` rejected a sample if the nearest cell's density byte was zero. The next line's
linear filtering could therefore never extend into an empty cell. The fixed-seed Metal captures show narrow,
detached-looking columns at frame 20 and a diamond perimeter at frames 40/80. Four-neighbour 0.5 m travel caused
the diamond. Byte truncation further delayed faint density. Both consumers already update smoke once per rendered
frame; there is no hidden low-rate simulation tick in this path.

The fix stores geometry independently from gas. It filters half-float density while checking nearest solid cells,
and suppresses diagonal filter taps when an adjacent wall blocks their path. That last check matters even when
a distant doorway makes both diagonal cells reachable; ordinary bilinear interpolation could jump the corner early.

The field computes weighted travel using cardinal, diagonal and 2:1 moves. Every short move checks its full cell rectangle,
so diagonals cannot cut a blocked corner. The unoccluded metric's maximum angular error is 2.75%; interpolation adds
a small error that the 5% radius test allows. The source is centred in its cell instead of snapped to a corner.
Growth and fade use continuous age; refill uses elapsed seconds. The fixed-size arrays and heap are reused.

The renderer keeps 24 march steps and the 480×320 cap. Its height-slab intersection now uses the configured height
and either ray direction. Depth-aware upsampling still uses four taps. A conservative source-distance rejection
retains a 0.71 m filter footprint, reducing empty-space texture fetches without clipping the interpolated front.

## The inspector edits the shared settings

Select Effects → Grenade smoke. Shape has radius, height, edge softness and billow scale. Motion has growth time,
rise, wind and turbulence. Appearance has extinction and lighting response. Lifetime has hold and fade. Units and
ranges are documented in `packages/kit/fx/README.md` and declared with the typed defaults in `volume-settings.ts`.

Radius, growth and lifetime changes apply on Retrigger. Appearance edits keep the existing cloud and its age.
Wind/rise integrate noise phase, avoiding phase jumps when their speeds change. Each group has constrained Randomize,
Reset and Copy; the whole-effect Copy and Workbench Export include every setting and the independent seed.

## Metal captures compare the actual Workbench

`packages/kit/lab/prove-smoke.ts` (deleted once the Lab moved to knobs; it is in git history) ran through hivemind
after a frozen root install. It served the four original
source modules from `git show <baseline>:<path>` through a Vite fixture and then the fixed modules, without changing
either checkout. On workers without Git metadata, copy those same four files under `.smoke-baseline/{fx,lab}/`
before syncing. `--perf-only` skips temporal capture. Fixtures bind loopback and audio is muted.

The follow-up is based on shipped main `076fb7c` (PR13). Its smoke modules, shared FX, Lab stage/shader, main,
Workbench, panel/navigation and both game Lab entry points are byte-identical to the recorded `bb0eca4` baseline.
The fixed runtime modules also remain identical after the rebase, so the original matched captures still apply.
The proof runner now defaults to `076fb7c`; `SMOKE_BASELINE` selects an explicit historical revision.

The capture uses a 1280×800 Workbench, a 740×722 canvas, fixed source (−1, 0), effect seed 7 and a framed camera.
The panel selects smoke, pauses transport and disables looping. The proof advances 1/60 s at a time. It records
frames 20, 40, 80 and 160, steady frame 360, and fade frames 440, 500 and 540. The silent clip compares the first
four seconds at 30 fps, source left and fixed right. The fixed front lacks the source's detached columns and
Manhattan diamond; fine low-resolution grain remains visible. The clip's encoded frame was inspected.

Evidence directory: `~/code/home/artifacts/2026-10-13-smoke-volume-refinement/`.

- `sheet.jpg`: matched early-growth frames.
- `before-after.mp4`: source left, fixed right; 1280×624, 120 distinct source frames per side, four seconds, silent.
- `before-*.png`, `after-*.png`: full Workbench captures and inspector.
- `report.json`: raw timestamps, memory counts, adapter and exported preset.
- `fx-integration/proof.json`: byte-identical tyre output and a live Blackout grenade, plus motion checks.

The isolated proof reports Apple `metal-3` and zero console/page errors. The bounded local Browser Control preview
also selects smoke through the inspector. Its clicks hit the existing Browser Control 0.8.4 injected `clockNow`
stack-overflow defect; the application state still updates. The existing `browser-control` todo `978855cf` records
that occurrence. It does not appear in the headless Metal proof.

## Cost increases within a fixed budget

On the M5 Max Studio, seven alternating pairs of 20 frames follow one warmup pair. Both variants use the same
Workbench, source, camera and steady age. These compare each version's defaults, including its different front shape.
The table reports medians of run medians and the median paired delta with its median absolute deviation (MAD).

| Interval | Source ms | Fixed ms | Paired delta ms | Delta MAD ms |
| --- | ---: | ---: | ---: | ---: |
| Whole dependent queue, including upload | 0.867 | 1.056 | +0.206 | 0.032 |
| Render GPU, polar/scene through composite | 0.347 | 0.514 | +0.166 | 0.008 |
| CPU start through final timestamp readback | 1.200 | 1.350 | +0.150 | 0.050 |

Whole-queue timestamps come from real one-workgroup markers submitted before simulation/upload and after rendering,
presentation and readback. They include CPU-fed queue idle time and driver scheduling; they are not GPU busy time.
The render interval excludes queue uploads and presentation copy. No overlapping pass spans are summed. One pair
has a +0.405 ms queue delta; it remains in the raw data. Upload-inclusive cost is therefore less certain than
the render-only increase. An initial empty-pass marker experiment returned zero timestamps and was discarded; the
runner now asserts positive intervals and dispatches actual marker work.

CPU typed-array storage is 175,356 bytes versus 92,352 (+83,004). The field upload and texture payload are 36,864
bytes versus 9,216 (+27,648). Grid resolution, four-volume capacity, ray steps and low-resolution target are unchanged.
Spawn-time pathfinding has not been benchmarked separately. Updates and uploads reuse storage.

## Tests cover the front and its barriers

Ten new numerical tests cover monotonic filtered growth, radius isotropy, thin walls, touching diagonal corners,
doors, carving/refill, deterministic reset, timestep consistency, monotonic fade, finite range endpoints and stable
storage. The front-jump threshold is 0.12 m per 60 Hz frame, below one quarter of a 0.5 m cell but over twice the
expected default travel. The 5% angular threshold allows this metric's 2.75% error and filtering while rejecting
eight-neighbour and Manhattan fronts. Existing pool-budget and door tests remain in Getaway's suite.
The old thin-wall test now samples inside its actual 0.10–0.15 m rectangle instead of x=0.25, which only fell in a
blocked cell under the old snapped grid. The GPU proof also compiles the actual `density()` WGSL as a compute probe:
the blocked diagonal reads exactly zero with source density 0.974, while an empty nearest cell on the growing front
retains filtered density 0.011. This exercises the shader rather than only a CPU reconstruction.

Clean-export verification on the fleet passed the frozen root install, package check (50 tests), Getaway check
(208 pass, 12 existing skips), Blackout check (364 pass) and Outbreak check (15 pass). Every game built, completed
Wrangler's deployment dry-run and passed its production-bundle browser smoke load. The export started from the
staged Git tree archive, with the subsequent staged correction diff applied in a fresh directory. The wrapper's
log-file fetch failed because its output directory was absent on that worker; the complete successful command
output was recovered as `checks.log`. No deployment ran.

This remains a shallow, wall-clipped visual approximation. Walls are conservatively expanded to cells, so sub-cell
doors can close and wall silhouettes still follow the raster. There is no pressure solver, vertical furniture flow,
or server-side visibility change. The static 24-step jitter still leaves fine grain; no global blur hides geometry.
