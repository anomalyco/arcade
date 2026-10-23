# Game shell

Every Arcade game shares one player-facing shell: the title and lobby, the Escape menu, Settings (volume, mute,
graphics quality, reduce camera motion, key labels), the leave-page warning and the loading screen. It lives in
`@arcade/kit/shell` (`packages/kit/shell/`). The debug `LabPanel` (Backquote) is separate and stays the designer's
tool; the shell is what players see.

## Rules

1. **Every game uses `@arcade/kit/shell` for settings, pause, title and lobby.** A game keeps its own backdrop, art
   and game-specific title and pause content (`shell.view.titleSlot`, `shell.view.pauseSlot`), and restyles with the
   `--shell-*` CSS variables. It never forks the behaviour. A HUD gear or speaker button calls
   `shell.flow.openSettings()`: Settings pauses, and closing it plays again.
2. **Default graphics is High (Auto starts High).** Build quality with `createShellQuality`: Auto starts at the
   game's High tier and steps down only on measured slow frames (startup and runtime), never on GPU headroom alone.
   The pick is saved per game (`arcade.quality.<game>.v1`) and applies live. `?quality=` pins a mode for automation.
   A game can opt into **Ultra** by supplying `tiers.ultra`; other games keep their four choices. Auto never picks
   Ultra. An explicit Ultra choice starts at full resolution, then may shed resolution and tiers on slow frames.
   Once it leaves Ultra, recovery stops at High until the player selects Ultra again. `?quality=ultra` pins it
   for measurement. Unsupported Ultra requests fall back to High.
3. **Volume and mute are always reachable from the title and the Escape menu**: the master volume slider and speaker
   in the bottom-right corner, and M (unless the game gives M to something else, like Outbreak's map, and passes
   `muteKey: false`). They agree: M mutes and the slider shows Muted; turning the slider up unmutes. Per-channel
   volumes are in Settings (a menu item on both screens).
4. **No game ships its own volume or quality UI.** The Lab panel may keep designer mix levels (renamed "Mix level"
   where it was "Volume"), but player volume, mute, quality and reduce camera motion live in the shell's Settings.
   The one sanctioned in-HUD volume control is the shell's `ShellVolumeButton` (below); a game opts in by mounting it.
5. **Escape behaves the same everywhere**: it opens the pause menu (Resume, Settings, Leave), closes Settings, and
   resumes. Pointer-lock games pause whenever the lock goes. A game menu that owns Escape (chat, a pack, a map) says
   so with `escapeOwned`, and the Lab panel's focus with `keysBlocked`.
6. **Closing the tab asks first only when it would lose something**: in a room, or after 30 s of solo play (the
   default), never under automation.
7. **Automation sees the game, not the shell.** Under `navigator.webdriver` the overlays are hidden (pointer-lock
   games start when they take the lock; others start in play), automation starts muted, and saved volumes and quality
   are ignored. Add `?shell` to a URL to show the shell in a proof.
