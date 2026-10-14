# Shared code

Code both games carry their own copy of, and what to extract. Extract something only when it is the same idea in
both games and has a current consumer in each. Game rules, maps, meshes and the look stay in the games.

## Where it goes

`packages/kit/` is the private, versionless `@arcade/kit` Bun workspace package: plain TypeScript source, no build
step. Getaway and Blackout declare `"@arcade/kit": "workspace:*"` and import subpaths, for example:

```ts
import { LabPanel } from "@arcade/kit/lab-panel"
import "@arcade/kit/compare.css"
```

Its exports resolve directly to `.ts` source (and `.css` assets); Vite and Wrangler bundle them in each game.
`packages/kit/tsconfig.json` checks every shared TypeScript file independently, including files no game imports yet.
Existing navigation tests run with `bun run --cwd packages/kit check` or root `bun run check:packages` and remain
part of both games' checks.

## Install, check and ship

Run `bun install --frozen-lockfile` at the repository root. The workspace explicitly includes `games/getaway`,
`games/blackout`, `games/outbreak`, `games/carrier` and `packages/*`; it has one root `bun.lock` and hoisted dependencies configured in `bunfig.toml`.
Wings, landing and redirects retain their independent installs, lockfiles and workflows.

Run each game's `bun run check`, dev, build and deploy commands from its own directory as before. Keep Vite,
Wrangler, TypeScript and Playwright versions aligned in the game manifests. Root scripts declare their own tooling
dependencies in the root manifest and use normal package imports rather than reaching into a game's `node_modules`.

All four workspace game workflows install at the root, then check and smoke-load the game's production bundle. Their paths include
`packages/**`, root `scripts/**`, `package.json`, `bun.lock` and `bunfig.toml`, so shared changes check all consumers.
Blackout also watches `games/getaway/shared/**` for its cross-game benchmark typecheck. A separate
`packages.yml` workflow runs the shared package's typecheck and tests. Deploy jobs stay per game.

For Cloudflare Builds, use the repository root for installation (`bun install --frozen-lockfile`) and then target the
game (`bun run --cwd games/blackout build` / `bun run --cwd games/blackout deploy`). A game-only source upload omits
the workspace package. Verify packaging from a clean `git archive` export with the root frozen install, package
checks, all affected game checks, and `bunx --no-install wrangler deploy --dry-run` from each game.

## Lab panel

`packages/kit/lab-panel.ts` is the one debug panel for every game: switches, sliders, presets, Copy, perf readout. New tunables go there, not into URL parameters. When a game needs a new kind of control, add it to the shared panel.

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
alone. The panel captures game keys while open, preserving main's keyboard navigation/search/exact editing.
The standalone sandbox uses `capture: "focus"`, so clicking the canvas enables its playable character while keeping
the panel visible. Getaway retains the approved single tyre-smoke look; study variants do not return to gameplay.

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

Materials runs the shared procedural material recipes from `packages/kit/gpu/surface-materials.ts` across Room, Material
Ball, and Surface Plane swatches under the Lab's lighting presets, with Before/After/A-B Split comparison, typed
parameter ranges/units, Reset, Undo/Redo, versioned preset export/import, and a separate deterministic `tuningSeed` for
group randomization. Both entries also import the actual game `MAT` constants (25 codes) in the folded Game Catalog group,
and `MaterialAdapter.prepare(code, context)` / `draw(pass, code)` remain available for game-specific code hooks.
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
exposes `window.lab` for deterministic automation. Current merged-host proofs:
`bun games/getaway/scripts/prove-lab-spawn.ts`, `prove-lab-effects.ts`, `prove-fire-water.ts` and
`prove-fx-integration.ts` on headless Metal. Earlier `prove-fx-playwright.ts` records the pre-cleanup study protocol.

## Shared motion blur

`packages/kit/gpu/motion-blur.ts` owns the bounded eight-tap, depth-aware shutter gather, camera reprojection,
stable transform history and transient part identities. Getaway supplies half-resolution camera/car/wheel/particle
velocities before bloom. Blackout supplies full-resolution MSAA MRT velocities and embeds the shared gather in its
existing composite. Both accept current/previous VP transforms, elapsed time, colour/depth and strength/shutter.
Transient keys preserve emission points and allow fast tracer travel without weakening actor teleport rejection.
Neither path feeds colour history back into the next frame. DOM HUDs stay outside the blur.

Getaway defaults on at strength 0.65 / shutter 0.5, with stronger blur under the existing nitro envelope. Blackout
remains off by default at strength 1 / shutter 1 when enabled. All settings live in Backquote Lab controls.
The final M5 Max 1440p whole-GPU paired deltas are Getaway +0.233 ms (MAD .002), Blackout office +0.229 ms
(MAD .004), downtown +0.813 ms (MAD .212). The downtown MRT path misses the 0.5 ms target. There is no tile-max;
foreground expansion and layered transparent velocity remain conservative. Reproduce with `prove-motion-blur.ts`
and `games/blackout/scripts/prove-shared-motion.ts`. Raw evidence and limits: `perf/shared-motion.md`.

## Other shared code and candidates

`packages/kit/vehicle/` now owns Getaway and Blackout's presentation chassis, body transforms, lamp submission and
Lab tunables, tyre heat/emissions, skids, pops, and procedural engine/gearbox/tyre voices. See its README for the
coordinate and renderer contracts. Each game supplies terrain, interpolated controls, meshes and renderer/audio
sinks. Blackout's adapter converts its +X-forward mesh convention and kilograms; simulation and human rigs remain
game-owned. The smoke pool and GPU pipeline are canonical in `kit/fx`; vehicle smoke paths are compatibility adapters.

