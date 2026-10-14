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

3. ** Primary interact/use is physical `KeyE`.**
   - `KeyE` is the primary interact, use, enter/exit vehicle, door/window, and ship-operations key across games.
   - Where `KeyF` has no competing binding (Blackout and Outbreak on foot), `KeyF` remains accepted as a silent alias
     for muscle memory while HUD prompts display `keyLabel("KeyE")`.
   - In aircraft flight (Carrier pilot), `KeyQ` / `KeyE` are left/right yaw rudder per PC flight-sim convention, so
     aircraft countermeasures/carrier landing use `KeyF`.

4. **Input ownership and release discipline.**
   - Ignore gameplay bindings when focus is inside `<input>`, `<textarea>`, `<select>`, or `contentEditable`, or while
     the Lab panel (`Backquote`), chat input, or a modal menu owns keyboard capture.
   - Release all held keys on `window` `blur`, `visibilitychange` (hidden), and `MetaLeft` / `MetaRight` `keyup`
     (macOS swallows other `keyup` events while `Cmd` is held).

## Cross-game standard vs. PC conventions

| Action | PC Convention | Arcade Standard (`e.code`) | QWERTY Prompt | Dvorak Prompt | Notes |
| --- | --- | --- | --- | --- | --- |
| Move / Steer / Pitch-Roll | `WASD` / Arrows | `KeyW`, `KeyA`, `KeyS`, `KeyD` + `Arrow*` | `WASD` | `,AOE` | Screen-axis move in top-down games; throttle/steer in vehicles |
| Interact / Use / Enter-Exit | `E` | `KeyE` (`KeyF` alias on foot) | `E` | `.` | Doors, windows, bomb plant/defuse, enter/exit vehicle, Ship Ops |
| Contextual Action Cycle / Secondary | `Q` | `KeyQ` | `Q` | `'` | Cycles window/door actions in Outbreak; cop gadget in Getaway; left rudder in flight |
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
| **Outbreak** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` (stamina sprint) | `Space` contextual vault (fences & open windows) | `KeyE` (`KeyF` alias) door, window peek/open/close/climb, fence vault; `KeyQ` cycles action | Cursor aim | — | Scroll wheel / Lab zoom | `Backquote` Lab | Switched interact from `KeyF`-only to `KeyE` (`KeyF` alias); wired `Space` for fence/window vaulting; removed `KeyE`/`Comma`/`KeyO` from `move()`; added layout-aware prompts |
| **Blackout (On Foot)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` | — | `KeyE` (`KeyF` alias) enter vehicle, hold to plant/defuse bomb | `Mouse0` fire, Cursor aim, `Mouse2` look ahead, Wheel zoom | `KeyR` reload, `KeyG`/`Mouse1` equip, `KeyV` melee, `Digit1`–`Digit3` gun, `Digit4`–`Digit5` equip | — | `Tab` scores, `KeyT` pin scores/teams, `Digit1`–`Digit4` end vote, `KeyM` mute, `KeyB` sandbox bots, `Backquote` Lab | Unified bomb plant/defuse (`interactHeld`) and vehicle enter/exit on `KeyE` (`KeyF` alias); removed logical `e.key` matching (`r`/`g`/`v`/`f`/`t`/`m`/`b`); layout-aware HUD prompts |
| **Blackout (Driving)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | — | `ShiftLeft` / `ShiftRight` handbrake | `KeyE` (`KeyF` alias) exit vehicle | Passengers shoot (`Mouse0`) and look (`Mouse2`) | — | `KeyC` cycle seat, `KeyH` horn | `Tab` scores, `KeyT` teams, `KeyM` mute, `Backquote` Lab | Prompt updated to `keyLabel("KeyE")` / `keyLabel("KeyC")` / `keyLabel("KeyH")` |
| **Blackout (Wizards)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` | — | `KeyE` (`KeyF` alias) | `Mouse0` cast spell at cursor, `Mouse2` look ahead | `Digit1`/`Digit2` or Wheel select spell, `KeyV` staff bonk | — | `Tab` scores, `KeyT` teams, `KeyM` mute, `Backquote` Lab | Removed `spellMode` `KeyE` movement workaround now that `KeyD` and `KeyE` are bound by physical `e.code` |
| **Getaway** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*`, Gamepad L-stick/triggers | `ShiftLeft` / `ShiftRight`, Gamepad B/X nitro | `Space`, Gamepad A/RB drift | — | — | `KeyQ` (`KeyE` slot 1) cop gadget | `KeyH` engine off (dark mode) | `Enter`/`KeyT` chat (`Esc` close), `KeyM` mute, `Backquote` Lab | Removed `e.key` character set (`","`, `"o"`, `"d"`, `"e"`, `"h"`) that caused Dvorak `KeyH` (`key: "d"`) to steer right while toggling engine; wired `keyLabel` / `moveClusterLabel` into HUD |
| **Carrier (Aboard / Helm)** | `KeyW`/`KeyS` or `ArrowUp`/`ArrowDown` step throttle; `KeyA`/`KeyD` or `ArrowLeft`/`ArrowRight` rudder | `ShiftLeft` / `ShiftRight` fast free-cam pan | — | `KeyE` Ship Operations (hold or tap to pin; `Digit1`–`Digit9` pick op) | Click takes Pointer Lock, mouse orbits ship camera, Wheel zooms | `Digit1`–`Digit9` 10–90% throttle, `Digit0` stop, `Equal`/`NumpadAdd` full ahead | `KeyC` toggle free orbit camera | `Tab` teams/ships (hold or tap to pin), `Escape` release pointer/close menu, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `e.key` matching in `Input`, `Helm`, `game.ts` (`KeyC`), and `Mixer` (`KeyM`) so Dvorak `KeyH` (`"d"`) and `KeyI` (`"c"`) no longer trigger rudder or free camera |
| **Carrier (Flight)** | `KeyW`/`KeyS` throttle/airbrake, `KeyA`/`KeyD` or `ArrowLeft`/`ArrowRight` roll, `ArrowUp`/`ArrowDown` pitch, `KeyQ`/`KeyE` yaw rudder | `ShiftLeft` / `ShiftRight` afterburner | — | `KeyF` carrier land (when prompt shown) | Mouse virtual stick (Pointer Lock), `Mouse0`/`Space` fire, `Mouse2`/`Mouse1`/`KeyX` free look | `Digit1`–`Digit3` select weapon, Wheel/`KeyV` cycle weapon, `KeyF` flares | `KeyC` chase/cockpit camera | `Tab` teams, `Escape` release pointer, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `e.key` matching in `FlightInput` and `WeaponInput` |
| **Carrier (Boat & Gunnery)** | Boat: `KeyW`/`KeyS` ahead/astern, `KeyA`/`KeyD` steer | Boat: `ShiftLeft` / `ShiftRight` boost | — | `KeyE` Ship Operations (leave turret / view ops at sea) | Mouse aim, `Mouse0`/`Space` fire, Turret `Mouse2` scope zoom | — | `KeyC` free camera | `Tab` teams, `Escape` release pointer, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `" "` key matching in `BoatInput` and `TurretInput` in favour of `Space` |
| **Lab & Dev Surfaces** | Play/Possess: `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | Play/Possess: `ShiftLeft` / `ShiftRight` | Play: `Space` brake | Edit canvas: `KeyP` possess/play, `Escape` exit play | Orbit drag, `Shift`+drag pan, `Alt`+drag marquee, `RMB`/`KeyM` radial | Edit canvas: `Space` retrigger, `KeyF` frame, `KeyG` move, `Shift`+`KeyR` rotate, `KeyD` duplicate, `Backspace`/`Delete` delete, `KeyB`/`KeyV` compare | Inspector: `Arrow*` navigate/adjust, `Enter`/`Space` edit, `0` reset, `KeyR` randomize, `KeyC` copy, `/` or `Cmd+K` search | `Backquote` toggle Lab chrome/overlay | `LabInput` updated to bind Play-mode movement strictly by physical `e.code` (`KeyW`, `KeyA`, `KeyS`, `KeyD`, `Arrow*`, `Space`, `Shift*`) |
