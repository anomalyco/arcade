# Motion blur

`motion-blur.ts` provides a depth-aware eight-tap shutter gather and optional camera-velocity pass.
`MotionBlur.resize(width, height, colour, depth, velocityTarget?)` binds the frame attachments. The optional velocity
target is RGBA: current-minus-previous UV displacement, device depth and coverage. Update with current, inverse
current and previous view-projection matrices, elapsed seconds, strength and shutter; then encode before bloom/HUD.
The built-in camera field is half resolution. A game's callback can overwrite it with instance/particle velocities.
`motionGatherWGSL(linearDepth)` embeds the same gather in an existing composite via `motionField`/`motionColor`.

`PreviousTransforms` keys previous submitted transforms by identity. Begin once per submitted moving frame. New
objects, missing frames and teleports use their current transform. Reset on camera cuts, resize or long frame gaps.
The shutter is a fraction of 1/60 second, independent of render rate; length is capped at 32 pixels. There is no colour
history or temporal feedback. The small kernel avoids the tile-max/neighbour-max passes; foreground expansion is
therefore conservative. Transparent velocities use coverage blending, not a multi-layer transparency solution.

Getaway uses camera reprojection plus car body/wheel transforms and persistent FX particle identities. Nitro scales
strength using the existing camera-rush envelope. Ground-anchored tyre smoke inherits camera motion; no second
smoke simulation is used. Defaults: enabled, strength 0.65, shutter 0.5. Backquote exposes all three settings.
The HUD is DOM-rendered after the canvas and stays sharp.

Blackout uses `MotionKeys` and `MotionHistory` with weak owner identities, optional transient emission points and
per-key travel bounds (4 m actors / 32 m tracers). Its adapter converts exposed pixel velocity and linear camera
depth to `motionField()` for the same gather in its composite. Full-resolution four-sample RGBA16F MRT avoids a
second geometry pass, but its bandwidth misses the 0.5 ms target downtown. It stays opt-in, strength 1 / shutter 1,
with a 1.25 px dead zone, 32 px cap and swept transient edges. See `perf/shared-motion.md` for paired costs.