### Outbreak M1 extractions

Blackout and Outbreak now consume `@arcade/kit/gpu/{mesh,renderer,shaders,limits,level}`,
`@arcade/kit/client/{camera,input}`, `@arcade/kit/rig`, and `@arcade/kit/sim/{geom,rng}`.
Blackout's original paths re-export the shared implementations. The renderer owns packed vertices/instances,
polar-light compute, cutaway chunks, MSAA/HDR targets and the five-level bloom/post chain. `makeSceneShader`
accepts pure WGSL surface and directional-light hooks, with Blackout's shader behavior as its default.
An optional exploration texture is available at binding 9; Blackout never samples it. Binding 7 retains the motion
uniform, and binding 8 holds the separate fine moon mask. The shipped Blackout look/motion variants share this engine.
`gpu/surface-materials.ts` supplies opt-in matte outdoor finishes and footprint-filtered detail. `gpu/look.ts`
(`@arcade/kit/look`) and `lab/looks.ts` supply the shared `LookSettings` presets, WGSL grading/lighting hooks, and the
Lab `Looks` debug room; `Renderer.setLook` / `FrameInput.look` opt into `makeLookSceneShader` and `makeLookPostShader`
while keeping `"Current"` pixel-identical to the baseline pipelines. Outbreak selects
the existing dense shadow kernel and custom post constants through shared shader options; default Blackout output
is preserved. House and terrain generation remain game-owned. See `docs/outbreak-look.md` for measured cost and gaps.

Outbreak reserves polar slot zero for eye-height sight with zero light power. Its CPU exploration mask uses the
same ray angles and slab geometry. The shared Input retains its existing action methods for compatibility;
Outbreak configures F-only interaction to avoid the Dvorak E movement binding. Rig math, IK, springs and human
dimensions are shared. Outbreak's civilian meshes and unarmed planted-foot gait adapt only the needed parts of
Blackout's soldier code.

Human locomotion, profiles and semantic detachment now live in `human-locomotion`, `human-profile` and `human-pose`
on the canonical rig. Blackout supplies weapon/reload/melee clips. See [Human rig](human-rig.md) for ownership,
attachments, stable cosmetic IDs and velocity spaces.

Remaining migration targets: split material-specific
scene shading from the shared WGSL contract; generalize the map-aware LightCuller when another game needs its
monitor/bounce caches. The Outbreak map/lighting writer and gameplay Session stay game-owned.

Custom discard routing is separate from appearance hooks. `solidCutaway` defaults to the old `cutaway` hook;
Outbreak explicitly leaves it empty and marks roof/high chunks with `LevelChunk.customCutaway`. Pure opaque
triangles have no screen cutaway bounds, while walls retain the existing screen test. Other consumers retain
their existing shader and routing behavior. Measurement and limits: `perf/outbreak-performance.md`.

Getaway's renderer and input are not migrated in this milestone. See `games/outbreak/README.md` for proof and limits.

Already shared: `packages/kit/compare.ts` / `compare.css` serve both comparison pages; `gpu-perf.ts` instruments
both GPU devices and their historical counterparts.
`getaway-main-hook.ts` supplies both games' historical Getaway instrumentation without a cross-game script import.
`lab-panel.ts` supplies the current games' floating Lab shell, enable/disable rows, All On / All Off, and input isolation.
It also accepts numeric range controls (`min`, `max`, `step`), selects (`options` with numeric or string values),
and an `enabled(settings)` predicate. Groups containing sliders or selects get Copy JSON.
Each named group gets Randomize: it chooses step-aligned slider values and select options through the same change
callback as manual edits, then refreshes dependent controls. Disabled sliders are randomized too, so changing styles
later reveals the new values. Switches are untouched; groups containing only switches have a disabled Randomize button.
All On / All Off affect switches only and are hidden when there are none. Getaway's Lights group uses both types:
its Style select switches the live renderer, and its sliders are enabled for the Soft pool style.
An optional change callback applies settings requiring resource updates, such as Getaway's live car-light meshes.
`lab-navigation.ts` owns row/group focus, folds, fuzzy matches, value changes and constructor-default resets without DOM
dependencies. The panel captures keyboard events while open, including matching keyups after closing; exact edits are
committed on Enter and cancelled on Escape. A compact hint lists navigation/search/group shortcuts. Comparison key
messages carry modifiers too. Both games run `lab-navigation.test.ts` in their normal check; Getaway's
`scripts/prove-lab-keyboard.ts` verifies real keyboard capture against Getaway and Blackout input adapters on a preview.

For `fx-kit` adoption: merge `packages/kit/lab-panel.ts`, add `lab-navigation.ts` and `lab-navigation.test.ts`, and retain
fx-kit's dynamic `addControls`, action controls and `LabOptions` when adapting its bindings to the navigation model.
Its `type: "range"` optional step needs a concrete step; per-control `change` callbacks must still run through the shared
write path. Keep action rows in navigation rather than treating them as switches. Include the shared tests in both games'
package scripts. For comparison panes, also adopt modifier forwarding in `packages/kit/compare.ts` and both games'
`src/game/input.ts`. The proof runner and Getaway script typecheck entry provide the browser regression check.
Each game's `src/ui/debug-overlay.ts` declares its own effect settings and telemetry adapter. The panel opens for
Backquote; `?perf=1` / `?lab=1` open it for automation. Styles and effect comparisons belong in this panel.

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
