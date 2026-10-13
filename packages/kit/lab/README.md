# Lab

The shared client-side isolation sandbox. Both games serve it at `/lab.html`; Backquote opens its controls.
Choose sections in the panel. `main.ts` owns the device, shared scene and active-section lifecycle.

- Effects: eight FX presets, playback, parameters, Copy, carving and debug views.
- Lighting: lamps, spot, bounded polar shadows, moon, tone and grade. Settings also light Effects.
- Materials: both games' code catalogs and a calibration renderer hook. Actual material shaders are pending.
- Physics: client solver adapter, oriented collider debug draw and awake/sleeping counts. Solver hookup is pending.

See [how to add a section or adapter](../../../docs/shared-code.md#add-an-isolation-experiment-to-the-lab).

The fixture lighting is a sandbox renderer. Its polar table handles nine box occluders at 256 angles for up to
eight lights; moon shadows use analytic box tests. The calibration sphere only receives shadows. Shared particle
and volume renderers accept point lights, so spot direction and polar occlusion currently affect the fixture
surfaces, not the FX light transport. Tone/grade applies to the final scene including FX. The tyre shader remains
the shared, unchanged game shader. The normals view hides tyre/volume smoke; particle billboards use facing normals.

`?bench` pauses automatic frames and exposes `window.lab` plus the older FX proof adapter `window.fx`. Interactive
section, effect and lighting selection never uses URL parameters. GPU timestamps span the scene's dependent
offscreen work and exclude the presentation copy; UI samples are not an optimization benchmark.
