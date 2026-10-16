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

2. **Show on-screen prompts with the QWERTY name of the physical key, on every layout.**
   - Prompts name the key at that position on a QWERTY keyboard: `KeyE` → `E`, `KeyR` → `R`, `Backquote` → `` ` ``,
     `ShiftLeft` → `Shift`, `Mouse0` → `LMB`. A Dvorak player sees `E` and presses the key in the same place
     (their `.`), which is what most PC games do. The binding never changes; only the label is fixed.
   - Import `keyLabel` and `moveClusterLabel` from `@arcade/kit/client/controls` for text, and `keyCapHtml` /
     `keyPromptHtml` from `@arcade/kit/client/key-cap` for drawn key caps. Never hard-code a letter in a prompt.
   - Players can opt into their own layout's characters with the shared **Key labels** setting
     (`QWERTY` default, `My keyboard layout`). Add it to each game's Lab or settings with `keyLabelSetting()`; the choice
     is stored per browser (`localStorage["arcade.keyLabels"]`) and applies to every game. Only in that mode does
     `controls.ts` query `navigator.keyboard.getLayoutMap()`, listen for `layoutchange`, and use characters learned
     from unshifted `keydown` events (`KeyE` → `.`, `moveClusterLabel()` → `,AOE` on Dvorak).
   - Re-render prompts from `onKeyLayoutChange`, which fires when the setting changes or the layout map resolves in
     layout mode.

3. **Primary interact/use is physical `KeyE`; secondary object action is `Hold KeyE`; `KeyF` is Flashlight.**
   - `KeyE` is the primary interact, use, enter/exit vehicle, door/window/fence, and ship-operations key across games.
   - Where an interactable object offers two contextual actions (such as Outbreak's windows and doors), **both actions are shown simultaneously** in a floating world-space prompt near the object (`[E] Peek  ·  [Hold E] Open` on closed windows; `[E] Climb  ·  [Hold E] Close` on open windows; `[E] Open  ·  [Hold E] Lock` on doors; `[E] Vault` on fences), with no hidden action cycling. Outbreak containers add a Shift+E alternative (`[E] Search · [Shift][E] Smash`).
   - Draw `Hold E` as the hold key cap, not the word "Hold": `keyPromptHtml("KeyE", "Lock", { hold: true, progress })`
     puts a ring around a round cap and fills it from the game's own hold timer (Outbreak's `holdProgress`, Blackout's
     bomb `progress`). The empty ring alone marks the action as a hold.
   - When tap and hold share a key, draw one cap, not two: Outbreak shows a single ringed E, the tap verb, then the hold
     verb after a small ring glyph (`E Open ◦Lock`). While E is held the ring fills, the tap verb dims and the hold verb
     turns warm.
   - `KeyF` is the dedicated **Flashlight** toggle in Outbreak (matching PC survival-horror conventions), accepted as a silent alias for `KeyE` in Blackout on foot, and used for aircraft countermeasures (flares) in Carrier flight (where `KeyQ`/`KeyE` are yaw rudder; carrier landing is `KeyR`).

4. **Input ownership and release discipline.**
   - Ignore gameplay bindings when focus is inside `<input>`, `<textarea>`, `<select>`, or `contentEditable`, or while
     the Lab panel (`Backquote`), chat input, or a modal menu owns keyboard capture.
   - Release all held keys on `window` `blur`, `visibilitychange` (hidden), and `MetaLeft` / `MetaRight` `keyup`
     (macOS swallows other `keyup` events while `Cmd` is held).

## Key-cap prompts

`@arcade/kit/client/key-cap` draws prompts as DOM key caps that any HUD can drop into `innerHTML`. The stylesheet
installs itself on first use.

| Call | Draws |
| --- | --- |
| `keyCapHtml("KeyE")` | Light key cap with the QWERTY label, dark outline and drop shadow so it reads over night, Noir and bright scenes |
| `keyCapHtml("KeyE", { hold: true, progress })` | Round cap inside a ring; the ring fills clockwise from the top with `progress` (0..1) and the cap sits pressed while `progress > 0` |
| `keyCapHtml("ShiftLeft")`, `keyCapHtml("Space")` | Wide caps (Shift, Ctrl, Alt, Tab, Enter, Esc, Backspace) and a wider Space bar |
| `keyCapHtml("Mouse0")`, `keyCapHtml("Mouse2")` | Mouse icon with the left or right button filled (`Mouse1`, `Wheel` fill the wheel) |
| `keyPromptHtml("KeyE", "Open", options)` | Cap followed by the action verb, the usual prompt row |
| `actionGlyphHtml("door-open", { size, label })` (`@arcade/kit/client/action-glyphs`) | A filled action glyph in `currentColor` to put beside a cap instead of a verb (Outbreak's world prompt, D-25) |

- Drive `progress` from the game's own hold timer every frame; the component has no timer of its own.
- Theme with `--akc-face`, `--akc-ink`, `--akc-edge`, `--akc-ring`, `--akc-track` and `--akc-size` on any ancestor.
- With `prefers-reduced-motion: reduce` the press offset, its transition and the ring glow are off; the ring still fills
  because it reports real progress.
- Caps carry `aria-label` (`"E"`, `"Hold E"`, `"Left mouse button"`).
- Proof: `bun scripts/prove-key-prompts.ts` captures Outbreak, Blackout, Getaway and the Lab on QWERTY, a simulated
  Dvorak layout and Dvorak with the opt-in, asserts the first two match, and writes `captures/key-prompts/sheet.png`.

## Cross-game standard vs. PC conventions

| Action | PC Convention | Arcade Standard (`e.code`) | Prompt (every layout) | Dvorak, opt-in layout labels | Notes |
| --- | --- | --- | --- | --- | --- |
| Move / Steer / Pitch-Roll | `WASD` / Arrows | `KeyW`, `KeyA`, `KeyS`, `KeyD` + `Arrow*` | `WASD` | `,AOE` | Screen-axis move in top-down games; throttle/steer in vehicles |
| Interact / Primary Action | `E` | `KeyE` (`KeyF` alias in Blackout) | `E` | `.` | Primary contextual verb (Peek closed window, Climb open window, Vault fence, Open/Close door, Enter/Exit vehicle, Carrier Deploy menu) |
| Secondary Object Action | `Hold E` | `KeyE` (`0.38 s` hold) | hold cap `E` | hold cap `.` | Shown simultaneously alongside `E` in Outbreak (`Hold E` Open/Close window, `Hold E` Lock door) |
| Flashlight / Flares | `F` | `KeyF` | `F` | `U` | Flashlight toggle in Outbreak; flares in Carrier flight |
| Gadget / Rudder (Context) | `Q` | `KeyQ` | `Q` | `'` | Ping (tap) and field craft (hold) in Outbreak; free in Blackout; cop gadget in Getaway; left yaw rudder in Carrier flight |
| Sprint / Boost / Afterburner | `Shift` | `ShiftLeft`, `ShiftRight` | `Shift` | `Shift` | Stamina sprint in Outbreak; run in Blackout; nitro/boost in Getaway & Carrier |
| Crouch / Seat / Camera | `Ctrl` / `C` | `ControlLeft`, `KeyC` | `Ctrl` / `C` | `Ctrl` / `J` | Hold `Ctrl` to crouch in Outbreak; `KeyC` cycles vehicle seat in Blackout and toggles camera in Carrier |
| Reload | `R` | `KeyR` | `R` | `P` | Firearm reload in Blackout and Outbreak (Outbreak draws rounds from the belt) |
| Jump / Handbrake / Vault / Turret Fire | `Space` | `Space` | `Space` | `Space` | Contextual fence vault & open-window climb-through in Outbreak; drift/handbrake in Getaway; secondary trigger in Carrier |
| Primary Fire / Cast / Aim | `LMB` + Mouse | `Mouse0` + Cursor / Pointer Lock | `LMB` | `LMB` | Cursor aim in Blackout/Outbreak; Pointer Lock in Carrier |
| Look Ahead / Scope / Free Look | `RMB` | `Mouse2` (`KeyX` alias in flight) | `RMB` | `RMB` | Far scout in Blackout; turret zoom / flight free-look in Carrier |
| Equipment / Grenade | `G` / `MMB` | `KeyG`, `Mouse1` | `G` | `I` | Frag / claymore in Blackout; drop held item (tap) or a supply bundle (hold) in Outbreak |
| Melee / Cycle Weapon | `V` | `KeyV` | `V` | `K` | Melee swing / wizard bonk in Blackout; weapon cycle in Carrier flight |
| Flares | `F` / `X` | `KeyF` (flight only) | `F` | `U` | Always flares in Carrier flight, where `KeyQ`/`KeyE` are yaw rudder |
| Horn / Engine Toggle | `H` | `KeyH` | `H` | `D` | Horn in Blackout vehicles; engine stealth toggle in Getaway |
| Slot / Preset Select | `1`–`9`, `0`, Wheel | `Digit1`–`Digit9`, `Digit0`, Wheel | `1`–`9`, `0` | `1`–`9`, `0` | Guns/equipment/spells/votes in Blackout; weapons/helm detents in Carrier |
| Scoreboard / Roster | `Tab` | `Tab` (`KeyT` pins in Blackout) | `Tab` | `Tab` | Hold `Tab` (or tap to pin in Carrier; `KeyT` toggles in Blackout) |
| Chat | `Enter` / `T` | `Enter`, `NumpadEnter`, `KeyT` (Carrier: `KeyT` all, `KeyY` crew) | `Enter` | `Enter` | Room chat in Getaway and Carrier |
| Map | `M` | `KeyG` in Carrier, `KeyN` in Outbreak (`KeyM` is mute in both) | `G` / `N` | `I` / `B` | Hold for the full map, tap to pin (Carrier); tap to open and close (Outbreak, [outbreak-map.md](outbreak-map.md)) |
| Mute Audio | `M` | `KeyM` | `M` | `M` | Global audio mute in Getaway, Blackout, Carrier, Outbreak; Lab mute in Edit mode |
| Pause / Release / Close | `Esc` | `Escape` | `Esc` | `Esc` | Releases Pointer Lock, closes menus/chat/Lab, exits Lab Play mode |
| Lab / Debug Overlay | `` ` `` / `~` | `Backquote` (`F2` alias in Carrier) | `` ` `` | `` ` `` | Opens `LabPanel` / `DebugMenu` and releases held gameplay keys |

## Full binding inventory & audit across games and Lab surfaces

| Surface | Move / Steer | Sprint / Boost | Handbrake / Jump | Interact / Use | Fire / Aim / Look | Reload / Equip / Melee / Swap | Camera / Seat / Horn | UI / Scoreboard / Chat / Audio / Lab | Audit fixes applied |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Outbreak** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` (stamina sprint) | `Space` contextual vault (fences & open windows) | `KeyE` primary (`Peek` closed window, `Climb` open window, `Vault` fence, `Open/Close` door, `Search` / `Take all` on containers, `Pick up` drops, `Unlock` / `Pry` keyed doors, `Deposit supplies` at the workbench, `Store held item` at the stash, hide in or leave a closet, disarm or take a can tripwire, put a car window in); `Shift`+`KeyE` smashes a container open (fast, loud) or looks through a shut outer door's peephole; `Hold KeyE` secondary (`Open/Close` window, `Lock` door, `Deposit supplies` at the stash, re-string sprung cans) shown simultaneously | Cursor aim; `Mouse0` uses the held item (fire, swing, heal, throw a bottle, string cans across a doorway) | `ControlLeft` / `ControlRight` held: crouch (Ctrl+letter, digit and Space browser shortcuts are suppressed); `KeyR` reload (swaps a spare battery with the flashlight in hand); `KeyV` shove; `KeyB` barricade (re-nails a damaged one with a crowbar in hand); `KeyF` flashlight; `Digit1`–`Digit5` & Wheel hotbar, or take item *n* while a container or stash strip is open, research or craft row *n* at the workbench, craft *n* in the field-craft strip, and swap pack slot *n* in while the pack is open; `KeyG` drop held item, hold `KeyG` leave an ammo and plank bundle; `KeyQ` ping, hold `KeyQ` opens the field-craft strip (digits craft); `Tab` pack | Lab zoom | `KeyN` map (drag or two-finger pan, pinch or wheel zoom, click to mark, `Equal`/`Minus` zoom), `Backquote` Lab, `Escape` closes the pack and the map | Belt supplies are never in the hotbar; digits follow the open strip; QWERTY key-cap prompts with the hold ring on `Hold E` |
| **Blackout (On Foot)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` | — | `KeyE` (`KeyF` alias) enter vehicle, hold to plant/defuse bomb | `Mouse0` fire, Cursor aim, `Mouse2` look ahead, Wheel zoom | `KeyR` reload, `KeyG`/`Mouse1` equip, `KeyV` melee, `Digit1`–`Digit3` gun, `Digit4`–`Digit5` equip | — | `Tab` scores, `KeyT` pin scores/teams, `Digit1`–`Digit4` end vote, `KeyM` mute, `KeyB` sandbox bots, `Backquote` Lab | Unified bomb plant/defuse (`interactHeld`) and vehicle enter/exit on `KeyE` (`KeyF` alias); removed logical `e.key` matching (`r`/`g`/`v`/`f`/`t`/`m`/`b`); QWERTY key caps, hold ring on plant/defuse |
| **Blackout (Driving)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | — | `ShiftLeft` / `ShiftRight` handbrake | `KeyE` (`KeyF` alias) exit vehicle | Passengers shoot (`Mouse0`) and look (`Mouse2`) | — | `KeyC` cycle seat, `KeyH` horn | `Tab` scores, `KeyT` teams, `KeyM` mute, `Backquote` Lab | Seat and enter prompts drawn with `keyCapHtml("KeyE")` / `KeyC` / `KeyH` / `ShiftLeft` |
| **Blackout (Wizards)** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | `ShiftLeft` / `ShiftRight` | — | `KeyE` (`KeyF` alias) | `Mouse0` cast spell at cursor, `Mouse2` look ahead | `Digit1`/`Digit2` or Wheel select spell, `KeyV` staff bonk | — | `Tab` scores, `KeyT` teams, `KeyM` mute, `Backquote` Lab | Removed `spellMode` `KeyE` movement workaround now that `KeyD` and `KeyE` are bound by physical `e.code` |
| **Getaway** | `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*`, Gamepad L-stick/triggers | `ShiftLeft` / `ShiftRight`, Gamepad B/X nitro | `Space`, Gamepad A/RB drift | — | — | `KeyQ` (`KeyE` slot 1) cop gadget | `KeyH` engine off (dark mode) | `Enter`/`KeyT` chat (`Esc` close), `KeyM` mute, `Backquote` Lab | Removed `e.key` character set (`","`, `"o"`, `"d"`, `"e"`, `"h"`) that caused Dvorak `KeyH` (`key: "d"`) to steer right while toggling engine; first-round key line drawn with key caps (`WASD`, `Space`, `Shift`, `H`) |
| **Carrier (Aboard / Helm)** | `KeyW`/`KeyS` or `ArrowUp`/`ArrowDown` step throttle; `KeyA`/`KeyD` or `ArrowLeft`/`ArrowRight` rudder | `ShiftLeft` / `ShiftRight` fast free-cam pan | — | `KeyE` Deploy menu (hold or tap to pin; `Digit1`–`Digit9` pick op) | Click takes Pointer Lock, mouse orbits ship camera, Wheel zooms | `Digit1`–`Digit9` 10–90% throttle, `Digit0` stop, `Equal`/`NumpadAdd` full ahead | `KeyC` toggle free orbit camera | `Tab` teams/ships (hold or tap to pin), `Escape` release pointer/close menu, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `e.key` matching in `Input`, `Helm`, `game.ts` (`KeyC`), and `Mixer` (`KeyM`) so Dvorak `KeyH` (`"d"`) and `KeyI` (`"c"`) no longer trigger rudder or free camera |
| **Carrier (Flight)** | `KeyW`/`KeyS` throttle/airbrake, `KeyA`/`KeyD` or `ArrowLeft`/`ArrowRight` roll, `ArrowUp`/`ArrowDown` pitch, `KeyQ`/`KeyE` yaw rudder | `ShiftLeft` / `ShiftRight` afterburner | — | `KeyR` carrier land (when prompt shown) | Mouse virtual stick (Pointer Lock), `Mouse0`/`Space` fire, `Mouse2`/`Mouse1`/`KeyX` free look | `Digit1`–`Digit3` select weapon, Wheel/`KeyV` cycle weapon, `KeyF` flares | `KeyC` chase/cockpit camera | `Tab` teams, `KeyG` full map (hold, tap to pin; every Carrier role), `Escape` release pointer, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `e.key` matching in `FlightInput` and `WeaponInput` |
| **Carrier (Boat & Gunnery)** | Boat: `KeyW`/`KeyS` ahead/astern, `KeyA`/`KeyD` steer | Boat: `ShiftLeft` / `ShiftRight` boost | — | `KeyE` Deploy menu (leave turret / view it at sea) | Mouse aim, `Mouse0`/`Space` fire, Turret `Mouse2` scope zoom | — | `KeyC` free camera | `Tab` teams, `Escape` release pointer, `KeyM` mute, `Backquote`/`F2` debug menu | Removed logical `" "` key matching in `BoatInput` and `TurretInput` in favour of `Space` |
| **Lab & Dev Surfaces** | Play/Possess: `KeyW` `KeyA` `KeyS` `KeyD`, `Arrow*` | Play/Possess: `ShiftLeft` / `ShiftRight` | Play: `Space` brake | Edit mode: logical `P` (`Alt+P` alias) or `▶ Play` button to possess/play, `F8` toggle Eject camera, `Escape` or `■ Stop` exit play & restore checkpoint | Orbit drag, `Shift`+drag pan, `Alt`+drag marquee, `RMB` tap / `Ctrl`+click / menu key radial; `KeyM` mute | Edit canvas: `Space` retrigger, logical `F` frame, `G` move, `Shift`+`R` rotate, `D` duplicate, `Backspace`/`Delete` delete, `B`/`V` compare | Inspector: `Arrow*` navigate/adjust, `Enter`/`Space` edit, `⌫` reset, `R` randomize, `⇧C` copy, `/` search the panel, `⌥1`–`⌥9` tabs, `Cmd+K` command search | `Backquote` toggle Lab chrome/overlay; `H` Home; `Alt+[` / `Alt+]` previous/next lab (Studio Tour mini-tabs while a tour runs) | `LabInput` binds Play-mode movement strictly by physical `e.code` (`KeyW`, `KeyA`, `KeyS`, `KeyD`, `Arrow*`, `Space`, `Shift*`); Edit-mode `P` / `Alt+P` / `F8` work from canvas, Outliner, and Details without requiring an active selection |

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
  - Bound strictly by physical `KeyboardEvent.code` so the left-hand cluster sits in the same place on every layout. The bottom status bar hint shows `moveClusterLabel()`: `WASD` on every layout, or `,AOE` on Dvorak with the opt-in layout labels.
- **Toggle Eject Camera (`F8`, `mode.eject`)**:
  - Detaches input ownership from the possessed actor and re-enables the free Edit orbit/pan/zoom camera while the simulation continues running. Pressing `F8` or `P` again re-possesses the actor.
- **Stop Play (`Escape` or top-bar `■ Stop` button)**:
  - Releases all held keys, exits Play mode back to Edit mode, and restores `prePlayCheckpoint` (with a `[Keep Play State]` toast action to keep the post-Play state as an undoable transaction).
- **Studio Tour mini-tab navigation (`Alt+[` / `Alt+]`)**:
  - When a single-tab studio tour is active, `Alt+[` / `Alt+]` (physical `BracketLeft` / `BracketRight` with `Alt`/`Option`) or clicking any mini-tab in the top strip switches between tour steps in place.
- **Multi-Tile Variation Grid (`⊞ Grid` button, `1`–`9`, `Esc` / `G`)**:
  - Clicking `⊞ Grid` in the top Compare bar (or running `arcade grid [preset]`) splits the single WebGPU canvas into 2–9 synchronized variant tiles sharing one camera, simulation clock, and seed.
  - Clicking a tile or pressing `1`–`9` focuses that tile full-size; pressing `Esc` or `G` returns to the multi-tile grid (or closes the grid when already in multi-tile view).

## Lab stations

- **Home** (the Lab's first page; [lab.md](lab.md#home-and-labs)): Home owns every key while it shows. `/` or `⌘K`
  search, `↑`/`↓` move (`↑` from the first row goes to the search), `←`/`→` fold, typing a letter jumps to a label,
  `↵` or a double-click opens a lab, `Esc` goes back to the open lab (from the search, `Esc` clears it first, then
  returns to the list). On a lab in the list: `+` new lab, `⌘D` duplicate, `⌘S` keep a draft, `⌫` archive, `⇧⌫`
  delete (labs made in this browser, after a confirm).
- **In a lab**: logical `H` shows Home (mnemonic, like `N` and `P`); `Alt+[` / `Alt+]` (physical `BracketLeft` /
  `BracketRight`) step to the previous or next lab in the collection, unless a studio tour is running, which keeps them
  for its tabs. Both work from the canvas and the chrome, not while typing, in Play or with focus in Details.
  `Digit1`–`Digit9` pick the lab's variants (outside text fields, Play, the variation grid and the radial, which keep
  their own number keys); `Shift` + a digit shows the current state beside that variant as an A/B wipe (section labs).
  `Ctrl+Space` does nothing in a lab: there is no Library drawer. In an embedded page (Characters, Carrier) number
  keys are forwarded from the page.
- **Knobs panels** (Details, station controls cards, game overlays): keys work only while focus is inside a panel and
  are knobs' own (`?` lists them): arrows move and adjust, `r` / `⌥R` random / mutate, `g` the focused group, `⇧L`
  lock, hold `\` compare, `⌫` reset a row, `⇧C` copy, `⇧S` save a variant, `u`/`z` undo, `Esc` hands focus back.
  `/` focuses the panel's search (Details and game overlays); on the canvas `/` still opens ⌘K. `⌥1`–`⌥9` pick a
  Details tab (no Lab key uses `⌥` + a digit; `⌥P` and `⌥[`/`⌥]` stay the Lab's). `[` / `]` cycle saved variants when there are some,
  else the tabs; on the canvas they keep rotating a ghost or a moved object.
- **Details toolbar**: Trigger, Frame, Duplicate, Delete, Move and Play show their canvas keys (`Space`, `F`, `D`,
  `⌫`, `G`, `P`). The keys press a button while focus is on the toolbar; in the settings panel below, `f`, `g` and
  `⌫` stay knobs' (first row, group Random, reset a row), so the toolbar is its own small panel.
- **Focused labs**: keys for a piece the open lab doesn't show do nothing (`Space`, `K`, `.`, `L` without a clock;
  `B`, `V` without compare; `P` without Play; every scene key in a page lab). See docs/lab.md, "Labs show only what
  their subject needs". There is no voice-note key: Kit gives feedback with Scrawl.

