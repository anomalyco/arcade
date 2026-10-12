# blackout

- After every meaningful change, run `bun run check` then `bun run deploy` so the latest build is live at https://anoma.ly/labs/blackout/.
- WebGPU only runs in secure contexts: test via the deployed URL, the opentunnel dev URL or `localhost`, never a bare LAN hostname.
- `TUNNEL=1 bun run dev` runs Wrangler (rooms, :8788) and Vite (:5191); opentunnel route `blackout` exposes it at https://blackout.lwoyjcaeyxv6.opentunnel.xyz.
- The game is a plain top-down free-for-all deathmatch: everyone sees everyone, three guns (rifle, shotgun, sniper), health with regen, respawns, a new procedural office floor every match. No progression.
- The simulation in `shared/` runs on the Durable Object and in the browser (practice mode, prediction); keep it free of DOM and Worker APIs.
- Target look: `concept/look-1-office.png`. Screenshots: apollo's Chrome via browser-control (call `page.bringToFront()` first or rAF is throttled to 1 fps), or `bun scripts/shot.ts` (local headless SwiftShader).
