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
misses, in a separate 1024-byte uniform binding (the forest's 2048-byte custom buffer is full).
Moonlit water excludes itself from SSR because reflection history amplified the lunar path
into white patches; SSR remains active on other forest surfaces. This is not a full planar
forest reflection: the canopy is a 64-bin directional approximation.

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
