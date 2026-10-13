# Blackout look pass

This report covers the original nine switches. The later [polar-shadow fix](blackout-shadows.md) and default-off
[motion-blur prototype](blackout-motion.md) have separate verification and 1440p GPU measurements.

The C paint-over is the target. Grade, practical lighting, wall faces, contact AO, cap rims, floor pattern and city
depth default on. Tile reflections now also default on after sandbox review; longer furniture shadows remain opt-in.

## What changes

| Look switch | Work added or changed |
| --- | --- |
| Teal & Warm Grade | Tone-curve shoulder, saturation and split-tone terms in the existing composite; less grain and fringing. |
| Warm Practicals | Per-visible-light colour constants on the CPU; warmer tube/sign emission, half-strength fixture haze and reduced office moon wash. Monitor lighting stays cyan. |
| Warm Wall Faces | Wall-only albedo multiplier and stronger direct light. |
| Corner & Contact AO | Reuses baked floor occlusion; one extra floor-map lookup on wall faces, with a height falloff. |
| Blue Cap Rims | Colour constants and a bevel-normal term in the existing cap material. |
| Floor Weave & Tile | More contrast in the existing carpet pile and tile variation terms. |
| City Depth | Replaces the existing city-material pattern with warm/cool windows, soft footprints and faint street-edge pools. Defocus is analytic and confined to this material, without a depth texture or blur pass. |
| Tile Reflections | Changes existing tile shininess/strength constants. |
| Long Furniture Shadows | Lowers the artificial light-height lift used by existing partial shadows, retaining their sharp base and widening penumbra. |

There are no added render passes, frame textures, draws or geometry. Baseline scene/composite pipelines are compiled
alongside the Look pipelines so all-off uses the original arithmetic. Startup compilation cost and CPU cost were not
measured. Downtown's material paths stay on the baseline shader; its grade is still switchable. The lot uses the
office map kind and exercises warm work lights and vehicles.

## Total GPU cost

M5 Max, headless Chromium on Metal, hardware timestamp queries, 1280×800. Each entry has one discarded warmup pair
and seven measured pairs, alternating OFF/ON order. Each side of a pair settles for four frames and averages 24
frozen-time frames. Every timestamp readback is awaited. Total GPU time spans the first compute-pass start to the
last composite-pass end. Pass durations are never summed. Negative or missing samples fail the run.

| Office switch alone | Median paired delta, ms | MAD, ms | Delta range, ms |
| --- | ---: | ---: | ---: |
| All on | +0.071 | 0.077 | -0.070 to +0.305 |
| Grade | +0.022 | 0.060 | -0.252 to +0.410 |
| Practicals | -0.040 | 0.193 | -0.678 to +0.330 |
| Walls | +0.045 | 0.166 | -0.296 to +0.906 |
| AO | +0.023 | 0.019 | -0.000 to +0.175 |
| Caps | +0.026 | 0.008 | -0.042 to +0.051 |
| Floors | +0.028 | 0.012 | +0.012 to +0.089 |
| City | +0.039 | 0.026 | -0.004 to +0.094 |
| Gloss | +0.032 | 0.015 | -0.156 to +0.047 |
| Shadows | +0.030 | 0.010 | -0.022 to +0.076 |

Office all-on OFF/ON medians were 1.349/1.420 ms. Downtown all-on measured -0.009 ms paired delta (MAD 0.034),
and the lot +0.024 ms (MAD 0.020). Individual changes include the baseline-to-Look shader transition, so their
deltas cannot be added. Clock and machine noise dominate several entries; none establishes a speedup.

`blackout-look-paired.json` retains each pair and all 24 total-GPU samples per block, including warmup and outliers.
The full per-pass readback ranges are also retained locally in `captures/blackout-look/paired.json`.

## Visual proof

Baseline revision: `e4625886e34b6d61f724784571e77615f689ec59`.

- Main versus all Look off has zero different RGB pixels in all three 1280×800 views. Pixel hashes are in the JSON.
- The office uses `?sandbox=1&seed=4`, 45 fixed ticks moving down and 300 settling ticks. Downtown and lot use their
  practice URLs, deterministic random numbers and idle bots. The camera is placed by the street/vehicle for those views.
- The baseline and all-off WGSL match after comments and whitespace are removed. A uniform-only implementation and
  a shader-override version left isolated one-code-value differences, so both were replaced by source-level omission.
- Production/current comparison completed 181 paired ticks with zero pose mismatches. All nine Look controls were
  present and All On/Off worked. This run checks synchronized standing poses; the existing movement protocol is unchanged.
- `bun run check` passed 258 tests, both typechecks and the production build.

## Reproduce

From the repository root, prepare the frozen main source used by the baseline capture:

```sh
git archive -o perf/blackout-main.tar e4625886e34b6d61f724784571e77615f689ec59 \
  games/blackout/src games/blackout/shared games/blackout/index.html \
  games/blackout/vite.config.ts games/blackout/package.json packages/kit
hivemind run --fetch captures/blackout-look -- sh -c \
  'cd games/blackout && bun install && bun scripts/build-id.ts && bun scripts/look-proof.ts --baseline && bun scripts/look-proof.ts --bench'
hivemind run --fetch captures/blackout-look -- sh -c \
  'cd games/blackout && bun scripts/look-proof.ts --compare'
python3 games/blackout/scripts/look-sheet.py --references <paintover-directory> --output <sheet.jpg>
```

The proof runner uses its own loopback Vite process, a headless browser and muted audio, and closes both afterward.
The Nexus review stays at `http://blackout-look.localhost:1355`; use `?sandbox=1&seed=4&lab=1`, or
`compare.html?seed=4` for production on the left. Use the shared Lab panel (Backquote) to change the look.
The comparison's `look=0` override is accepted only with `mux=1`, `bench`, or `manualVideo` automation.
