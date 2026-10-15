# Lab adapters

How a game plugs sections, materials, physics and spawnables into the shared Lab (`packages/kit/lab/`). Controls, keys
and authoring rules are in [lab.md](lab.md); the workbench is in [lab-workbench.md](lab-workbench.md).

## Add an isolation experiment

Open the Lab (`/arcade/lab/` under `bun run dev`). Backquote opens the shared panel; its Section select
chooses Effects, Lighting, Materials, Physics or Spawn. The sandbox has one device and frame loop. Switching sections
clears shared particles and volumes, calls the old section's `leave`, then calls the new section's `enter`.
Only the active section updates or draws. Lighting settings survive section changes so effects can be inspected
under the lighting you just tuned. Hidden pages stop simulation and rendering.

Effects has eight presets, play/loop, retrigger, parameter sliders, Copy and smoke carving. Lighting has up to
eight lights, lamp power/radius/height, a spotlight with cone/yaw/pitch, polar shadows, moon controls and tone/grade.
Density, additive particle overdraw, smoke optical depth and volume bounds are Effects views. Lighting-only and
surface normals are available across sections. Normals omits tyre/volume smoke, which has no surface normal.
GPU ms measures the dependent interval from polar compute (or scene start) through the offscreen composite.
The presentation copy is outside that interval; unsupported timestamp queries display “unavailable”.

A game adds sections through `lab({ camera, sections })` in its entry file. For example, this isolated emission
study uses the shared particle renderer and puts its rate control in the shared panel:

```ts
import { lab, type SectionFactory } from "../../../packages/kit/lab/main"
import { Emitter, type ParticleSpec } from "../../../packages/kit/fx/particles"

const fountain: SectionFactory = ({ particles }) => {
  const settings = { rate: 40 }
  const emitter = new Emitter()
  const spec: ParticleSpec = {
    kind: "water", life: 2, size: 0.1, growth: 0, gravity: 10, drag: 0.2,
    bounce: 0.2, r: 0.3, g: 0.7, b: 1, alpha: 0.8,
  }
  return {
    id: "fountain", label: "Fountain", settings,
    controls: [{ key: "rate", label: "Rate", type: "range", min: 1, max: 100 }],
    enter: () => emitter.reset(),
    update(dt) {
      emitter.step(0, 0.5, 0, dt, settings.rate, "rate",
        (x, y, z) => { particles.spawn(spec, x, y, z, 0, 8, 0) })
      particles.update(dt)
    },
    telemetry: () => `${particles.count} particles`,
  }
}

// Keep the game's existing camera writer.
void lab({ camera, sections: [fountain] })
```

`LabSection` in `packages/kit/lab/types.ts` also supports `prepare()` for uploads and `draw(pass)` for game-owned
geometry. The pass is 4× MSAA, `rgba16float`, with `depth24plus`. Bind your own pipeline and resources before
drawing. `context.stage.viewProj` and `.eye` expose the current camera. Allocate buffers in the factory, reuse
them in `prepare`, and release section-specific external listeners in `leave`. Factories run once; re-entry calls
`enter` again. IDs must be unique. Section controls bind directly to its `settings` object.

## Connect Materials and Physics through adapters

Materials runs the shared procedural material recipes from `packages/kit/gpu/surface-materials.ts` across Room, Material
Ball, and Surface Plane swatches under the Lab's lighting presets, with Before/After/A-B Split comparison, typed
parameter ranges/units, Reset, Undo/Redo, versioned preset export/import, and a separate deterministic `tuningSeed` for
group randomization. Both entries also import the actual game `MAT` constants (25 codes) in the folded Game Catalog group,
and `MaterialAdapter.prepare(code, context)` / `draw(pass, code)` remain available for game-specific code hooks.
The shared Lab itself imports no game modules. `packages/kit/textures/` and `scripts/texture-assets.ts` supply the
16-layer `256×256` `rgba8unorm-srgb` material texture array (`texture-assets/*.webp`, 1.10 MB prepared, 1.18 MB sources)
with linear-light mipmaps, authored roughness in alpha, derived lawn detail normal, and per-recipe Lab controls.

Physics uses the merged `getaway-clutter` solver and shares the Spawn section's props. The adapter supplies
`bodies`, `update(dt)`, `reset()` and optional `wakeAll()`. `DebugBody` uses the client's position, half-extents,
yaw/pitch/roll, awake and enabled fields. Convert rotations if the solver differs from local Z roll, X pitch,
then Y yaw. The Lab draws at most 512 oriented collider boxes, orange awake and cyan sleeping, and counts every
enabled body. Play, Colliders, Sleeping bodies, Reset and Wake all stay in the panel. Without an adapter it shows
“adapter pending” and zero bodies. A standalone section can still use `lab({ camera, physics: context => adapter })`.

