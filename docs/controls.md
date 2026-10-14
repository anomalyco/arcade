# Controls standard

Cross-game keyboard and mouse conventions for Getaway, Blackout, Outbreak, Carrier, and the shared Lab.

## Core rules

1. **Bind gameplay actions by physical `KeyboardEvent.code`, never logical `e.key`.**
   - Physical `KeyW`, `KeyA`, `KeyS`, `KeyD` (plus arrow keys) are always the movement/steering cluster, and physical
     `KeyE` is immediately to the right of `KeyW` on every keyboard layout (QWERTY, Dvorak, Colemak, AZERTY).
   - Previously, input handlers added `e.key.toLowerCase()` alongside `e.code` and mapped `"e"` / `"KeyE"` to right
     strafe (`KeyD` produces `e.key === "e"` on Dvorak). That stole `KeyE` on both QWERTY and Dvorak, forcing
     interaction onto `KeyF`, and caused Dvorak keys to cross-trigger unrelated actions (`KeyH` producing `"d"` steered
     right while toggling the engine in Getaway; `KeyP` producing `"r"` reloaded in Blackout; `KeyI` producing `"c"`
     toggled free camera in Carrier).
   - Binding strictly by `e.code` eliminates cross-layout collisions and keeps the left-hand cluster identical across
     layouts without configuration.

2. **Show on-screen prompts with the user's active layout label.**
   - Import `keyLabel`, `moveClusterLabel`, `observeKeyLayout`, and `onKeyLayoutChange` from
     `@arcade/kit/client/controls`.
   - `controls.ts` queries `navigator.keyboard.getLayoutMap()` where available, listens for `layoutchange`, learns
     unshifted printable characters from live `keydown` events when the API is unavailable, and falls back to the
     physical code letter (`KeyE` → `E` on QWERTY, `.` on Dvorak; `moveClusterLabel()` → `WASD` on QWERTY, `,AOE` on
     Dvorak).

