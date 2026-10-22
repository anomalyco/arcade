# Shared code

What the workspace games (`getaway`, `blackout`, `outbreak`, `carrier`, `brawl`, `archers`, `lab`) still carry their own copy of,
and what to do about it. What is already shared, and which game uses which `@arcade/kit` module, is the generated
table in [architecture.md](architecture.md); check it before writing something a game might already have.

Extract something only when it is the same idea across games and has a current consumer in each. Game rules, maps,
meshes and the look stay in the games. Realism techniques (lights, shadows, fog, weather, materials, camera, sound)
are the exception: they start in the kit even with one consumer, and the game supplies hooks and settings. A game path that re-exports a kit module in one line (for example
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

## Realism techniques still in one game

Realism techniques belong in `packages/kit/` from the start (root [AGENTS.md](../AGENTS.md)); these were built
inside a game and would help others. [realism.md](realism.md) describes each one. Effort: S under a day, M a few
days, L a week.

| Technique | Lives in | Target kit module | Would help | Effort | State |
|---|---|---|---|---|---|
| Lightning channel, stroke timing, WCAG flash limiter, ribbon pass | Lot `src/weather/bolt.ts`, `bolt-pass.ts` | `weather/lightning`, `weather/lightning-pass` | Outbreak, woods, Night Shift | S | Moved (branch `kit-lightning`) |
| Synthesized night ambience (wind, traffic, buzz, HVAC, drips, wildlife) | Lot `src/ambience.ts` | `audio/ambience` | Woods, Night Shift | S | Moved (branch `kit-ambience`) |
| Thunder by distance, surface rain emitters, indoor muffle; shelter rects and eaves | Lot `src/weather/audio.ts`, `shelter.ts` | `audio/thunder`, `weather` shelter type | Outbreak (own `src/weather/audio.ts`), woods | M | AR-131 |
| Outbreak's strike schedule on the kit flash limiter | Outbreak `shared/weather/lightning.ts`; kit `weatherStrikeFlash` | `weather/lightning` | Every storm | S | AR-131 |
| Top-down lens-lamp adapter (flux matching, arm from the road) | Outbreak `src/street-lamps/lens.ts` | `gpu/lights/street` | Blackout, Getaway | M | AR-132 |
| Mist pooling mask (walls, hollows, gutters) | Outbreak `src/mist/wgsl.ts` | `gpu/fog-scatter` | Woods, Lot | M | AR-132 |
| Lamp reach fade | Outbreak `src/scene/frame-lighting.ts` (`stepLampReach`) | `gpu/scene-frame` | Blackout, any distance-culled lamps | S | AR-132 |
| Looks in quality tiers (`QUALITY_TIER`, `fromTier`) | Outbreak `src/quality.ts` | `quality` | Lot, Night Shift, woods | S | AR-132 |
| Tube signal driving light, emissive and ballast sound | Night Shift `src/polish/tube.ts` | `gpu/lights/flicker` | Outbreak sconces, Lot interior | S | AR-133 |
| Analytic blind gobo shared by surfaces and dust | Night Shift `src/blind-cookie.ts` | a kit cookie module | Lot interior, Outbreak windows | M | AR-133 |
| Lens finish (edge softness, fringe, midtone grain) | Night Shift `src/polish/lens.ts` | `gpu/look` | Lot, woods | S | AR-133 |
| Shadow-gated dust motes | Outbreak `src/air/dust.ts`, Night Shift `src/polish/dust.ts` | `fx/dust` with a visibility hook | Lot, woods, Blackout (`MAT.mote` is unshadowed) | M–L | AR-134 |
| Volumetric torch shaft pass | Outbreak `src/flashlight-beam.ts` | `gpu/lights/beam` | Lot, woods, Night Shift | M | AR-134 |
| Analytic puddle light mirrors and LEAN glints | Outbreak `src/reflections/` | `gpu/reflections` | Blackout, Getaway; LEAN for the Lot's asphalt | M | AR-135 |
| Motion-stability metric | Lot and Outbreak `scripts/motion.ts` | root `scripts/motion/` | Night Shift, woods | M | AR-136 |
| Baked bounce and lamp pools | Blackout `bakeBounce`, Outbreak `bakeOutbreakBounce` + `src/lightbake.ts` | `gpu/level` | Top-down games | M | Not carded: only top-down games bake |
| Forest renderer | branch `woods-look` | `packages/kit/forest` | Woods first, then the Lot | — | Being built in the kit |

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
  would change how they sound. Its picking board (the Sounds tab of its dev panel, the shared `LabPanel` with `buttons` and `readout` rows; picks.json, ratings) is the curation step for its
  candidate takes. To share further: a 3D listener in the runtime, then `playCue` for the bank.
