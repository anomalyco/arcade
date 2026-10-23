# BARBARA lake water, 2026-10-22

Ported from the retired local `woods` integration onto main after BARBARA (#447) and the
ocean (#455) shipped. Only the lake came over: forest lake optics, the shared-sky reflection
adapter, the canopy uniform/sky-cube fix and the SSR lunar-feedback fix. Ocean and kit
water modules already on main were not duplicated.

Opt-in: BARBARA keeps the Today lake by default. `?lab=water` (solo only) applies the
moonlit preset and opens the Water group with a draggable log; Lab › Water › Water look
switches any session to Moonlit.

The lake uses production `kit/sky` for visible stars/moon and a cached HDR reflection cube.
The lunar disk is excluded from the cube; shared lunar lux drives a ripple-modulated microfacet
path. Actual tree positions/heights provide a coarse canopy mask for off-screen reflection
misses. This is not a full planar forest reflection: the canopy is a 64-bin directional
approximation.

Today is inert: the forest scene shader, `WOODS_FLOATS` and group-1 layout are main's
(`scripts/lake-pins.ts` checks the shader byte for byte). Choosing Moonlit creates the cube, the
lake uniform buffer (frame + canopy) and a separate water-only pipeline (compiled async; Today
water draws until it is ready). Fresnel, transmission and the lunar lobe reuse kit water
(`waterFresnel`, `waterTransmission`, `waterSpecular`). SSR skips the lake through a per-frame
exclusion ellipse (`ssrVolume({ exclude: true })`, inert when off), so the fog's torch-shaft and
camp-light reflections still reach the water.

Ripple, rain and surface-mist phases are periodic over 64 seconds. Log drag limits and
starting pose derive from the world's lake/dock. The probe uses the same simulation clock
as the forest frame.

No paired timing; GPU cost is unmeasured. Proof results for this port are recorded below.

## Port proof (main 097dd477 + lake)

- HiveMind on mini: BARBARA client and server typechecks, kit and root-script typechecks pass;
  73 targeted tests pass (BARBARA, kit forest, architecture map, Lab stations) with
  `bun test --max-concurrency 4`; BARBARA production build passes.
- Mini/Metal stills in BARBARA at night, same pose and clock: no shader/page errors. Real log
  drag moves the log; Edit blocks walking and pointer lock; the Today control works.
- Today: milky grey wash with speckled glints and a tiny moon dot. Moonlit: dark water, broken
  moon glitter path, no wash. The far shore reads as a dark band, not reflected trees.
- Decision: stays opt-in. It clearly beats Today, but the treeline is not actually reflected.

## Review fixes (Argon review)

- Cube faces were upside-down: clip y is flipped so each face matches WebGPU sampling
  (`lake-sky.test.ts` maps directions to face/uv). Horizon rays now read the sky half.
- Today allocates nothing (proof: `todayInert`); Moonlit resources are lazy, as above.
- `?lab=water`: the shell's overlays stay hidden in Edit, Play keeps the F torch, the story
  doesn't start.
- Stills after the fixes: unchanged in character. Dark water, broken moon path, no wash. The far
  shore still reads as a dark band, not tree shapes: under a dark sky a black treeline reflects as
  black, so the upright cube adds no visible structure. Stays opt-in.
