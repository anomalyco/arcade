# Shared night sky ledger

Branch: night-sky, rebased onto `0a28cd80` (origin/main, 22 October 2026).

## Goal

A single shared sky for Arcade. Judge the production woods images against the targets, retaining dark foreground silhouettes. Stability and visibility instruments support that review. Kit's latest direction removes exact GPU timing and quiet-mini waits; historical measurements below remain evidence of earlier revisions only. Absolute calibration remains open.

## Contract and research

`~/code/home/artifacts/sky-2026-10-22/{RESEARCH,INTERFACE}.md`.
Sky owns `packages/kit/sky`; weather owns clouds and shared eye adaptation. Woods owns scene calibration/adoption. Main does not contain forest yet.

## Kept local commits

- `8b120607`: credited catalogue and astronomical photometry.
- `8d59da1d`: typed settings, assets and lunar light contract.
- `a1a18a77`: production sky renderer/controller and opt-in infinity TAA.
- `74b2f9db`: lunar mips, dark-disk occultation and expanded GPU proofs.
- `6789f767`: opt-in Lab/Lot/Night Shift/Outbreak adapters, credits and consumer capture fixture.
- `4e03cdcf`: initial experiment ledger.
- `f868f9d5`: review fixes and adapted visibility.
- `3b428a58`: exact default parity via geometry windows, synchronous Outbreak proof and visibility instrumentation.

Nothing pushed. The adapters are candidates; actual visibility and verification limits are below.

## Experiments

1. Research and provenance only. HYG share-alike rejected under asset rules; selected explicitly public-domain BSC5 JSON conversion and NASA SVS CGI Moon Kit. Procedural Milky Way avoids double-counting stars in an all-sky texture. No rendered baseline or target generated yet.
2. Catalogue/photometry: 6 tests, 541 assertions passed. Model: 3 tests, 14 assertions passed. Typed Today/physical settings, lunar lighting output and lazy local asset loading added. Moon none and Today yield zero moon illuminance.
3. Real woods frames captured from the existing :5298 preview using its autoplay hook. Initial menu-obstructed captures rejected; final clearing-up/lake frames have no menu. Paint-over edits generated before writing renderer code (`artifacts/sky-2026-10-22/targets`, generation provenance alongside). Candidates overstate star density and crescent angular size; retain the restrained palette/dark foreground, not those inaccuracies. No Kit approval yet.
4. Production SkyPass compiled without GPU errors on mini (Metal, 1920×1080, 4×MSAA). Single-star HDR flux across 32 subpixel phases: mean 1.320421, peak-to-peak **0.035114%**, below the 1% limit. This measures integrated point energy, not whole-scene TAA or visibility in woods.
5. Mini paired sky-only render-pass cost: 14 alternating pairs, median delta **+0.204286 ms**, MAD **0.027605 ms**. Physical median 0.219431 ms; concurrent worker activity caused outliers up to 3.94 ms in the empty baseline. Original raw observations are preserved in the gallery's `proof/report-initial.json`. Prior woods baselines spilled to Studio; those are not timing evidence. Whole-frame forest measurements remain pending.
6. Kit typecheck passed; existing temporal tests: 4 passed / 38 assertions. Shared TAA now has an opt-in infinity reprojection path; default remains off. Mini GPU translation proof passed: **0.030859 px** centroid drift after **64 m** travel, against a 0.05 px bound. Adapter explicitly reports Apple / metal-3. This uses the isolated production sky and temporal resolve, not a forest scene.
7. Lunar follow-up: mask catalogue stars behind the entire lunar disk, including its dark side. Added linear-light texture mips and trilinear sampling after finding that the 2K texture was sampled at level zero on an approximately eight-pixel Moon. Renderer and asset code now both import lazily. Mini occultation proof passed: unobscured star energy 1.188713, energy through the crescent's disk **0**, no GPU errors. Worker and local asset/shader SHA-256 hashes matched after capture. Initial timing numbers predate these changes.
8. Workspace verify completed **red**: 72 steps, 617.8 s after queueing. Every typecheck, build and dry-run passed; Lab, Lot and Night Shift tests passed. Missing `sky/*` architecture classification was ours and is fixed (both architecture tests pass); the earlier two Lab scene failures also pass after reusing the existing world kind. Remaining failed targets: walkers tests, Blackout tests, kit tests, Outbreak tests and Lot smoke. Printed failures are wall-clock limits under concurrent load (including 32 Outbreak failures, whose output was truncated); Lot missed its 60 s ready deadline without browser errors. Do not call this a clean workspace verification.
9. Targeted timing rerun: 3 passed, 5 failed. Walkers learning, Blackout generation, Outbreak behaviour and kit ragdoll budgets remained red on loaded Studio. Outbreak's full failure list was not retained by verify; not every failure has been classified as unrelated.
10. Post-mip sky proof spilled from mini to Studio: no GPU errors, star energy variation still **0.035114%**. Its timings do **not** replace the original mini result. `captures/sky-gpu/report.json` now contains this Studio run.
11. Consumer capture fixture initially copied the canvas before `Renderer.render()`'s queued microtask drew it. Night Shift's black frames and Lot's stale frame are rejected as appearance evidence. The fixture now uses the production synchronous `drawTo()` entry point and rejects blank frames. The initial runs did verify lazy assets and mode switching, with no browser errors. Lot uses the production build because its existing public `paint.js` import fails in Vite dev mode.
12. Delta typechecks passed for kit, Getaway/root scripts, Lot and Night Shift, including the final synchronous capture-fixture change. Opt-in adapters share `attachSky`; default mode is Today. Pixel parity against main is not yet measured.
13. Corrected production-build consumer checks passed on Studio: Lot and Night Shift fetched no sky assets in Today, fetched both assets in Physical, returned to Today and logged no browser errors. Nonblank frames inspected. This is **adapter operation evidence only**: catalogue detail is not visible through Lot's existing cloud/fog/depth-blur stack; Night Shift's aperture changes but visible stars/Moon are not established. Keep both visibility tasks open. Restricted Night Shift's glass discard to exterior panes so its rotated internal-office pane remains intact; all nine generated shaders passed Naga validation afterwards.

