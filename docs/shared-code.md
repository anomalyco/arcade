# Shared code

Code both games carry their own copy of, and what to extract. Extract something only when it is the same idea in
both games and has a current consumer in each. Game rules, maps, meshes and the look stay in the games.

## Where it goes

`packages/kit/`: plain TypeScript source, no build step. Games import it by relative path. Each game's tsconfig must
include it, and each game's workflow must also trigger on `packages/kit/**`, because a change there ships every game
that uses it.

## Candidates

Shared FX now lives in `packages/kit/fx/` ([API](../packages/kit/fx/README.md)). Getaway's two small adapters
use the extracted tyre simulation and shader/pipeline without changing the image. Blackout supplies camera,
culled lights, readable depth and wall rectangles to the bounded volume path. The same package supplies fixed
particle storage, rate/distance emitters, lit billboards, bouncing/stretched sparks and instanced debris.
The particle renderer's current consumer is the shared Lab (`/lab.html` in either game); existing game debris
remains game-owned. Both workflows already trigger on `packages/kit/**`, and both client typechecks include the
FX source. `packages/kit/lab/` owns the sandbox, controls and test scene. Each game's `src/lab.ts` supplies camera
matrices and material catalogs. FX proof and GPU-cost limitations are in `perf/fx-kit.md`.

All Lab tuning uses `LabPanel`, including the section/effect/debug selects, parameter sliders and playback,
copy and carve actions. `LabControl` supports toggles, typed selects, ranges and actions; `addControls(settings,
controls)` binds another game-owned settings object without copying it. Toggle presets leave selects and ranges
alone. Standalone consumers opt into the shared Backquote listener, while games keep their existing input routing.
Getaway's smoke selector uses this same control type. Its query override is restricted to benchmark/comparison
automation, and changing styles in the panel leaves the URL alone.

## Add an isolation experiment to the Lab

Open `/lab.html` from Getaway or Blackout's Vite server. Backquote opens the shared panel; its Section select
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

### Connect Materials and Physics through adapters

Materials is a catalog/renderer stub. Both entries import the actual game `MAT` constants (plus Getaway's smoke
code); they list 25 codes without duplicating the numbers. `MaterialAdapter.prepare(code, context)` and
`draw(pass, code)` are the hook for each game's calibration sphere/box shader. Until a renderer is supplied,
the section shows neutral geometry and “renderer pending”; selecting a code does not pretend to render it.
The shared Lab itself imports no game modules.

Physics uses the merged `getaway-clutter` solver and shares the Spawn section's props. The adapter supplies
`bodies`, `update(dt)`, `reset()` and optional `wakeAll()`. `DebugBody` uses the client's position, half-extents,
yaw/pitch/roll, awake and enabled fields. Convert rotations if the solver differs from local Z roll, X pitch,
then Y yaw. The Lab draws at most 512 oriented collider boxes, orange awake and cyan sleeping, and counts every
enabled body. Play, Colliders, Sleeping bodies, Reset and Wake all stay in the panel. Without an adapter it shows
“adapter pending” and zero bodies. A standalone section can still use `lab({ camera, physics: context => adapter })`.

### Add spawnables through game adapters

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

For a new game, add `lab.html` with a module script for its `src/lab.ts`, call `lab({ camera })`, and add the HTML
to Vite's build inputs. Additional catalogs and sections are optional. Game-specific assets/dependencies belong
in the entry's adapters. Query parameters never select sections or looks; `?bench` only stops the live loop and
exposes `window.lab` for deterministic automation. Proof: `perf/lab.json`; run
`bun games/getaway/scripts/prove-fx-playwright.ts --lab` on headless Metal.

## Other shared code and candidates

Already shared: `packages/kit/compare.ts` / `compare.css` serve both comparison pages; `gpu-perf.ts` instruments
both GPU devices and their historical counterparts. `perf-overlay.ts` supplies the historical builds' readout.
`lab-panel.ts` supplies the current games' floating Lab shell, enable/disable rows, All On / All Off, and input isolation.
Each game's `src/ui/debug-overlay.ts` declares its own effect settings and telemetry adapter. The panel opens for
`?perf=1` / `?lab=1`; the always-available `~ Lab` pill and Backquote toggle it.

In rough order of value against risk.

1. **Matchmaker and lobby Durable Object.** `server/matchmaking.ts` and `server/lobby.ts` are nearly identical across
   the games. Blackout's lobby persists room reports in storage; Getaway's keeps them in memory. Share the persistent one,
   with the "is this room open" rule and stale window as options.
2. **Room plumbing.** Throttled lobby reports with a heartbeat, idle kick with a countdown, the build-hash version
   handshake (only Blackout has it today), and seat bookkeeping. The game supplies the simulation and the snapshot.
3. **Seeded RNG.** Two mulberry32 implementations: a function in Getaway, a class in Blackout. Keep one.
4. **Keyboard input.** Layout-aware keys (`e.code` and `e.key`), release by keydown character, Cmd and blur release, and
   the receiver for multiplexed input from `compare.html`. Each game keeps its own bindings.
5. **Dev and proof tooling.** `scripts/dev.ts` (same apart from ports), the before/after capture and benchmark harness
   (`scripts/compare.ts` in both), the multiplayer benchmark, the perf readout and effect switches in the debug overlay,
   and the `?peaceful&seed` convention. One runner with a small scenario hook per game.
6. **Post-processing chain.** HDR target, MSAA resolve, five-level bloom, composite and grade, with cached views. Both
   renderers build the same chain. Getaway could also take Blackout's packed 24-byte vertex format.
7. **Session interface.** Local (solo, practice) and network sessions behind one interface, as both games already do.
8. **Camera feel.** Trauma-squared shake, punch and presentation-only hit-stop.
9. **Audio basics.** Unlock on first gesture, mute key.

Later, once both games use it: snapshot interpolation (Getaway `interp.ts`/`netcode.ts`, Blackout `smooth.ts`) differs
too much today.
