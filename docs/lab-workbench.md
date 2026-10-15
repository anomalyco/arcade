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
`outliner.ts`, `library.ts`, `watch.ts` and `perf.ts`, with knobs' overlays (`overlays.ts`), wired by `workbench.ts`.

```
┌ top bar: Hub · Lab <game> · Edit/Play/Box/2F · transport ⟲ ❚❚ ⏭ ↻ speed clock · A V Wipe · View · ⌘K Search · ⌖ ↶ ↷ ⋯ ┐
├ Outliner ─────────┬ viewport (canvas, HUD badge, frame time, Watch list) ────┬ Details ───────────────────┤
│ search · filter   │                                                          │ selection header, toolbar │
│ Vehicles 1        │                                                          │ tabs · search · Modified  │
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
  a toolbar of registry commands (Trigger, Frame, Duplicate, Delete, Move, Play, each with its canvas key as a chip;
  knobs' toolbar, `LabToolbar` in `packages/kit/lab-knobs.ts`), then `LabPanel` groups ordered by
  the section's `detailsGroups(selection)`: Transform, then object groups (Character, Vehicle & Skids for a vehicle;
  Items for a prop; Light and Lights for a light; Effects for an emitter). Unrelated groups are hidden while
  something is selected; `All` shows them. Nothing selected shows scene settings (Spawn starts with Environment).
  Multi-selection keeps the shared Position X/Z/Yaw (and light) fields. Non-default values are accent-coloured with a
  per-field `↺` reset (one undo entry). knobs' search field (`/` with focus in the panel) filters by label, key, group
  or sub-heading across every tab, and its `Modified` chip (with a count) narrows to changed fields. Sections with many
  groups split them into tabs (`LabSection.tabs`). Spawn-time values (units ending `· retrigger`) show an amber dot.
  Defaults are the section's settings captured when the workbench starts, before fixtures or edits.
- **Library drawer** (bottom, `Ctrl+Space`) holds everything you can add: Effects (Starting Fixtures first), Objects,
  Lighting, Audio, Materials, Foliage (the Vegetation section's Tree/Bush/Grass tools and presets) and Looks, with
  collections, search and items. Items show as compact tiles (a 56×36 preview or a line icon for the item's kind, the
  full name on up to two lines, the tag only when the group heading doesn't already say it) or as a dense list (the
  two buttons right of `Search library`; the choice persists in `arcade.lab.library-view`). Click arms a placement
  ghost for props/lights (or runs the fixture/effect); dragging an item into the viewport places props, lights and
  characters at the ground point under the cursor (with a live ghost) and moves an effect's emitter there. The drawer
  bar with category tabs and `Search library` stays visible when closed. Open state persists in `localStorage`.
- **Previews** (`packages/kit/lab/library-thumbs.ts`): the first time a scene-level item runs (fixtures, effects,
  presets, looks, materials; not single props, lights, characters or sounds), its frame 0.9 s later becomes the
  item's preview. `Render previews` under the collections renders every missing one in the current view offline: the
  live loop pauses, each item runs from the same starting scene for 40 fixed ticks through the production renderer,
  and the scene, camera and active item are restored. Previews are 112×72 WebP in `arcade.lab.library-thumbs.v1`
  (240 at most, oldest dropped first); `library.previews clear=true` forgets them.
- **Resizable panels** (`packages/kit/lab/panels.ts`): drag the edge between the viewport and the Outliner, Details,
  Library or station dock, or under a station's left/right widget slot. A handle shows an accent line on hover;
  double-click resets that panel, and its button (or dragging well past the minimum) collapses the Outliner, Details
  or dock to a 22 px bar with its name (click the bar to expand) and closes the Library. A focused handle takes
  `←`/`→` (or `↑`/`↓`) for 16 px, `⇧` for 64 px, `Home`/`End` for the minimum and maximum, `Enter` to collapse and
  `Esc` back to the canvas. The viewport always keeps 360×180 px. Sizes and collapsed state persist per layout in
  `arcade.lab.panels.v1`: the plain workbench, and each station by id, so a station's dock height comes back when it
  reopens. `⋯` → `Reset panel sizes` resets the current layout.
- **Viewport resolution** (`packages/kit/lab/viewport-size.ts`, `⋯` menu): `Auto` renders at the display's pixel
  ratio up to 1.5× (the games' `MAX_DPR`), `Device pixels` up to 2×, `1×` at CSS pixels. A ResizeObserver tracks the
  viewport box, so the render loop no longer reads layout every frame; a panel change marks the size stale and the
  next frame measures it once, because Chrome delivered ResizeObserver callbacks 7–8 frames late while dragging. The
  canvas is resized right before it is drawn, so a resize never presents an empty canvas.
- **⌘K** is knobs' `commandPalette` (`/` also opens it). It lists scene objects (select and frame), registry commands
  (those without required arguments, run by their ids with their keys as chips), the Details panel's own actions,
  presets, fields and resets (knobs' `commandsFrom`, under `Details · <group>`), Library items, and every other
  section's settings (switch section, clear Details filters, scroll, focus and flash the field). With no query it
  shows recent commands first. `palette.open query=…` replies with the ranked results.
- **Watch** pins any Details field (hover a row, click the pin) to a knobs readout panel in the viewport's lower left:
  a numeric setting is a sparkline of the values it has had, any other a watch of its text. Values are pushed only
  when they change (checked four times a second), so an idle list does nothing per frame. Clicking a name jumps to
  the field, `×` unpins (accented while the value is modified). Pins persist in `localStorage` (`arcade.lab.watch.v1`).
- **Frame time** (click the status bar's stats, or `view.perf`): a knobs graph of the frame interval, CPU (the
  frame's script work) and GPU (timestamp queries) against a 16.7 ms line, and CPU and GPU meters against the same
  budget, in the viewport's upper right. Frames are pushed only while it shows; it remembers whether it was open.
- **Overlays** come from `@arcade/knobs/ui` in the Lab's preset (`setupLabOverlays`): top-bar hints are `tooltip`s
  with their shortcut as key chips (`tip(el, text, shortcut)`), notices are `toast`s (deletes carry Undo), and
  deleting several objects at once asks first with `confirm` (the `arcade` CLI deletes without asking).

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
| `library.view` | `view?` (`tiles`/`list`), `group?`, `focus?` | Switch the item view or collection; `focus` moves keyboard focus to the items |
| `library.previews` | `ids?`, `clear?` | Render missing previews for the current view (or `ids`), or forget them |
| `layout.panels` | `panel?`, `size?`, `collapsed?`, `reset?` | Resize, collapse or reset `left`, `right`, `drawer`, `dock`, `leftSlot`, `rightSlot`; returns sizes |
| `palette.open` | `query?` | Open ⌘K search; returns the ranked results |
| `view.perf` | `show?` | Show, hide or toggle the frame-time readout |
| `watch.pin` / `watch.unpin` | `key`, `section?`, `pinned?` / `all?` | Manage Watch pins |
| `details.filter` | `modified?`, `query?`, `all?` | Details filters; returns the visible keys |
| `details.reveal` | `key`, `section?` | Jump to a setting |

`arcade state` includes `layout` (`library` with `view`, `focused`, `cursor` and the preview count, `panels`,
`locked`, `details`, `watch`).

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
- `LabOptions` also takes `history` (the workbench's undo stack as knobs' `HostHistory`: `undo`, `redo`, `canUndo`,
  `canRedo`, `subscribe`; knobs' header Undo/Redo and `u`/`z` follow it), `variants` (where saved knobs variants are
  kept; the Lab keys them per section), `groupActions: false` (no dice) and `pill: false`.
- Section and control shape (all knobs Phase B, knobs `bc769f0`):
  - `LabSection.tabs` puts the section's groups on Details tabs (`{ label, groups }`; a group as `[id, label]` reads
    shorter there: Vegetation's Trees tab shows "Tree Structure" as "Structure"). Groups no tab names show on every
    tab. Only the panel's own Details view has tabs; station cards and game overlays don't. `⌥1`–`⌥9` pick a tab while
    focus is in the panel, `reveal(key)` shows the row's tab, and the search reaches every tab. Vegetation (Scene,
    Trees, Bushes, Grass) and the Outbreak vignette (Scene, Lights, Materials, Look) have tabs.
  - `LabControl.subsection` puts rows under a sub-heading inside their group (Materials: Texture, Colour & roughness,
    Pattern & wear); sub-headings named "Advanced" start folded (Splatter). A group's rows without one come first.
  - `LabControl.pair: { key, label }` draws a range and its upper end as one low–high row with two thumbs (Splatter's
    Small/Large drops as Drop size); both stay separate settings, Copy lists both, and saved variants migrate.
  - Seeds (keys ending `seed`) draw as knobs' seed row: the number and a die that rolls a new one (never part of
    Random). Full-turn headings (a 360° range in degrees: yaw, azimuth, wind direction, texture rotation) draw as an
    angle dial; partial angles stay sliders. The Lab has no key bindings to capture and every vector is a ground-plane
    X/Z pair, which knobs' vec2 letters X/Y, so neither keybind nor vec2/vec3 fields are used yet.
  - A group's die runs the group's own `Randomize <group>` action when it has one (knobs' `groupRandom`).
- `LabControl.mixed?(settings)` marks a value that differs across a multi-selection (Spawn's Light power and radius
  with two different lights selected): the row reads "—" until edited, and the edit sets every selected item.
- Knobs draws each group under a heading with a die (Random, `⌥` Mutate) and a reset icon that shows while the group
  differs from its defaults; the header has Random, Reset, Copy, Undo, Redo and `?`. Groups marked `folded` fold in
  place and open from their heading (or when `reveal(key)` lands in them).
- Every LabPanel wears the `arcade` preset (`arcadePreset` in `packages/kit/lab-knobs.ts`): knobs' `labPreset`
  (square, `--k-frame: flat`, the Lab's palette, title and font weights) with 24 px rows, the UI font and one 11.5 px
  size for labels and values, 20 px fields (`--k-control-h`, `--k-value-size`) and the Lab's 20 px square buttons
  through knobs' `--k-button-*` tokens (toolbars, All on/All off, the variants menu). Inline panels have no frame of
  their own and use the DOM renderer. knobs gives long choices a tooltip with the whole value, keeps labels' words up
  to half the row, and opens lists of more than eight options with a search field (type to filter). The preset's
  `css` holds only what no token reaches yet: action rows and preset chips drawn as the Lab's buttons, and toolbar
  labels at full strength.
  Change the look through tokens first, never in `packages/knobs`; gaps go to Kit's knobs session (`knobs-requests.md`).
- Inspector layout only: `addControls(settings, controls, defaults?)` takes approved defaults for Reset and modified
  highlighting; `setView({ order, filter })` orders groups and filters rows; `reveal(key)` focuses, scrolls and flashes
  a row; `resetControl(key)`; `modifiedControls()`; `LabOptions.onPin`/`isPinned` add the per-row Watch pin (a dot at
  the row's left edge on hover). `panel.mountView(el, { id, include, claim })` adds another knobs card over the same
  settings (station `controls` widgets), sharing the write path, transactions, tuning seed and history. With
  `claim: true` (station cards) Details leaves those rows out while the card is mounted, so each setting shows once;
  `reveal(key)` finds a claimed row in its card.
- Horizontal pointer dragging on `<output>` (and holding `F` over an active numeric row) scrubs values continuously
  (`Shift` ×10, `Alt` ×0.1; `Escape` cancels an active `F`-scrub).

### `packages/kit/lab/types.ts`, `stage.ts`, `game-effects.ts` and `spawn.ts`

- `Stage` (`packages/kit/lab/stage.ts`) adds spherical camera state (`camYaw`, `camPitch`, `camDist`) around `focus`
  with `frameTarget(x, y, z, dist)`, `resetCamera()`, `orbit(dyaw, dpitch)`, `pan(dx, dz)`, `zoomBy(factor)`, and
  raycasting helpers `screenRay(u, v)` and `pickGround(u, v, groundFn)`.
- Canvas dimensions follow the center viewport host's box (tracked by `viewport-size.ts`, scaled by the Viewport
  resolution setting) after sidebars, preventing aspect-ratio stretching when panels resize, collapse or are toggled
  with `Backquote`.
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
   A focused Library (anything below its bar except `Search library`) owns arrows, `Enter`, `Space`, `Home`/`End`,
   `PageUp`/`PageDown`, `Backspace`, `Escape` and every printable key: arrows move between items by row and column
   (group headings break rows; `↑`/`↓` keep the column), `Enter`/`Space` apply the focused item and keep focus on it,
   letters and digits type into `Search library` (so `M`, `N`, `P` and number keys don't fire there), `Esc` returns
   to the canvas. Category tabs take `←`/`→`, collections `↑`/`↓` (`→` or `Enter` into the items), and `↓` from
   `Search library` enters the items. `Tab`/`⇧Tab` moves between the tabs, search, view buttons, collections,
   `Render previews` and the items; each keeps one tab stop. A focused item shows its whole name on a card over its
   neighbours.
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
hivemind run --kind browser --fetch captures/lab-panels -- bun packages/kit/lab/prove-panels.ts
hivemind run --fetch captures/lab-car-playground -- bun packages/kit/lab/prove-car-playground.ts
```

