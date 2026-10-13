# Window-light edges

The window-side floor bands come from the baked moonlight mask, independently of the polar fixture shadows.
`bakeFloor` formerly classified one centre sample per 0.125 m texel, marched a quantised blocker grid in 0.1875 m
steps, then applied a three-tap box filter in each direction. Thin slanted mullion shadows became broad cloudy bands;
diagonal boundaries retained the grid steps. The GPU sampler was already bilinear.

The first candidate integrated exact visibility over each original texel. It preserved the mullions but still showed
coarse diagonal edges at close zoom, so that resolution alone was insufficient.

## Change

- Keep the AO map and its two existing blur passes at their original resolution.
- Give office moonlight a separate R8 mask at four times the linear resolution, approximately 3.125 cm per texel.
- Integrate 2×2 coverage samples per moon texel. Intersect the window-to-receiver segment with world-space blocker
  rectangles exactly, retaining the existing receiver/window clearances and occluder selection.
- Remove the office moon mask's broad box filter. Keep the existing sill/head falloff and bilinear sampling.
- Sample the new moon mask alongside AO in `floorData`. Downtown retains its existing sky-mask algorithm and resolution.

The change adds one R8 texture and one filtered lookup per `floorData` call. It adds no render pass or fullscreen filter.
Window coverage is baked when a level loads. AO bytes, floor textures/materials and animation code are unchanged.

## Reproduce

```sh
git show 4479061:games/blackout/src/render/level-mesh.ts > games/blackout/scripts/window-baseline.txt
hivemind run --kind browser --fetch captures/blackout-window -- sh -c \
  'cd games/blackout && bun scripts/window-proof.ts'
```

The temporary baseline file supplies the historical bake to the remote proof; remove it afterward.
The proof renders seed 2's wood window room and seed 4's blue-carpet window room. For each, it captures all Look
effects off/on crossed with motion blur off/on, with the old bake, corrected bake and moon-only ablation. The camera
and scene time are fixed for each matched set. It also drives ordinary movement and hashes every submitted instance
transform, player state and camera matrix across all four settings.

GPU measurements compare the original single RG lookup and old bake against the new separate moon lookup/bake.
Both use the same fixed wood-room scene, all Look effects on, motion off, and a 2560×1440 offscreen final composite.
Textures and pipelines are prepared once. After 32 warmup pairs, each block alternates 48 before/after frame pairs,
reversing their order every pair. One block is discarded and seven retained. Timestamp readbacks are awaited;
whole-frame ranges are used rather than summed overlapping passes.

## Results

- 270 tests, typechecks and production build pass. Regression cases cover a two-centimetre blocker, a mullion's dark
  core and rotational coverage consistency. All browser/Metal captures completed without errors.
- The coarse bands persist with all Look effects off and motion off; zeroing only moonlight removes them. Look changes
  contrast and moon strength (Warm Practicals scales it to 0.68), exposing the bake differently rather than generating it.
- Both maps have **zero changed AO bytes**. With Look on, static blur-off/on frames are pixel-identical; all-Look-off
  frames differ at only one pixel. Motion blur therefore does not cause these static light bands.
- The 24-frame movement traces have identical hashes across all four settings for both rooms, including every submitted
  instance transform, player state and camera matrix. PR #5 also has no `anim.ts` diff. The matched images show blur
  softening the same moving limbs and the Look changing their contrast. No pose regression was reproduced. These fixed
  camera traces do not diagnose live frame pacing. Blur remains optional and default off.

### Cost on M5 Max

| Fixture | Median bake before → after | Extra R8 texture bytes |
| --- | ---: | ---: |
| Wood room, seed 2 | 3 → 34 ms | 1,942,304 (1.85 MiB) |
| Blue room, seed 4 | 3 → 59 ms | 1,681,120 (1.60 MiB) |

Bake times are seven warmed alternating measurements, using wall-clock milliseconds in headless Chromium. This cost is
paid when loading the level. Per-frame work adds one filtered moon lookup and no passes. The interleaved 1440p GPU
delta was **−0.00048 ms median, MAD 0.00249 ms**, with block deltas from −0.00464 to +0.00481 ms. That is no measurable
change in this fixture, not a speedup or a guarantee for every scene.

The initial long-block GPU run swung by roughly a millisecond as the GPU changed operating speed. `proof.json` retains
that diagnostic; `cost.json` contains the more tightly paired result with preallocated textures and per-frame ordering.

### Evidence

The local artifact directory `2026-10-13-blackout-window/` contains reviewed, native-size matched crops:
`wood-before-after.jpg`, `blue-before-after.jpg`, `moon-ablation.jpg`, `movement-settings.jpg`, raw state/timing reports
`proof.json` and `cost.json`, and `blackout-window-check.log`. All review sheets are at most 1200 pixels wide.