## Add spawnables through game adapters

Both game entries compose Getaway's `src/lab/spawn.ts` with Blackout's `src/lab/spawn.ts`. Getaway registers every
vehicle spec and all 17 street prop kinds. Blackout registers its animated soldier. The generic core imports no
game code; `SpawnFactory` supplies an item world and a list of character factories:

```ts
import { lab } from "../../../packages/kit/lab/main"
import { getawaySpawn } from "./lab/spawn"
import { blackoutSpawn } from "../../blackout/src/lab/spawn"

void lab({
  camera, // Use the sixth argument, focus [x, y, z], as the camera's target.
  spawn(context) {
    const getaway = getawaySpawn(context)
    return {
      items: getaway.items,
      characters: [...getaway.characters, blackoutSpawn(context)],
    }
  },
})
```

Add a character by appending a `CharacterSpawnable` with a unique `id`, a `label`, and `create(context, at)`.
The factory returns `point` (world X/Y/Z and yaw), `update(dt, input)`, `prepare()`, `lights()` and `inspect()`.
Optional `leave()` releases the old character when it is replaced. Cache models in the factory closure so
respawning reuses GPU buffers. `context.stage.meshes` accepts position/normal/RGB/emission vertices, then draws
instances submitted during `prepare`. Adapters translate game material codes and rotation conventions. The Lab
uses the actual car/soldier geometry with simplified shared shading; it does not run either game's whole renderer.

Getaway's adapter calls `stepAndCollide`, `Chassis`, `wheelRotation` and `VehicleEmissions`. Blackout's calls its
shared movement step and `animate`/`pose`. A character that advances the shared tyre trail sets `updatesTrail`.
The core supplies canvas-owned WASD/Dvorak/arrows, Space and Shift state. Cars use Space for handbrake and Shift
for boost; soldiers use Shift to sprint. Clicking the canvas focuses gameplay. Panel focus, panel pointer input,
Backquote, window blur and section changes release held keys. The shared panel's interaction model is unchanged.

An `ItemWorld` supplies `items`, `spawn(id, at)`, `clear()`, physics lifecycle methods, `prepare()`, `lights` and
`inspect()`. Add street props through Getaway's `PROP_KINDS`/`SPECS`, mesh and contact-shape catalog, so the Lab
and game share their dimensions and reactions. `StreetProps.spawn` and `clear` are bounded client-only operations.
Car contacts use the production swept-car contact path, including breakage, hydrant water and delayed propane
explosions. Props affect presentation and do not change authoritative car handling.

Spawn keeps one controlled character, at most 512 props and four placed lights. Choose Character then Spawn
character. Item placement supports the character's position, a distance ahead, a row along its heading or a grid.
Clear all removes items, debris, reactions, triggered effects and placed lights while retaining the character.
The Effects controls trigger the eight shared presets. Lights drops a lamp, spotlight or torch; the
rendering budget remains eight lights, with explosion flashes and character lights taking priority over placed
lights and the yard fill. Spawn and Physics share the same ground plane, three walls and driveable ramp.
Switch to Physics to pause/reset/wake props or inspect colliders and awake/sleeping counts.

Run `bun games/getaway/scripts/prove-lab-spawn.ts` on headless Metal. It drives a car through five cones and a
propane tank with actual keyboard input, verifies chassis motion and tyre emission, and walks/sprints the soldier
through Blackout's host. It also exercises every car spec, row/grid/clear, all effects, placed lights and panel
input release. Evidence is in `perf/lab-spawn.json`; stills are in `captures/lab-spawn/`.

To add a game to the Lab, give it a module in `games/lab/src/games/` that exports its sections, materials and
characters, and list it (with its section ids) in `games/lab/src/games/registry.ts`. Each module is its own chunk,
loaded only when its game is chosen. Game-specific assets/dependencies belong in the game's adapters. Query parameters never select sections or looks; `?bench` only stops the live loop and
exposes `window.lab` for deterministic automation. Current merged-host proofs:
`bun games/getaway/scripts/prove-lab-spawn.ts`, `prove-lab-effects.ts`, `prove-fire-water.ts` and
`prove-fx-integration.ts` on headless Metal. Earlier `prove-fx-playwright.ts` records the pre-cleanup study protocol.
