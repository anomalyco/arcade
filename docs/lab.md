# Lab authoring guide

Use the shared Lab to tune a production effect, material, physics response or audio cue, then verify it in the game.
This is the canonical authoring contract. [lab-workbench.md](lab-workbench.md) describes the current shell and input
API; [dev-control.md](dev-control.md) covers driving an open browser page with `bun run arcade …`;
[shared-code.md](shared-code.md) covers adapters; [game-notes.md](game-notes.md) records measured techniques.
The rules below apply to new authoring work. Existing gaps are listed explicitly and do not add release gates.

## Tune one change and reproduce it

1. Open the Lab at `/arcade/lab/` (one app for every game; the top-bar Game picker loads one game's adapters or
   all of them). Choose an effect or fixture in the Library drawer
   (`Ctrl+Space`, then type to filter or use the arrow keys and `Enter`), then its environment in the Outliner's World footer. Select what you are tuning in the Outliner or
   viewport; Details shows its settings first. `⌘K` finds objects, Library items, commands and setting names, and
   the pin on a Details row adds it to the Watch list. Backquote toggles the workbench chrome; games use the same
   panel as a floating overlay.
2. Record the settings, room seed, effect seed, lighting and camera. In game-effect sections, keep `Lock FX` on
   while rerolling the room with `R`; `Lock Env` prevents room regeneration. Locks are section-dependent.
3. Use `Space` on the Edit canvas to retrigger the active section. Adjust one Inspector value, then retrigger
   if that value only affects newly spawned particles or bodies. Test bright/dark rooms and gameplay zoom.
4. Use transport Pause and Step where supported. Step advances `1/60 s`; Edit/Play determines input ownership,
   independently of the simulation clock. Reset and replay from the same seeds to compare the same tick.
5. Copy a panel's values (the knobs Copy button or `⇧C`; a row selection copies just those rows) for a parameter
   dictionary, or Export the versioned preset and save the JSON yourself.
   Promote approved values into the canonical production defaults, then check the actual game's rendering and input.

Selecting a fixture intentionally changes scene state. Selecting a tool/effect should preserve the environment,
lighting and authored placement unless the user explicitly changes or resets them. Current lighting survives section
changes, but environments are section-owned and fixtures can replace them. There is no cross-reload saved-preset library.

## Home and labs

The Lab opens on **Home**: every lab, grouped by collection, in a knobs/ui outliner (`tree`) with the selected lab
described beside it (`split`). `/` or `⌘K` searches (every word must match the title, kind, collection or summary),
`↑`/`↓` move, `←`/`→` fold a collection, `↵` or a double-click opens, and `Esc` goes back to the lab you came from.
Home covers the workbench, which stops drawing until a lab opens. In a lab the top bar shows `Labs › collection › lab`;
`H` (or Labs) comes back to Home, the lab's name lists the others in its collection, and `⌥[` `⌥]` step through them.
`1`–`9` pick the open lab's variants, and `⇧` with a number shows what you see now beside that variant as an A/B wipe
(section labs; a page lab just switches). A lab shows only what its subject needs (below): the Library drawer and the
World footer (the global section, environment and seed pickers) are always hidden and `Ctrl+Space` does nothing while
one is open (`data-library="off"` on the workbench root). `?lab=<collection>/<id>` opens a lab on load, and old `?station=<id>` links still
work. `arcade run lab.list`, `lab.open {"id": "look-and-light/weather"}` and `lab.home` do the same from the CLI.

Labs come and go from Home. `+` (or ＋ New lab) starts a draft lab of any section kind in Drafts and opens it; `⌘D`
makes a draft copy beside the selected lab; `⌘S` keeps a draft; `⌫` archives a lab (Undo in the toast) and archived
labs wait, folded, at the bottom of the list with Restore; `⇧⌫` deletes a lab made in this browser after a confirm.
Station labs can be archived (this browser hides them; Restore brings them back) but not deleted: delete the station
file. Drafts nobody touched for 7 days are archived, and labs archived here are deleted 30 days later, each time the
Lab starts (`createSceneStore().sweep()`). Labs made here live in `localStorage` (`arcade.lab.scenes.v1`).

Labs come from station files for now (`games/lab/src/home/catalog.ts`): each station becomes a kept lab in an area
collection (`STATION_AREAS` in `games/lab/src/scenes/from-stations.ts`), merged with this browser's own labs
(`createSceneStore`). A lab a station became unchanged opens that station; one the migration split off (Explosions'
splatter variants) opens a station built from the lab (`stationFromScene`). Every station needs a lab kind in
`games/lab/src/scenes/kinds.ts`; one without starts as a plain `section` or `page` lab and logs a warning, and
`games/lab/tests/scenes.test.ts` fails until it has one. The model and the plan are in [lab-scenes.md](lab-scenes.md).
`bun games/lab/scripts/prove-home.ts` proves Home in a headless browser and writes stills to `captures/lab-home`.

