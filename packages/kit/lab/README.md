# Lab

The shared client-side isolation sandbox, served by the Lab app (`games/lab`, `/arcade/lab/`); Backquote opens its controls.
Choose sections in the panel. `main.ts` owns the device, shared scene and active-section lifecycle.

- Effects: eight FX presets, playback, parameters, Copy, carving and debug views.
- Lighting: lamps, spot, bounded polar shadows, moon, tone and grade. Settings also light Effects.
- Materials: both games' code catalogs and a calibration renderer hook. Actual material shaders are pending.
- Physics: the merged Getaway prop solver, oriented collider debug draw and awake/sleeping counts.
- Spawn: seven Getaway vehicles, the Blackout soldier, 17 street props, effects and placed lights.

Choose Spawn, pick a character, then Spawn character. Click the canvas to drive or walk with WASD/Dvorak/arrows.
Space is the car handbrake; Shift boosts the car or sprints the soldier. Item controls place a single prop, a row
or a grid at the character or ahead of it. Clear all retains the character. Physics inspects that same item world.

See [how to add a section or adapter](../../../docs/lab-adapters.md).

The fixture lighting is a sandbox renderer. Its polar table handles nine box occluders at 256 angles for up to
eight lights; moon shadows use analytic box tests. The calibration sphere only receives shadows. Shared particle
and volume renderers accept point lights, so spot direction and polar occlusion currently affect the fixture
surfaces, not the FX light transport. Tone/grade applies to the final scene including FX. The tyre shader remains
the shared, unchanged game shader. The normals view hides tyre/volume smoke; particle billboards use facing normals.
Spawn geometry uses shared diffuse/emissive shading over the real game meshes. Its ramp uses the same height
profile as the car and prop adapters. Spawned meshes receive local lights but do not cast polar shadows.

`?bench` pauses automatic frames and exposes `window.lab` plus the older FX proof adapter `window.fx`. Interactive
section, effect and lighting selection never uses URL parameters. GPU timestamps span the scene's dependent
offscreen work and exclude the presentation copy; UI samples are not an optimization benchmark.
