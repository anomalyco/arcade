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
3. **Volume and mute are always reachable from the title and the Escape menu**: the speaker and gear buttons in the
   card's corner, and M (unless the game gives M to something else, like Outbreak's map, and passes `muteKey: false`).
4. **No game ships its own volume or quality UI.** The Lab panel may keep designer mix levels (renamed "Mix level"
   where it was "Volume"), but player volume, mute, quality and reduce camera motion live in the shell's Settings.
5. **Escape behaves the same everywhere**: it opens the pause menu (Resume, Settings, Leave), closes Settings, and
   resumes. Pointer-lock games pause whenever the lock goes. A game menu that owns Escape (chat, a pack, a map) says
   so with `escapeOwned`, and the Lab panel's focus with `keysBlocked`.
6. **Closing the tab asks first only when it would lose something**: in a room, or after 30 s of solo play (the
   default), never under automation.
7. **Automation sees the game, not the shell.** Under `navigator.webdriver` the overlays are hidden (pointer-lock
   games start when they take the lock; others start in play), automation starts muted, and saved volumes and quality
   are ignored. Add `?shell` to a URL to show the shell in a proof.
8. **Every card fits a 1280×720 window.** A taller card scrolls inside itself with a soft fade at the edge that has
   more, never clips; keep title slots compact enough that the title card fits without scrolling. The mute and gear
   icons sit in their own row above the title. Check the title at 1280×720 and 1920×1080.

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
| Leave warning | `LeaveGuard` (`shell.guard`) | Nothing, or its own `leaveGuard: () => boolean`. |
| Loading | `ShellLoading` (`shell.loading`): weighted `stage()`s, `done()`, `finish()`, `fail()` | Reports real work; calls `finish()` after the first frame. |
| View | `ShellView` (`shell.view`): title and pause cards, Settings inside them, loading bar, reconnect pill | Restyles with `--shell-font`, `--shell-title-font`, `--shell-ink`, `--shell-dim`, `--shell-card`, `--shell-edge`, `--shell-field`, `--shell-accent`, `--shell-accent-ink`, `--shell-backdrop`, `--shell-radius`. `view: false` draws nothing (headless). |

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
- [ ] Prove it with `bun scripts/prove-game-shell.ts <game>` (stills of the title at 1280×720 and 1920×1080, Settings,
  lobby and pause with `?shell`).

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
| Woods | Not yet (unshipped branch `woods`); see the adoption note below | |
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

## Woods adoption note

Woods (`games/woods`, branch `woods`) built the shell's first draft: `src/menu.ts` (`SettingsMenu`), the `#start`
and `#pause` cards in `index.html`, and quality that starts High and is remembered (`woods.quality`). To adopt the
kit shell: replace `SettingsMenu` and both cards with `createGameShell({ game: "woods", title: "WOODS", subtitle,
soloLabel: "Play alone", soloNote: "you and three campers", friendsNote: "a private room, up to 6", resumeLabel:
"Back to the woods", pointerLock: canvas, blocked: () => panel.holdsInput, keysBlocked: () => panel.hasFocus(), quality,
lobby: { friends: true, onJoin: (room) => (location.search = `?room=${room}`) } })`; build quality with
`createShellQuality({ game: "woods", tiers: FOREST_QUALITY, ... })` (the saved key becomes `arcade.quality.woods.v1`);
point the sound bank's volumes and mute at `shell.settings` (channels master, effects, ambience); drop the Lab's
Quality row; and copy the card's look into `--shell-*` variables (Georgia title, warm `#f2c96b` accent).

## Audit (Oct 22, before the shell)

What each game had for its player-facing shell. Paths are under `games/<game>/`.

| Game | Title / start | Lobby, rooms, invite | Pause / Escape | Volume and mute | Graphics quality (default) | Key prompts | Name entry | Loading | Leave warning | Reconnect UI | LabPanel |
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