### Labs show only what their subject needs

Every panel is opt-in per lab kind, and there is no voice-notes panel (Kit gives feedback with Scrawl). A kind lists
its panels (`LabKind.panels` in `games/lab/src/scenes/kinds.ts`; the vocabulary is `LabPanel` in
`packages/kit/lab/scenes/kinds.ts`) and the lab shows nothing else:

- The subject's knobs come first and largest: Details for a section lab, the page's own panel in a card for a page lab
  (Outbreak unseen's Unseen layers). A section kind can name its own Details groups (`groups`); otherwise Details
  leaves out the backdrop's groups (`BACKDROP_GROUPS`: Environment and room seed) unless the kind has `backdrop`.
- Variants only when the lab has some; the A/B and grid card and the top bar's A, V, Wipe and Grid only with
  `compare` (Look, Scene look, Style). `⇧` with a number still wipes in any section lab with variants.
- The Outliner only with `objects` (placeable things: the Vehicle lab). The clock and Details' Retrigger row only with
  `transport` (effects and physics). Play only for kinds with a `play` verb.
- A page lab is its page: none of the Lab's own chrome (modes, clock, Details, Outliner, debug view, undo, status-bar
  hints) shows around it, because all of it drives the Lab scene behind the page.
- Station cards are trimmed to the kind too (`labWidgets`): status always (a short summary and the links as buttons,
  such as Play Outbreak), `metrics` when something was measured, `perf` only for section labs with `readouts`, and
  `notes` or `changes` only for a kind that asks for them (none do today).
- A column left with nothing closes. Keys for a piece the lab doesn't show (`Space`, `K`, `.`, `L` without a clock;
  `B`, `V` without compare; `P` without Play; every scene key in a page lab) do nothing.

The Lab's Home applies this when a lab opens (`labChrome` and `detailsGroups` write `data-lab-show` on the workbench
and scope Details; `createStations({ widgets })` trims the cards). `games/lab/tests/scenes.test.ts` checks that only
the Vehicle lab has an Outliner, page labs get none of the Lab's chrome and no station file lists a card its kind
leaves out. Every button, chip, picker and close button in the Lab's own chrome is one size (`--control-h`, knobs'
control height) and one shape.

## Stations

