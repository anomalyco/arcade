# blackout

- Visual work (props, creatures, rooms, lighting, looks): follow [quality-checklist.md](../../docs/quality-checklist.md)
  and the `arcade-quality` skill.
- Run `bun run check` before pushing; pushing to `main` deploys https://anoma.ly/arcade/blackout/ (follow `../../docs/agent-state.md` for deploy and branch rules).
- WebGPU only runs in secure contexts: test via the deployed URL, the opentunnel dev URL or `localhost`, never a bare LAN hostname.
- `TUNNEL=1 bun run dev` runs Wrangler (rooms, :8788) and Vite (:5191); opentunnel route `blackout` exposes it at https://blackout.lwoyjcaeyxv6.opentunnel.xyz.
- The game is a plain top-down shooter: everyone sees everyone, three guns (rifle, shotgun, sniper), health with regen, respawns, a new procedural office floor every match. No progression, no bots online (only the dev `?practice` mode has bots; `?practice&mode=dom` picks a mode).
- Modes (`shared/sim/modes.ts`, placements from the map in `shared/sim/places.ts`): free for all, team deathmatch, domination, search and destroy. Create game picks the first mode (`?mode=` on the first socket); quick rooms start as FFA; the end screen votes on the next.
- Kill confirmed, hardpoint and capture the flag live in `shared/sim/modes-objective.ts` (zones and flag bases from `places.ts`; sprites in `src/game/objective-fx.ts`). Modes in other files register in `MODE_FACTORIES` (modes.ts can't import them: cycle) and World imports the file. The end screen offers the current mode plus three random others (`voteOptions`, world rng, sent in the snapshot); per-mode scoreboard counts go in `Player.stats`.
- Infected, gun game and one in the chamber live in `shared/sim/modes-rules.ts`. What a player fights with comes from `Mode.loadout()` as a `Kit` (`shared/sim/kit.ts`: gun or bare hands, mag, reload, damage, speeds, melee, equipment); the World and client prediction (`src/game/game.ts`) read only the kit. Melee (`shared/sim/melee.ts`): V, or the trigger when bare-handed; 0.15 s wind-up, one-hit kill within 1.5 m.
- The simulation in `shared/` runs on the Durable Object and in the browser (practice mode, prediction); keep it free of DOM and Worker APIs.
- Target look: `concept/look-1-office.png`. Screenshots: apollo's Chrome via browser-control (call `page.bringToFront()` first or rAF is throttled to 1 fps), or `bun scripts/shot.ts` (local headless SwiftShader).
- Room host (`shared/sim/host.ts`, ♛ on the scoreboard): picks teams in team modes, and in any mode restarts the match (`hostRestart` → `World.restart`: reset or switch mode, new floor by default, 3 s cooldown, a `host` event for the banner) from the HOST panel in the Tab/T scoreboard (two clicks to confirm).
- Netcode: snapshots go out packed (`shared/wire.ts`, decoded back to `Snapshot` in `decodeServer`; add new fields
  there). Remote soldiers and vehicles are drawn from `src/game/remote.ts` (100 ms `SnapshotBuffer`, cubic through
  snapshot velocities, coast and `Glide`); your own soldier is predicted with `@arcade/kit/net/prediction`.
  `bun scripts/bench-remote.ts` measures smoothness, bytes and local corrections.
- Input edges: `INTENT_OPS` (`shared/sim/world.ts`) lists which `Intent` fields are one-shot presses. The room's jitter
  buffer (`@arcade/kit/net/room-core`) merges them forward and strips them from dry-tick stand-ins; a new press field
  must go there, or a stall can repeat or lose it.
- Idle kick (`server/room.ts` RoomCore): 90 s with no input while alive in play gets you kicked (end screen and time dead don't count), with a 15 s `idle` countdown shown in the HUD status line.
- Vehicles (jeep, van, scooter): only on maps that list `MapDef.vehicles` spawns (never office floors). Physics and
  collisions in `shared/sim/vehicle.ts` + `vehicle-collide.ts` (ported from getaway), rules in `vehicle-rules.ts` (F/E
  enter/exit via `Intent.enter`, C cycles to the next free seat via `Intent.seat`, seat 0 drives with WASD + Shift handbrake + H horn, passengers shoot, armour per seat,
  roadkill, explosion → burning wreck → respawn at its spot, `Mode.canRide`). Client: `src/game/vehicles.ts` (draw,
  lamps as dynamic lights, prediction of the vehicle you drive), `src/render/vehicle-mesh.ts`, `src/audio/vehicle-sound.ts`.
  Test yard: `?practice&map=lot` (`shared/sim/vehicle-lot.ts`); `globalThis.practice` is the practice World.
- Map kinds (`MapDef.kind`): `office` (`shared/maps/office.ts`) and `downtown` (`shared/maps/downtown*.ts`: street grid
  with a ring road, superblocks, stubs closed by hoardings, buildings cut by alleys, enterable shops, plaza, parking lot,
  park; `roads` + `paint` on the MapDef; drivable `vehicles` in parking lanes and the lot). `getMap(kind, seed)`; the
  snapshot carries `map` (seed), `mapKind` and `maps` (the room's setting: office, downtown or random per match). Create
  game picks it (`?map=` on the first socket; quick rooms are random); the host changes it in the HOST panel
  (`hostMaps`, applies from the next new floor). Downtown renders via `src/render/street-models.ts` (props, buildings,
  cars, cover) and floor kinds 5-9 in `shaders.ts`; ambient per kind in `lighting.ts` `AMBIENT`. Viewers:
  `envlab.html?kind=downtown&seed=N`, `?practice&map=downtown`, `KIND=downtown bun scripts/plan.ts`. Concepts: `concept/dt-*.png`.
- Client/server version: `scripts/build-id.ts` hashes `shared/` into `shared/build.gen.ts` (gitignored; check, test, build, deploy and dev generate it). The client sends it in `hello`; a server with a different hash replies `reload` and the client reloads into the same room (old clients without a build get an error asking them to reload).
- Cross-game techniques and lessons: `../../docs/research/game-notes.md`. Shared code plans: `../../docs/shared-code.md`.
- Characters use the shared human rig (the adapter is `@arcade/kit/avatar/anim`, re-exported from `src/game/anim.ts`; Brawl uses it too). Motion rules: `../../docs/animation.md`; tuning scripts: `scripts/animation/` (see the `procedural-animation-iteration` skill). All shared docs: `../../docs/README.md`.

## Game shell

- The title, lobby, Escape menu and Settings are the kit game shell (`@arcade/kit/shell`, [docs/game-shell.md](../../docs/game-shell.md)), set up in `src/main.ts`. The mode and map picks, Solo sandbox and the live player count sit in its title slot (`LandingPicks` in `src/ui/menus.ts`); the scoreboard, host controls and vote stay Blackout's own. Shell colours are at the end of `src/style.css`.
- Deliberate changes when it moved onto the shell (Oct 22):
  - The landing page is the shell's title: name, Quick join, Bot practice, Play with friends (Create game: a private
    room with the picked mode and map) and Join by code or invite link, with Settings and mute in the corner. An
    invite link shows "Join room CODE" first.
  - Escape opens the menu (Resume, Settings, Leave room or Quit to title). Bot practice and the sandbox pause behind
    it; a room keeps playing. Leave returns to the title.
  - Volume and mute moved from the Lab's Volume rows to Settings (same `arcade.volume.blackout.v1` levels); M still
    mutes. Quality is in Settings, not the Lab's View group, and uses the slow-frames policy. Reduce camera motion
    sets the shake settings' Reduce motion.
  - A lost connection returns to the title with the message; the reconnect state shows in the shell's pill, and the
    HUD keeps only the idle warning.
  - Gameplay keys (guns, equipment, T, votes, B) are ignored on the title and the menu; Backquote still opens the Lab.