`hivemind run --kind browser --fetch captures/lab-overlays -- bun packages/kit/lab/prove-overlays.ts` proves the
readouts and overlays in Spawn: the Frame button's tooltip with its `F` chip and no native `title` left in the top bar;
⌘K finding and running Frame Scene, and `palette.open` returning Details fields through `commandsFrom`; deleting two
selected lights asks first, Esc keeps them, Delete removes them and the toast's Undo restores them; a numeric Watch
pin is a sparkline and a choice a watch, an idle Watch list makes no DOM changes for a second and an edit reaches it;
the frame-time readout shows its graph and two meters, with main-thread task time per second hidden and shown.
It also proves (in `prove-knobs.ts`) that compare (hold `\`) held past a key nudge's settle leaves the nudge one undo step.

`hivemind run --kind browser --fetch captures/lab-knobs -- bun packages/kit/lab/prove-knobs.ts` proves the knobs panels
at 1440×900 and 1728×1117@2x on the Outbreak scenes station and the vignette section: no rounded box anywhere in the
workbench outside the viewport, 24 px knobs rows, labels, values and choices in one 11.5 px font, no visible frame around
inline panels, flat groups, the Details toolbar and knobs buttons drawn as the Lab's 20 px square buttons with the
canvas keys as chips, no group in both the station's controls
card and Details, no cut menu labels and a tooltip on every cut value, RMB and Ctrl-click on a Details button never open
the radial while an RMB tap on the canvas does, and a press on a panel closes it. It also types into the first choice
list longer than eight options (Materials' texture map) and checks the list filters, selects a spotlight and a lamp in
Spawn and checks Light power reads "—" until an edit sets both, and checks Outbreak's floating overlay wears the same
preset, has a search field that `/` focuses, and that a page's bare `button`/`span` rules don't restyle knobs' buttons.
On the vignette's Details it checks the four tabs, `⌥2` showing Lights, `details.reveal` switching back to the row's
tab, `/` in the panel focusing the search (typing "porch" leaves only the porch lights, across tabs) while `/` on the
canvas still opens ⌘K, and `details.filter { modified }` leaving only changed rows. It checks Lighting's yaw and
azimuth are dials (pitch stays a slider), a Materials seed die rolls a new seed, Splatter's drops are one range whose
low thumb moves only `sizeMin` with the Advanced rows together under their sub-heading, and that Smoke's Shape die
runs `Randomize Shape` instead of knobs' roll. `--shots-only` captures a before/after pair.

`prove-stations.ts` covers the knobs panels and stations. The older workbench layout proof (`prove-workbench.ts`) read
the pre-knobs panel DOM and was deleted; `prove-panels.ts` (below) covers the resizable panels, the Library and its keyboard navigation.
`games/getaway/scripts/prove-lab-effects.ts` and `prove-lab-spawn.ts` still read that DOM and need knobs selectors.

`hivemind run --kind browser --fetch captures/lab-panels -- bun packages/kit/lab/prove-panels.ts` proves the panels
and Library at 1440×900 (DPR 1) and 1728×1117 (DPR 2): previews render for every Foliage item; dragging the Outliner,
Details and Library handles resizes them by the drag, the canvas backing size matches the viewport on every frame
(no lag) and screenshots taken mid-drag are never blank; sizes survive a reload; double-click resets; Details
collapses to a bar and stays collapsed across a reload; handle arrow keys resize; a station's dock height is kept
separately from the workbench's; at DPR 2 the canvas is 1.5× (Auto) or 2× (Device pixels) its CSS box; and a
keyboard-only sequence (`Ctrl+Space`, `↓`, `→`, `↓`, `Enter` applies Maple; typing `pi`, `↓`, `Space` applies Pine;
`⇧Tab`, `↓`, `→`; `M` filters instead of muting; `Esc` to the canvas; Play keys never reach the Library) does what it
says. `--shots-only` captures screenshots and idle cost on any branch for a before/after pair. Idle cost with the
Library open, from CDP `Performance.getMetrics` (`--only idle`, three 6 s windows at 1440×900): layouts per second
fell from 124.5–124.7 to 72.2–73.7 because the per-frame `clientWidth` reads are gone, layout time stayed at 7–9 ms
per second, style recalcs stayed at 62 per second, and `requestAnimationFrame` callbacks stayed at 122–124 per second.
A single 3 s window at 1728×1117 (DPR 2) gave 124 layouts per second before and 71 after. Captures are in `2026-10-14-lab-panels/` relative to the local artifact root.