A station is a saved workspace for one demo. Opening its lab runs its section and setup commands, then its widgets
fill three slots around the viewport: the Outliner column (`left`), the top of the Details column (`right`) and a dock
under the viewport (`dock`, which takes the Library drawer's place until you open the Library again). Choosing another
section by hand leaves the lab. The slots and the dock resize from their edges like the other panels, and each
station keeps its own sizes ([lab-workbench.md](lab-workbench.md#layout-outliner--details--library-drawer)). A station whose section belongs to a game that isn't loaded loads that game's
adapters when it opens (`ensureGame` in `games/lab/src/main.ts`, `LabApi.addSections`). `arcade station <id>` still
opens one directly.

Widgets (`packages/kit/lab/stations/widgets.ts`):

| Widget | Shows |
| --- | --- |
| `status` | Status, board feature, a three-line summary and the station's links as buttons |
| `controls` | Knobs cards for chosen Details `groups` and single `keys`, over the same settings as Details |
| `variants` | The variants as chips (`⇧1`–`⇧9`) |
| `compare` | A/B wipe (pin A, pick a variant for B) and the variation grid when the station names one |
| `perf` | Frame rate and the Lab's telemetry line (section counts, GPU time), twice a second |
| `metrics` | Measured numbers with their sources |
| `changes` | Recent commits and unmerged branches (dev server only) |
| `notes` | A text note kept in the browser, only for a kind with `notes` |
| `links` | Links to where the thing lives in the games (status already shows them) |

✎ in the list header edits the layout: drag a card between slots or use its ⋯ menu (move to a slot, earlier or later,
Configure for a title and the controls card's groups, Remove), and `+ Widget` adds one. Edits save per station in the
browser (`arcade.lab.station-layouts.v1`) as you make them; Reset goes back to the station file's layout and Copy JSON
gives the `layout` block to paste into the file. `arcade run station.layout` reads, replaces (`layout`), resets or
opens the editor from the CLI. Without a `layout` the station gets the default: status and measurements left, a
controls card for the section's first two groups with real tuning sliders right, and variants (plus compare and live
numbers in a section lab) in the dock. Either way the lab kind trims it, and `+ Widget` only offers the kind's cards. Groups shown in a controls card are left out of Details, so each setting appears once.

Each station is one file in `games/lab/src/stations/`, picked up by `import.meta.glob`, so adding a station means
adding a file, plus one line for its collection in `STATION_AREAS` (`games/lab/src/scenes/from-stations.ts`) and, unless
an existing kind fits, a lab kind in `games/lab/src/scenes/kinds.ts` (`PAGE_STATIONS` maps page stations to theirs);
`bun test games/lab/tests` says which is missing. Use stations instead of writing a tour when the thing you want Kit to look at is a demo he will come
back to. The type is `LabStation` in `packages/kit/lab/stations/types.ts` (older files import it from
`@arcade/kit/lab/overworld/types`, which still works):

```ts
import { defineStation } from "./define"

export default defineStation({
  id: "weather",                          // arcade station weather, ?station=weather
  title: "Weather",
  summary: "Rain, fog and wind from the shared weather kit, in the Looks room.",
  order: 30,                              // list position; the first ten get keys 1–9 and 0
  status: "in-progress",                  // live | in-progress | review | planned
  demo: { kind: "section", section: "weather", setup: [{ command: "weather.preset", args: { preset: "storm" } }] },
  defaultVariant: "storm",                // the variant the setup already shows
  variants: [{ id: "storm", label: "Storm", setup: [{ command: "weather.preset", args: { preset: "storm" } }] }],
  grid: "looks",                          // optional VARIATION_GRID_PRESETS id for the Grid button
  board: { feature: "AR-19" },            // the board feature the status card links
  metrics: [{ label: "GPU, rain at 1280×800", value: "0.4 ms", source: "perf/weather-lab.json" }],
  paths: ["packages/kit/weather.ts"],     // recent commits touching these
  branches: ["weather-*"],                // unmerged branches matching these
  links: [{ label: "Outbreak street", href: "/arcade/outbreak/?peaceful=1&seed=7" }],
  layout: {                               // optional; Kit's saved edits override it
    right: [{ widget: "controls", groups: ["Precipitation", "Wind & Atmosphere"], title: "Rain" }],
    dock: [{ widget: "variants" }],
  },
})
```

`prop` and `color` from the old Overworld still check; `color` tints the station's chip and cards. Reference sections by
id and put the real setup in commands the section already registers, so a station uses the production path exactly as
`arcade run` would. If the section isn't merged yet the station still appears and says so. `gridVariants("smoke")`
turns a variation-grid preset's tiles into variants. Page demos (`{ kind: "page", url }`) embed another Arcade page,
such as the Characters page, over the viewport; their variants set `url` and run `setup` commands inside the page
through its dev-control runtime. `bun test games/lab/tests` validates every station file and
`bun games/lab/scripts/prove-stations.ts --serve` proves the whole path headlessly. For one page-demo station,
`bun games/lab/scripts/prove-page-station.ts <id> --serve --read key,key` starts the dev router in the same job, picks
each variant through `station.variant` and records the page's Lab settings, body data attributes and a frame. For one
section-demo station, `bun games/lab/scripts/prove-station.ts <id>` runs the demo and every variant against the
production build. It waits while the section's optional `busy()` is true, so a section that bakes in a Worker (Rugs)
is captured after its results land.

## Bind controls to typed production settings

Every control panel is drawn by knobs ([Kit's library](https://github.com/kitlangton/knobs), vendored as
`packages/knobs`): the Lab's Details column, station `controls` cards and each game's Backquote overlay. `LabControl`
and the settings objects stay the source of truth. `packages/kit/lab-knobs.ts` turns rows into knobs fields (ranges with
units and steps, choices, switches, action buttons, groups as flat rows under a heading, in the Lab chrome's `arcade`
preset) and sends edits back through `LabNavigation.set`,
one transaction per gesture; `packages/kit/lab-tuning.ts` holds the pure mapping and the seeded Random. Knobs gives
every panel its header (Random, Reset, Copy and, in games, Undo/Redo), per-group dice and resets, `⇧L` to lock a row
out of Random, hold `\` to see the values from before the last change, `⇧S` saved variants (kept in the browser per
section or page), the row menu and `?` for the rest. In the Lab, `u`/`z` in a panel use the workbench's undo, the same
history as `⌘Z`. Compare's preview and its release apply to the settings but are never undo steps: holding `\` first
closes a gesture still settling, so that gesture stays one step of its own. A panel only works while focus is inside
it, and an open game overlay keeps every key from the game.

- Put every tunable visual, material, physics and audio value in a typed settings object consumed by the real code.
  Bind it with `LabPanel.addControls(settings, controls)` or a `LabSection`'s `settings`/`controls`. `LabSettings`
  is a primitive-valued record, not domain validation; keep stronger types and validation at the production boundary.
- Use `LabControl` ranges, typed select options, toggles and actions. Supply concise labels, named groups, numeric
  `min`/`max`/`step` and explicit `unit`. Use `unit: ""` for seeds or unitless values and `"×"` for multipliers.
  Inferred units can be wrong: shard size scaling is not metres, and radians must not be labelled degrees.
- Where a setting stands in for a ramp (a colour or value over life, distance or the hour), use a `type: "gradient"` or
  `type: "curve"` row (knobs' ramp editors) instead of several numbers. The setting holds the stops or points as JSON
  text in knobs' normalized form; build it with `gradientText`/`curveText` and read it with `parseGradient`/
  `parseCurve` from `@arcade/kit/ramps`. Sample once per change, not per frame or particle: bake a table
  (`curveTable`, `gradientTable`) and read it with `sampleTable` (`@arcade/kit/ramp-table`, no knobs import). Make the
  default the formula it replaces, sampled, and keep running the exact formula while the curve still reads as its
  default (`sameCurve`), so adding a curve changes no pixel until someone edits it. Ramps stay out of Random.
  Shipped: Effects' tint, size and opacity over life (`packages/kit/lab/effects.ts`, `fx/particles.ts` `lifeRamp`),
  Outbreak's sky fill, moon fill and street air haze by darkness (`day-night.ts`) and its beam, lamp and unseen falloffs
  (`light-ramps.ts`).
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

The knobs dice (the header's for every row, a card's for its group, `⌥` to mutate instead) are knobs' own Random and
Mutate, drawing from the panel's recorded tuning seed (knobs' `random` option over `seededRandom(LabPanel.tuning.seed)`;
each roll records the seed it used in `tuning.last` and moves to the next). knobs draws only for the keys a roll
changes, in row order, so a recorded seed replays the roll. Its `tunable` option and `random: false` on seeds keep
switches, locked and dependency-disabled rows, the effect, environment and room pickers, the key-label layout and every
seed out. Copy adds `tuningSeed` when a roll produced the values. A group with
its own `Randomize <group>` action keeps using it. Tuning seeds recorded before the switch to knobs' draws (Arcade's
`seededPatch`, until October 2026) give different values now; none were recorded. Section seeds such as Looks', Weather's or Effects' `tuningSeed` drive their own randomizers and
are unchanged.

Current limitations:

- `LabNavigation.randomize` (still used by the `effect.randomize` command for sections without their own seeded
  `Randomize` actions) uses `Math.random` and leaves toggles unchanged. Copy the result to reproduce it; a room seed
  alone cannot reproduce it.
- `game-effects.ts` provides a custom `Randomize <group>` action with seeded draws, but uses and increments
  `effectSeed`. It clears/retriggers the effect. It does not yet have a separate tuning seed.
- Copy is a dictionary, not an importable full preset. The workbench's `LabPresetSchema` version 1 exports
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
from `arcade`/bench, and `bun scripts/lab/prove-foliage.ts` captures every preset.

Gameplay rules and replicated simulation remain authoritative. Camera, cosmetic effects and presentation clutter stay
local; Lab tuning must not silently add wire fields or change authoritative movement, damage or collision rules.
Test an intentional gameplay-physics change in the actual simulation separately from cosmetic clutter experiments.

## Preserve input and audio ownership

Text editors, search, `<select>` dropdowns and preset dialogs own printable keys, arrows, Space and clipboard/text-undo
shortcuts. They must not trigger canvas actions. A list with type-to-filter (the Library) owns printable keys the same
way: mark its host `data-typeahead` so capture-phase letter shortcuts (`M` mute) skip it, and stop
propagation for the keys it handles. Placement/move ghosts precede Inspector navigation; focused Inspector
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
  contextual 8-sector radial menu in Lab or the action menu in Catalogue and Characters. The Lab opens it only on the
  viewport itself (the canvas or the gizmo, never a panel or button over or beside it; the key only while the canvas
  has focus), and a press or focus anywhere outside the viewport closes it. The Lab ring
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
for effects. Outbreak plays the shared sound library in the game ([sfx-library.md](sfx-library.md)) but has no Lab
scene-sound adapter yet. The Audio section's **Sound library** source browses every library id: pick a sound, a
variant (0 = seeded round-robin) and a distance, then Audition (the only way to hear it) or Render offline. The shared runtime only stands in where no loaded game has a sound: glass,
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
