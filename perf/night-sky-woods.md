# Woods night-sky integration checkpoint

Base: woods `2cb0fb0e`, including woods-camera and the staged highlight shoulder/camp dressing.
Reviewed core: `36396d73`; bridge: `80db0cfa`. This supersedes the integration on `fe3e6756`
(core `97220ab7`, bridge `d8df2180`) and the original `4d14b07f` integration.

Main sky shipped in PR #430, squash merge `3b80159ca8dfaa51f9bf5a7b591b293db4256658`.
The shared sky source here matches that merge, including the final corrections: the lunar disk
is excluded from the adapted gain, and dome/stars use the same selected twilight value.
Woods already supplies `darkAdaptation` from its camera stops. Today remains the default;
Kit decides whether to promote Physical. The earlier gallery stills and camp clip retain their
documented bases and predate these final shader corrections.

Post-rebase checks passed sequentially through strict-pinned HiveMind Pro: kit, root-script,
woods client and woods server typechecks. Runtime settings assertion confirms Today is the
default. `git diff 3b80159c -- packages/kit/sky` is empty.

## Kept

- `ForestLookSettings` includes typed shared sky settings. Today is the default and retains its existing sky pass. The production `attachSky` handle is available as `forest.sky`.
- The host supplies its existing camera adaptation stops, normalized between `-adaptRange` and `adaptLift`. Scene-unit conversion is 1, matching the reference physical-light convention; this is a candidate observer mapping, not a measured luminance calibration of the whole forest.
- The extra distance-darkening medium now has an explicit sky predicate. In Physical mode only, it applies to finite scene surfaces, rather than extinguishing the sky at `FOG_SKY_DISTANCE`. The finite mist-bank transmittance still applies to the sky.
- Moon phase/direction/lux come from the shared sky. Near-field moon shadows reuse a distant spotlight map and existing terrain/cut-out foliage casters. Rays are approximately parallel over the 100 m region; this is not a cascaded directional-shadow implementation. The old unshadowed moon term remains only in Today.
- A pre-existing typecheck error in `build.test.ts` is corrected with a non-null assertion after `Map.has`.

## Evidence

`scripts/sky/woods-checkpoint.ts` captures production clearing-up and lake Today/new views through the real forest post, at 1920×1080. It uses synchronous canvas GPU readback. Final stills freeze the render clock at 8 s and hold the sim while allowing the existing eye response to settle. The camp look-up clip uses ordinary advancing scene time.

The first production capture and six-second camp clip completed on Studio with no browser/GPU errors. Both new views show catalogue stars, Galactic structure and a small hazy crescent above dark forest silhouettes. The Moon adds one shadow layer. Final measurements and linked media are in the shared sky gallery.

Matched-clock stills also pass without browser/GPU errors. Strong peaks ≥12/255: clearing 446 (target 4868),
lake 298 (target 4263); Today has zero in both fixed upper-sky regions. Diffuse contrast is .432/.155,
versus targets .418/.461. Sky medians are 7.93/9.28 per 255, versus 7.14/6.14. Weak peaks include sensor
noise and are counted separately. `spots.rendered` in the capture stats counts maps redrawn that frame,
not active shadow slots: a fixed lunar map can report zero once cached.
Current woods `fe3e6756` kit/root-script typechecks, production build and fresh clearing/lake captures pass
without browser/GPU errors. The inspected current-base stills are published with regenerated statistics;
the values above match the prior matched-clock run. The six-second camp clip retains the original
`4d14b07f` woods base. Exact timing is no longer a review gate per Kit; no quiet-mini wait.

## Remaining boundaries

- Woods owner's final adoption and weather's common eye-response/composition agreement remain to be confirmed.
- The observer gain is applied to sky before volumetric composition. Cloud/flash radiometry must account for that candidate response before combining branches.
- A shadow map running successfully does not establish shadow accuracy; the distant-spot approximation needs a ground-facing lunar comparison.
- The generated targets have substantially more strong point-like peaks than this finite catalogue. Weak peaks in the actual frames also include the forest camera's sensor noise.
