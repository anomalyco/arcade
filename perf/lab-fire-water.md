# Fire and water Lab study

Open either game's `/lab.html`, choose **Fire and water**, then **Style**. Flowing is the default; Graphic has harder
flame bands and a denser jet. Current draws the existing game emitters through the Lab sprite adapter. Each new
style keeps separate settings during this page session. Choose downtown night, office or Getaway alley, adjust
Zoom, pause, retrigger, or toggle the siren lights. Flame and Water controls enable for the matching effect.

The section covers burning wrecks, lingering grenade fire, Getaway fireballs and hydrant water. The new renderer
lives in `packages/kit/fx/fire-water.ts` and `fire-water-shader.ts`; the game/environment adapter lives in
`games/blackout/src/lab/fire-water.ts` and is registered by both games. It is a Lab study, not a change to either
game's production fire/water renderer. The existing production tyre smoke path is unchanged.

## Visual proof

`games/getaway/scripts/prove-fire-water.ts` captures every combination of three generated environments, five
effects, three styles and two camera distances on headless Chromium/Metal. Each style sees the same paused
simulation frame. The script rejects browser/GPU errors. `fire-water-sheet.py` assembles fire and hydrant views
with full frames, so gameplay and close views retain their real relative size.

The first pass looked like separate candles and overly bright concentric puddle bands. The revised pass uses
three unequal flame heights, darker smoke, fewer splash rings, irregular ripple normals and narrower specular
lobes. The water sheet maintains the jet silhouette behind discrete droplets.

```sh
LAB_URL=http://fx-kit-blackout.localhost:1355 bun games/getaway/scripts/prove-fire-water.ts
python3 games/getaway/scripts/fire-water-sheet.py captures/fire-water /path/to/lab-fire-water-sheet.jpg
```

Run the browser proof through `hivemind` on the preview host. `FX_QUICK=1` checks fire/water styles in downtown;
`FX_CAPTURE_ONLY=1` omits timing; `FX_TIMING_ONLY=1` omits screenshots. All effect/style choices remain panel controls.

## Paired GPU measurement

The measurement is the existing Lab timer's dependent interval from polar compute through the offscreen composite,
including the heat-shimmer copy/pass for fire. Presentation is outside the interval. It does not sum pass times.
At 1000×720, each frozen effect/camera case gets two warm-up rounds and nine measured rounds in alternating
Current/Flowing/Graphic order. Each style visit discards four frames and retains eight; comparisons pair the median
of each batch with the same round's Current median. Raw frames, paired medians and median absolute deviations
are retained in `lab-fire-water.json`.

Apple M2 Max / Metal 3, downtown, milliseconds:

| Effect / zoom | Current | Flowing | Graphic | Paired Flowing Δ (MAD) | Paired Graphic Δ (MAD) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fire / gameplay | 0.686 | 0.674 | 0.671 | −0.014 (0.011) | −0.017 (0.009) |
| Fire / close | 1.414 | 1.288 | 1.425 | −0.116 (0.044) | −0.112 (0.113) |
| Water / gameplay | 0.537 | 0.548 | 0.543 | +0.006 (0.003) | +0.006 (0.002) |
| Water / close | 0.787 | 0.812 | 0.817 | +0.042 (0.011) | +0.043 (0.019) |

These are medians of paired batches; a median difference need not equal the difference of medians. Shared-machine
variance is substantial, especially close-up fire, so the negative deltas are not a reliable speedup claim.
The first unbatched pre-merge run had 0.6–4 ms outliers; this warmed-batch run replaces that diagnostic.

The alley clips generated walls at 3.2 m so foreground rooftops cannot hide the source at either zoom.
The geometry uses the real map builders and game props, but the Lab's neutral materials and eight-light budget
differ from the final game renderers. Puddle specular approximates light reflection; it does not reflect buildings.
The analytic spray does not collide with room furniture. The benchmark covers one source and two zooms, not many
simultaneous fires or mobile GPUs. CPU cost and game-renderer integration cost remain unmeasured.

## Checks and delivery

A clean `git archive` export of `ee9e25a` plus this source patch passed a frozen workspace install,
`bun run check:packages`, both games' `bun run check`, and both Wrangler `deploy --dry-run` commands on the Studio.
Blackout passed 267 tests; Getaway passed 178 with 12 existing skips. No deployment was performed.

The contact sheet is `/Users/kit/code/open-source/lamplight/captures/preview/lab-fire-water-sheet.jpg` (1440×1280).
Its inspected 1280-pixel copy is `/Users/kit/code/home/artifacts/2026-10-13-lab-fire-water.jpg`.
