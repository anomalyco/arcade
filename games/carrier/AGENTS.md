# carrier

- Right now the game is only the sea and islands: a procedural sunny archipelago (new seed per room) under an orbit
  camera, no ship yet. Waves are a pure function of `(seed, synced sea time)`, so every client sees the same sea.
  Look targets: `concept/shot-5-fleet.png` (sea, swell, sky) and `concept/shot-4-topdown.png` (islands, reefs).
- Module contracts and file ownership: `CONTRACTS.md` (Frame uniform, scene passes, sea, islands, net, URL params).
- `bun run dev` runs Wrangler (rooms, :8797) and Vite (:5197, proxies `/ws`). `bun run check` before every push;
  pushing to `main` deploys to https://anoma.ly/arcade/carrier/ (`bun run deploy` also works).
- WebGPU only runs in secure contexts: test via the deployed URL or `localhost`, never a bare LAN hostname.
- No params: the load screen (quick join, create, join by code; see CONTRACTS.md "Multiplayer"). URL params:
  `?room=name` (join it directly), `?seed=N` (offline, fixed world, no menu), `?t=S` (freeze sea time),
  `?cam=x,z,yaw,pitch,dist` (yaw/pitch in degrees, yaw 0 looks north), `?weather=clear|light|medium|heavy` (local
  weather preview from the start, for scripted captures), `?lab=weather` (opens the debug menu on its weather tab),
  `?tod=H` (freeze the local clock at hour H, 0-24, for scripted captures).
  `globalThis.carrier` exposes the renderer, camera, net, frame, grade and atmosphere (the live-editable sunny bases;
  the time of day, then the weather, are applied on top), `weather`, `lab`, `daynight`, `stars`, `lights` and
  `debugMenu` for debugging and screenshots.
- ` (or F2) opens the debug menu (`src/dev/debug-menu.ts`, in production builds too): tabs added with
  `debugMenu.addTab({ id, label, mount, unmount?, frame?, css? })`. WEATHER tab: timeline/manual, presets, every
  weather parameter, strike now, sea-time pause/speed, readouts, copy/paste JSON, BROADCAST TO ROOM. TIME tab: clock,
  sun/moon readouts, local hour scrub, presets, speed/freeze, BROADCAST TO ROOM (see CONTRACTS.md "Day-night").
- Rooms: up to 32 players, free for all: 4 carriers, each its own side in its own colour (orange, cyan, pink, lime),
  8 aboard each; friendly means your own carrier's crew, every other carrier and its jets, boats and guns are enemies
  (one rule: a ship's `team`, shared/crew.ts). Roles: a ship's HELM, a PILOT or a GUNNER (one per
  weapon mount). E: DEPLOY (footer prompt "E DEPLOY"; hold, tap to pin; physical key only; not in a jet, where E is yaw), the only way to
  take the helm, launch a Hornet (2 out per ship; a destroyed jet's slot recharges 30 s) or the F-35C strike jet (1 per
  ship, 45 s; no gun, bay and wing bombs), or man a gun (CIWS PORT/STBD, SAM PORT/STBD, 5-INCH GUN: first person, mouse
  aims, LMB/Space fires, RMB zooms; pick another operation to leave), or launch the BOAT (1 per ship, craned over the
  port side; W/S A/D Shift boost, mouse aims the 25 mm turret, LMB/Space fires; it ends only when brought back alongside
  slowly or sunk, 40 s recharge, and you return to the role you launched from; dev harness `boat.html`, see CONTRACTS.md
  "Boat"); pilots wait on deck until they launch. Mouse: aboard, the first click takes Pointer Lock and the mouse then orbits the ship camera (the stick in
  flight); Esc frees it, menus free it and give it back. Controls: at the helm W/S throttle, 1-9/0/= presets, A/D rudder; as a pilot the flight keys plus
  Space/LMB fire, 1/2/3 or wheel/V weapons, F flares, or close to and pointing at your own carrier R LAND (a scripted landing; a flight ends only by landing aboard, a crash or being shot down); Tab players and ships (hold, tap to pin: every carrier in its colour with its crew; JOIN switches ship and so side,
  CREATE SHIP in a sunk carrier's empty berth, captains LOCK, KICK, promote); C free camera (WASD pan, drag orbit, wheel zoom); G full map (hold, tap to pin; the radar and target markers show by themselves in flight, CONTRACTS.md "Pilot's map"); T chat to everyone, Y to your carrier's crew (Tab in the input switches; Enter sends, Esc cancels; the input owns the keyboard; `src/ui/chat.ts`, rules `shared/chat.ts`); M mute; ` debug menu. Shared rules: `shared/{crew,squad,ops}.ts`.
- Objective: capture zones (CONTRACTS.md "Capture zones"): hold a 650 m zone alone to score; zones move every
  5 minutes; first carrier to 1,200 points wins the round.
- Sound: one mix in `src/audio/mixer.ts`; every recorded sound is a slot in `src/audio/sfx-slots.ts` (takes in
  `public/sfx/v3/`, picks in `public/sfx/picks.json`), played with `sfx().play/loop` (`sfx-bank.ts`). SOUNDS tab in the
  debug menu (or `?sounds=1`): audition every take and pick by ear; AUDIO tab: levels. See CONTRACTS.md "Sound".
- Renderer (`src/render/`): raw WebGPU, HDR rgba16float, MSAA x4, depth32float with reversed Z (clear 0,
  `greater-equal`), bloom and an ACES-graded composite (`post.ts`). Static world via `renderer.setStatic` (packed
  `Mesh` chunks, `lit.ts`); everything else is a `ScenePass` in the sky/opaque/alpha slots. Sun, sky and fog live in
  `atmosphere.ts` (TS values plus shared WGSL `skyColor`/`hazeColor`/`applyFog`).
- `src/main.ts` still carries TEMPORARY placeholder sky and sea passes; the phase-2 `sky.ts` and `ocean.ts` replace them.
- `shared/` runs in the Durable Object and the browser: keep it free of DOM and Worker APIs. `scripts/build-id.ts`
  hashes it into `shared/build.gen.ts` (gitignored) for the client/server version handshake.
- Cross-game techniques and lessons: `../../docs/game-notes.md`. Shared code plans: `../../docs/shared-code.md`.
