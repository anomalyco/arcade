# Lab authoring guide

Use the shared Lab to tune a production effect, material, physics response or audio cue, then verify it in the game.
This is the canonical authoring contract. [lab-workbench.md](lab-workbench.md) describes the current shell and input
API; [dev-control.md](dev-control.md) covers driving an open browser page with `bun run arcade …`;
[shared-code.md](shared-code.md) covers adapters; [game-notes.md](game-notes.md) records measured techniques.
The rules below apply to new authoring work. Existing gaps are listed explicitly and do not add release gates.

## Tune one change and reproduce it

1. Open the Getaway or Blackout host's `/lab.html`. Choose a library effect or fixture, then its environment.
   Backquote toggles the workbench chrome; games use the same panel as a floating overlay.
2. Record the settings, room seed, effect seed, lighting and camera. In game-effect sections, keep `Lock FX` on
   while rerolling the room with `R`; `Lock Env` prevents room regeneration. Locks are section-dependent.
3. Use `Space` on the Edit canvas to retrigger the active section. Adjust one Inspector value, then retrigger
   if that value only affects newly spawned particles or bodies. Test bright/dark rooms and gameplay zoom.
4. Use transport Pause and Step where supported. Step advances `1/60 s`; Edit/Play determines input ownership,
   independently of the simulation clock. Reset and replay from the same seeds to compare the same tick.
5. Copy the group for a parameter dictionary, or Export the versioned preset and save the JSON yourself.
   Promote approved values into the canonical production defaults, then check the actual game's rendering and input.

Selecting a fixture intentionally changes scene state. Selecting a tool/effect should preserve the environment,
lighting and authored placement unless the user explicitly changes or resets them. Current lighting survives section
changes, but environments are section-owned and fixtures can replace them. There is no cross-reload saved-preset library.

## Bind controls to typed production settings

- Put every tunable visual, material, physics and audio value in a typed settings object consumed by the real code.
  Bind it with `LabPanel.addControls(settings, controls)` or a `LabSection`'s `settings`/`controls`. `LabSettings`
  is a primitive-valued record, not domain validation; keep stronger types and validation at the production boundary.
- Use `LabControl` ranges, typed select options, toggles and actions. Supply concise labels, named groups, numeric
  `min`/`max`/`step` and explicit `unit`. Use `unit: ""` for seeds or unitless values and `"×"` for multipliers.
  Inferred units can be wrong: shard size scaling is not metres, and radians must not be labelled degrees.
- Start from approved defaults before binding; Reset restores the panel's captured defaults. Keep defaults within
  safe ranges. Use `visible` for irrelevant controls, `enabled` for dependency gates and `folded` for advanced groups.
- Route edits through the shared write path (`LabNavigation.set` and control `change` callbacks). Pointer, keyboard,
  exact edits, reset and randomization must apply the same resource updates. A scrub/drag is one authored transaction.
- For `EffectAdapter.groups`, provide explicit `ranges` and `units`; generated ranges and humanized keys are fallbacks,
  not a substitute for deliberate authoring. Use `relevantGroups` to show only the active effect's parameters.

Declare each control's update boundary in its adapter or nearby settings documentation:

| Boundary | Expected behavior |
| --- | --- |
| Live uniform/mixer/emitter value | Update without clearing existing particles or resetting the scene. |
| Spawn-time value (burst count, initial velocity, shard dimensions) | Apply to new spawns; explicitly retrigger with the same effect seed to inspect it. |
| Structural value (room, collision shape, pipeline/buffer capacity) | Explicitly rebuild/reset affected resources and state; keep unrelated settings. |

The shell does not automatically implement these distinctions. Existing section callbacks differ; do not claim that
every slider updates an already-spawned effect or re-simulates a paused frame.

## Separate randomization, replay and presets

New parameter Randomize paths must use a recorded deterministic tuning seed, respect ranges/steps and leave structural
room and effect seeds unchanged. Randomize explores recipes; Retrigger repeats an effect; Reroll regenerates a room.
Locks protect comparison state, not explicit parameter edits. Include the resulting settings and required seeds in Copy.

Current limitations:

- Generic `LabNavigation.randomize` uses `Math.random`, randomizes group ranges/selects (including dependency-disabled
  values), and leaves toggles unchanged. Copy the result to reproduce it; a room seed alone cannot reproduce Randomize.
- `game-effects.ts` provides a custom `Randomize <group>` action with seeded draws, but uses and increments
  `effectSeed`. It clears/retriggers the effect. It does not yet have a separate tuning seed.
- Group Copy is a dictionary, not an importable full preset. The workbench's `LabPresetSchema` version 1 exports
  `section`, section `settings`, `lighting`, and optional spawn character ID/props. It omits camera, transport tick,
  placed lights and character position. Environment/seed values are carried only when present in section settings.
