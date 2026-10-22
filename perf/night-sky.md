# Shared night sky ledger

Branch: night-sky, base 52e5b830 (origin/main, 22 October 2026).

## Goal

A single calibrated sky for Arcade. Primary metric: unintended star flux variation under subpixel motion with scintillation disabled. Secondary: detectable stars at woods exposure; paired GPU delta on mini at 1920×1080. Budget <0.5 ms for the sky alone. Isolated baseline measured; woods visibility remains pending.

## Contract and research

`~/code/home/artifacts/sky-2026-10-22/{RESEARCH,INTERFACE}.md`.
Sky owns `packages/kit/sky`; weather owns clouds and shared eye adaptation. Woods owns scene calibration/adoption. Main does not contain forest yet.

## Kept local commits

- `4dd50ca2`: credited catalogue and astronomical photometry.
- `efa04ad7`: typed settings, assets and lunar light contract.
- `64193600`: production sky renderer/controller and opt-in infinity TAA.
- `b053ae99`: lunar mips, dark-disk occultation and expanded GPU proofs.
- `34f4860d`: opt-in Lab/Lot/Night Shift/Outbreak adapters, credits and consumer capture fixture.

Nothing pushed. The adapters are candidates; visibility/calibration and parity gates below remain open.

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

## Verification pending

## Review round: 22 October

- Corrected lunar north-up basis; expanded star quads to 3 px; host local-solar clock/daylight now drives Lab and Outbreak.
- Failed code imports wait for late asset acquisition and release it. Explicit load or Today → Physical retries; per-device reference-counted leases share the catalogue and Moon upload.
- Night Shift's Office uniform grew **56 → 60 floats** (224 → 240 bytes), including a new sky-control vec4. The TAA fields reused padding; the Office fields did not.
- Candidate adapted vision redistributes catalogue flux with a magnitude-7 floor and exponent 0.65, normalizing the aggregate budget; 0.72 px integrated PSF. Host adaptation supplies bounded 1–10× observer sensitivity, with no sky history. This is a perceptual pre-composition response, not calibrated physical radiance; weather composition still needs agreement.
- Targeted model/resource/perception tests: 10 passed, 49 assertions. Real-catalogue aggregate flux error <1e-6.
- Review GPU run spilled from mini to Studio: photometric variation **0.035087%**, adapted **0.035832%**, translation drift **0.031247 px** over 64 m, lunar transmission zero, no GPU errors. Not mini timing evidence.
- Main baseline production builds for Lot/Night Shift/Outbreak completed at `d4b6a9f2`. Synchronous parity driver rejects blank frames; comparisons pending.
- Integration tree `night-sky-woods` is based on woods `4d14b07f`; owner tree remains separate.

- Consumer celestial visibility through atmosphere/windows.
- Default pixel parity against main; current reference conversion is explicitly 1 scene unit per cd/m².
- Woods adoption/base agreement, exposure calibration, actual star visibility, shadowed moonlight and camp clip.
- Weather cloud/transmittance and adaptation integration with the single Sky station.
- Resolve workspace timing/smoke failures; no push.
