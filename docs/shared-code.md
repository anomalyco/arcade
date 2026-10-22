# Shared code

What the workspace games (`getaway`, `blackout`, `outbreak`, `carrier`, `brawl`, `archers`, `lab`) still carry their own copy of,
and what to do about it. What is already shared, and which game uses which `@arcade/kit` module, is the generated
table in [architecture.md](architecture.md); check it before writing something a game might already have.

Extract something only when it is the same idea across games and has a current consumer in each. Game rules, maps,
meshes and the look stay in the games. A game path that re-exports a kit module in one line (for example
`games/getaway/src/game/fx.ts` → `@arcade/kit/vehicle/fx`) is not duplication.

## Where it goes

`packages/kit/` is the private, versionless `@arcade/kit` package: plain TypeScript source, no build step. Games
declare `"@arcade/kit": "workspace:*"` and import subpaths (`@arcade/kit/gpu/renderer`, `@arcade/kit/compare.css`);
Vite and Wrangler bundle the source. Proof and benchmark scripts for kit code live in root `scripts/` (Lab proofs in
`scripts/lab/`), not in `packages/kit/`. `games/*/shared/` (the authoritative simulation) imports only pure kit
modules (`sim/`, `net/`, `limits`), never `gpu/`, `client/`, `avatar/`, `fx/` or `lab/`. Install and verification
are in the root [AGENTS.md](../AGENTS.md); Lab adapters are in [lab-adapters.md](lab-adapters.md).

## Remaining duplication

Roughly in order of value against risk. Line counts are from `main` at the time of writing.

| Idea | Shared version (users) | Game-owned copies | Notes |
|---|---|---|---|
| Room server plumbing | `net/room-core`, `server/{room-object,lobby-object,worker}`, `net/room-socket` (`server/*` in Getaway, Blackout, Outbreak, Carrier, Brawl, Archers) | Getaway `server/core.ts` (269), Carrier `server/core.ts` (1,206), Outbreak `server/room-core.ts` (291) | All room games share `RoomObject`, `LobbyObject` and `gameWorker`. Outbreak's core uses `net/{seats,jitter-buffer,bytes,interest,rewind}` directly; Carrier packs its high-rate messages with `net/bytes` (`shared/wire.ts`, JSON for the rest); Getaway and Carrier keep public-id reconnect and latest-input overwrite. |
| Rollback over an input relay | `net/rollback` (`RollbackClient`, `TickPacer`, `InputRelay`; Archers) | — | For deterministic fixed-step games only. Brawl would need a deterministic world first (no trig in state, seeded random, plain-data state). |
| Snapshot interpolation and prediction | `net/{interpolate,prediction}` (Blackout, Brawl, Outbreak) | Getaway `src/game/{net,netcode,interp}.ts` (195 + 354 + 21), Carrier `src/net.ts` (605) | Server-side `net/rewind` (lag-compensated hitscan) is Outbreak-only; Blackout's sniper and rifle are the next users. |
| Adaptive quality | `quality` (Outbreak) | Blackout and Brawl `MAX_DPR = 1.5`, Carrier 1.5, Getaway `Math.min(dpr, 2)` | Wiring is per game: each needs its own scale hooks (DPR, shadows, ray steps). |
| WebGPU renderer | `gpu/renderer`, `gpu/shaders`, `gpu/mesh` (Blackout, Brawl, Lab, Outbreak) | Getaway `src/render/{renderer,shaders,mesh}.ts` (585 + 645 + 123, ortho shadows, 48-byte vertices), Carrier `src/render/renderer.ts` (207, ocean and sky) | Migrate Getaway behind `scripts/prove-pixel-parity.ts`. Carrier's ocean and sky passes are game-specific. |
| Frame light packing | `gpu/scene-frame` (`SceneLights`, `packSceneFrame`; Brawl) | Blackout `src/render/lighting.ts` (253), Outbreak `src/lighting.ts` (1,500) | Both pack `FRAME_FLOATS` by hand. Outbreak's map-aware culler with monitor/bounce caches is more than `scene-frame` does; generalise it when a second game needs it. |
| Keyboard input | `client/input` (top-down `Input`; Blackout, Brawl, Outbreak), `client/controls` `KeyStateTracker` (Carrier) | Getaway `src/game/input.ts` (123) | Carrier's `src/input.ts` and its flight, gunnery and weapon inputs read keys through `KeyStateTracker` (held/pressed by physical code, editable-target and blur/Meta release) and keep only their own mouse, Pointer Lock and binding logic; the top-down `Input` (aim cursor, `mux`) does not fit Carrier's Pointer Lock vehicles. Getaway, Blackout, Outbreak and Carrier already use `client/controls` for prompts. |
| Camera and shake | `client/camera` (`Camera.add`, `HitStop`, shake controls; Blackout, Brawl, Lab, Outbreak; `TraumaShake`, `shakeWave`, `attenuateShake` for rig-owned 3D cameras: Carrier) | Getaway `src/game/camera.ts` (93) plus `Scene.shake`/`hitStop` | Carrier's chase, boat, turret and flight/crash rigs each own a `TraumaShake` reading one `cameraShakeDefaults()` (`SHAKE` in `src/render/camera.ts`, honours reduced motion); the rigs stay per game. Carrier has no hit-stop: its frame draws an interpolated, room-synced world and flight, so freezing presentation would desync it from sea time. |
| Vehicle simulation | none; presentation is shared (`vehicle/{chassis,body-pose,emissions,fx,lights,audio}`) | Getaway `shared/sim/vehicle.ts` (415), Blackout `shared/sim/vehicle{,-rules}.ts` (353 + 369), Outbreak `shared/vehicles.ts` (1,852) | Handling is tuned per game. A shared core is worth it only if a fourth game needs cars. |
| Tyre marks | `fx/skids` + `fx/skid-renderer` through `vehicle/driving-fx` (Outbreak) | Blackout's sprite skids in `src/game/vehicles.ts`; Getaway keeps its sprite path on purpose (byte-identical captures, `prove-driving-fx-parity.ts`) | Blackout can switch to `contacts()` + `SkidMarks` the way Outbreak did. |

