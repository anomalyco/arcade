# carrier

- Right now the game is only the sea and islands: a procedural sunny archipelago (new seed per room) under an orbit
  camera, no ship yet. Waves are a pure function of `(seed, synced sea time)`, so every client sees the same sea.
  Look targets: `concept/shot-5-fleet.png` (sea, swell, sky) and `concept/shot-4-topdown.png` (islands, reefs).
- Module contracts and file ownership: `CONTRACTS.md` (Frame uniform, scene passes, sea, islands, net, URL params).
- `bun run dev` runs Wrangler (rooms, :8797) and Vite (:5197, proxies `/ws`). `bun run check` before every push;
  pushing to `main` deploys to https://anoma.ly/arcade/carrier/ (`bun run deploy` also works). A deploy restarts every
  room (games in progress reset), so CI runs `scripts/deploy.ts --if-changed`: it skips the deploy when the build's
  fingerprint (`/arcade/carrier/deploy.txt`) matches the live one, e.g. a merge that only touches other games.
- WebGPU only runs in secure contexts: test via the deployed URL or `localhost`, never a bare LAN hostname.
- No params: the title (the kit game shell: quick join, create, join by code; see CONTRACTS.md "Multiplayer"). URL params:
  `?room=name` (join it directly), `?seed=N` (offline, fixed world, no menu), `?t=S` (freeze sea time),
  `?cam=x,z,yaw,pitch,dist` (yaw/pitch in degrees, yaw 0 looks north), `?weather=clear|light|medium|heavy` (local
  weather preview from the start, dev builds), `?lab=weather` (dev: opens the dev panel on its weather section; any section id works),
  `?tod=H` (freeze the local clock at hour H, 0-24, for scripted captures), `?bots` (dev: opens the Bots tab; with
  `?seed=N` it plays on an in-page dev room, `src/dev/local-room.ts`, so bots work offline).
  `globalThis.carrier` exposes the renderer, camera, net, frame, grade and atmosphere (the live-editable sunny bases;
  the time of day, then the weather, are applied on top), `weather`, `daynight`, `stars`, `lights`, and in dev builds
  `lab`, `debugMenu` (the dev panel) and `bots`, for debugging and screenshots.
- Dev only: ` opens the dev panel (`src/dev/dev-panel.ts`): the shared floating Lab panel (`@arcade/kit/lab-panel`,
  drawn with knobs) with tabs World (weather, time), Audio, Sounds, Flight (bombsight, radar), Bots and Game (zones,
  quality, volume, key labels, camera shake). Every tunable is a typed setting with label, unit, range, step, approved default and
  Reset; commands are `buttons` rows and live values `readout` rows. `src/main.ts` imports `src/dev/dev-tools.ts`
  behind `import.meta.env.DEV`, so production bundles contain no panel, section or bot code: add a `DevSection` in
  `dev-tools.ts`, never statically in main.ts, and no bespoke menu UI. Weather: timeline/manual, presets, every weather
  parameter, strike now, sea-time pause/speed, readouts, copy/paste JSON, Broadcast to room. Time: clock, sun/moon
  readouts, local hour scrub, presets, speed/freeze, Broadcast to room (see CONTRACTS.md "Day-night"). Bots: see
  CONTRACTS.md "Bots". `globalThis.carrier.debugMenu` is the `DevPanel` (`open(id)`, `select`, `close`, `toggle`).
- Dev rooms: a room runs in dev mode only when the Worker's own config says so (`CARRIER_DEV=1` in `.dev.vars`, read
  by `wrangler dev`, never uploaded by `wrangler deploy`). Only then does it take `shared/protocol.ts` `DEV_MESSAGES`
  (weather, time, objective, bot); anywhere else `RoomCore.message` answers `nope` "dev-only", the one gate.
- Rooms: up to 32 players, free for all: 4 carriers, each its own side in its own colour (orange, cyan, pink, lime),
  8 aboard each; friendly means your own carrier's crew, every other carrier and its jets, boats and guns are enemies
  (one rule: a ship's `team`, shared/crew.ts). Roles: a ship's HELM, a PILOT or a GUNNER (one per
  weapon mount). E: DEPLOY (footer prompt "E DEPLOY"; hold, tap to pin; physical key only; not in a jet, where E is yaw), the only way to
  take the helm, launch a Hornet (2 out per ship; a destroyed jet's slot recharges 30 s) or the F-35C strike jet (1 per
  ship, 45 s; no gun, bay and wing bombs), or man a gun (CIWS PORT/STBD, SAM PORT/STBD, 5-INCH GUN: first person, mouse
  aims, LMB/Space fires, RMB zooms; pick another operation to leave), or launch the BOAT (1 per ship, craned over the
  port side; W/S A/D Shift boost, mouse aims the 25 mm turret, LMB/Space fires; it ends only when brought back alongside
  slowly or sunk, 40 s recharge, and you return to the role you launched from; dev harness `boat.html`, see CONTRACTS.md
  "Boat"); pilots wait on deck until they launch. Every ready jet stands parked in its bay on its carrier's deck and enemies can
  destroy it there (bombs, missiles, shells, rounds, crashes; its slot then recharges as after a crash; CONTRACTS.md
  "Parked jets"). Mouse: aboard, the first click takes Pointer Lock and the mouse then orbits the ship camera (the stick in
  flight); Esc frees it, menus free it and give it back. Controls: at the helm W/S throttle, 1-9/0/= presets, A/D rudder; as a pilot the flight keys plus
  Space/LMB fire, 1/2/3 or wheel/V weapons, F flares, or close to and pointing at your own carrier R LAND (a scripted landing; a flight ends only by landing aboard, a crash or being shot down); Tab players and ships (hold, tap to pin: every carrier in its colour with its crew; JOIN switches ship and so side,
  CREATE SHIP in a sunk carrier's empty berth, captains LOCK, KICK, promote); C free camera (WASD pan, drag orbit, wheel zoom); G full map (hold, tap to pin; the radar and target markers show by themselves in flight, CONTRACTS.md "Pilot's map"); T chat to everyone, Y to your carrier's crew (Tab in the input switches; Enter sends, Esc cancels; the input owns the keyboard; `src/ui/chat.ts`, rules `shared/chat.ts`); M mute; ` dev panel (dev builds). Shared rules: `shared/{crew,squad,ops}.ts`.