## Review round: 22 October

- Corrected lunar north-up basis; expanded star quads to 3 px; host local-solar clock/daylight now drives Lab and Outbreak.
- Failed code imports wait for late asset acquisition and release it. Explicit load or Today → Physical retries; per-device reference-counted leases share the catalogue and Moon upload.
- Night Shift's Office uniform initially grew **56 → 60 floats** (224 → 240 bytes), including a new sky-control vec4. The geometry-aperture revision restores **56 floats**, and its shaders match main exactly. The TAA fields reused padding; the original Office fields did not.
- Candidate adapted vision redistributes catalogue flux with a magnitude-7 floor and exponent 0.65, normalizing the aggregate budget; 0.72 px integrated PSF. Host adaptation supplies bounded 1–10× observer sensitivity, with no sky history. This is a perceptual pre-composition response, not calibrated physical radiance; weather composition still needs agreement.
- Targeted model/resource/perception tests: 10 passed, 49 assertions. Real-catalogue aggregate flux error <1e-6.
- Review GPU run spilled from mini to Studio: photometric variation **0.035087%**, adapted **0.035832%**, translation drift **0.031247 px** over 64 m, lunar transmission zero, no GPU errors. Not mini timing evidence.
- Main baseline production builds for Lot/Night Shift/Outbreak completed at `d4b6a9f2`. Final default frames for **all three are pixel-identical** at 1920×1080. The initial Night Shift shader aperture changed nine pixels by one byte, with an exact baseline/control; moving the discard did not help. Geometry apertures remove that shader change. Synchronous parity rejects blank frames; Outbreak uses its actual `__arcadeHarness`.
- Night Shift's final production consumer check passes with no errors: zero Today sky-asset requests, both assets in Physical, return to Today. The inspected frame shows stars through the blind gaps; the Moon is outside this view.
- Integration tree `night-sky-woods` is now based on woods `fe3e6756`; owner tree remains separate.
- Production woods clearing/lake Today/new stills use a matched 8 s render clock and the existing host eye response. Six-second camp look-up retained from the advancing-clock run. Both captures pass without browser/GPU errors. Forest and root-proof typechecks pass.
- Matched-clock visibility, strong peaks ≥12/255: clearing **0 → 446** (target 4868), lake **0 → 298** (target 4263). Diffuse contrast clearing **0.432** (target 0.418), lake **0.155** (target 0.461). New sky medians **7.93/255** and **9.28/255**, targets **7.14** and **6.14**. Weak sensor-noise peaks are reported separately; generated points are image features, not astronomical counts.
- Woods bridge originally committed as `7c319cd5`; rebased onto current woods **`fe3e6756`**, now **`d8df2180`** (reviewed core `97220ab7`). Includes typed settings, host eye-state mapping, finite-mist sky predicate, distant-spot lunar shadows, production capture script and credits. Current-base kit/root-script typechecks, production build and clearing/lake captures pass without browser/GPU errors. Inspected stills and regenerated statistics are published; metrics match the prior matched-clock capture. The six-second camp clip retains the earlier woods `4d14b07f` base.
- Mini review timing attempt waited 1800 s and exited 75 without running. The longer queue was cancelled by the server restart. No timing job or timing wait remains; per Kit's latest direction this is no longer a completion gate. Final main root-script typecheck passed before the restart.

## Shipping delta review

- Opus delta review reported no blockers; the preceding sky/GPU run passed 181 tests.
- Woods already supplies `darkAdaptation` from its camera stops in the separate integration branch.
  Main-branch hosts omit it and therefore use the fully dark-adapted fallback, attenuated by daylight.
- Adapted vision still brightens the diffuse dome and lunar halo by up to 10× and the Galactic band
  by an additional 6×. It is a whole-sky perceptual candidate, not only a faint-star boost.
  The lunar disk is now excluded from that sensitivity gain.
- The dome now uses the same selected daylight value as the stars; host-clock mode no longer
  overrides the host with a brighter astronomical twilight in the shader.
- Existing review-gallery Physical frames predate these two shader corrections; Today is unchanged.

## Remaining limits

- Lot celestial visibility through its cloud/fog/blur stack.
- Absolute scene calibration: current reference conversion is explicitly 1 scene unit per cd/m².
- Woods owner adoption and ground-facing verification of the distant-spot lunar-shadow approximation.
- Weather cloud/transmittance and adaptation integration with the single Sky station.
- Workspace verification remains red as recorded in experiments 8–9; not all Outbreak failures were classified. No clean-workspace claim.
