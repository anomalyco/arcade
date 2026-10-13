# Tune game effects in the Lab

Open either game's `/lab.html` and choose **Blackout effects** or **Getaway effects**. The controls edit
the settings objects read by the production emitters. Choose an effect, trigger it, or turn on Loop.
Play pauses the simulation; Clear effects removes the active presentation state. Copy JSON exports
the game, room/effect seeds, selected effect and every parameter group.

Randomize environment rebuilds the selected room type and retriggers the effect. Lock effect preserves
the effect seed and its parameters across those room changes. Lock environment preserves the room.
An explicit group randomization changes that group's parameters even with Lock effect enabled.
All controls use the shared panel's public bindings and keyboard behavior.

## The adapters call production emitters

Blackout uses `Game` with an inert session and an unstarted `Sound`. Its Lab port advances presentation
time and calls the same emitters used by gameplay. Getaway uses `Fx`, `VehicleEmissions`, `StreetProps`
and `Chassis`. The Lab draws their output through shared mesh, sprite and smoke renderers. Its neutral
materials and eight-light budget differ from each game's final shading.

| Blackout group | Production path | Live controls |
| --- | --- | --- |
| Muzzle | `Game.muzzleFlash` and flash drawing | Flash/light lifetimes, powers, radius, core and petals |
| Tracer | `Game.tracer` | Speed, length, sniper life, widths by weapon |
| Bullet holes | `Game.impact` and hole batches | Capacity, life, fade, heat, cooling |
| Scorch | `Game.explode` and scorch batches | Capacity, frag/claymore radii |
| Blood / splats | `Game.blood` and particle update | Count, speed, life, size and spreads |
| Impact / dust | `Game.impact` | Counts by weapon, speed, life, size, bounce, dust growth/opacity |
| Glass / paper | `Game.looseSheets` | Count, velocity, lift, life, paper gravity/drag/flutter |
| Monitor | `Game.environmentHit` / `sparkBurst` | Spark count/speed/life/size, electric light life/power |
| Casings / magazines | `Game.casing` / `dropMag` | Ejection speed/lift, lifetimes, capacity, drop speed |
| Lamps | Lamp jolts and `sparkBurst` | Brownout duration/depth/retrigger, spark count |
| Explosion | `Game.explode` | Fire/spark/soot/chip counts, smoke radius/life |
| Corpse | Production ragdoll and corpse drawing | Life, sink time, pool delay/time/radius |
| Vehicle | `Vehicles.ping` and skid drawing | Impact count/speed/life/size, skid life |
| Fire / wreck | `mapFires` and burning vehicle drawing | Rate, size, smoke life/size/spreads |

Fire at surface selects a real glass pane, desk, monitor, wall, metal rack or partition in the map.
It calls the tracer → furniture-hit path and the solid-surface impact path. Desks are bullet-transparent
in production, so desk hits shed paper and monitor hits break screens without leaving wall decals.
Wall, rack and partition hits leave holes. Glass hits shed shards.

| Getaway group | Production path | Live controls |
| --- | --- | --- |
| Sparks / scrape | `Fx.sparks`, `Scene` scrape accumulation | Speed/life/size/spreads, gravity/drag/bounce, scrape rate |
| Skids | `Fx.skidSegment` | Life, width (fixed 1,600 ribbon capacity) |
| Connected tyre smoke | Shared `SmokeTrail`, used by `VehicleEmissions` | Spacing, idle rate, inherited velocity, life, drag, radius/growth/lift/curl |
| Nitro / pops / cold | `VehicleEmissions.car` / `emit` | Flame size/length/power, pop life/cooldown, cold rate/life/opacity/speed |
| Landing | Production `Chassis.update` landing-counter impulse | Lift/pitch limits and speed scaling; existing in-game test spring/punch |
| Clutter / hydrant | `StreetProps.hit` and particle updates | Debris counts/life, water rate/duration/lift/life/size |
| Explosion / plumes | Propane reaction and prop particles | Burst counts, flash/light parameters, plume life/size/growth/opacity |
| Headlights | `Scene` reference headlights | Radius and power; the approved soft-pool style retains its separate game Lab controls |

The main integration uses packed skid storage and the approved single production tyre path. The removed
`Fx.smoke` study and old smoke switches are not restored. Clutter's paper/water/fire IDs use main's 20–22 slots.

## Rooms come from the game generators

Blackout crops `getMap` around office, corridor, glass meeting-room, breakroom, server-room or downtown
locations. A small cleared test bay contains production surface specimens. The desk material seed is
chosen with `deskMonitorLights` so every room has a real shootable monitor.

Getaway builds seeded streets, alleys and plazas with `generateCity`, `buildCityMesh` and
`partitionCityMesh`. It retains nearby geometry and lights around the selected location. Rebuilds
replace the existing GPU geometry and destroy the old vertex buffer.

## Proof covers the controls and default game stills

Run from the repository root against the existing local Nexus previews:

```sh
bun games/getaway/scripts/prove-lab-effects.ts
bun games/getaway/scripts/prove-effects-defaults.ts
```

Both scripts launch headless Chromium with Metal and muted audio. Route browser work through the
host's job runner. The first visits all nine environment types on both hosts, triggers the effect
inventory, and asserts glass/paper emission, holes on three solid surfaces, a broken monitor, hydrant
water and a propane explosion. It also checks room lock, locked-effect retrigger, group randomization,
loop, pause, Copy JSON and a panel slider's keyboard input.

The defaults proof serves pre-extraction modules from `8211aa0` through the current renderer. It retains
the parallel motion-metadata plumbing in the baseline so that the comparison isolates this extraction.
Both games' matched PNGs were byte-identical. This proves the sampled seeded frames, not every effect
under every setting. Local symlinked font URLs returned 403 in both game captures; HUD/menu text was
hidden. The Lab proof had no page or console errors. Results are in `perf/lab-effects*.json`.

Both complete project checks passed on Studio: Blackout 258 tests; Getaway 150 tests with 12 existing
skips. CPU/GPU overhead of the settings extraction has not been isolated.
