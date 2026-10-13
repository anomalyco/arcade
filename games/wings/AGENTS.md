# wings

Multiplayer aerial combat (planes, helicopter, carrier strike groups) at https://anoma.ly/arcade/wings/.

- TypeScript only. Client: Three.js `WebGPURenderer` with TSL node materials (WebGL2 fallback). Server: Cloudflare
  Worker `arcade-wings` (`server.ts`) with the `Room` and `RoomDirectory` Durable Objects.
- Read `DESIGN.md` (game design), `STYLE.md` (locked STORMFRONT look and UI typography) and `CONTRACTS.md` (module
  ownership) before larger changes. Shared contracts live in `src/sim/types.ts`, `vehicles.ts`, `protocol.ts`, `fleet.ts`.
- `bun install`, `bun run check` (typecheck client + worker, tests, build). `bun run dev` (Vite, 5173) with
  `bun run dev:worker` (8787) for local multiplayer.
- Models in `public/models/` are built in Fiend. Edit secrets live in `.fiend-secrets*.json` (gitignored, never commit).
