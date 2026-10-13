# Blackout motion blur

`Motion Blur` is a default-off Look switch in the shared Lab panel. The prototype writes per-pixel velocity alongside
scene colour, then gathers eight depth-weighted samples plus the centre in the existing composite. Camera movement
and moving actors, ragdolls, grenades and vehicle parts use the previous submitted view-projection matrix and transforms.
Tracers and muzzle flashes carry stable sprite identities and previous centres. The DOM HUD and crosshair stay sharp.
The sub-0.5 ms GPU target is not established: paired timings on this machine remain too variable to certify that budget.

## History follows submitted frames

`src/render/motion.ts` holds weak owner/part identities and previous transforms. Each model's ordinal is scoped to its
owner, so reordering model batches or removing another actor cannot transfer velocity between actors. History advances
in `Renderer.draw`, after frame coalescing. First frames, missing identities, level changes, resizes, long frame gaps,
large camera cuts and teleports reset velocity.

After sandbox review, exposure is 1/60 second, capped at two frames, and the maximum blur length is 32 pixels.
The first 1.25 pixels of displacement are suppressed so slow camera following stays sharp. The velocity attachment
stores pixel displacement and distance from the camera in RGBA16F, with the scene's four-sample MSAA resolve. Transparent
surfaces blend their motion by opacity; a single blended field approximates overlapping transparent layers. Sprite
motion tracks centres, while mesh parts include rotation and scale. Tracked flash/tracer quads extend their trailing
edge by the same bounded shutter displacement, so thin effects can streak beyond their original silhouette. New
transients start from their emission point. Tracers use a 32-metre continuity threshold because normal flight at
240 m/s exceeds the actor teleport threshold of 4 metres per frame. Flying casings and sheets now have stable keys.
There is no temporal colour feedback or tile-max expansion. Velocity targets allocate on first enable and are recreated on resize.

## Whole-frame GPU measurement

The fixture replays the same camera pan and per-owner transforms over real office, downtown and vehicle-lot geometry.
It separately captures camera-only and object-only motion. This is a deterministic rendering fixture, not a timed
gameplay benchmark. A separate live-input proof turns the Lab switch on, moves and fires, checks populated sprite/part
histories, and verifies that resize resets motion.

The measurements below predate the stronger shutter and transient-silhouette tuning. They do not establish the tuned
implementation's cost. M5 Max, headless Chromium/Metal, 2560×1440. Each effect has one discarded warmup pair followed by seven alternating
OFF/ON pairs. Each block settles for 32 frames and averages 96 frames. Hardware timestamp readback is awaited; total
time spans the first compute start through the final composite end. The final composite uses an offscreen attachment
with the canvas's size and format to exclude presentation contention. Overlapping pass timings are never summed.
Motion is compared with the recommended look and shadow filter enabled on both sides; shadow filtering is compared
with motion disabled on both sides.

| View | Motion delta, ms | Motion MAD, ms | Shadow-filter delta, ms | Shadow MAD, ms |
| --- | ---: | ---: | ---: | ---: |
| Office | +0.060 | 0.345 | +1.341 | 0.282 |
| Downtown | -0.312 | 0.896 | -0.101 | 0.338 |
| Vehicle lot | +0.237 | 0.273 | +0.410 | 0.134 |

These are medians of paired differences, with median absolute deviation (MAD). Negative values indicate noise, not a
speedup. Earlier 96-frame blocks measured motion medians of +0.691 / +0.622 / +0.626 ms; the repeatability problem
persists with the offscreen target. The prototype therefore remains opt-in, and a stable budget needs a quiet GPU run
or comparison with the shared half-resolution velocity implementation.

The final paired report is `blackout-motion-paired.json`; raw timestamp ranges remain in
`captures/blackout-motion/paired.json`.

The final live-input checks found populated motion histories in all three maps, with 10/12/12 sprite identities and
60/79/102 part identities at peak. Resize cleared the exposure for the next submitted frame. All Look off remained
RGB-identical to main at 1280×800 in office, downtown and lot. `bun run check` passed 260 tests, typechecks and build.
After merging main's workspace conversion (`1bac7ef`, including `8dff834`), root frozen install and
`bun run check:packages` passed; Blackout's `bun run check` passed 266 tests, typechecks and build. The merged Lab
comparison passed all 11 Look switches and All On/Off, with 180 paired ticks and zero pose mismatches.

## Reproduce

### Sandbox review

Motion blur remains default off. It now reads on the passing vehicle, shotgun recoil and ragdoll, but offers little
during ordinary slow, top-down movement. Sound Rings and Lamp Flicker have been removed, including their settings,
Lab controls and emission paths; tile reflections are approved and default on.

`scripts/motion-demo.ts` drives the actual practice simulation with seeded randomness and identical input on both sides.
The vehicle starts at 15 m/s and runs through the normal vehicle physics. The close-zoom shotgun shot kills a passive
target, ejects a casing and is followed by a grenade throw. The four captures matched all recorded player, vehicle,
camera and effect-count states. The shot contains eight tracers, one muzzle flash, one casing, one grenade and one
ragdoll. Frame crops confirm sharper still scenery beside the moving vehicle, with HUD/crosshair outside the blur.
The output is a silent eight-second 1080×600, 60 fps side-by-side clip: vehicle at real time, shotgun at labelled quarter
speed. Both settled frames are RGB-identical below the OFF/ON label (zero differing pixels). The final package checks,
267 Blackout tests, typechecks and build pass. Current main's PR #5 squash was merged with an identical source tree.
Reviewed clip and raw state proof: `~/code/home/artifacts/2026-10-13-blackout-feedback/blackout-motion-blur.mp4`
and `proof.json`.

```sh
hivemind run --kind browser --fetch captures/blackout-motion-demo -- sh -c \
  'cd games/blackout && bun scripts/motion-demo.ts'
```

### Original performance fixture

```sh
hivemind run --kind browser --fetch captures/blackout-motion -- sh -c \
  'cd games/blackout && bun scripts/motion-proof.ts'
python3 games/blackout/scripts/motion-sheet.py --output captures/blackout-motion
```

The preview is `http://blackout-look.localhost:1355/?sandbox=1&seed=4&lab=1`. Toggle Motion Blur under Look, or use
Backquote to open the Lab. `tests/motion.test.ts` covers identity reordering, gaps, new objects, cuts and teleports.

## Shared-module follow-up

The separate `fx-kit` branch owns `packages/kit/gpu/motion-blur.ts`. Its gather supports callbacks for colour and velocity,
so Blackout can keep the full-resolution scene velocity attachment and replace its local gather with a thin adapter.
The prototype's history helpers are also candidates for that shared module. This branch retains its standalone
implementation until those changes land, so neither PR needs the other branch's visual or particle changes.
