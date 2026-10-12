# blackout

- After every meaningful change, run `bun run check` then `bun run deploy` so the latest build is live at https://anoma.ly/labs/blackout/.
- WebGPU only runs in secure contexts: test via the deployed URL, the opentunnel dev URL or `localhost`, never a bare LAN hostname.
- `TUNNEL=1 bun run dev` runs Wrangler (rooms, :8788) and Vite (:5191); opentunnel route `blackout` exposes it at https://blackout.lwoyjcaeyxv6.opentunnel.xyz.
- The game is a plain top-down shooter: everyone sees everyone, three guns (rifle, shotgun, sniper), health with regen, respawns, a new procedural office floor every match. No progression, no bots online (only the dev `?practice` mode has bots; `?practice&mode=dom` picks a mode).
- Modes (`shared/sim/modes.ts`, placements from the map in `shared/sim/places.ts`): free for all, team deathmatch, domination, search and destroy. Create game picks the first mode (`?mode=` on the first socket); quick rooms start as FFA; the end screen votes on the next.
- Kill confirmed, hardpoint and capture the flag live in `shared/sim/modes-objective.ts` (zones and flag bases from `places.ts`; sprites in `src/game/objective-fx.ts`). Modes in other files register in `MODE_FACTORIES` (modes.ts can't import them: cycle) and World imports the file. The end screen offers the current mode plus three random others (`voteOptions`, world rng, sent in the snapshot); per-mode scoreboard counts go in `Player.stats`.
- The simulation in `shared/` runs on the Durable Object and in the browser (practice mode, prediction); keep it free of DOM and Worker APIs.
- Target look: `concept/look-1-office.png`. Screenshots: apollo's Chrome via browser-control (call `page.bringToFront()` first or rAF is throttled to 1 fps), or `bun scripts/shot.ts` (local headless SwiftShader).
