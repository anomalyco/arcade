# Shared night sky ledger

Branch: night-sky, base 52e5b830 (origin/main, 22 October 2026).

## Goal

A single calibrated sky for Arcade. Primary metric: unintended star flux variation under subpixel motion with scintillation disabled. Secondary: detectable stars at woods exposure; paired GPU delta on mini at 1920×1080. Budget <0.5 ms for the sky alone. Baseline not measured yet.

## Contract and research

`~/code/home/artifacts/sky-2026-10-22/{RESEARCH,INTERFACE}.md`.
Sky owns `packages/kit/sky`; weather owns clouds and shared eye adaptation. Woods owns scene calibration/adoption. Main does not contain forest yet.

## Experiments

1. Research and provenance only. HYG share-alike rejected under asset rules; selected explicitly public-domain BSC5 JSON conversion and NASA SVS CGI Moon Kit. Procedural Milky Way avoids double-counting stars in an all-sky texture. No rendered baseline or target generated yet.

## Verification pending

- Real woods clearing-up/lake targets before visible changes.
- Pixel-integrated star PSF invariance, astronomy reference positions and phase/lux.
- GPU compilation, ≤1% unintended star energy variation with motion; TAA integration.
- Today pin/parity, mini GPU, actual woods star count, requested clip.
- Workspace verify; no push.