- Objective: capture zones (CONTRACTS.md "Capture zones"): hold a 650 m zone alone to score; zones move every
  5 minutes; first carrier to 1,200 points wins the round.
- Sound: one mix in `src/audio/mixer.ts` (`CARRIER_MIX` on the kit's `AudioRuntime`); every recorded sound is a slot in `src/audio/sfx-slots.ts` (takes in
  `public/sfx/v3/`, picks in `public/sfx/picks.json`), played with `sfx().play/loop` (`sfx-bank.ts`) and is a shared library id the Lab can audition (`SLOT_LIBRARY_ID`). Sounds tab of the
  dev panel (or `?sounds=1`): audition every take and pick by ear; Audio tab: levels. See CONTRACTS.md "Sound".
- Renderer (`src/render/`): raw WebGPU, HDR rgba16float, MSAA x4, depth32float with reversed Z (clear 0,
  `greater-equal`), bloom and an ACES-graded composite (`post.ts`). Static world via `renderer.setStatic` (packed
  `Mesh` chunks, `lit.ts`); everything else is a `ScenePass` in the sky/opaque/alpha slots. Sun, sky and fog live in
  `atmosphere.ts` (TS values plus shared WGSL `skyColor`/`hazeColor`/`applyFog`).
- `src/main.ts` still carries TEMPORARY placeholder sky and sea passes; the phase-2 `sky.ts` and `ocean.ts` replace them.
- `shared/` runs in the Durable Object and the browser: keep it free of DOM and Worker APIs. `scripts/build-id.ts`
  hashes it into `shared/build.gen.ts` (gitignored) for the client/server version handshake.
- Cross-game techniques and lessons: `../../docs/game-notes.md`. Shared code plans: `../../docs/shared-code.md`.

## Game shell

- The title, lobby, Escape menu and Settings are the kit game shell (`@arcade/kit/shell`, [docs/game-shell.md](../../docs/game-shell.md)), set up in `src/main.ts` over the live offline sea. Carrier is rooms only (no Play alone) and needs a callsign (`nameRequired`). The Tab menu, DEPLOY and chat stay Carrier's own. Shell colours are in `src/ui/menu.css`.
- Deliberate changes when it moved onto the shell (Oct 22):
  - The load screen (`src/ui/menu.ts`, removed) is the shell's title: callsign, Quick join, Play with friends (Create
    game) and Join by code or invite link, with Settings and mute in the corner. An invite link without a saved
    callsign shows "Join room CODE" instead of a prefilled code field; a full room returns to the title with the
    message (the pre-check of `GET /api/room/:code` is gone).
  - Escape first closes Carrier's own menus (Tab pinned, DEPLOY, the radar map), then opens the shell's menu
    (Resume, Settings, Leave room). The room keeps playing behind it with the controls idle; Leave room returns to
    the title over the offline sea.
  - Volume and mute are in Settings (Master, Effects, Ambience: the same `arcade.volume.carrier.v1`); the mixer's
    designer levels stay underneath in the dev panel. M mutes from the shell (the runtime's own M is off; the mute in
    `carrier.audio.v4` is carried over once) and the "SOUND OFF" toast stays. Quality is in Settings and uses the
    slow-frames policy.
  - Connection trouble shows in the shell's reconnect pill.
