# Getaway look pass

All six Look switches default on. The reviewed frames have smaller amber lamp pools, darker navy gaps,
matte streets, lit shopfront spill, ground contact and cooler roof tops. The colour grade retains more
colour in bright lamps and reduces the blue shadow lift. The helicopter radius and softness remain at 1.

## Implementation

- `tightPools`: street-light radius 17 → 10.5 m, small-light radius 10 → 6 m, warmer light colour,
  lower sky fill and moon intensity. The compact cores have enough diffuse light to survive removing road specular.
- `flatGround`: road and sidewalk specular strength 0.55 → 0.035.
- `shopSpill`: lit street-facing shopfronts record short rectangular footprints during mesh construction.
  Nearby footprints use the existing additive sprite batch. Window room colours are baked into the unused U
  channel and applied in the vertex shader. This adds no dynamic lights or texture fetches.
- `grounding`: short alpha strips at building feet, tree-base discs, an analytic curb-foot term and a
  wider car shadow with four stronger wheel patches. The car shadow extends beyond the body and fades with altitude.
- `wallGradients`: stronger lower-wall darkening and a small cool contribution on upward-facing roof geometry.
- `colourGrade`: a peak-preserving shoulder mixed with the existing ACES curve, less shadow lift and a lighter vignette.

All switches affect presentation only. Disabling them restores the original constants and skips the added decals.
The original airborne-car shadow remains available when Grounding is off.

## GPU measurement

Apple M5 Max, headless Chromium, Apple `metal-3` adapter, 960 × 600, seed 7, frozen route frame 12.
Hardware timestamps sum the render passes, including shadows and post-processing. Queue-completion waits only
pace submission; they are not the reported GPU time.

Each feature and the complete pass received one warmup pair and seven measured runs. Each run contains 24
adjacent on/off hardware samples in alternating AB/BA order. The table reports the median of each run's median
paired difference. The range covers all seven run medians. Raw samples are in `getaway-look-paired.json`.

| Switch | Paired GPU delta, ms | Range, ms |
| --- | ---: | ---: |
| All six | -0.154 | -0.221 to -0.038 |
| Tighter lamp pools | -0.115 | -0.185 to -0.071 |
| Flatter ground | +0.011 | -0.029 to +0.077 |
| Shop-window spill | +0.077 | -0.244 to +0.217 |
| Grounding | -0.002 | -0.034 to +0.060 |
| Wall and roof gradients | -0.016 | -0.149 to +0.260 |
| Colour grade | +0.066 | -0.012 to +0.179 |

For the full pass, the median off/on GPU times were 5.249 / 5.141 ms, and the paired-delta MAD was 0.055 ms.
Every feature's measured median addition is below 0.1 ms. Concurrent simulator/build activity caused wide
individual-feature spreads, so these results do not establish a reliable sub-0.1 ms bound for every feature.
The full pass was cheaper in all seven paired run medians.

## Visual and functional proof

- The pristine baseline is commit `b1d84a31dbd529db65f01678e396434251c91e22`, extracted from this worktree's Git objects.
  No files in the main checkout were changed.
- Stills cover main, all-on and each switch alone at matched frames. The sheet uses frame 12 and includes a car-contact crop.
  The concept sheet also includes frame 60, where the tight helicopter cone is visible.
- The six-second, 30 fps video renders the pristine baseline and look pass separately. All 180 car poses match exactly.
  Encoding uses `h264_videotoolbox`, High profile, quality 75, with no audio track.
- The Lab proof checks six enabled defaults, each switch in both directions, and All Off / All On.
- `compare.html` loads current production on the left and this preview on the right. Both panes loaded and reported
  telemetry in headless Metal Chromium. The existing main preview returned a Vite import-resolution error, so it is
  not used by the comparison page.

Artifacts under `captures/getaway-look/`:

- `getaway-look-sheet.jpg` (1500 × 1020)
- `getaway-look-vs-concept.jpg` (1400 × 990)
- `getaway-look.mp4` (1920 × 600, six seconds)
- `stills.json`, `video.json`, `ui.json`, `compare.json`

## Reproduce

From `games/getaway`, use the existing Nexus preview for `bun scripts/prove-look.ts ui` and `compare`.
For bounded fleet proofs, use `hivemind run --kind browser --fetch captures/getaway-look -- bun scripts/prove-look.ts
stills --fixture` or replace `stills` with `paired --individual`.

For the original-source video, make a Git archive of the baseline containing `games/getaway/src`,
`games/getaway/shared`, its HTML entries, package files, Vite config and `packages/kit`. Pass its path as
`--baseline=...` to `video --fixture`. The runner serves the extracted source with an isolated Vite cache and deletes
the extraction after the run. `python3 games/getaway/scripts/look-sheets.py` rebuilds the sheets from the captures.