Intentional copies, not to extract: Carrier's ocean rain (`src/render/rain.ts`, displaced onto Gerstner waves) and
Wings's Three.js rain are not `@arcade/kit/weather`; Wings is an independent project.

## Sound

The shared library (`@arcade/kit/audio/library`, [sfx-library.md](sfx-library.md)) holds sounds by semantic id.
Remaining overlap, checked against [sfx-inventory.md](sfx-inventory.md); none is a clean swap:

- **Blackout's guns, footsteps and mechanics** are procedural (`games/blackout/src/audio/sound.ts`) and proven
  graph-identical to the Lab's path (`games/lab/scripts/prove-game-audio.ts`). Library samples would change their
  sound. To share them, render the synth into library entries or give the library procedural entries.
- **Blackout's crash samples** (`public/sfx/vehicles/`) are different encodes of Getaway's crash family. Pick one.
- **Getaway** shares only `ui.click` with the library.
- **Carrier** runs on the kit runtime (`AudioRuntime` with a game-defined `mix`, `@arcade/kit/audio/mix`) and its
  played takes are library ids (`usedBy: ["carrier"]`, reused in place). It keeps its own playback chain for recorded
  slots (`sfx-bank.ts`: a 3D listener with HRTF panners, distance gain, air absorption, travel delay, a 6-voice priority
  budget): the runtime's `spatialize` is a top-down 2D model (ear height, 260 m/s Doppler, 150 m default range) and
  would change how they sound. Its picking board (SOUNDS tab, picks.json, ratings) is the curation step for its
  candidate takes. To share further: a 3D listener in the runtime, then `playCue` for the bank.