8. **Menus sit in the world, not in a card** (Kit, Oct 22: "much more like in-game… it's really weird that it keeps
   making you click in different places"). The wordmark stays at one place from loading to the title to the Escape
   menu and Settings; under it a line (subtitle, Paused, Settings or a message) always holds two lines' height, so the
   menu's first item (Play, Resume) lands on the same spot on every screen. The game's controls are a one-line hint row
   along the bottom, with the volume at its right. A menu taller than the window scrolls inside itself with a soft
   fade; it never clips. Check the title at 1280×720 and 1920×1080.
9. **One click plays.** Play (or Resume) takes the pointer lock and starts the sound in the same click. Right after
   the player's own Esc the browser refuses a new lock for about a second; the shell holds the click's request until
   then (inside the click's activation) and retries once, so no second click is needed. A click anywhere on the world
   behind the Escape menu resumes too.

## Using it

```ts
import { createGameShell, createShellQuality } from "@arcade/kit/shell"

const quality = createShellQuality({ game: "lot", tiers: LOT_QUALITY, params, gpuMs: () => renderer.lastGpuMs, onChange: () => shell.settings.changed() })
const shell = createGameShell({
  game: "lot", title: "LOT", subtitle: "Ashwood, after hours", playLabel: "Walk the lot",
  channels: ["master", "effects", "ambience"], quality,
  pointerLock: canvas,                       // omit for cursor games
  blocked: () => panel.holdsInput,           // hides the overlays while the Lab panel has the input
  keysBlocked: () => panel.hasFocus(),       // the shell ignores M and Escape while typing in the panel
  loading: { gpu: 1, world: 4, frame: 1 },   // or omit when the game has its own loading art
  controls: () => [keyPromptHtml("KeyW", "Move"), keyPromptHtml("Escape", "Menu")].join(" "),
  lobby: { friends: true, onSolo, onJoin, onLeaveRoom, onReady, onStart },  // room games only
  onLeave: () => leaveRun(),
})

// Each frame:
shell.tick(now)
if (shell.playing) quality.frame(now); else quality.pause()
if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
audio.master = shell.settings.gain("master")   // master × channel, 0 while muted
```

| Piece | Headless model | What the game does |
|---|---|---|
| Settings | `ShellSettings` (`shell.settings`): `volumes`, `muted`, `gain(channel)`, `volume(channel)`, `reduceMotion`, `keyLabels`, `quality`, game `sections` | Reads values or subscribes and applies them to its mix, camera and quality. Plugs its own player settings in as `sections` (range, toggle, choice rows). |
| Flow | `ShellFlow` (`shell.flow`): `screen` (`title`, `playing`, `paused`), `overlay`, `settingsOpen`, `play()`, `pause()`, `resume()`, `leave()` | Simulates while `shell.playing` (or keeps running in a room). Runs its Leave in `onLeave`. |
| Lobby | `ShellLobby` (`shell.lobby`): `name` (saved as `<game>.name`), `room`, `players`, `connection`, `inviteLink()`, `join()`, `playWithFriends()` (`api/create`), `quickMatch()` (`api/quick`, with `quick: true`), `linkedRoom` (an invite link opened the page). No `onSolo`: no Play alone. `nameRequired`: rooms wait for a typed name instead of `fallbackName` | Owns the room socket; pushes `setRoom`, `setPlayers`, and `setSocketStatus(socket.status())` for the reconnect pill. A game that plays as soon as it joins calls `shell.flow.play()` in `onJoin`; one that gathers first leaves the room card up (players, ready, start). |
| Audio runtime | `audioRuntimeSync(settings, runtime)` | Games on the kit `AudioRuntime` call it once a frame: mute, master and per-channel bus gains. It turns the runtime's own M off (`muteKey = false`); keep `autoBindDom` on, since it also unlocks audio on the first gesture. |
| HUD volume | `ShellVolumeButton` / `mountVolumeControl(shell.settings, el, { channel?, muteKey? })` | Opt-in. Mounts a speaker in a HUD corner `el` (the game positions `el`; the control sets `pointer-events: auto`). Click toggles mute; hover drops a master-volume slider (moving it up unmutes). The icon shows muted (or 0), low (< 50%) or high. Same `ShellSettings` as Settings and M, so it saves the same way. It never holds keyboard focus (a key while it has focus blurs it and goes on to the game) and stops its own pointer events, so clicking it never takes pointer lock; under pointer lock it is out of reach until Esc frees the cursor. Carrier uses it top right. |
| Leave warning | `LeaveGuard` (`shell.guard`) | Nothing, or its own `leaveGuard: () => boolean`. |
| Loading | `ShellLoading` (`shell.loading`): weighted `stage()`s, `done()`, `finish()`, `fail()` | Reports real work; calls `finish()` after the first frame. |
| View | `ShellView` (`shell.view`): the wordmark, the menu column (title, Escape menu, Settings, the loading bar), the title slot beside it, the hint row and volume along the bottom, reconnect pill | Restyles with CSS variables (below). `pausedLabel` sets the Escape menu's line (`""` keeps the subtitle), `decor(phase)` draws a theme's own furniture around the menu (Barbara's camcorder OSD). `view: false` draws nothing (headless). |

### Theming

The default look is a left-aligned column over a scrim that darkens the left and the bottom of the world and leaves the
rest clear. A game restyles it with variables on `.arcade-shell` and its own rules for the shell's classes:

| Hook | What it sets |
|---|---|
| Type and colour | `--shell-font`, `--shell-title-font`, `--shell-title-size`, `--shell-item-size`, `--shell-ink`, `--shell-dim`, `--shell-accent`, `--shell-accent-ink`, `--shell-field`, `--shell-edge`, `--shell-radius`, `--shell-card` (the reconnect pill and HUD volume) |
| Layout | `--shell-x` (left and right inset), `--shell-top` (the wordmark's top), `--shell-col` (menu width), `--shell-aside` (title slot width beside the menu; it moves above the menu under 1080 px) |
| Backdrop | `--shell-scrim` (the gradient behind the menu), `--shell-backdrop` (under it, for a vignette or scan lines), `--shell-curtain` (the loading screen's dark, which lifts off the world when it's done) |
| Motion | `--shell-ease`, `--shell-in`, `--shell-out`, `--shell-stagger`, `--shell-rise`: a changed screen's items rise into place in a stagger, exits only fade and are shorter, the first paint doesn't animate, reduced motion drops the rise |
| State | `data-phase` on `.arcade-shell` and `data-shell` on `<html>` (`loading`, `title`, `paused`, `settings`; absent in play), so a game can step its own HUD aside (`html[data-shell] #hud { opacity: 0 }`); `--v` on every slider is its fill, for themes that draw their own track |

Volume channels are the kit's (`@arcade/kit/audio/volume`): Master, Effects, Ambience, Voices and Music, saved per
game in `arcade.volume.<game>.v1`, so games that already saved them keep the player's levels. List only the channels
the game has sound for (`channels: []` for a silent game such as Walkers: no Sound section, mute button or M); `labels` renames one (Voices → "Zombies"). Mute is `arcade.mute.<game>.v1`
(`legacyMuteKey` reads an older one once). Reduce camera motion is one choice for every game
(`arcade.reduceMotion`, default from `prefers-reduced-motion`), like Key labels (`arcade.keyLabels`).

The quality policy is `stepDown: "slow-frames"` on `AdaptiveQualityController` (`packages/kit/quality.ts`): startup
keeps High unless the startup frames miss the budget (over 1.25× → Balanced, 1.65× → Low), and at runtime only slow
windows shed resolution, then a tier. The older `"headroom"` policy, still the controller's default, also stepped down
when GPU time alone left little headroom. Record frames only in play (`shell.playing`): the title and the menu are
not the game's real load.

Settings reads the active tier live, including while a room keeps running behind it: `Auto: Balanced`, or
`Ultra: High` after a downgrade. Reduced resolution is reported as a percentage of that tier's DPR, for example
`Ultra: Ultra · 90% resolution`. The requested mode stays selected and saved.

Barbara's Ultra draws at native DPR up to 2, with 12 fog samples and mist steps, full-detail trunks to 60 m,
ferns to 22 m and distant geometry to 180 m (the camera already reaches 300 m). Its shadow cap remains 2048,
the spot-shadow API's current limit; the authored shadow-size setting still applies. It retains High's two
torch-shadow slots and 4K map print. Measurements: [Barbara Ultra](../perf/barbara-ultra.md).

## Checklist for a new game

- [ ] `createShellQuality` with the game's three tiers; High is the default. `quality.frame(now)` only while
  `shell.playing`, `quality.fit` before rendering.
- [ ] `createGameShell` with the title, the channels the game has, `pointerLock` (if any), `blocked` and
  `keysBlocked` for the Lab panel, `controls` key-cap prompts, and `lobby` for room games.
- [ ] The game's audio reads `shell.settings.gain(...)`/`volume(...)` and `muted`; no other mute or volume UI. If the
  audio runtime binds M itself, turn only that off (`audioRuntimeSync` sets `AudioRuntime.muteKey = false`). Don't use
  `autoBindDom: false` for it: that also drops the first-gesture audio unlock unless the game unlocks audio itself.
- [ ] Simulation pauses with `shell.playing` in solo play; rooms keep running behind the menu.
- [ ] Game menus that close on Escape are named in `escapeOwned`.
- [ ] Player settings that aren't volume or quality go in as `sections`, not Lab rows.
- [ ] The game's own HUD steps aside while the shell is up if it would sit under the menu or the hint row
  (`html[data-shell] #hud { opacity: 0 }`).
- [ ] Prove it with `bun scripts/prove-game-shell.ts <game>` (stills of the title at 1280×720 and 1920×1080, Settings,
  lobby and pause with `?shell`). `bun scripts/prove-shell-ingame.ts <game> --clip` measures the wordmark and Play
  against Resume, counts the clicks to play and back, checks M against the slider and records loading → play.

## Status (Oct 22)

Each game lists its deliberate changes in its own `AGENTS.md` under "Game shell".

| Game | On the shell | Where |
|---|---|---|
| Lot | Yes | `games/lot/src/main.ts`, `src/quality.ts`, `src/walk-audio.ts` |
| Night Shift | Yes (its boot screen stays its loading screen; the title card sits over READY) | `games/nightshift/src/main.ts`, `src/look/quality.ts` |
| Brawl | Yes (roster parade in the title slot) | `games/brawl/src/main.ts` |
| Archers | Yes (couch Play, Play online, rooms) | `games/archers/src/main.ts` |
| Walkers | Yes (silent: Playback section, no Sound) | `games/walkers/src/main.ts` |
| Blackout | Yes (mode and map picks in the title slot) | `games/blackout/src/main.ts`, `src/ui/menus.ts` |
| Getaway | Yes (night-road backdrop in the title slot) | `games/getaway/src/main.ts`, `src/ui/lobby.ts` |
| Carrier | Yes (rooms only, callsign required) | `games/carrier/src/main.ts` |
| Outbreak | Escape menu and Settings; its own lobby stays the title | `games/outbreak/src/main.ts`, `src/lobby/run-tools.ts` |
| Barbara | Yes (room by link; M mutes; the Lab panel hides the menus while it is open, so you can play with it up; camcorder OSD theme, the title camera pans the camp) | `games/barbara/src/main.ts`, `index.html` |
| Lab | Exempt: it is the authoring tool, not a game. It keeps Key labels and its own Edit-mode mute | |
| Landing, redirects | Out of scope: independent projects | |

### Deliberate changes in the Lot and Night Shift

- Both get a title card before play and the Escape menu (Resume, Settings, Quit to title) on losing the pointer lock,
  instead of a "click to look/resume" prompt.
- M mutes on the title and the menu too, not only while the pointer is locked.
- Lot: graphics quality is new. Auto starts at High, which is the 1.5× cap it always drew at, and steps to Balanced
  (1.25×) and Low (1×) only on slow frames. Its loading text is now the shell's loading bar.
- Lot: the Lab's Sound › Mute and Walking › Reduce camera motion rows moved to Settings; Sound › Volume is now
  "Mix level". Footsteps are the Effects channel, beds, one-shots and weather are Ambience.
- Night Shift: the Lab's Look › Quality tier and Feel › Reduce camera motion rows moved to Settings (its saved
  `nightshift.reduceMotion` is read once). Quality is now saved, uses the slow-frames policy and sizes the canvas
  with the Lab's Look off too (Today had always drawn at 1.5×, so before, the Quality setting did nothing by default). The phone and the
  descent voices are Voices ("Phone and voices"), movement is Effects, room tone and machinery are Ambience. Audio
  Volume is now "Mix level".
- Night Shift: the READY screen no longer prints "Begin"; the title card's Begin starts the opening.

## Barbara (formerly Woods)

Woods built the shell's first draft (`SettingsMenu`, the `#start` and `#pause` cards, quality that starts High and is
remembered). Barbara now uses the kit shell: `createGameShell({ game: "barbara", ... })` with Play alone, Play with
friends and an invite room (a room is its own page, `?room=<code>`, so joining loads it and Leave room loads solo),
`createShellQuality` over `FOREST_QUALITY` (`arcade.quality.barbara.v1`; frame time only, as before), channels master,
effects, ambience and voice copied into the sound bank, Subtitles as a Story section, and the look in `--shell-*`
variables (since Oct 23 a 1996 camcorder's viewfinder: see Barbara's `AGENTS.md`, Game shell). The Lab's Volume, Mute, Quality and Reduce camera motion
rows are gone; `blocked` is the Lab panel being open, not only holding input, so the cards stay out of the way while
you tune and a click on the woods plays on.

## Audit (Oct 22, before the shell)

What each game had for its player-facing shell. Paths are under `games/<game>/`.

| Game | Title / start | Lobby, rooms, invite | Pause / Escape | Volume and mute | Graphics quality (default) | Key prompts | Name entry | Loading | HUD volume | `ShellVolumeButton` / `mountVolumeControl(shell.settings, el, { channel?, muteKey? })` | Opt-in. Mounts a speaker in a HUD corner `el` (the game positions `el`; the control sets `pointer-events: auto`). Click toggles mute; hover drops a master-volume slider (moving it up unmutes). The icon shows muted (or 0), low (< 50%) or high. Same `ShellSettings` as Settings and M, so it saves the same way. It never holds keyboard focus (a key while it has focus blurs it and goes on to the game) and stops its own pointer events, so clicking it never takes pointer lock; under pointer lock it is out of reach until Esc frees the cursor. Carrier uses it top right. |
| Leave warning | Reconnect UI | LabPanel |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Archers | None: couch play starts at once (`src/main.ts`) | `?room=`, `?online` or P quick-joins; Copy invite in the room line (`src/ui/hud.ts`) | None | None: `Sound.setMuted` (saved `archers.muted`) is never bound, though its comment says M; no sliders | None: fixed `MAX_DPR = 1.5` | Key caps in `src/ui/hud.ts` | None (bot names) | None | None | None | Dev playground only (`src/dev/playground.ts`) |
| Blackout | Landing in `src/ui/menus.ts` | Quick, practice, sandbox, create (mode, map), join by code; host controls on the scoreboard; rejoin after a version reload | None (Esc unused in play) | M mutes (`src/main.ts`); sliders in the Lab (`src/ui/debug-overlay.ts`, `bindVolumeControls`) | `GameQuality` Auto, headroom policy; Lab View › Quality (`src/quality.ts`) | Key caps (`src/ui/hud.ts`, `modes-hud.ts`) | Landing field, `blackout.name` | None | None | `RoomSocket.status()` in the HUD (`src/game/net.ts`) | `DebugOverlay` extends `LabPanel` |
| Brawl | Landing in `src/ui/menus.ts` | Quick, practice, create, join; character select; results | None | M mutes (saved `brawl.muted`); no sliders | `GameQuality` Auto, headroom; Lab View | Key caps (`src/ui/menus.ts`, `hud.ts`) | Landing field, `brawl.name` | WebGPU notice only | None | `session.status()` in the HUD (`src/session.ts`) | `LabPanel` in `src/main.ts` |
| Carrier | Load screen over the sea (`src/ui/menu.ts`) | Quick, create, join by code (`src/ui/lobby.ts`); team and ops menus | Esc frees the pointer and closes menus | M mutes (kit runtime via `src/audio/mixer.ts`, `carrier.audio.v4`); sliders in the dev panel | `GameQuality` Auto, headroom; dev panel Game tab | Key caps (`src/ui/hud.ts`, `menu.ts`, `flight/hud.ts`) | Callsign field (required) | None | None | Own socket state (`src/net.ts`) | Dev builds only (`src/dev/dev-panel.ts`) |
| Getaway | Title in `src/ui/lobby.ts` | Solo, quick, create, join by code; waiting room with Copy invite link (`src/ui/hud.ts`); `?r=` links | Esc only closes chat | M mutes (`src/audio/game-audio.ts`); sliders in the Lab (`src/ui/debug-overlay.ts`) | `GameQuality` Auto, headroom; Lab View | Key caps (`src/ui/hud.ts`) | Title field, `getaway.name` | None | None | Room pill with connecting/reconnecting (`src/game/net.ts`, `hud.ts`) | `DebugOverlay` extends `LabPanel` |
| Lab | Home page (`src/home/home.ts`) | None | Esc exits Play and closes Home | M mutes in Edit mode (`src/sound/lab-sound.ts`) | Per renderer | Key caps throughout | None | None | None | None | Is the Lab |
| Lot | None: click to look | None | None (pointer lock just drops) | M mutes while locked; Lab Sound › Mute and Volume (`src/walk-settings.ts`) | None: fixed 1.5× | Key caps (`src/main.ts`) | None | "Loading the lot…" text | None | None | `LabPanel` (Night panel) |
| Night Shift | Boot screen READY + "Begin" (`@arcade/kit/client/boot-screen`) | None | None ("Click Resume" prompt) | M mutes while locked; Lab Audio › Volume | `AdaptiveQualityController` Auto (headroom), not saved; Lab Look › Quality tier (`src/look/quality.ts`) | Key caps (`src/main.ts`) | None | Boot screen with real progress | None | None | `LabPanel` (Office panel) |
| Outbreak | Lobby over a practice space (`src/lobby/lobby-ui.ts`) | Solo, host, join by code or link, Copy invite link, ready, start; seed replay link | Solo pause in the lobby (#399): Esc, Resume | Speaker button with sliders (`src/volume/menu.ts`) and the Lab; M is the map (#419) | `AdaptiveQualityController` Auto, headroom, saved `arcade.quality.v1` (`src/quality.ts`) | Key caps everywhere | Lobby field (`src/coop-hud.ts`) | "Loading" status text | `beforeunload` in a night (`src/controls/index.ts`, #419) | Co-op HUD (`src/coop-hud.ts`, `src/net-session.ts`) | `LabPanel` in `src/main.ts` |
| Walkers | None: a training viewer | None | None | No audio | None | Key caps (`src/main.ts`) | None | None | None | None | `LabPanel` in `src/main.ts` |
| Woods (branch) | `#start` card: name, Play alone, Play with friends | Create room, Copy invite link, room code on pause | `#pause` card: Esc, Resume, click outside | `SettingsMenu` (`src/menu.ts`): Master, Effects, Ambience, Mute (M) on title and pause | Auto/High/Balanced/Low, starts High, remembered (`woods.quality`) | Key caps (`src/main.ts`) | `woods.name` | None | None | Away players in the room list | `LabPanel` |
