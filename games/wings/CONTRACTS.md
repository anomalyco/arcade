# Module Contracts & Ownership

Work is split across parallel agents. Each agent owns specific files and must not edit files owned by others.
Read `DESIGN.md` and `STYLE.md` for context. Shared contracts live in:

- `src/sim/types.ts` — core shared types (orchestrator-owned)
- `src/sim/vehicles.ts` — vehicle & weapon tuning tables (orchestrator-owned)
- `src/sim/protocol.ts` — network messages, room config (orchestrator-owned)

If you need a contract change, do not edit these files. Put the exact proposed change in your final report.
You may add private helper types/functions inside your own files.

## Global rules
- TypeScript only, strict mode. `src/sim/**` must be dependency-free (no `three`, no DOM, no `Date.now`/`Math.random` inside simulation steps — use passed-in time and seeded RNG) so it runs identically in the browser and the Cloudflare Worker.
- Coordinates: meters, Y up. Aircraft nose = local -Z, right = +X. Map is a 30 × 30 km square centered on the origin.
- Fixed tick 60 Hz (`TICK_DT`), snapshots 20 Hz.
- Each stub file shows the exported signatures; keep them (you may add exports).
- Tests: `bun test tests/<area>.test.ts` (create your own test file). Typecheck: `bun run typecheck` — only fix errors in your own files.
- Performance first: avoid per-frame allocations in hot loops, keep draw calls low.

## Ownership
| Area | Owner | Files |
| --- | --- | --- |
| Flight physics | Flight agent | `src/sim/flight.ts`, `tests/flight.test.ts` |
| World (sim + render) | World agent | `src/sim/geography.ts`, `src/render/world-view.ts`, `src/render/world/**`, `tests/geography.test.ts` |
| Combat | Combat agent | `src/sim/combat.ts`, `tests/combat.test.ts` |
| Bots | (removed — out of scope) | — |
| Server / rooms / net | Server agent | `server.ts`, `src/sim/room-engine.ts`, `src/net.ts`, `src/sim/loopback.ts`, `tests/room.test.ts` |
| Aircraft rendering | Aircraft agent | `src/render/aircraft.ts`, `src/render/toon.ts` |
| Audio | Audio agent | `src/audio.ts`, `public/audio/**` |
| Client app (UI, input, camera, HUD, effects, main loop) | Client agent | `index.html`, `src/main.ts`, `src/style.css`, `src/input.ts`, `src/ui/**`, `src/render/scene.ts`, `src/render/camera.ts`, `src/render/effects.ts`, `src/render/hud.ts` |
| Models | Model agents | Fiend scenes, `public/models/*.glb` |

## Rendering migration (WebGPU, "STORMFRONT")
- `src/render/scene.ts` (Client/UI agent) creates `WebGPURenderer` (`await renderer.init()`), owns the `PostProcessing` pipeline, exports the renderer/scene/camera host as before, and exposes `host.lightning(intensity)` hook + current quality.
- World agent: sky, clouds, fog, ocean (GPU waves), rain/spray particles, islands, ships rendering, lightning events (exports `onLightning(cb)` or a `lightning` value per frame the scene can read for bloom/exposure flashes).
- Aircraft agent: node materials, wet specular, emissive afterburners/lights tuned for bloom.
- Effects (UI agent): tracers, flashes, explosions, smoke, flak as node materials / compute particles.
- Shared lighting/fog constants stay in `src/render/world/palette.ts`.

## Integration points
- `src/net.ts` (Server agent) exports `connectRoom(code, name, handlers)` returning `{ send(msg), close() }`, and `createLocalRoom(config, name, handlers)` using `RoomEngine` in-browser for offline play. Handlers: `onMessage(ServerMessage)`, `onStatus("connecting"|"open"|"closed")`. Also `listRooms()`, `createRoom(config)`, `quickPlay()` REST helpers. Base path for all HTTP/WS: `${import.meta.env.BASE_URL}api/...` (i.e. `/labs/wings/api/...`).
- Server HTTP API (Worker, after stripping the `/labs/wings` prefix): `GET /api/rooms`, `POST /api/rooms` (body: Partial<RoomConfig>) → `{ code }`, `GET /api/quickplay` → `{ code }`, `GET /api/room?code=XXXX` (WebSocket upgrade), `GET /api/health`.
- Client prediction: the client runs `stepFlight` locally for its own vehicle (pilot seat) using the same inputs it sends, and reconciles to snapshots using `ack`.
- Rendering reads `VehicleEntity` from interpolated snapshots and passes it to `AircraftView.update`.
