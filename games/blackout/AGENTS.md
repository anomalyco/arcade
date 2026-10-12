# blackout

- After every meaningful change, run `bun run check` then `bun run deploy` so the latest build is live at https://anoma.ly/arcade/blackout/.
- WebGPU only runs in secure contexts: test via the deployed URL, the opentunnel dev URL or `localhost`, never a bare LAN hostname.
- `TUNNEL=1 bun run dev` runs Wrangler (rooms, :8788) and Vite (:5191); opentunnel route `blackout` exposes it at https://blackout.lwoyjcaeyxv6.opentunnel.xyz.
- The game is a plain top-down shooter: everyone sees everyone, three guns (rifle, shotgun, sniper), health with regen, respawns, a new procedural office floor every match. No progression, no bots online (only the dev `?practice` mode has bots; `?practice&mode=dom` picks a mode).
- Modes (`shared/sim/modes.ts`, placements from the map in `shared/sim/places.ts`): free for all, team deathmatch, domination, search and destroy. Create game picks the first mode (`?mode=` on the first socket); quick rooms start as FFA; the end screen votes on the next.
- Kill confirmed, hardpoint and capture the flag live in `shared/sim/modes-objective.ts` (zones and flag bases from `places.ts`; sprites in `src/game/objective-fx.ts`). Modes in other files register in `MODE_FACTORIES` (modes.ts can't import them: cycle) and World imports the file. The end screen offers the current mode plus three random others (`voteOptions`, world rng, sent in the snapshot); per-mode scoreboard counts go in `Player.stats`.
- Infected, gun game and one in the chamber live in `shared/sim/modes-rules.ts`. What a player fights with comes from `Mode.loadout()` as a `Kit` (`shared/sim/kit.ts`: gun or bare hands, mag, reload, damage, speeds, melee, equipment); the World and client prediction (`src/game/game.ts`) read only the kit. Melee (`shared/sim/melee.ts`): V, or the trigger when bare-handed; 0.15 s wind-up, one-hit kill within 1.5 m.
- The simulation in `shared/` runs on the Durable Object and in the browser (practice mode, prediction); keep it free of DOM and Worker APIs.
- Target look: `concept/look-1-office.png`. Screenshots: apollo's Chrome via browser-control (call `page.bringToFront()` first or rAF is throttled to 1 fps), or `bun scripts/shot.ts` (local headless SwiftShader).
- Room host (`shared/sim/host.ts`, ♛ on the scoreboard): picks teams in team modes, and in any mode restarts the match (`hostRestart` → `World.restart`: reset or switch mode, new floor by default, 3 s cooldown, a `host` event for the banner) from the HOST panel in the Tab/T scoreboard (two clicks to confirm).
- Idle kick (`server/room.ts` RoomCore): 90 s with no input while alive in play gets you kicked (end screen and time dead don't count), with a 15 s `idle` countdown shown in the HUD status line.
- Vehicles (jeep, van, scooter): only on maps that list `MapDef.vehicles` spawns (never office floors). Physics and
  collisions in `shared/sim/vehicle.ts` + `vehicle-collide.ts` (ported from getaway), rules in `vehicle-rules.ts` (F/E
  enter/exit via `Intent.enter`, seat 0 drives with WASD + Shift handbrake + H horn, passengers shoot, armour per seat,
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
