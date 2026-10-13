# Lab Workbench

Desktop workbench for the shared isolation Lab (`packages/kit/lab/`, served at `/lab.html` in Getaway and Blackout).
Embedded game debug overlays (`new LabPanel(...)` in Getaway, Blackout and Outbreak) retain their lightweight floating
overlay behavior (`layout: "floating"`, `capture: "open"`). The standalone Lab mounts the three-column workbench shell
with `LabPanel` in `layout: "inspector"` and `capture: "focus"`.

## Pain points in the previous Lab UI

Before captures, relative to the local artifact root: `2026-10-13-lab-ux-before.png`,
`2026-10-13-lab-workbench/before-default.png`, and
`2026-10-13-lab-workbench/before-blackout-effects.png`.

1. **Floating 285 px overlay over a full-window grid:** A single narrow `<section>` in the top-right corner covered the
   right side of the scene and scrolled through every control in one column.
2. **Duplicate `▾ Controls` headings:** `main.ts` registered global `Section`/`Debug view` controls without a group
   name and then appended the active section's ungrouped controls, creating two separate `▾ Controls` headers stacked
   together; clicking `Randomize` on the first randomized the `Section` and `Debug view` selects.
3. **Overloaded `Section` dropdown:** One flat select mixed `Effects`, `Lighting`, `Materials`, `Physics`, `Spawn`,
   `Blackout effects`, `Getaway effects`, `Fire and water`, `Splatter` and `Audio`.
4. **All 20 parameter groups rendered at once:** Selecting `Blackout effects` mounted all 19 effect parameter groups
   (80+ controls) simultaneously regardless of the chosen effect.
5. **Unreadable default scale and fixed camera:** Effects opened at a 31.8 m camera distance (`eye = focus + [0,22,23]`)
   with no orbit, pan, zoom or target framing (`F`).
6. **Implicit gameplay input in `Spawn`:** Clicking the canvas immediately drove the vehicle or soldier, so Dvorak `e`
   and `Space` competed with editing controls.

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
- Each group header provides `Randomize`, `Reset` (`aria-label="Reset <group>"`) and `Copy` (`aria-label="Copy <group> JSON"`).
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
- **Car skid marks and ground decals (`games/getaway/src/lab/spawn.ts`, `packages/kit/lab/game-sprites.ts`):**
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

1. **Text editing / modal dialog** (`Search library`, `Search controls`, `Exact <control>`, Preset JSON modal): owns
   printable keys, `Space`, arrows and clipboard shortcuts; `Escape` closes the active editor or clears search.
2. **Active placement ghost or move ghost** (`Place <item>`, `Move <object>`): `Click` or `Enter` commits (`Shift+Click`
   stamps and stays armed), `[` / `]` rotates yaw by 15° (`Shift` 1°), arrow keys nudge on the ground plane, `Escape`
   cancels without recording history.
3. **Focused Inspector (`LabPanel`)**: `↑`/`↓` rows, `←`/`→` adjust (`Shift` ×10, `Alt` ×0.1), `Tab`/`Shift+Tab` groups,
   `Enter`/`Space` edit or toggle, `0` reset control, `Shift+0` reset group, `R` randomize group, `C` copy group JSON,
   `Escape` returns focus to the canvas.
4. **Play mode (`mode === "play"`)**: Entered explicitly with `P` (or the top-bar `Play · P` button) when a character
   exists (`?bench` auto-enables `input.enabled` on `Spawn character` for non-interactive regression scripts). Owns
   `WASD`, Dvorak `, o a e`, arrows, `Space` (handbrake) and `Shift` (boost/sprint). Pressing `Escape` or focusing any
   sidebar/toolbar control immediately exits `Play` to `Edit` and calls `input.release()`.
5. **Edit canvas (`mode === "edit"`)**: `Space` retriggers with the same seed, `F` frames the active target/object, `R`
   rerolls the room seed while respecting `Lock FX`/`Lock Env`, `Q`/`E` cycles the active effect/item, `1`–`4` switches
   library categories, `A` arms prop placement, `G` moves the selected object, `Backspace`/`Delete` removes a deletable
   placed object, `⌘D` duplicates it, `⌘Z`/`⇧⌘Z` undoes/redoes authored edits, `Tab` focuses the Inspector, `⌘K` or `/`
   focuses library search, and `Backquote` hides/shows the workbench chrome. Browser shortcuts (`⌘R`, `⌘L`, etc.) are
   never swallowed.

## Limits

