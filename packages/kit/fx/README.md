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
Sixteen-direction weighted arrival distance follows doors instead of cutting straight through walls. Short moves
check their entire cell rectangle, including diagonal corners. Thin walls are rasterized conservatively; the game
supplies walls, windows and glass once per map. Unobstructed travel has at most 2.75% angular error before filtering.

`new SmokeVolumes(partialSettings)` accepts typed settings from `fx/volume-settings.ts`. Existing spawn arguments
override radius, total life and power. Without overrides, total life is growth time + hold + fade. Radius is the
outer travel limit in metres. `reset(walls, seed)` resets noise motion deterministically (default seed 7).
`density` is now a Float32Array of optical density multipliers; `solid` is independent geometry. The renderer uploads
the preallocated `field` as RG16F and filters density even where the nearest density is zero. Nearest occupancy
still excludes wall cells. Bilinear reconstruction excludes a diagonal tap if either intervening neighbour is solid,
so filtering cannot skip a corner ahead of the arrival wave. Float16 upload preserves faint onsets that previously
rounded down in the byte field.

| Group | Controls (range) |
| --- | --- |
| Shape | Radius 2–8 m; height 1–4 m; edge softness 0.6–2.5 m; billow scale 0.5–2× |
| Motion | Growth 0.6–4 s; rise 0–0.8 m/s; wind −0.8–0.8 m/s; turbulence 0–1× |
| Appearance | Extinction 0.5–5 /m; lighting response 0–1.5× |
| Lifetime | Hold 0–10 s; fade 1–6 s |

Radius, growth, hold and fade apply at the next spawn and say “retrigger” in the inspector. Other controls are live;
wind/rise integrate phase rather than multiplying absolute time, so speed edits do not jump to a new noise phase.
Turbulence controls noise contrast and warp strength; its transport speed comes from wind/rise. Tint remains supplied
by scene lights and the existing soot argument. Validate external numeric input with `smokeSettings(partial)`.
The Lab's Copy and Workbench Export include all twelve fields and the separate effect seed. Group Randomize samples
the middle 60% of each range and constrains softness to 40% of the randomized radius. Reset restores defaults.

Call `update(dt)` once per presentation frame. Both the Lab and Blackout's `Game.build` already do this. Density is
evaluated from continuous age, with no lower-rate simulation tick or cached cell activation to interpolate. Carve
refill advances with elapsed time. Frame/substep replay is tested at 30 Hz, 60 Hz and one equivalent large step.

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
and `perf/fx-kit.md` for the original cost and noise. The refined front's captures, tests and paired cost are in
`perf/smoke-volume-refinement.md`.

## The tyre port preserves Getaway's image

`tyreShader(commonWGSL)` accepts a host frame/light declaration. `TyreRenderer` uses the host bind group at index 0
and its own noise bindings at index 1. The Getaway adapter supplies its original `common`; the Lab
supplies the smaller declaration it needs. The approved main billows use vertex-evaluated lighting and no density
field. Live solver constants retain shipped defaults. `prepare()` and `upload(trail, visible)` replace the old
style argument. The matched main/shared drift-frame proof has zero differing pixels.

## Surface splatter

`Splatter` accepts cosmetic impact events and an immutable `SplatterSurfaces` receiver mesh. Blackout uses it
behind **Blood → Style → Surface splatter**; Current remains the gameplay default. Both Lab hosts have a Splatter
section with blood, ink, slime, oil and potion presets, seeded retrigger, frame stepping and slow motion.

```ts
import { Splatter, splatterPresets } from "@arcade/kit/fx/splatter"
import { SplatterSurfaces } from "@arcade/kit/fx/splatter-surfaces"
import { SplatterRenderer } from "@arcade/kit/fx/splatter-renderer"

// Per triangle: A.xyz, B.xyz, C.xyz, material (0 sealed, 1 absorbent, 2 slick, 3 blocker).
const effect = new Splatter(new SplatterSurfaces(receiverTriangles))
const renderer = new SplatterRenderer(device)
effect.emit({ id: 42, limbId: 3, seed: 19,
  x: 12, y: 1, z: 10, dx: 1, dy: 0, dz: 0, vx: 2, vy: 0, vz: 0 }, splatterPresets.blood)
effect.update(dt)
renderer.prepare(effect, viewProjection, eye)
renderer.draw(hdrPass)
```

Events use world XYZ with Y up, including inherited velocity. The caller owns event and limb IDs, damage,
detachment and pose sampling. The last 128 `(id, limbId)` pairs are deduplicated. Blackout exposes the same input
through `Game.cosmeticSplatter`; a detachment producer can pass its world-space joint position, direction and
velocity without importing game rules into the effect. An animation-side caller is still pending.

The fixed 120 Hz solver sweeps points against actual static triangles. It stores at most 256 droplets and 256
deposits, with a default recycling budget of 192 each. Every deposit clips to at most 12 coplanar receiver triangles.
Grazing impacts stretch along the projected velocity; absorbent surfaces spread less and fade sooner. Glass
blocks without receiving. The renderer uses one non-additive, depth-tested HDR draw and a preallocated instance
buffer. Its optional motion-MRT pipeline preserves the velocity attachment. Rebuild the system when static
receivers change; moving actors and vehicles are not receivers. The current tint is unlit and has no specular lobe.

`games/blackout/scripts/prove-splatter.ts` records matched captures and paired whole-frame GPU samples against
the current blood. See `perf/lab-splatter.md` for reproduction, measured costs and limits.

## Integration proof

From the repository root, run `bun games/getaway/scripts/prove-fx-integration.ts` on a Metal-capable Mac after the
root frozen install. It launches private, headless Vite fixtures and closes them when done. It verifies shipped tyre
parity, default grenade volumes and live Blackout motion. The two `perf/fx-baseline/*.txt` files preserve the approved
main Getaway modules for this comparison. `prove-lab-spawn.ts` and `prove-lab-effects.ts` exercise both Lab hosts.
