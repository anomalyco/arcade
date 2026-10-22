# Shared night sky ledger

Branch: night-sky, base 52e5b830 (origin/main, 22 October 2026).

## Goal

A single calibrated sky for Arcade. Primary metric: unintended star flux variation under subpixel motion with scintillation disabled. Secondary: detectable stars at woods exposure; paired GPU delta on mini at 1920×1080. Budget <0.5 ms for the sky alone. Baseline not measured yet.

## Contract and research

`~/code/home/artifacts/sky-2026-10-22/{RESEARCH,INTERFACE}.md`.
Sky owns `packages/kit/sky`; weather owns clouds and shared eye adaptation. Woods owns scene calibration/adoption. Main does not contain forest yet.

## Experiments

1. Research and provenance only. HYG share-alike rejected under asset rules; selected explicitly public-domain BSC5 JSON conversion and NASA SVS CGI Moon Kit. Procedural Milky Way avoids double-counting stars in an all-sky texture. No rendered baseline or target generated yet.
2. Catalogue/photometry: 6 tests, 541 assertions passed. Model: 3 tests, 14 assertions passed. Typed Today/physical settings, lunar lighting output and lazy local asset loading added. Moon none and Today yield zero moon illuminance.
3. Real woods frames captured from the existing :5298 preview using its autoplay hook. Initial menu-obstructed captures rejected; final clearing-up/lake frames have no menu. Paint-over edits generated before writing renderer code (`artifacts/sky-2026-10-22/targets`, generation provenance alongside). Candidates overstate star density and crescent angular size; retain the restrained palette/dark foreground, not those inaccuracies. No Kit approval yet.
4. Production SkyPass compiled without GPU errors on mini (Metal, 1920×1080, 4×MSAA). Single-star HDR flux across 32 subpixel phases: mean 1.320421, peak-to-peak **0.035114%**, below the 1% limit. This measures integrated point energy, not whole-scene TAA or visibility in woods.
5. Mini paired sky-only render-pass cost: 14 alternating pairs, median delta **+0.204286 ms**, MAD **0.027605 ms**. Physical median 0.219431 ms; concurrent worker activity caused outliers up to 3.94 ms in the empty baseline. Raw observations in `captures/sky-gpu/report.json`. Prior woods baselines spilled to Studio; those are not timing evidence. Whole-frame forest and TAA measurements remain pending.
6. Kit typecheck passed; existing temporal tests: 4 passed / 38 assertions. Shared TAA now has an opt-in infinity reprojection path; default remains off. Full GPU translation proof pending.

## Verification pending

- Real woods clearing-up/lake targets before visible changes.
- Pixel-integrated star PSF invariance, astronomy reference positions and phase/lux.
- GPU compilation, ≤1% unintended star energy variation with motion; TAA integration.
- Today pin/parity, mini GPU, actual woods star count, requested clip.
- Workspace verify; no push.