- Undo/redo tracks authored state (parameter gestures, group randomize/reset, room seed rerolls, preset imports, and
  placed props/lights/characters in `Spawn`). It does not rewind live particle or rigid-body simulation ticks.
- Full 3D transform gizmo handles and autonomous object behavior presets (`Patrol`, `Chase`, `Orbit` from the proposal)
  are not included in this pass; object placement and movement use cursor ground-raycast ghosts (`yardGround` including
  the ramp) plus keyboard nudging and Inspector `Position X` / `Position Z` / `Yaw` sliders.
- `Audio` never creates or unlocks a live `AudioContext` on section entry or catalog selection; waveform and spectrogram
  previews render through `OfflineAudioContext`, and live playback occurs only after clicking `Audition`.

## Reproduction and verification

Run package and game checks from the repository root:

```sh
bun run check:packages
bun run --cwd games/getaway check
bun run --cwd games/blackout check
bun run --cwd games/outbreak check
```

Run the headless Metal browser proofs through `hivemind`:

```sh
hivemind run --fetch captures/lab-workbench -- bun packages/kit/lab/prove-workbench.ts
hivemind run --fetch captures/lab-car-playground -- bun packages/kit/lab/prove-car-playground.ts
hivemind run -- bun games/getaway/scripts/prove-lab-effects.ts
hivemind run -- bun games/getaway/scripts/prove-lab-spawn.ts
```

<<<<<<< HEAD
Source-branch before/after screenshots and proof JSON live under `2026-10-13-lab-workbench/`, relative to the local
artifact root. Combined-branch results are recorded separately in `docs/integration.md`:
||||||| parent of 0ae6f7f (feat(lab): add connected car skids, persistent playground world, and switchable yard environments)
Saved before/after screenshots and proof JSON live under `~/code/home/artifacts/2026-10-13-lab-workbench/`:
=======
Saved car playground and skid proofs live under `~/code/home/artifacts/2026-10-13-lab-car-playground/`:

- `before-car-skids-1280x800.png` and `after-car-skids-1280x800.png` — matched 1280×800 workbench pair on the identical
  keyboard launch + drift + handbrake trajectory (`0/1600` vs `188/1600` connected rear-wheel skid segments).
- `before-canvas-native-1280x800.png` and `after-canvas-native-1280x800.png` — full-bleed native game scale canvas pair.
- `after-shared-playground-effects.png` and `after-select-car-inspector.png` — switching `Effects` (`Grenade smoke`),
  `Lighting` and `Objects` (`Getaway · Muscle`) in the same persistent Playground while retaining the car, 6 props and
  `73/1600` skid segments.
- `after-street-environment-skids.png` — switching `Env` to `Getaway · Street`, relocating to a validated street spawn,
  and painting `86/1600` skid segments across the crosswalk.
- `car-playground-proof.json` — verified counts and budgets (`1600` skids, `1024` smoke billows, `4096` particles,
  `0` straight-cruise skids, `0` airborne skids, `0` teleport-bridged skids) across both `getaway` and `blackout` hosts.

Saved before/after screenshots and proof JSON live under `~/code/home/artifacts/2026-10-13-lab-workbench/`:
>>>>>>> 0ae6f7f (feat(lab): add connected car skids, persistent playground world, and switchable yard environments)

- `before-default.png` and `before-blackout-effects.png` — prior floating panel with duplicate `Controls` headers and
  all 20 effect groups exposed.
- `after-default-1280x800.png` — workbench layout at 1280×800 with Left Library, framed smoke room, Right Inspector and
  Bottom Transport.
- `after-glass-default.png`, `after-glass-shard-size.png`, `after-glass-rerolled.png` — keyboard-selected `Glass shards`
  in the meeting room (`▾ Emitter`, `▾ Glass shards`, `▾ Environment` only), framed at the glass pane, shard size
  adjusted to a `2.2×` scale factor, and room seed rerolled with the effect locked. Integration labels the new
  glass/paper size controls as multipliers rather than metres.
- `after-spawn-play.png` and `after-spawn-edit.png` — `Car into cones` fixture driven in `Play` mode (`10.92 m/s`),
  exited with `Esc` (`throttle: 0`), and inspected in `Edit` mode without stuck input.
- `after-audio-silent.png` — Audio Lab selected and rendered offline with `0` live `AudioContext` attempts.
- `after-flame-hydrant-1920x1080.png` — responsive 1920×1080 layout on the `Flame & hydrant` fixture.
- `workbench-proof.json` — machine-verified assertions across both `getaway` and `blackout` Lab hosts on Apple Metal.