3. **Primary interact/use is physical `KeyE`; secondary object action is `Hold KeyE`; `KeyF` is Flashlight.**
   - `KeyE` is the primary interact, use, enter/exit vehicle, door/window/fence, and ship-operations key across games.
   - Where an interactable object offers two contextual actions (such as Outbreak's windows and doors), **both actions are shown simultaneously** in a floating world-space prompt near the object (`[E] Peek  ·  [Hold E] Open` on closed windows; `[E] Climb  ·  [Hold E] Close` on open windows; `[E] Open  ·  [Hold E] Lock` on doors; `[E] Vault` on fences), with no hidden action cycling and `KeyQ` kept free.
   - `KeyF` is the dedicated **Flashlight** toggle in Outbreak (matching PC survival-horror conventions), accepted as a silent alias for `KeyE` in Blackout on foot, and used for aircraft countermeasures/carrier landing in Carrier flight (where `KeyQ`/`KeyE` are yaw rudder).

4. **Input ownership and release discipline.**
   - Ignore gameplay bindings when focus is inside `<input>`, `<textarea>`, `<select>`, or `contentEditable`, or while
     the Lab panel (`Backquote`), chat input, or a modal menu owns keyboard capture.
   - Release all held keys on `window` `blur`, `visibilitychange` (hidden), and `MetaLeft` / `MetaRight` `keyup`
     (macOS swallows other `keyup` events while `Cmd` is held).

## Cross-game standard vs. PC conventions

| Action | PC Convention | Arcade Standard (`e.code`) | QWERTY Prompt | Dvorak Prompt | Notes |
| --- | --- | --- | --- | --- | --- |
| Move / Steer / Pitch-Roll | `WASD` / Arrows | `KeyW`, `KeyA`, `KeyS`, `KeyD` + `Arrow*` | `WASD` | `,AOE` | Screen-axis move in top-down games; throttle/steer in vehicles |
| Interact / Primary Action | `E` | `KeyE` (`KeyF` alias in Blackout) | `E` | `.` | Primary contextual verb (Peek closed window, Climb open window, Vault fence, Open/Close door, Enter/Exit vehicle, Ship Ops) |
| Secondary Object Action | `Hold E` | `KeyE` (`0.38 s` hold) | `Hold E` | `Hold .` | Shown simultaneously alongside `E` in Outbreak (`Hold E` Open/Close window, `Hold E` Lock door) |
| Flashlight / Flares | `F` | `KeyF` | `F` | `U` | Flashlight toggle in Outbreak; flares / carrier land in Carrier flight |
| Gadget / Rudder (Context) | `Q` | `KeyQ` | `Q` | `'` | Kept free in Outbreak/Blackout; cop gadget in Getaway; left yaw rudder in Carrier flight |
| Sprint / Boost / Afterburner | `Shift` | `ShiftLeft`, `ShiftRight` | `SHIFT` | `SHIFT` | Stamina sprint in Outbreak; run in Blackout; nitro/boost in Getaway & Carrier |
| Crouch / Seat / Camera | `Ctrl` / `C` | `ControlLeft`, `KeyC` | `CTRL` / `C` | `CTRL` / `J` | `KeyC` cycles vehicle seat in Blackout and toggles camera in Carrier |
| Reload | `R` | `KeyR` | `R` | `P` | Firearm reload in Blackout |
| Jump / Handbrake / Vault / Turret Fire | `Space` | `Space` | `SPACE` | `SPACE` | Contextual fence vault & open-window climb-through in Outbreak; drift/handbrake in Getaway; secondary trigger in Carrier |
| Primary Fire / Cast / Aim | `LMB` + Mouse | `Mouse0` + Cursor / Pointer Lock | `CLICK` | `CLICK` | Cursor aim in Blackout/Outbreak; Pointer Lock in Carrier |
| Look Ahead / Scope / Free Look | `RMB` | `Mouse2` (`KeyX` alias in flight) | `RIGHT CLICK` | `RIGHT CLICK` | Far scout in Blackout; turret zoom / flight free-look in Carrier |
| Equipment / Grenade | `G` / `MMB` | `KeyG`, `Mouse1` | `G` | `I` | Frag / claymore in Blackout |
| Melee / Cycle Weapon | `V` | `KeyV` | `V` | `K` | Melee swing / wizard bonk in Blackout; weapon cycle in Carrier flight |
| Flares / Carrier Land | `F` / `X` | `KeyF` (flight only) | `F` | `U` | Only in Carrier flight where `KeyQ`/`KeyE` are yaw rudder |
| Horn / Engine Toggle | `H` | `KeyH` | `H` | `D` | Horn in Blackout vehicles; engine stealth toggle in Getaway |
| Slot / Preset Select | `1`–`9`, `0`, Wheel | `Digit1`–`Digit9`, `Digit0`, Wheel | `1`–`9`, `0` | `1`–`9`, `0` | Guns/equipment/spells/votes in Blackout; weapons/helm detents in Carrier |
| Scoreboard / Roster | `Tab` | `Tab` (`KeyT` pins in Blackout) | `TAB` | `TAB` | Hold `Tab` (or tap to pin in Carrier; `KeyT` toggles in Blackout) |
| Chat | `Enter` / `T` | `Enter`, `NumpadEnter`, `KeyT` | `ENTER` | `ENTER` | Room chat in Getaway |
| Mute Audio | `M` | `KeyM` | `M` | `M` | Global audio mute in Getaway, Blackout, Carrier |
| Pause / Release / Close | `Esc` | `Escape` | `ESC` | `ESC` | Releases Pointer Lock, closes menus/chat/Lab, exits Lab Play mode |
| Lab / Debug Overlay | `` ` `` / `~` | `Backquote` (`F2` alias in Carrier) | `~` | `~` | Opens `LabPanel` / `DebugMenu` and releases held gameplay keys |

## Full binding inventory & audit across games and Lab surfaces

| Surface | Move / Steer | Sprint / Boost | Handbrake / Jump | Interact / Use | Fire / Aim / Look | Reload / Equip / Melee / Swap | Camera / Seat / Horn | UI / Scoreboard / Chat / Audio / Lab | Audit fixes applied |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Outbreak** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` (stamina sprint) | `Space` contextual vault (fences & open windows) | `KeyE` primary (`Peek` closed window, `Climb` open window, `Vault` fence, `Open/Close` door); `Hold KeyE` secondary (`Open/Close` window, `Lock` door) shown simultaneously; `KeyQ` free | Cursor aim | `KeyF` flashlight toggle; `Digit1`–`Digit5` & Wheel 5-slot hotbar (slot 1: Flashlight) | Lab zoom | `Backquote` Lab | `KeyF` toggles flashlight; simultaneous dual-action prompts (`E` primary + `Hold E` secondary) anchored near objects with `KeyQ` free; `Digit1`–`Digit5` / Wheel hotbar; layout-aware prompts |
| **Blackout (On Foot)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` | — | `KeyE` (`KeyF` alias) enter vehicle, hold to plant/defuse bomb | `Mouse0` fire, Cursor aim, `Mouse2` look ahead, Wheel zoom | `KeyR` reload, `KeyG`/`Mouse1` equip, `KeyV` melee, `Digit1`–`Digit3` gun, `Digit4`–`Digit5` equip | — | `Tab` scores, `KeyT` pin scores/teams, `Digit1`–`Digit4` end vote, `KeyM` mute, `KeyB` sandbox bots, `Backquote` Lab | Unified bomb plant/defuse (`interactHeld`) and vehicle enter/exit on `KeyE` (`KeyF` alias); removed logical `e.key` matching (`r`/`g`/`v`/`f`/`t`/`m`/`b`); layout-aware HUD prompts |
| **Blackout (Driving)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | — | `ShiftLeft` / `ShiftRight` handbrake | `KeyE` (`KeyF` alias) exit vehicle | Passengers shoot (`Mouse0`) and look (`Mouse2`) | — | `KeyC` cycle seat, `KeyH` horn | `Tab` scores, `KeyT` teams, `KeyM` mute, `Backquote` Lab | Prompt updated to `keyLabel("KeyE")` / `keyLabel("KeyC")` / `keyLabel("KeyH")` |
| **Blackout (Wizards)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` | — | `KeyE` (`KeyF` alias) | `Mouse0` cast spell at cursor, `Mouse2` look ahead | `Digit1`/`Digit2` or Wheel select spell, `KeyV` staff bonk | — | `Tab` scores, `KeyT` teams, `KeyM` mute, `Backquote` Lab | Removed `spellMode` `KeyE` movement workaround now that `KeyD` and `KeyE` are bound by physical `e.code` |
| **Getaway** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*`, Gamepad L-stick/triggers | `ShiftLeft` / `ShiftRight`, Gamepad B/X nitro | `Space`, Gamepad A/RB drift | — | — | `KeyQ` (`KeyE` slot 1) cop gadget | `KeyH` engine off (dark mode) | `Enter`/`KeyT` chat (`Esc` close), `KeyM` mute, `Backquote` Lab | Removed `e.key` character set (`","`, `"o"`, `"d"`, `"e"`, `"h"`) that caused Dvorak `KeyH` (`key: "d"`) to steer right while toggling engine; wired `keyLabel` / `moveClusterLabel` into HUD |
| **Carrier (Aboard / Helm)** | `KeyW`/`KeyS` or `ArrowUp`/`ArrowDown` step throttle; `KeyA`/`KeyD` or `ArrowLeft`/`ArrowRight` rudder | `ShiftLeft` / `ShiftRight` fast free-cam pan | — | `KeyE` Ship Operations (hold or tap to pin; `Digit1`–`Digit9` pick op) | Click takes Pointer Lock, mouse orbits ship camera, Wheel zooms | `Digit1`–`Digit9` 10–90% throttle, `Digit0` stop, `Equal`/`NumpadAdd` full ahead | `KeyC` toggle free orbit camera | `Tab` teams/ships (hold or tap to pin), `Escape` release pointer/close menu, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `e.key` matching in `Input`, `Helm`, `game.ts` (`KeyC`), and `Mixer` (`KeyM`) so Dvorak `KeyH` (`"d"`) and `KeyI` (`"c"`) no longer trigger rudder or free camera |
| **Carrier (Flight)** | `KeyW`/`KeyS` throttle/airbrake, `KeyA`/`KeyD` or `ArrowLeft`/`ArrowRight` roll, `ArrowUp`/`ArrowDown` pitch, `KeyQ`/`KeyE` yaw rudder | `ShiftLeft` / `ShiftRight` afterburner | — | `KeyF` carrier land (when prompt shown) | Mouse virtual stick (Pointer Lock), `Mouse0`/`Space` fire, `Mouse2`/`Mouse1`/`KeyX` free look | `Digit1`–`Digit3` select weapon, Wheel/`KeyV` cycle weapon, `KeyF` flares | `KeyC` chase/cockpit camera | `Tab` teams, `Escape` release pointer, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `e.key` matching in `FlightInput` and `WeaponInput` |
| **Carrier (Boat & Gunnery)** | Boat: `KeyW`/`KeyS` ahead/astern, `KeyA`/`KeyD` steer | Boat: `ShiftLeft` / `ShiftRight` boost | — | `KeyE` Ship Operations (leave turret / view ops at sea) | Mouse aim, `Mouse0`/`Space` fire, Turret `Mouse2` scope zoom | — | `KeyC` free camera | `Tab` teams, `Escape` release pointer, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `" "` key matching in `BoatInput` and `TurretInput` in favour of `Space` |
| **Lab & Dev Surfaces** | Play/Possess: `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | Play/Possess: `ShiftLeft` / `ShiftRight` | Play: `Space` brake | Edit mode: logical `P` (`Alt+P` alias) or `▶ Play` button to possess/play, `F8` toggle Eject camera, `Escape` or `■ Stop` exit play & restore checkpoint | Orbit drag, `Shift`+drag pan, `Alt`+drag marquee, `RMB`/logical `M` radial | Edit canvas: `Space` retrigger, logical `F` frame, `G` move, `Shift`+`R` rotate, `D` duplicate, `Backspace`/`Delete` delete, `B`/`V` compare | Inspector: `Arrow*` navigate/adjust, `Enter`/`Space` edit, `0` reset, `R` randomize, `C` copy, `/` or `Cmd+K` search | `Backquote` toggle Lab chrome/overlay; `Alt+[` / `Alt+]` switch Studio Tour mini-tabs | `LabInput` binds Play-mode movement strictly by physical `e.code` (`KeyW`, `KeyA`, `KeyS`, `KeyD`, `Arrow*`, `Space`, `Shift*`); Edit-mode `P` / `Alt+P` / `F8` work from canvas, Outliner, and Details without requiring an active selection |

## Lab Play / Possess & Studio Tour shortcuts

Engine conventions surveyed:
- **Unity Editor**: `Ctrl/Cmd+P` toggles Play (`Ctrl/Cmd+Shift+P` Pause). In a browser, `Cmd/Ctrl+P` is reserved by the OS/browser for **Print**.
- **Unreal Engine (PIE)**: `Alt+P` starts Play In Editor, `Esc` stops PIE, and `F8` toggles **Eject / Possess** (detaching to the free Edit camera while the simulation keeps running).
- **Godot Editor**: `F5` runs the project (`F8` stops). On macOS laptops, function keys require `Fn` or trigger media keys by default.

Arcade Lab workbench standard:
- **Enter Play (`P` or `Alt+P`, or top-bar `▶ Play` button)**:
  - Uses logical `event.key.toLowerCase() === "p"` (physical `KeyP` on QWERTY, physical `KeyR` on Dvorak) and `Alt+P` (`Option+P` on macOS) in Edit mode outside text inputs (`<input>`, `<textarea>`, `contentEditable`), including when focus is in the Outliner, Details (`LabPanel`), Library, or a `<select>` dropdown.
  - Works even when nothing or a prop is selected: automatically switches to `Spawn`, spawns the host Lab's default controllable actor (`getaway:muscle` in Getaway Lab, `blackout:soldier` in Blackout Lab) if none is present, selects `character:active`, captures a `prePlayCheckpoint`, resumes simulation transport if paused, and focuses the canvas. If a Lab host has no character adapter (e.g. Outbreak Vignette-only Lab), displays an explanatory toast.
- **Play-mode movement (`KeyW`, `KeyA`, `KeyS`, `KeyD`, `Arrow*`, `Space`, `ShiftLeft`/`ShiftRight`)**:
  - Bound strictly by physical `KeyboardEvent.code` so the left-hand cluster is identical on QWERTY (`WASD`) and Dvorak (`,AOE`). The bottom status bar hint dynamically displays `moveClusterLabel()` (`WASD` on QWERTY, `,AOE` on Dvorak).
- **Toggle Eject Camera (`F8`, `mode.eject`)**:
  - Detaches input ownership from the possessed actor and re-enables the free Edit orbit/pan/zoom camera while the simulation continues running. Pressing `F8` or `P` again re-possesses the actor.
- **Stop Play (`Escape` or top-bar `■ Stop` button)**:
  - Releases all held keys, exits Play mode back to Edit mode, and restores `prePlayCheckpoint` (with a `[Keep Play State]` toast action to keep the post-Play state as an undoable transaction).
- **Studio Tour mini-tab navigation (`Alt+[` / `Alt+]`)**:
  - When a single-tab studio tour is active, `Alt+[` / `Alt+]` (physical `BracketLeft` / `BracketRight` with `Alt`/`Option`) or clicking any mini-tab in the top strip switches between tour steps in place.
