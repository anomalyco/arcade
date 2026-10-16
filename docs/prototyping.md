# Prototyping: Start as a Toy

New game ideas in `arcade` start as a single-screen, low-resolution toy built on `@arcade/kit` primitives (`bun scripts/new-toy.ts <name>`). A toy proves that moving, aiming, and hitting feel good on plain boxes and cylinders before anyone writes custom meshes, skeletal animations, custom WGSL shaders, procedural worlds, or Durable Object rooms.

## Cheap presentation, shared feel on by default

Low fidelity means cheap *presentation*, not stripped *feel*. A toy draws with test models (boxes, capsules, prisms,
flat colours, one stock look), but it uses the kit's shared game feel from the first day, because it costs nothing:

- **Camera and impact:** `Camera` shake and directional kick, `HitStop` (`@arcade/kit/client/camera`).
- **Effects:** shared particles, explosions, smoke and trails (`@arcade/kit/fx`).
- **Sound:** placeholder sounds from the shared library (`@arcade/kit/audio`) and the shared volume controls.
- **Characters, when the idea needs people:** the shared human rig with procedural animation (`@arcade/kit/avatar`).
- **Bots, input and tuning:** shared input bindings by physical key, bots for playtests, and `LabPanel` knobs.

Trying a different game style (top-down, side-view, first-person) should mean a different camera and arena, not new
infrastructure. Never rebuild one of these per toy. If a toy needs something the kit doesn't have, add it to the kit
once, so the next toy gets it free; shared libraries grow from real needs, not up front.

## Why feel comes before meshes

Game ideas almost never play the way they sound in a pitch. Studios that consistently ship responsive action games separate **finding the toy** from **dressing the world**:

- **Nintendo's garden room (*Super Mario 64*)**: Shigeru Miyamoto spent months of *Super Mario 64*'s development moving Mario around a flat gridded test room chasing MIPS the rabbit before the team built a single castle level. His rule was that if turning, jumping, diving, and stopping in 3D did not feel good in an empty room with no enemies, no level design or art would save the game.
- **Maddy Thorson & Noel Berry (*Celeste*)**: *Celeste* started as a four-day PICO-8 prototype on a 128×128 grid. Because a room took minutes to build and the character was an 8×8 sprite, the team could spend their time tuning dash momentum, wall-climb stamina, jump buffering, and coyote time before committing to a full game.
- **Vlambeer (*The Art of Screenshake*)**: Jan Willem Nijman builds the core loop in a couple of days with flat shapes, then layers feel one measurable parameter at a time: projectile speed, recoil kick opposite the shot, 40–80 ms hitstop frames, knockback impulse, camera trauma, and permanence (bodies and craters that stay on the floor).
- **Valve & Naughty Dog greybox blockouts**: Level designers block out combat arenas with untextured boxes and metre-grid textures (`blockmesh` / `greybox`). When a room is ten lines of box calls instead of a finished Blender scene, you delete a bad corridor or double a dash distance after a two-minute playtest without sunk-cost hesitation.

## The Toy Rules

When starting a new game or mode in `arcade`, keep the prototype inside four constraints until the core loop passes playtest:

| Constraint | Toy phase (Days 1–2) | Graduate only after feel is proven |
| --- | --- | --- |
| **Geometry** | `@arcade/kit/gpu/mesh` primitives (`Mesh.box`, `Mesh.prism`, `Mesh.bevelBox`) colored by role: player, threat, goal, wall. | Blender `.glb` assets, `@arcade/kit/avatar` human rigs, surface material recipes, foliage. |
| **World & Net** | Single fixed arena (for example 24×24 m) in `shared/sim.ts`, stepped locally at 60 Hz with `@arcade/kit/sim/move` (`stepBody`). | `@arcade/kit/server` (`RoomObject`, `LobbyObject`, `gameWorker`), snapshot interpolation, or chunk streaming. |
| **Shaders & Post** | Stock `@arcade/kit/gpu/renderer` + `@arcade/kit/gpu/scene-frame` (`SceneLights`, `packSceneFrame`), with the kit's stock particles and look. | Custom WGSL passes, volumetric smoke, weather passes, custom post-grading. |
| **Tuning** | Every feel constant (`moveSpeed`, `accel`, `dashImpulse`, `cooldown`, `knockback`, `hitStopMs`, `shake`) bound to `@arcade/kit/lab-panel` (`Backquote`). | Hardcoded magic numbers scattered across simulation files. |

## Building a toy in 30 seconds

Scaffold a runnable toy in `games/<name>` with:

```sh
bun scripts/new-toy.ts <name>
bun --cwd games/<name> run dev
```

The scaffold generates three small files on `@arcade/kit`:

1. `shared/sim.ts`: Plain-data state (`ToyState`), a `FEEL` object with `LabControl[]` definitions, and a deterministic `stepToy(state, input, dt)` loop using `stepBody` from `@arcade/kit/sim/move`.
2. `src/main.ts`: Boots WebGPU via `openGpu`, builds three primitive models (`Mesh.box` floor/pillars, `Mesh.prism` capsule), drives `Camera` and `HitStop` from `@arcade/kit/client/camera`, reads physical keys via `Input` (`@arcade/kit/client/input`), and mounts `LabPanel` (`Backquote`) so every movement and impact constant is live-tunable while playing.
3. `index.html` + `vite.config.ts`: Minimal Vite entry under `/arcade/<name>/` with `<meta name="robots" content="noindex">`.

## What to tune in the first hour (the 3Cs)

Spend the first hour exclusively on **Character, Camera, and Controls** with the `LabPanel` open (`Backquote`):

1. **Movement envelope**: Tune top speed, acceleration, and deceleration (`stepBody` `accel` rate) until figure-eights around two box pillars feel crisp. Test whether stopping is instant or carries momentum, and whether turning while sprinting feels responsive.
2. **Primary verb & commitment**: Give the player one primary action (`Mouse0` or `Space`) with a clear windup, active window, and recovery cooldown. A verb feels weighty when the player commits to a trajectory or cooldown for 150–400 ms rather than spamming every frame.
3. **Impact response**: Sell hits with timing and motion first, then the kit's stock particles and sounds (no custom effects yet):
   - **Hitstop (`HitStop.trigger`)**: Freeze presentation steps for 30–70 ms on heavy hits while the camera continues to shake.
   - **Directional camera kick (`cam.add(amount, dir)`)**: Kick the camera along the attack vector on impact.
   - **Knockback & permanence**: Push hit targets physically across the floor and leave knocked-out boxes on the arena floor so the aftermath of a fight is legible.

## The Graduation Gate (Keep, Pivot, or Kill)

Before writing a custom mesh, shader, or multiplayer room, run a two-minute playtest on the greybox toy and answer three questions:

1. **Toy test**: Is moving and using the primary verb in the empty box arena fun for 30 seconds before any enemies spawn?
2. **Second-to-second decision**: When threats are active, does the player make a meaningful positioning or timing decision every 2–4 seconds?
3. **Knob sensitivity**: Did tuning the `LabPanel` feel sliders lock in a distinct pace, or are we hoping art and effects will rescue a flat mechanic?

If the answer to any of the three is no, change the rules in `shared/sim.ts` or delete the prototype while it is still 150 lines of code. Once the toy passes, keep `shared/sim.ts` as the authoritative simulation, add a 25-line `@arcade/kit/server` room (`RoomObject` + `gameWorker`), and replace the primitive model IDs one at a time.
