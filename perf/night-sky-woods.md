# Woods night-sky integration checkpoint

Base: woods `4d14b07f`, plus the sky core through `3961d857` (equivalent to main-based `f868f9d5`). This branch is local and separate from the woods owner's tree.

## Kept

- `ForestLookSettings` includes typed shared sky settings. Today is the default and retains its existing sky pass. The production `attachSky` handle is available as `forest.sky`.
- The host supplies its existing camera adaptation stops, normalized between `-adaptRange` and `adaptLift`. Scene-unit conversion is 1, matching the reference physical-light convention; this is a candidate observer mapping, not a measured luminance calibration of the whole forest.
- The extra distance-darkening medium now has an explicit sky predicate. In Physical mode only, it applies to finite scene surfaces, rather than extinguishing the sky at `FOG_SKY_DISTANCE`. The finite mist-bank transmittance still applies to the sky.
- Moon phase/direction/lux come from the shared sky. Near-field moon shadows reuse a distant spotlight map and existing terrain/cut-out foliage casters. Rays are approximately parallel over the 100 m region; this is not a cascaded directional-shadow implementation. The old unshadowed moon term remains only in Today.
- A pre-existing typecheck error in `build.test.ts` is corrected with a non-null assertion after `Map.has`.

## Evidence

`scripts/sky/woods-checkpoint.ts` captures production clearing-up and lake Today/new views through the real forest post, at 1920×1080. It uses synchronous canvas GPU readback. Final stills freeze the render clock at 8 s and hold the sim while allowing the existing eye response to settle. The camp look-up clip uses ordinary advancing scene time.

The first production capture and six-second camp clip completed on Studio with no browser/GPU errors. Both new views show catalogue stars, Galactic structure and a small hazy crescent above dark forest silhouettes. The Moon adds one shadow layer. Final measurements and linked media are in the shared sky gallery.

## Remaining boundaries

- Woods owner's final adoption and weather's common eye-response/composition agreement remain to be confirmed.
- The observer gain is applied to sky before volumetric composition. Cloud/flash radiometry must account for that candidate response before combining branches.
- A shadow map running successfully does not establish shadow accuracy; the distant-spot approximation needs a ground-facing lunar comparison.
- The generated targets have substantially more strong point-like peaks than this finite catalogue. Weak peaks in the actual frames also include the forest camera's sensor noise.
