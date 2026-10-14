# Lab authoring guide

Use the shared Lab to tune a production effect, material, physics response or audio cue, then verify it in the game.
This is the canonical authoring contract. [lab-workbench.md](lab-workbench.md) describes the current shell and input
API; [dev-control.md](dev-control.md) covers driving an open browser page with `bun run arcade …`;
[shared-code.md](shared-code.md) covers adapters; [game-notes.md](game-notes.md) records measured techniques.
The rules below apply to new authoring work. Existing gaps are listed explicitly and do not add release gates.

## Tune one change and reproduce it

1. Open the Lab at `/arcade/lab/` (one app for every game; the top-bar Game picker loads one game's adapters or
   all of them). Choose an effect or fixture in the Library drawer
   (`Ctrl+Space`), then its environment in the Outliner's World footer. Select what you are tuning in the Outliner or
   viewport; Details shows its settings first. `⌘K` finds objects, Library items, commands and setting names, and
   the pin on a Details row adds it to the Watch list. Backquote toggles the workbench chrome; games use the same
   panel as a floating overlay.
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

### Vegetation

The Vegetation section (`packages/kit/lab/foliage.ts`, deep link `#foliage`) tunes the production
`packages/kit/gpu/foliage.ts` generators that Outbreak builds its town with. Its Tool picker chooses a test room:

- **Tree**: three trees of the current recipe on a lawn by a street. Presets: Oak, Maple, Pine, Birch.
- **Bush**: a house front with lit windows, foundation planting, a free-standing shrub and a hedge line. Presets:
  Clipped hedge, Overgrown shrub, Hydrangea.
- **Grass**: lawn, mulch edge, path and verge. Presets: Lawn, Overgrown lawn, Weeds / dead grass.
- **Outbreak lot**: all three looks together around a bungalow.

Each look has its own preset, parameters, Randomize (seeded by the Randomize seed, never the structure seed) and
Reset; changing one look never touches the others. Structural parameters rebuild the room from the structure seed;
wind, translucency and actor bending are live uniforms. Lighting is Night (2100K streetlamp, moon, the lead walker's
flashlight), Dusk or Day. The Look picker applies the shared `lookGradeColor` post grade only; the games' scene-side
look terms (palette, practical warmth) are not reproduced here. Walkers (a survivor and a zombie stand-in) loop
through the room and bend grass and bushes with the same `foliageTrample` code Outbreak uses for the player and
zombies. `foliage.set`, `foliage.randomize` and `foliage.preset` (preset JSON version 2; version 1 migrates) drive it
from `arcade`/bench, and `bun packages/kit/lab/prove-foliage.ts` captures every preset.

Gameplay rules and replicated simulation remain authoritative. Camera, cosmetic effects and presentation clutter stay
local; Lab tuning must not silently add wire fields or change authoritative movement, damage or collision rules.
Test an intentional gameplay-physics change in the actual simulation separately from cosmetic clutter experiments.

## Preserve input and audio ownership

Text editors, search, `<select>` dropdowns and preset dialogs own printable keys, arrows, Space and clipboard/text-undo
shortcuts. They must not trigger canvas actions. Placement/move ghosts precede Inspector navigation; focused Inspector
precedes gameplay. Standalone `LabPanel` uses `capture: "focus"`, `layout: "inspector"`; game overlays use floating/open
capture.

Canvas click in Edit selects/places and never possesses a character. Enter Play explicitly with `P` or the Play button
when a character exists. Escape or sidebar/toolbar focus exits Play and releases held keys, including Dvorak movement
(`,AOE`), Space and Shift. Preserve browser shortcuts (`⌘R`, `⌘L`, `⌘W`, `Meta+wheel`). Authored Undo/Redo covers edits
and placements, not simulation time rewind; exiting Play restores the pre-Play checkpoint (with a toast option to keep
the Play state).

All 3D debug surfaces (Lab, Catalogue and Characters) share one viewport gesture grammar (`@arcade/kit/orbit-gestures`
and `packages/kit/lab/viewport-input.ts`):

