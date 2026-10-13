# Shared FX

Getaway uses `SmokeTrail` and `TyreRenderer`; Blackout uses `SmokeVolumes` and `VolumeRenderer` for frag,
claymore and wreck smoke. Both games serve `/lab.html`, which runs both paths and the general particle renderer.
All positions use world X/Z with Y up. Simulation and upload storage is allocated at construction.
The Lab's effect picker, parameter sliders, playback actions and debug views live in the shared Lab panel.
Backquote toggles it. Getaway retains the approved single tyre-smoke path; all experiments use Lab controls.

## Particles draw inside the game's HDR pass

`Particles.spawn(spec, x, y, z, vx, vy, vz, seed)` accepts a reusable `ParticleSpec`. `update(dt, walls, ground)`
takes nearby X/Z wall rectangles and an optional ground-height query. Ground collisions bounce; rectangle
collisions reverse horizontal velocity. The current rectangle check is discrete, so fast collision-critical
debris should keep its game's swept physics. `prepare()` writes the instance buffer without making particle objects.

`Emitter.step(x, y, z, dt, amount, "rate" | "distance", emit)` carries fractional births, interpolates positions,
rejects teleports over 20 m, and limits a step to 128 births. Keep `emit` and the spec outside the frame loop.
The pool holds 2,048 particles and reports dropped births. The renderer draws lit soft billboards, velocity-stretched
sparks/water and six-faced debris in one instanced draw. Fire and sparks emit light into the HDR image; games
supply actual scene lights separately. Soft billboards fade analytically against Y=0.

Create `ParticleRenderer(device, depthFormat, samples)`, fill its persistent `uniforms`, call `upload(pool)`, then
`draw(hdrPass)`. The HDR format is `rgba16float`; depth defaults to `depth24plus`, with four samples.
Uniform float offsets are 0–15 view-projection, 16–18 eye, 19 debug mode, 20–22 ambient RGB, 23 light count,
24 onward lights. Each light is eight floats: XYZ/radius, RGB/power. The shader caps the loop at eight.

The clutter worktree's current `Fx` particles carry the same position, velocity, colour, size/growth, gravity,
drag and life concepts. Its game-specific collision and damage rules can remain there while it writes this
pool or its instance layout. Its existing particles have not been migrated in this branch.

## Smoke renders after the HDR pass, before bloom

Call `SmokeVolumes.reset(walls)` when the map changes. `spawn(x,z,radius,life,power,soot)` starts a finite cloud;
`sustain(x,z)` keeps a nearby wreck plume alive. `carve(ax,az,bx,bz,radius)` clears a temporary horizontal cylinder
and `update(dt)` refills it. Four slots each hold a 48² field at 0.5 m spacing. Full pools reject new clouds.
Flood-fill arrival distance follows doors instead of cutting straight through walls. Thin walls are rasterized
conservatively; the game supplies walls, windows and glass once per map.

Create `VolumeRenderer(device)`. On resize, call `resize(width,height,readableDepthView)` with the game's stored
four-sample depth attachment. For a depth-stencil texture, use a depth-only view. Fill the persistent `uniforms`:

| Float offset | Value |
| --- | --- |
| 0–15 | Inverse view-projection |
| 16–18 | Camera XYZ |
| 22 | Light count, at most eight |
| 24–26 | Ambient RGB |
| 60 onward | Eight-float lights, as above |

`render(encoder,hdrView,volumes)` uploads the field, integrates 24 density samples per pixel into an RGBA16F
target capped at 480×320, then composites with depth-aware four-tap upsampling. Empty systems skip both passes.
The low-resolution pass stops at scene depth, uses a fixed progressive farthest-point jitter texture, animated
3D noise, approximate upward extinction, and local lamp scattering. `debug` selects shaded (0), density (1),
optical depth (2), lighting (3), or field bounds (4). Particle mode 2 instead adds fragment contributions as an
overdraw heatmap. The Lab reports whole-stage GPU timestamps separately from those debug views.

This shallow model treats every supplied rectangle as a sealed column. Blackout supplies walls at least 1.8 m
high, windows and glass; low wrecks and cover remain depth occluders without sealing the smoke field. The model
does not simulate pressure or support arbitrary camera angles. Carving is presentation-only and refills in about 0.7 s.
It changes visual sightlines, not server visibility or hit detection. See `docs/game-notes.md` for the CS2 sources
and `perf/fx-kit.md` for the measured cost and noise.

## The tyre port preserves Getaway's image

`tyreShader(commonWGSL)` accepts a host frame/light declaration. `TyreRenderer` uses the host bind group at index 0
and its own noise bindings at index 1. The Getaway adapter supplies its original `common`; the Lab
supplies the smaller declaration it needs. The approved main billows use vertex-evaluated lighting and no density
field. Live solver constants retain shipped defaults. `prepare()` and `upload(trail, visible)` replace the old
style argument. The matched main/shared drift-frame proof has zero differing pixels.

## Run the proof

From the repository root, run `bun games/getaway/scripts/prove-fx-integration.ts` on a Metal-capable Mac after the
root frozen install. It launches private, headless Vite fixtures and closes them when done. It verifies shipped tyre
parity, default grenade volumes and live Blackout motion. The two `perf/fx-baseline/*.txt` files preserve the approved
main Getaway modules for this comparison. `prove-lab-spawn.ts` and `prove-lab-effects.ts` exercise both Lab hosts.