- Import checks version, section, select choices and character/prop IDs, clamps numeric range settings and ignores
  unknown setting keys. It does not fully validate types, lighting bounds or placement coordinates. Treat exported
  presets as trusted local data; import is not a security boundary or an exact simulation checkpoint.

For new preset fields, validate finite numbers, types, ranges and catalog IDs before mutating state; reject malformed
payloads without partial changes. Preserve versioned compatibility or explicitly migrate/bump the schema. Apply imports
through the same production update boundaries as manual edits. Do not bypass validation with an independent importer.

## Reuse the actual implementation

Lab adapters must call the production renderer/shader, effect emitter, physics solver and audio graph being evaluated.
Keep sandbox fixtures, transport and inspection in `packages/kit/lab/`; keep reusable implementations in their canonical
modules. Game-specific geometry, assets and rules remain game-owned. Share implementation between Lab and game rather
than copying constants or approximating behavior in a second renderer.

Existing limitations matter: Materials is a catalog/renderer stub until a `MaterialAdapter.prepare`/`draw` is supplied;
Spawn uses real geometry and simulation adapters with simplified shared shading. Some shared FX are Lab candidates
pending game adoption. These views cannot establish full production material or lighting parity.

The material authoring goal is reusable typed recipes with base colour, roughness, grain/detail scale, wear and relevant
surface response, tested under common lights and at gameplay distance. A complete recipe editor is not implemented.
When adding one, connect the actual material shader, expose its tunables and retain production defaults; do not create
a calibration-only shader and call it the game's material.

Gameplay rules and replicated simulation remain authoritative. Camera, cosmetic effects and presentation clutter stay
local; Lab tuning must not silently add wire fields or change authoritative movement, damage or collision rules.
Test an intentional gameplay-physics change in the actual simulation separately from cosmetic clutter experiments.

## Preserve input and audio ownership

Text editors, search and preset dialogs own printable keys, arrows, Space and clipboard/text-undo shortcuts. They must
not trigger canvas actions. Placement/move ghosts precede Inspector navigation; focused Inspector precedes gameplay.
Standalone `LabPanel` uses `capture: "focus"`, `layout: "inspector"`; game overlays use floating/open capture.

Canvas click in Edit selects/places and never possesses a character. Enter Play explicitly with `P` or the Play button
when a character exists. Escape or sidebar/toolbar focus exits Play and releases held keys, including Dvorak movement,
Space and Shift. Preserve browser shortcuts. Authored Undo/Redo covers edits and placements, not simulation time rewind;
exiting Play currently keeps the live aftermath rather than restoring a pre-Play checkpoint.

Audio entry/selection must stay silent. Render waveform/spectrogram previews offline; live playback requires explicit
Audition. Neither a generic Retrigger nor a preset import should automatically unlock/play audio. Release live audio
on section leave, blur or hidden-tab transitions.

## Compare matched state and label cost honestly

Use `/lab.html?bench` for automation: it stops the live loop and exposes `window.lab` with `select`, `advance`, `render`
and workbench import/export. Reset each variant, apply recorded settings/seeds and advance identical fixed ticks with
the same camera, viewport, lighting and inputs. Pause/Step helps inspect a frame; it does not supply saved A/B slots.
Use the existing `compare.html` acknowledged paired-tick protocol for game comparisons and verify matching snapshots.

Measure cost separately from screenshot/video capture and concurrent comparison panes. Record hardware/backend,
resolution, timing interval, warmup and raw samples; alternate variants for at least seven measured pairs and report
median deltas with spread. A change inside the spread is inconclusive. Check matched before/after images before calling
a change an optimization. Save measured findings in `perf/` and proven techniques in `docs/game-notes.md`.

Label CPU update/encode wall time, frame/vsync time, GPU timestamp intervals and queue-completion latency separately.
Queue completion is not pure GPU time. The Lab's GPU interval covers polar compute/scene start through offscreen
composite, excluding presentation copy; unsupported timestamps are unavailable. Await timestamp readback and never
sum overlapping passes. Isolation diagnostics do not establish game-wide or phone performance.

## Planned research is not supported UI

The local research report `~/code/home/artifacts/2026-10-13-lab-workflow-ux.md` proposes fixed-sector radial menus,
a unified command registry, viewport A/B pin/flip/wipe, deterministic frozen-frame re-evaluation, pre-Play checkpoint
restore and a multi-zone proving ground. These are proposals, not shipped actions. In particular, `B`/`V`, radial `M`,
`K`/`.` transport shortcuts, backward stepping and named-preset `⌘S` are not the current workbench contract.
Use the existing transport buttons, Copy/Export/Import and fixture reset/replay paths; consult
[lab-workbench.md](lab-workbench.md#input-ownership-and-modes) for implemented shortcuts and scoped proof commands.