- **Trackpad**: two-finger scroll orbits (`2F: Orbit` default, switchable to `2F: Pan` in the Lab topbar or via
  `twoFingerScroll`), `Shift` + two-finger scroll pans, and two-finger pinch (`Ctrl+wheel` and Safari
  `gesturestart`/`gesturechange`) zooms (`preventDefault()` scoped strictly to `<canvas>` with `overscroll-behavior: none`
  so horizontal swipes and pinches never navigate or zoom the page).
- **Mouse**: wheel zooms (distinguished from trackpad scroll by `deltaMode !== 0` or 1D integer `|deltaY| >= 80`),
  `RMB` or `MMB` drag orbits, and `Shift` + `RMB`/`MMB` drag pans.
- **Primary pointer (`LMB`)**: click (`<= 4 px`) selects (`Shift+click` toggles multi-selection); click-drag (`> 4 px`)
  on empty space box-selects where multi-object selection exists (Lab sections with scene objects, or when `Box`/`Alt`
  is active) and orbits elsewhere (Catalogue, Characters, or Lab sections without selectable objects; `Shift+drag` pans
  when not adding to an existing selection).
- **Context / Radial**: unmoved `RMB` tap or `Ctrl+click` (`<= 8 px` threshold) or the `ContextMenu` key opens the
  contextual 8-sector radial menu in Lab or the action menu in Catalogue and Characters. The Lab ring
  (`packages/kit/lab/radial.ts`) draws 8 equal wedges with an icon and short label each; the wedge under the pointer's
  bearing from the centre is highlighted (not the label under the pointer), a press anywhere on the disc selects by
  direction, the hub names the target, and the caption below shows the full label and shortcut or the disabled reason.
  Disabled slots stay in place, dimmed. Give radial commands an `icon`. While the ring is open the OS cursor is shown
  instead of the drawn viewport glyph, and pointer moves only rotate the highlight and pointer and retarget two labels;
  rebuild sector DOM only when the ring opens.
- **Keyboard**: `F` frames the active target, `Arrows` orbit (`Shift+Arrows` pan) when the canvas is focused, and `Esc`
  cancels active transforms/ghosts/radial/drags, clears selection, or exits Play/Possess.

Audio entry/selection must stay silent. Render waveform/spectrogram previews offline; live playback requires explicit
Audition. Neither a generic Retrigger nor a preset import should automatically unlock/play audio. Release live audio
on section leave, blur or hidden-tab transitions.

Scene sound is the exception that follows the scene: once the user's first click or key unlocks audio, each loaded
game plays its own sound through a `LabAudioAdapter` (`packages/kit/lab/audio-adapter.ts`), loaded with that game's
Lab adapters and attached to the Lab's single `AudioContext`. Getaway's adapter (`games/getaway/src/lab/audio.ts`) runs
the game's `GameAudio` on its own `AudioEngine`, with the Lab car as the local player's car: the approved procedural
DriverVoice engine and gearbox, tyre squeal and scrub, nitro, crash and scrape samples, landing thumps, exhaust pops and
the city bed. Blackout's (`games/blackout/src/lab/audio.ts`) drives its `Sound` the way `Game` does: animation-cued
footsteps and gun mechanics for the soldier, plus gunshots, bullet impacts, casing and magazine clinks and explosions
for effects. Outbreak has no sound yet. The shared runtime only stands in where no loaded game has a sound: glass,
sparks, splats, vehicle-effect crashes, fire and water beds, and explosions when Blackout isn't loaded. Sections report
effects through `LabContext.emit`; characters hand `LabCharacter.sound()` state to the adapters every simulated tick.
`bun games/lab/scripts/prove-game-audio.ts` renders each game's path and the Lab's into separate offline contexts and
requires identical nodes, connections and AudioParam automation (an engine held at fixed RPM, a slide, footsteps,
gun cues, an explosion) and samples within -120 dBFS. The
top-bar speaker toggles mute (`M` in Edit mode, never in text fields or Play), its slider sets master volume, and the
Audio section's **Lab volume** group sets Vehicles, Effects, Ambience and UI. All of it persists in `localStorage`
(`arcade.lab.audio.v1`). `?bench` stays silent unless `&sound` is added, and automated browsers start muted.

## Compare matched state and label cost honestly

Use `/arcade/lab/?bench` for automation: it stops the live loop and exposes `window.lab` with `select`, `advance`, `render`
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
