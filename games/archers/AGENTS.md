# archers

- Unlisted prototype: side-view arena archery (TowerFall-like) in the Noir Silhouette look picked on board card
  AR-39 (decision D-24, option 2; concept in `~/code/home/artifacts/2026-10-15-arena-archers/`). The working name lives
  only in `GAME` (`shared/config.ts`); rename there.
- `shared/` is the deterministic 60 Hz sim: `world.ts` (platforming, arrows, catches, stomps, chests, rounds),
  `arena.ts` (wrapping tile maps), `nav.ts` + `bots.ts` (nav graph built by replaying real movement, bot brains),
  `tuning.ts`, `input.ts` (one byte of held buttons per archer per tick). All state is plain data in `SimState`
  (bot minds included) so rollback can `structuredClone` it; only + − × ÷ and sqrt touch it, never trig.
- `src/render/` is a game-side renderer built for side view (the kit's top-down Renderer doesn't fit): fog backdrop,
  static silhouette layers, instanced parts, 4× MSAA HDR plus a shaft-source target, half-res god rays from the
  tower window, screen-space silhouette rim, kit bloom, kit particles and the kit `noir_silhouette` look grade.
  HDR alpha is the colour-retention mask: fire, arrows, marks and scarves write it so the grade keeps their colour.
- `src/game/archer-pose.ts`: ground locomotion is kit `animate()` (unarmed) in a private rig-space lane; air, wall
  slide, ledge hang and dodge poses are built with the rig's IK and blended in; the bow arms layer on top. Read
  `docs/animation.md` and use the procedural-animation-iteration skill before changing poses.
- Camera is kit `SideCamera` (`packages/kit/client/side-camera.ts`).
- Controls (`src/game/controls.ts`): one keyboard player gets WASD/arrows with Space/J/Z jump, Shift/K/X shoot,
  E/L/C dodge. Enter splits the keyboard (left WASD+Space/Shift/E, right IJKL+M/Semicolon/O). Gamepads join with A.
- Online is rollback over an input relay (`@arcade/kit/net/rollback`). The room (`server/room.ts`, a kit `RoomCore`
  ticking at 60 Hz) is the input authority: each tick it takes every person's buttons from an `InputRelay` (a late
  input applies a tick later, a missing one holds the last), runs the same `World`, and broadcasts that frame
  (`shared/protocol.ts`; seat changes ride in the frame as commands). Clients (`src/net/online.ts`) step their own copy
  with confirmed frames and draw a prediction re-simulated to the `TickPacer`'s head with their own buttons as typed.
  The room sends the whole world only on join, reconnect or a hash mismatch (`HASH_EVERY` ticks). Anything that
  touches `SimState` must stay deterministic across engines: no trig, no `Math.hypot`, no clocks, no unseeded random.
- Online presentation (`Game.updateOnline`): corrections to where archers were drawn are eased out (`offsets`), events
  re-simulated within 4 ticks show once (`eventSig`), hit-stop freezes effects only and there is no slow motion.
- URL params: `?room=code` joins a room (bots hold the other slots), `?online` quick-joins (P in couch play does the
  same); the first arrival may add `&arena=cloister` and `&private=1`. Automation only: `?watch` (four bots),
  `&seed=N`, `&arena=cloister`, `&focus=a0&span=4` (close-up camera on one archer). `window.archers` is the client
  Game (`.online` is the session). Keys 1/2 switch arena locally.
- `bun run dev` runs Wrangler (:8792) and Vite (:5198). `bun run check` before pushing; pushing to `main` deploys
  https://anoma.ly/arcade/archers/.
- Captures: `bun scripts/capture.ts --query "watch&seed=3" --shots 2,5,9 --out captures/x` (or `--video 20`) against
  a built `dist`; run it through `hivemind run --kind browser`. `scripts/headless.ts` lifts headless Chrome's ~15 fps
  rAF throttle and paces frames at 60 Hz.
- Online proofs: `tests/online.test.ts` runs the real room core with two clients over `link-sim` and checks every
  world hash (`ONLINE_BENCH=1 bun test tests/online.test.ts -t bench` prints good/wifi/bad numbers).
  `bun scripts/online-proof.ts --seconds 30 --out captures/online` runs the built bundle on `wrangler dev` behind a
  proxy that delays WebSocket messages like Wi-Fi, with two headless tabs in one room, and records both.
