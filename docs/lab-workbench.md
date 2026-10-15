# Lab Workbench

For tuning workflows and enforceable authoring rules, use [Lab authoring guide](lab.md). This document records
the implemented workbench API and proof; research proposals are not supported actions.

Desktop workbench for the shared isolation Lab (`packages/kit/lab/`, served by the Lab app at `/arcade/lab/`).
Embedded game debug overlays (`new LabPanel(...)` in Getaway, Blackout and Outbreak) retain their lightweight floating
overlay behavior (`layout: "floating"`, `capture: "open"`). The standalone Lab mounts the three-column workbench shell
with `LabPanel` in `layout: "inspector"` and `capture: "focus"`. Both draw with knobs through
`packages/kit/lab-knobs.ts` ([lab.md](lab.md#bind-controls-to-typed-production-settings)); stations add widget slots
around the viewport ([lab.md](lab.md#stations)).

## Layout: Outliner + Details + Library drawer

Board decision D-4 (AR-13) picked concept 1 from `2026-10-14-lab-layout/` (Unreal/Unity style), plus ⌘K universal
search and pinned Watch values from concept 3. `packages/kit/lab/main.ts` mounts the shell; the pieces live in
`outliner.ts`, `library.ts`, `palette.ts` and `watch.ts`, wired by `workbench.ts`.

```
┌ top bar: Hub · Lab <game> · Edit/Play/Box/2F · transport ⟲ ❚❚ ⏭ ↻ speed clock · A V Wipe · View · ⌘K Search · ⌖ ↶ ↷ ⋯ ┐
├ Outliner ─────────┬ viewport (canvas, HUD badge, toast, Watch list) ─────────┬ Details ───────────────────┤
│ search · filter   │                                                          │ selection header + chips  │
│ Vehicles 1        │                                                          │ search · Modified · All   │
│ Props 6 ▸ Cone ×5 ├ Library drawer: categories · collections · tiles ────────┤ Transform → object groups │
│ World: section,   │ (Ctrl+Space; drag a tile into the viewport or click)     │ → relevant section groups │
│ env, seed, locks  │                                                          │                           │
└ status: focus pill · telemetry · hints ─────────────────────────────────────────────────────────────────┘
```

- **Outliner** (left) lists only what is in the scene (`allSceneObjects()`), grouped Characters, Vehicles, Props,
  Emitters, Lights and Fixtures (specimens) with counts and collapse. Repeated kinds fold into one row (`Cone ×5`,
  expandable; clicking the fold selects every member). Type filter menu, `Search scene` field and a per-row lock
  (locked objects are skipped by viewport picking and the marquee). Selection syncs both ways: click replaces,
  `⌘`/`Ctrl`-click toggles, `Shift`-click selects a range; viewport clicks, Shift-clicks and marquees highlight and
  reveal rows. Keyboard (focus with `⇧Tab` from the canvas): `↑↓` select, `⇧↑↓` extend, `←→` collapse/expand,
  `Space` toggle, `Enter` frame, `⌫`/`D`/`F`/`G` act on the selection, `Esc` returns to the canvas. Visibility toggles
  are not implemented (sections have no per-object hide hook yet). The World footer holds Section, Environment,
  seed, Reroll and the effect/environment locks.
- **Details** (right) shows the selection first: header (name, group, kind, position or a multi-selection summary),
  registry-backed action chips (Trigger, Frame, Duplicate, Delete, Move, Play), then `LabPanel` groups ordered by
  the section's `detailsGroups(selection)`: Transform, then object groups (Character, Vehicle & Skids for a vehicle;
  Items for a prop; Light and Lights for a light; Effects for an emitter). Unrelated groups are hidden while
  something is selected; `All` shows them. Nothing selected shows scene settings (Spawn starts with Environment).
  Multi-selection keeps the shared Position X/Z/Yaw (and light) fields. Non-default values are accent-coloured with a
  per-field `↺` reset (one undo entry) and a modified count per group; `Modified` filters to changed fields and
  `Search details` filters by label/key/group. Spawn-time values (units ending `· retrigger`) show an amber dot.
  Defaults are the section's settings captured when the workbench starts, before fixtures or edits.
- **Library drawer** (bottom, `Ctrl+Space`) holds everything you can add: Effects (Starting Fixtures first), Objects,
  Lighting, Audio, Materials, Foliage (the Vegetation section's Tree/Bush/Grass tools and presets) and Looks, with collections, search and tiles. Click arms a placement ghost
  for props/lights (or runs the fixture/effect); dragging a tile into the viewport places props, lights and characters
  at the ground point under the cursor (with a live ghost) and moves an effect's emitter there. The drawer bar with
  category buttons and `Search library` stays visible when closed. Open state persists in `localStorage`.
- **⌘K** searches scene objects (select and frame), Library items, registry commands (those without required
  arguments) and every section's setting names (switch section if needed, clear Details filters, scroll, focus and
  flash the field). Prefixes: `@` scene, `#` settings, `+` library, `>` commands. `/` also opens it.
- **Watch** pins any Details field (hover a row, click the pin) to a small list in the viewport's lower left. Values
  update live, modified values are accented, clicking a name jumps to the field, `×` unpins. Pins persist in
  `localStorage` (`arcade.lab.watch.v1`).

Kept unchanged: transport, A/B compare, radial menu, cursor states, Edit/Play, preset/recipe dialogs (now under `⋯`),
text-field ownership and the CLI. Every layout action is a registry command:

| Command | Args | Effect |
| --- | --- | --- |
| `outliner.select` | `id`, `ids` (comma list), `kind`, `additive` | Replace or extend the selection; reveals the row |
| `outliner.lock` | `id`, `locked?` | Lock/unlock viewport picking |
| `outliner.collapse` | `group`, `collapsed?` | Collapse or expand a type group |
| `outliner.focus` | | Focus the Outliner (`⇧Tab`) |
| `library.toggle` | `open?`, `category?`, `query?` | Toggle/open the drawer (`Ctrl+Space`) |
| `library.place` | `id`, `at?` (`x,z`), `yaw?` | Place a Library item at a ground point, or arm/run it |
| `palette.open` | `query?` | Open ⌘K search |
| `watch.pin` / `watch.unpin` | `key`, `section?`, `pinned?` / `all?` | Manage Watch pins |
| `details.filter` | `modified?`, `query?`, `all?` | Details filters; returns the visible keys |
| `details.reveal` | `key`, `section?` | Jump to a setting |

`arcade state` includes `layout` (`library`, `locked`, `details`, `watch`).

### Registering sections with the layout

Sections need no layout-specific code: every section gets a Library entry (`section:<id>`) categorised by
`LabSection.library?.category` or by its id (`foliage` → Foliage, `looks` → Looks, `*effect*`/`*fx*`/`vignette`/
`explosion` → Effects, `material` → Materials, `audio` → Audio, `light` → Lighting, otherwise Objects). Optional hooks:

```ts
const section: LabSection = {
  id: "looks", label: "Looks", settings, controls,
  library: { category: "looks", items: () => looks.map(l => ({ id: l.id, label: l.label, tag: "Look", select: () => apply(l) })) },
  detailsGroups: selected => (selected.length ? ["Transform", "Grade"] : undefined),
}
```

Catalog entries pushed directly in `buildCatalog()` still work; `libraryCategoryOf` maps `sectionId: "foliage"`,
`"looks"` and `material-recipe:*` entries to their drawer categories even when they use the older `category`.
`LabWorldObject.kind` drives folding and `vehicle` the Vehicles group; `CharacterSpawnable.vehicle` sets it for Spawn.
`LabControl.derived` marks values that mirror scene state (selection transform) so they never count as modified.

## Shared API extensions

### `packages/kit/lab-navigation.ts` and `packages/kit/lab-panel.ts`

- `LabControl` adds optional metadata:
  - `unit?: string` (or inferred from key/label: `m`, `s`, `m/s`, `ms`, `°`, `/s`) formatted cleanly in `<output>` via
    `formatLabValue`.
  - `visible?: (settings: Readonly<LabSettings>) => boolean` to mount only controls and groups relevant to the current
    selection. Groups with no visible controls are unmounted from `[data-controls]` and excluded from keyboard row/group
    navigation and search.
  - `folded?: boolean` to start secondary/advanced groups collapsed.
- `LabNavigation.append(controls)` merges controls into existing groups by name so multiple `addControls` calls never
  produce duplicate group headers.
- `LabOptions` adds:
  - `layout?: "floating" | "inspector"` (default `"floating"`).
  - `onTransaction?: (label: string, before: LabSettings, after: LabSettings) => void` for single-entry history commits
    across slider drags, `<output>` horizontal scrubs, `F`-hold scrubs, arrow-key holds, exact number edits, group
    resets and group randomizations.
  - `onFocusChange?: (focused: boolean, activeRow?: LabRow) => void` and `onToggle?: (visible: boolean) => void`.
- `LabOptions` also takes `history` (the workbench's undo and redo, used by knobs' `u`/`z`), `variants` (where saved
  knobs variants are kept; the Lab keys them per section), `groupActions: false` (no dice) and `pill: false`.
- Knobs draws each group as a card with a die (Random, `⌥` Mutate) and a reset icon that shows while the group differs
  from its defaults; the header has Random, Reset, Copy and `?`.
- Inspector layout only: `addControls(settings, controls, defaults?)` takes approved defaults for Reset and modified
  highlighting; `setView({ order, filter })` orders groups and filters rows; `reveal(key)` focuses, scrolls and flashes
  a row; `resetControl(key)`; `modifiedControls()`; `LabOptions.onPin`/`isPinned` add the per-row Watch pin (a dot at
  the row's left edge on hover). `panel.mountView(el, { id, include })` adds another knobs card over the same settings
  (station `controls` widgets), sharing the write path, transactions, tuning seed and history.
  Floating game overlays keep their previous look.
- Horizontal pointer dragging on `<output>` (and holding `F` over an active numeric row) scrubs values continuously
  (`Shift` ×10, `Alt` ×0.1; `Escape` cancels an active `F`-scrub).

### `packages/kit/lab/types.ts`, `stage.ts`, `game-effects.ts` and `spawn.ts`

- `Stage` (`packages/kit/lab/stage.ts`) adds spherical camera state (`camYaw`, `camPitch`, `camDist`) around `focus`
  with `frameTarget(x, y, z, dist)`, `resetCamera()`, `orbit(dyaw, dpitch)`, `pan(dx, dz)`, `zoomBy(factor)`, and
  raycasting helpers `screenRay(u, v)` and `pickGround(u, v, groundFn)`.
- Canvas dimensions are read from the center viewport host (`viewportHost.clientWidth` × `clientHeight`) after sidebars,
  preventing aspect-ratio stretching when sidebars are open or toggled with `Backquote`.
- `LabSection` (`packages/kit/lab/types.ts`) adds optional workbench hooks:
  `retrigger?()`, `reroll?()`, `frameTarget?()`, `objects?()`, `selectedObjectId?`, `selectObject?(id)`,
  `moveObject?(id, x, z, yaw)`, `deleteObject?(id)`, `duplicateObject?(id)` and `groundHeight?(x, z)`.
- `EffectAdapter` (`packages/kit/lab/game-effects.ts`) adds `relevantGroups?(settings)` so `Blackout effects` and
  `Getaway effects` only mount the active effect's parameter group(s) (for example, `▾ Emitter`, `▾ Glass shards` and
  `▾ Environment` when `Glass shards` is selected).
- `ItemWorld` (`packages/kit/lab/spawn-types.ts` and `games/getaway/src/lab/spawn.ts`) adds `entries()`, `move(id, at)`,
  `remove(id)`, `drawGhost(kind, at)`, `snapshot()`, `restore(placements)`, `environments`, `setEnvironment(kind, seed)`,
  `clearSkids()`, `setSkidsEnabled(enabled)`, `setSmokeEnabled(enabled)` and `skidStats()` using `StreetProps` body IDs
  and models without modifying game physics or default constants.
- **Car skid marks, lamp mounts and fender geometry (`games/getaway/src/lab/spawn.ts`, `games/getaway/src/render/car-mesh.ts`, `packages/kit/lab/game-sprites.ts`, `packages/kit/lab/stage-shader.ts`):**
  - Wires `emissions.skids = fx` (`Fx` from `@arcade/kit/vehicle/fx`) and advances `fx.update(dt)` + `emissions.update(dt)`
    once per simulation tick (`update(dt)`), never inside `prepare()`.
  - Fixes planar decal orientation in `GameSprites` (`right = (cos(r), 0, -sin(r))`, `up = (sin(r), 0, cos(r))`) to match
    `games/getaway/src/render/shaders.ts` so consecutive skid ribbon segments (`kind = 4`, up to 1,600 segments) join
    end-to-end along curves and diagonals, and adds car contact shadow (`kind = 9`, `shape = 5`) and forward headlight
    fan support (`shape = 6`).
  - Exposes `Vehicle & Skids` in the car inspector (`Skid marks`, `Skid width` `0.04–0.45 m`, `Skid life` `1–30 s`,
    `Tyre smoke`, `Clear skids`, `Reset scene`) with exact value entry.
- **Persistent Playground and switchable environments (`packages/kit/lab/yard.ts`, `spawn.ts`, `main.ts`, `workbench.ts`):**
  - Expands the default `Proving Yard` (`72 m × 76 m`) with a central 60 m acceleration/braking lane and 10 m scale ticks,
    a west skid pad with painted drift rings, three ramps/suspension steps (`yardRamps`), and a walled/glass effect test
    alcove (`yardWalls` + `yardBoxes` in `stage-shader.ts` so rendering, polar shadows, smoke volumes, particles and
    vehicle/prop collisions agree).
  - Switching between `Effects`, `Objects` (`Spawn`), `Lighting` and `Physics` while a Playground scene is active keeps
    the car, placed props, skid marks, smoke trails and camera in the same persistent 3D world instead of resetting pools.
  - The top-bar `Env` picker switches the Playground between `Proving Yard` and real seeded `Getaway · Street`,
    `Getaway · Alley` and `Getaway · Plaza` chunks (rebuilding `PropPhysics` wall hashes, relocating the car to a
    validated collision-free spawn with a fresh `EmissionState` so teleports never bridge long segments, and clearing
    incompatible transient trails while preserving effect/lighting settings and seed locks).

## Input ownership and modes

Priority order:

1. **Text editing / modal dialog** (⌘K search, `Search scene`, `Search library`, `Search details`, `Search controls`, `Exact <control>`, Gizmo numeric `X`/`Z`/`°` inputs, Preset/Recipe JSON modal): owns
   printable keys, `Space`, arrows and clipboard shortcuts; `Escape` closes the active editor or clears search.
   `⌘K` (toggle search) and `Ctrl+Space` (Library drawer, physical Space key) work from anywhere, including Play.
   A focused Outliner tree owns arrows, `Space`, `Enter`, `Home`/`End` and `Escape`; other keys fall through to
   the Edit canvas shortcuts below.
2. **Open Radial Marking Menu (`RMB`, `Ctrl+LMB`, or the `ContextMenu` key)**:
   - Uses 8 fixed compass sectors (`0°, 45°, 90°, 135°, 180°, 225°, 270°, 315°`), a `14 px` center dead zone, `96 px` ring radius, and `180 ms` tap-to-latch vs. hold-flick-release threshold.
   - Unavailable commands stay dimmed (`aria-disabled="true"`) in their fixed compass slot so neighbor angles never shift.
   - Object ring (`N` Trigger `Space`, `NE` Possess `P`, `E` Duplicate `D`, `SE` Inspect `I`, `S` Delete `⌫`, `SW` Reset `0`, `W` Move `G`, `NW` Frame `F`) vs. Empty-Ground ring (`N` Trigger FX `Space`, `NE` Spawn Char `P`, `E` Spawn Here `A`/`E`, `SE` Drop Light `L`, `S` Clear FX `⌫`, `SW` Reroll `R`, `W` Move Here `G`, `NW` Frame `F`).
   - When latched open, owns `1`–`8`, sector accelerator keys, `Arrows`, `Enter` and `Escape`.
3. **Active placement ghost or modal transform** (`Place <item>`, `Move <object>` `G`, `Rotate <object>` `⇧R` or `G`→`R`):
   - `Click` or `Enter` commits as 1 undo transaction (`Shift+Click` stamps and stays armed for ghosts), `[` / `]` rotates yaw by 15° (`Shift` 1°), arrow keys nudge on the ground plane, typing digits (`0–9`, `-`, `.`, `Tab` for `X`/`Z`) enters exact coordinate/angle values live, and `Escape` cancels and restores pre-gesture state with 0 history entries.
   - Selected movable objects also display an in-viewport **Transform Gizmo** (`packages/kit/lab/transform.ts`) with draggable Move (`✥`) and Rotate (`↻`) handles and inline numeric `X` / `Z` / `°` inputs, plus a context-aware viewport reticle (`[data-viewport-cursor]`) that hides in `Play` mode.
4. **Focused Inspector (`LabPanel`, drawn by knobs)**: knobs' keys (`?` in the panel lists them): `↑`/`↓` rows,
   `←`/`→` adjust (`Shift` ×10, `⌥`-drag fine), digits or `Enter` edit a number, `⌫` reset a row, `r`/`⌥R` random or
   mutate, `g` the focused group, `⇧L` lock, hold `\` compare, `⇧C` copy, `u`/`z` undo through the workbench, `Escape`
   returns focus to the canvas.
5. **Play mode (`mode === "play"`)**: Entered explicitly with `P` (or `Play · P` / Radial `Possess`) when a character
   exists (`?bench` auto-enables `input.enabled` on `Spawn character` for non-interactive regression scripts). Captures a
   `prePlayCheckpoint` on entry. Owns `WASD`, Dvorak `, o a e`, arrows, `Space` (handbrake) and `Shift` (boost/sprint).
   Pressing `Escape` or focusing any sidebar/toolbar control immediately exits `Play` to `Edit`, calls `input.release()`,
   and restores `prePlayCheckpoint` (with a `[Keep Play State]` toast action if the user wants to keep the aftermath).
6. **Edit canvas (`mode === "edit"`)**:
   - **Pointer & Selection (`packages/kit/orbit-gestures.ts`)**: Shared across Lab, Catalogue and Characters. `Click` (`<= 4 px`) selects, `Shift+Click` toggles/adds to multi-selection, `LMB Drag` on empty space draws a marquee selection box where multi-object selection exists (Lab sections with scene objects, or when `Box`/`Alt` is active) and orbits elsewhere (`Shift+LMB Drag` pans when not adding to an existing selection). `RMB Drag` (`> 8 px`) and `MMB Drag` (`> 4 px`) orbit (`Shift` pans), while an unmoved `RMB Tap` or `Ctrl+Click` (`<= 8 px`) opens the radial/context menu. Multi-selection exposes shared Inspector fields (`Position X`, `Position Z`, `Yaw`, `Light power`, `Light radius`) and commits group move, duplicate (`D` / `⌘D`) and delete (`⌫` / `Delete`) as single undo transactions.
   - **Trackpad & Wheel (`packages/kit/lab/viewport-input.ts`)**: Shared classifier across Lab, Catalogue and Characters viewports. Two-finger scroll orbits by default (`twoFingerScroll: "orbit"`, toggleable to `"pan"` via the Lab topbar `2F: Orbit`/`2F: Pan` button or `scene.set-param`), `Shift` + two-finger scroll pans, physical mouse wheel (`deltaMode !== 0` or 1D integer `|deltaY| >= 80`) zooms, and two-finger pinch (`Ctrl+wheel` or Safari `gesturestart`/`gesturechange`) zooms the 3D camera inside the canvas (`preventDefault()` scoped strictly to `canvas`), with smooth exponential camera damping (`stage.stepCamera(dt)`). `Meta+wheel` and browser `Cmd` shortcuts are never intercepted. Automated Playwright proofs dispatch synthetic `WheelEvent`s; physical multi-finger trackpad hardware feel is not established by synthetic events.
   - **Transport, Frozen-Frame Scrub & A/B Compare (`packages/kit/lab/compare-ab.ts`, `recipe.ts`)**: `Space` retriggers with the locked seed, `K` toggles transport Pause/Play, `.` steps forward 1 frame (`Shift+.` 5 frames), `,` steps backward 1 frame (`Shift+,` 5 frames). Scrubbing any parameter while paused at frame `fN` deterministically re-simulates `fN` ticks of the locked seed in place. `B` pins Baseline `Slot A`, `V` flips between `Slot A` and Candidate `Slot B` at the same frame, `Shift+V` toggles the draggable split-screen A/B wipe, and `Copy Recipe` exports typed game settings (`arcade-game-recipe/v1`) with zero URL parameters.

## Limits

- Undo/redo tracks authored state (parameter gestures, group randomize/reset, room seed rerolls, preset imports, and
  placed props/lights/characters in `Spawn`). It does not rewind live particle or rigid-body simulation ticks; exiting `Play` restores `prePlayCheckpoint`.
- Autonomous object behavior presets (`Patrol`, `Chase`, `Orbit` from the proposal) are not included in this pass; object placement and transforms use cursor ground-raycast ghosts (`yardGround` including ramps), in-viewport 2D projected Move/Rotate handles, modal `G`/`⇧R` numeric entry, and Inspector sliders.
- `Audio` never creates or unlocks a live `AudioContext` on section entry or catalog selection; waveform and spectrogram
  previews render through `OfflineAudioContext`, and live playback occurs only after clicking `Audition`.

## Reproduction and verification

Run package and game checks from the repository root:

```sh
bun run check:packages
bun run --cwd games/getaway check
bun run --cwd games/blackout check
bun run --cwd games/outbreak check
bun run --cwd games/lab check
```

`bun games/lab/scripts/prove-lab.ts` (headless Metal, browser muted) loads every game's sections from the one app,
checks that audio assets return 200 under `/arcade/lab/`, that no `AudioContext` exists before the first gesture, that
mute, master volume and category volumes persist, and that unmuted effects, beds and the engine create voices on a
never-rendered `OfflineAudioContext`. `bun games/lab/scripts/prove-game-audio.ts` checks that the Lab's Getaway and Blackout
audio builds the same node graph and automation as the games' own paths.

Run the headless Metal browser proofs through `hivemind`:

```sh
hivemind run --kind browser -- bun games/lab/scripts/prove-stations.ts --serve
hivemind run --fetch captures/lab-car-playground -- bun packages/kit/lab/prove-car-playground.ts
```

`prove-stations.ts` covers the knobs panels and stations. The older workbench layout proof (`prove-workbench.ts`) read
the pre-knobs panel DOM and was deleted; there is no layout regression proof until the Lab scenes redesign settles.
`games/getaway/scripts/prove-lab-effects.ts` and `prove-lab-spawn.ts` still read that DOM and need knobs selectors.
