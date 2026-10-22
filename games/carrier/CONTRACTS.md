# carrier: module contracts

Working name `carrier`. First milestone: **only the ocean and islands**, no ship yet. A procedurally generated sunny
archipelago (new seed per room), big rolling swells plus chop, waves identical on every client because they are a pure
function of `(seed, synced sea time)`. Look target: `concept/shot-5-fleet.png` (ocean, swells, sky, clouds) and
`concept/shot-4-topdown.png` (islands, reef shallows). Same engine family as `games/blackout` (raw WebGPU, wgpu-matrix,
packed 24-byte vertices, HDR + MSAA + bloom + graded composite), but lit by a sun, not practical lights.

Units: metres, Y up, plan (x, z). A future carrier is ~330 m long, so the sea is big: swell wavelengths 165-390 m,
crest-to-trough 6-7 m typical and 10-12 m on sets; faint chop 8-28 m. Islands 150 m-1.5 km across, scattered over roughly 12 km x 12 km; open sea forever.

## Ownership (phase 1 runs in parallel; touch only your files)

| owner | files |
| --- | --- |
| scaffold | `package.json`, `bun.lock`, `tsconfig*.json`, `vite.config.ts`, `wrangler.jsonc`, `index.html`, `AGENTS.md`, `scripts/**`, `src/main.ts`, `src/style.css`, `src/render/{renderer,camera,mesh,frame,lit,post,atmosphere}.ts`, `src/ui/**`, `src/input.ts`, `../../.github/workflows/carrier.yml`, `tests/render*.test.ts` |
| net | `server/**`, `shared/protocol.ts`, `shared/clock.ts`, `src/net.ts`, `tests/net*.test.ts` |
| sea | `shared/sea.ts`, `shared/sea.wgsl.ts`, `tests/sea*.test.ts` |
| islands | `shared/rng.ts`, `shared/islands.ts`, `shared/seabed.ts`, `src/render/island-mesh.ts`, `tests/islands*.test.ts` |
| ship | `src/render/carrier-mesh.ts`, `src/render/deck-vehicles.ts`, `src/render/ship-weapons.ts` (CIWS, SAM, 5-inch gun on `WEAPON_MOUNTS` sponsons; mount + yaw turret + pitch barrel; `concept/weapons-*.png`), `shared/carrier-spec.ts`, `scripts/carrier-preview.ts`, `scripts/raster.ts`, `concept/model-*.png`, `tests/carrier*.test.ts` |
| ship viewer | `ship.html`, `src/dev/ship-viewer.ts`, `src/dev/ship-viewer.css`, `src/dev/feedback.ts`, `scripts/feedback-plugin.ts`, `feedback/**`, small edits to `vite.config.ts` (plugin + rollup input) |
| driving | `shared/ship.ts`, `src/game/**`, `src/render/ship-pass.ts`, `tests/ship*.test.ts`, `scripts/drive-shot.ts`, `captures/drive/**`; edits to `src/render/camera.ts`, `src/ui/hud.ts`, `src/input.ts`, `server/**`, `shared/protocol.ts`, `src/net.ts`; additive edits to `src/main.ts` |
| multiplayer | `server/lobby.ts`, `server/matchmaking.ts`, `shared/crew.ts`, `src/ui/lobby*.ts`, `src/ui/menu*.ts`, `src/ui/roster*.ts`, `src/ui/*.css` it creates, `tests/crew*.test.ts`, `tests/lobby*.test.ts`, `scripts/mp-shot.ts`, `captures/multiplayer/**`; `wrangler.jsonc` (LOBBY binding + migration); integration edits to `server/core.ts`, `server/room.ts`, `server/index.ts`, `shared/protocol.ts`, `src/net.ts`, `src/game/**`, `src/main.ts`, hud only in phase B (after the driving agent finishes) |
| ui (Tab, squads, ship operations) | `shared/squad.ts`, `shared/ops.ts`, `src/ui/team-menu.*`, `src/ui/ops-menu.*`, `tests/squad*.test.ts`, `tests/ops*.test.ts`, `scripts/ui-shot.ts`, `captures/ui/**`; integration edits to `shared/crew.ts` (captain, lock, bans, slot `op`, `runOp`), `shared/protocol.ts`, `server/core.ts`, `src/net.ts`, `src/main.ts`, `src/game/game.ts`, `src/ui/{hud,menu*}.ts`, and the LAUNCH button / F-Enter launch removal in `src/flight/{seam,hud,input,flight,harness}.ts` |
| boat | `shared/boat.ts`, `src/boat/**`, `src/render/boat-*.ts`, `src/audio/boat*.ts`, `tests/boat*.test.ts`, `scripts/boat-shot.ts`, `captures/boat/**`; integration edits to `shared/ops.ts`, `shared/crew.ts`, `shared/protocol.ts`, `server/core.ts`, `src/net.ts`, `src/game/game.ts`, `src/main.ts`, `src/ui/{ops-menu,hud,team-menu}.ts`, `src/dev/ship-viewer.ts`, combat hooks only in phase B (after ship health, then gunnery, finish) |
| gunnery | `shared/gunnery.ts`, `src/gunnery/**`, `src/render/turret-*.ts`, `src/audio/turret*.ts`, `tests/gunnery*.test.ts`, `scripts/gunnery-shot.ts`, `captures/gunnery/**`; integration edits to `shared/ops.ts`, `shared/crew.ts`, `shared/combat.ts`, `shared/weapons.ts`, `shared/protocol.ts`, `server/core.ts`, `src/net.ts`, `src/game/game.ts`, `src/main.ts`, `src/render/ship-pass.ts`, `src/ui/ops-menu.ts`, `src/ui/hud.ts` only in phase B (after the ship-health agent finishes) |
| jet audio | `src/audio/jet*.ts`, `src/audio/mixer*.ts`, `public/sfx/**` (or `src/audio/assets/**`), `scripts/sfx-*.ts`, `tests/audio*.test.ts`, `captures/audio/**`; integration edits to `src/flight/**` / `src/weapons/weapons.ts` / `src/game/game.ts` / `src/main.ts` / `src/audio/weapon-audio.ts` only additive hook calls (re-read first) |
| day-night | `shared/daycycle.ts`, `src/render/daynight*.ts`, `src/render/stars*.ts`, `src/render/lights*.ts`, `tests/daycycle*.test.ts`, `scripts/daynight-shot.ts`, `captures/daynight/**`, `concept/night-*.png` / `concept/time-*.png`; a "TIME" tab in the debug menu via `debugMenu.addTab`; integration edits to `src/render/{atmosphere,sky,clouds,post,lit,ship-pass,ocean*}.ts`, `src/render/weather-*.ts`, `src/main.ts`, protocol/server/net only in phase B (orchestrator go-ahead) |
| weapons | `shared/weapons.ts`, `shared/combat.ts`, `shared/fleet.ts`, `src/weapons/**`, `src/render/weapon*.ts`, `src/audio/weapon*.ts`, `tests/weapon*.test.ts`, `tests/combat*.test.ts`, `scripts/weapons-shot.ts`, `captures/weapons/**`; integration edits to `src/flight/**` (input, hud, seam), `shared/plane.ts` (health/crash cause only), `shared/protocol.ts`, `server/core.ts`, `src/net.ts`, `src/game/game.ts`, `src/main.ts` only in phase B (after the roles change and the jet paint finish) |
| flight | `shared/plane.ts`, `shared/launch.ts`, `src/flight/**`, `src/render/plane*.ts`, `tests/plane*.test.ts`, `tests/launch*.test.ts`, `scripts/flight-shot.ts`, `captures/flight/**`; integration edits to `src/game/**`, camera, hud, input, main, protocol/server/net only in phase B (after the driving agent finishes) |
| weather | `shared/weather.ts`, `src/render/rain*.ts`, `src/render/weather*.ts`, `src/audio/**`, `src/dev/debug-menu.*`, `src/dev/weather-lab.*`, `tests/weather*.test.ts`, `scripts/weather-shot.ts`, `captures/weather/**`; storm tuning in `shared/ship.ts` (SHIP.storm*); additive weather wiring in `src/main.ts`, `shared/protocol.ts`, `server/core.ts`, `src/net.ts` |
| phase 2 ocean + sky | `src/render/ocean*.ts`, `src/render/sky.ts`, `src/render/clouds.ts`, `scripts/ocean-shot.ts`, `captures/ocean/**`; additive edits to `src/main.ts`, `src/render/atmosphere.ts` and post grade constants; may add detail-wave packing to `shared/sea.ts` without changing existing behaviour |

Do not edit `package.json`; if you need a dependency, say so in your report. `shared/` must stay free of DOM and Worker
APIs (it runs in the Durable Object and the browser). Use `bun test` for tests. Ports: Vite 5197, Wrangler 8797.

## Frame uniform (`src/render/frame.ts`, bind group 0 binding 0, every scene pass)

`FRAME_FLOATS = 48` (192 bytes). WGSL (export it as `FRAME_WGSL`):

```wgsl
struct Frame {
  viewProj: mat4x4f,   // [0..16)
  eye: vec4f,          // [16..20) camera position xyz, w = sea time in seconds (wrapped, for cheap animation only)
  sunDir: vec4f,       // [20..24) unit vector toward the sun, w = sun intensity
  sunColor: vec4f,     // [24..28) rgb, w = ambient strength
  zenith: vec4f,       // [28..32) sky colour overhead, w unused
  horizon: vec4f,      // [32..36) sky colour at the horizon, w = fog density (per metre)
  viewport: vec4f,     // [36..40) w, h, 1/w, 1/h in pixels
  forward: vec4f,      // [40..44) camera forward xyz
  extra: vec4f,        // [44..48) day-night: night, warm twilight, practical lights, moon as key light (all 0 by day)
}
```

## Scene passes (`src/render/renderer.ts`)

```ts
export type PassContext = {
  device: GPUDevice
  frameLayout: GPUBindGroupLayout // group 0: the Frame uniform, visible to vertex + fragment
  color: GPUTextureFormat         // "rgba16float" HDR target
  depth: GPUTextureFormat         // "depth32float", REVERSED Z: clear 0, depthCompare "greater-equal" (far plane ~40 km)
  samples: number                 // 4 (MSAA)
}
export interface ScenePass {
  /** Called inside the main HDR render pass with group 0 (Frame) already bound. Set your own pipeline and group 1+. */
  draw(pass: GPURenderPassEncoder): void
  /** Optional: encode work (compute, offscreen passes) into the frame's encoder before the main HDR pass begins. */
  prepare?(enc: GPUCommandEncoder): void
}
renderer.context: PassContext
renderer.addPass(slot: "sky" | "opaque" | "alpha", pass: ScenePass): void   // drawn in that order, each slot in insertion order
renderer.setStatic(chunks: { data: ArrayBuffer; box: [x0: number, z0: number, x1: number, z1: number] }[]): void
renderer.render(frame: Float32Array, grade: Grade): void
```

`setStatic` takes packed `Mesh` vertex data (`src/render/mesh.ts`, copied verbatim from Blackout's, with its own `MAT`):
`MAT = { lit: 0, glow: 1, foliage: 2 }`. Vertex colour is albedo. `lit`: flat sun diffuse + sky ambient + distance fog
to the horizon colour. `glow`: emissive. `foliage`: lit like `lit`, sways gently with `aux` as phase. Chunks are culled
against the view rect from `camera.groundRect()`.

Scaffold helpers for pass authors: `frame.ts` also exports `FRAME` (float offsets of each field), `TIME_WRAP` (3600:
eye.w wraps there, so periodic shader animation should use whole cycles per 3600 s) and `FRAME_BINDING_WGSL` (the
struct plus `@group(0) @binding(0) var<uniform> F: Frame;`). `atmosphere.ts` exports `ATMOSPHERE_WGSL` (needs `F` in
scope): `skyColor(dir)`, `hazeColor(dir)` (the fog colour, equal to the sky at the horizon) and `applyFog(color, world)`.
`renderer.module(code, label)` compiles WGSL and logs errors with line numbers. Static chunks open the opaque slot.
`Grade` (`post.ts`, `DEFAULT_GRADE`): exposure, bloom, threshold, saturation, vignette, grain, warmth.

## Camera shake (`@arcade/kit/client/camera`, `SHAKE` in `src/render/camera.ts`)

- Every rig owns a kit `TraumaShake` (trauma², presentation only) reading the one `SHAKE` (`cameraShakeDefaults()`:
  `shakeScale`, `reduceMotion`; the OS reduced-motion setting also stops it; dev CONTROLS tab edits both). The rigs
  keep their own magnitudes and `shakeWave` frequencies: chase (`src/game/chase.ts`, the ship's grounding/slam passed
  in per frame), boat (`BoatCam.shake`, hits and slams, decay 3/s), turret (`TurretCam.shake`, recoil, linear 2.4/s),
  flight and crash (`FlightCam.shake`, catapult, trap, buffet floor, hits, explosions, decay 2.2/s). No hit-stop: the
  frame draws a room-synced world.

## Sea (`shared/sea.ts`, `shared/sea.wgsl.ts`)

Deterministic, seeded, Gerstner-style sum of waves (a dominant swell direction with long crests, a secondary swell, and
chop). CPU and GPU must agree on displacement within a few centimetres.

Recipe (`makeSea`, "bigger waves" revision; tests in `tests/sea.test.ts`): a FEW BIG swells, so the 330 m carrier
rides one or two crests at a time and visibly heaves and pitches.

- **Primary swell:** 4 components in two close-wavelength pairs, 250-340 m (dominant) and 165-225 m. Each partner is
  10-16% longer and travels 8-24° from its pair-mate, on either side of `swell`. Significant height 7.5-9 m.
  - Sets 2-4 km long: crest-to-trough about 6-7 m typical (median over 400 m stretches) and 10-12 m on sets.
  - Crests are long but irregular: they end and shift where the partners cancel.
- **Sharp crests:** one shared Gerstner Q > 1 on the primary swell (about 4-6), with its Σ Q k A at 0.6-0.72. The whole
  sea is capped at Σ Q k A ≤ 0.85 (det J ≥ ~0.3). `Wave.steep` may exceed 1; each wave's own Q k A stays < 0.5.
- **Shape:** one weak 90-130 m swell near `swell`, and one 140-240 m cross swell 40-80° off it. Both are under a third
  of the dominant amplitude.
- **Chop:** 5 faint components, 8-28 m, within ±60° of the wind, kA 0.005-0.013. Texture up close only.
- **Foam:** `sea.foam` keeps its meaning.
- **Detail band:** `makeSeaDetail` is cosmetic, 2-8 m, kA 0.008-0.015. Physics ignores it.
- **Accuracy:** `seaRest` now iterates to < 1 µm.
- **Weather:** `makeWeatherSea` (shared/weather.ts) keeps det J > 0 at full storm across 40 seeds. The test is in
  `tests/sea.test.ts`.

```ts
export type Sea = {
  seed: number; waves: Wave[]
  wind: [number, number]  // unit plan direction the chop travels toward
  swell: [number, number] // unit plan direction the primary swell travels toward
  foam: [lo: number, hi: number, height: number] // foam = smoothstep(lo, hi, (1 - det J) + height * y)
}
export type Wave = { dirX: number; dirZ: number; k: number /* 2π/λ */; omega: number /* sqrt(g k) */; amp: number
  steep: number /* Gerstner Q 0..1, horizontal amplitude = steep * amp */; phase: number /* seeded φ */ }
export function makeSea(seed: number): Sea
// Rest-position functions (what the GPU computes):
/** Displaced surface offset for the rest position (x, z) at sea time t (seconds, float64 on the CPU). */
export function seaDisplace(sea: Sea, x: number, z: number, t: number, out?: Float64Array): Float64Array // [dx, y, dz]
export function seaSlope(sea: Sea, x: number, z: number, t: number, out?: Float64Array): Float64Array // [dh/dX, dh/dZ, foam, det J]
export function seaFoam(sea: Sea, x: number, z: number, t: number): number
// Plan-position functions (solve for the rest position by Newton, < 0.1 mm; for buoyancy):
export function seaRest(sea: Sea, x: number, z: number, t: number, out?: Float64Array): Float64Array // rest [x, z]
export function seaHeight(sea: Sea, x: number, z: number, t: number): number
export function seaNormal(sea: Sea, x: number, z: number, t: number, out?: Float64Array): Float64Array // unit, y up
export const SEA_MAX_WAVES = 16
export const SEA_UNIFORM_FLOATS = 136 // 544 bytes
export const SEA_UNIFORM_LAYOUT = { waves: 0, shape: 64, origin: 128, foam: 132 } // float offsets
export const SEA_ORIGIN_GRID = 1024
export function snapSeaOrigin(v: number): number // round to SEA_ORIGIN_GRID
/** Packs the waves and their phases at time t into the GPU uniform. Phases k (d · origin) - ω t + φ are computed in
 *  float64 and wrapped to [0, 2π), so the shader never sees a large time or coordinate. Call every frame. */
export function packSea(sea: Sea, t: number, out: Float32Array, originX = 0, originZ = 0): void
```

`SEA_WGSL` (`shared/sea.wgsl.ts`) declares `struct SeaUniform` and functions only, no bindings. The consumer declares
`@group(1) @binding(0) var<uniform> sea: SeaUniform;`. Functions: `fn seaDisplace(p: vec2f) -> vec3f` and
`fn seaSlope(p: vec2f) -> vec4f` (xy = analytic height gradient of the displaced surface, normal =
`normalize(vec3f(-g.x, 1, -g.y))`; z = crest foam 0..1 from the Jacobian and height; w = 0).

```wgsl
struct SeaUniform {
  waves: array<vec4f, 16>, // dirX, dirZ, k, phase at p = 0
  shape: array<vec4f, 16>, // A, Q*A, Q*A*k, A*k
  origin: vec4f,           // origin x, z (world metres), wave count, 0
  foam: vec4f,             // lo, hi, height weight, 0
}
```

Large world coordinates: `p` is the rest position minus `origin`. Each frame, snap the camera position with
`snapSeaOrigin` on both axes, pass it to `packSea`, and build `p` in f32 from small numbers (camera-centred grid plus the
camera offset from the origin), never by subtracting two large f32 world coordinates. World position of a vertex =
`origin + p + seaDisplace(p).xz`, height `seaDisplace(p).y`.

## Islands (`shared/islands.ts`, `shared/seabed.ts`, `src/render/island-mesh.ts`)

Look: `concept/island-1-kinds.png` (the six kinds), `island-2..5`. Every world has 24-36 islands of all six kinds and one
centrepiece (`islands[0]`, a big volcano or jungle island 2.3-3.3 km north of the spawn). Islands come in groups with
300-1200 m of open water between neighbouring coasts: the centrepiece's group (a big neighbour, stack clusters, cays, an
atoll, a cliff island) spills toward the spawn, one group sits beyond it on the horizon, and 2-4 more are scattered
further out. 600 m around (0, 0) is open deep sea.

```ts
export type IslandKind = "cay" | "jungle" | "atoll" | "stacks" | "cliff" | "volcanic"
export type Island = { x: number; z: number; radius: number; peak: number; kind: IslandKind; seed: number }
export type Archipelago = { seed: number; islands: Island[]; bounds: [x0: number, z0: number, x1: number, z1: number] }
export function makeArchipelago(seed: number): Archipelago
/** Terrain height in metres at (x, z): positive above sea level, negative on the seabed (deep sea ≈ -60). Deterministic. */
export function terrainHeight(arch: Archipelago, x: number, z: number): number
/** Coral cover of the seabed at (x, z), 0 = sand, 1 = coral heads (clustered blobs on reef shelves and in lagoons). */
export function coralAt(arch: Archipelago, x: number, z: number): number
export type Seabed = { x0: number; z0: number; size: number; res: number; data: Uint8Array<ArrayBuffer> } // RGBA8, res x res, square
/**
 * R = water depth / 40 m clamped (0 at the shoreline and on land), G = 255 on land, B = distance to shore / 300 m clamped
 * (on land: distance to the water), A = coral cover (0 = sand, 255 = coral; 0 on land and deeper than 20 m).
 */
export function bakeSeabed(arch: Archipelago, res: number): Seabed
export function seabedAt(bed: Seabed, x: number, z: number): { depth: number; land: boolean; shore: number; coral: number }
```

Reef shelves are pale and shallow (-0.5 to -4.5 m) out to a clear edge, then drop to -60 m within ~200 m; atoll lagoons
are 3.5-5.5 m deep. The shelf outline is deliberately irregular: its width swings from almost nothing (steep and cliff
sides) to several hundred metres, reef tongues trail toward the sea's wind (`reefWind(seed)`, from `makeSea`), the edge
is lobed and scalloped with spur-and-groove fingers, passes cut through some reefs (jungle bays, atolls), shallow bars
join close neighbours (broken by gaps), and patch reefs sit in open water near islands. Terrain stays continuous
everywhere (no height jumps), so the depth (R), shore distance (B) and coral (A) channels agree. Coral patches lie on
shelves, bars and patch reefs only, clustered toward the shelf middle and outer edge.

`buildIslandMesh(arch, { props?: boolean }): { data: ArrayBuffer; box: [number, number, number, number] }[]` returns
512 m chunks of flat-shaded, low-poly terrain (beach rings, jungle floor, volcano ridges, cliff strata) with every prop
merged in (canopy clumps and palms as `MAT.foliage` with a per-instance `aux` phase; boulders, lava rocks, stacks'
tufts, hillside crags), using `Mesh` and `MAT` from `./mesh`. At most `TRI_BUDGET` (900k) triangles; the canopy is thinned to fit.

For an instancing renderer, `buildIslandMesh(arch, { props: false })` gives the terrain alone and
`buildIslandProps(arch): { protos: { name; data: ArrayBuffer /* packed Mesh, prototype space */; tris }[]; instances:
Float32Array[] }` gives the props: per prototype, `INSTANCE_FLOATS` (8) floats per instance, `x, y, z, yaw, scale, r, g,
b`. World position = rotateY(yaw) · (scale · p) + (x, y, z); vertex colour × (r, g, b); foliage `aux` phase =
fract(x · 0.0137 + z · 0.0071). The merged fallback is exactly this expansion.

## Ocean, sky, clouds (`src/render/ocean*.ts`, `sky.ts`, `clouds.ts`)

Technique: `docs/ocean-research.md` plus the Sea of Thieves colour/foam/area-sun model (`docs/sea-of-thieves-water.md`).
`main.ts` wires them; no renderer change was needed.

- `RelView` (`ocean-view.ts`): `update(eye, forward, aspect)` once per frame builds a rotation-only `viewProjRel`
  (and its inverse, plus f64 copies for culling). Sea, sky and clouds draw eye-relative positions with it, never the
  Frame's `viewProj`, so kilometre-scale coordinates never reach f32.
- `Sky` ("sky" slot): fullscreen triangle; `skyColorAt` above the horizon, `seaHazeAt` below it.
  `update(view, sunView)`.
- Ocean lattice: N = 32, T = 4 (13 levels of 64 x 64 cells from 0.5 m; level skipping and the morph also scale with
  camera height via `look.lodK`), for chunky 40-60 px facets.
- Surf (`surfCover` in `ocean-shader.ts`) uses no fixed distance to shore:
  - It breaks where depth < 1.3 × the local swell height. That height is the analytic envelope of the swell, so the
    surf grows with sets and pulses as crests arrive.
  - It is gated by exposure: a march up-swell through the seabed shelters lagoons, the lee of land and inner reefs, and
    shores facing away from the swell get less.
  - It is cut into segments by world-anchored, hash-based noise.
  - It thins with pixel footprint, so islands seen from far away show a few windward flecks, not rings.
  - The shore wash is a separate, thin layer, and wide and churning only on exposed rock and cliff.
- Wake field (`src/render/ocean-wake.ts`): a camera-centred 2048² rg8 texture, 2 m texels, 4 km across.
  - Hull passes (`src/game/wake.ts`) draw foam strength (R) and age (G) into it in their `prepare`.
  - The ocean samples it, so wakes use the same chunky crest-foam look. `ocean.look.wake` scales it.
- Hooks for the weather pass:
  - `ocean.look.foamAmount` scales all crest, surf and wake foam coverage.
  - `ocean.look.roughness` is the GGX base roughness.
  - `Ocean.setSea` accepts the live `makeWeatherSea(...).sea` view: amplitudes are re-read every frame.
- `Ocean` ("opaque" slot, after the static islands so early-z rejects water under them): `setSea(makeSea(seed))`,
  `setSeabed(bakeSeabed(arch, 2048))` (R depth, B shore distance, A coral cover; reef-edge steepness comes from the R
  gradient), `setClouds(seed, drift)`, then `update(seaTime, view, sunView)` every frame (packs the sea with `packSea`
  at the snapped origin, adds `makeSeaDetail`, builds and frustum-culls the tile list). `ocean.look` is live-editable.
- `Clouds` ("opaque" slot): `setWorld(seed, sea.wind)`, `update(seaTime, view)`. Placement is a hash of world cells in
  a frame drifting with sea time, so every client sees the same clouds; `CLOUD_SHADOW_WGSL` mirrors it for shadows.
- `Atmosphere.sunView?` (`atmosphere.ts`): optional direction of the visible sun disc, its glow and the sea's glitter
  path, lower than `sunDir` (which still lights everything). The concepts paint a low sun with a long glitter path over
  midday lighting. When it is unset, `sunDir` is used. `ATMOSPHERE_WGSL` adds `skyNoSun[At]`, `skyColorAt` and
  `seaHaze[At]`.
- `shared/sea.ts` gained `makeSeaDetail(sea)` (8 cosmetic 2-8 m waves, seeded from `seed ^ 0xde7a11`). Physics ignores
  them; nothing else in `sea.ts` changed.

## Net (`server/**`, `shared/protocol.ts`, `src/net.ts`)

Room Durable Object (`Room`, binding `ROOM`) keyed by room name. First joiner creates `{ seed: random u32, epoch: Date.now() }`;
when the last player leaves, the room forgets it, so the next visit is a new world. Sea time = `(serverNow - epoch) / 1000`.
A reconnecting client sends the world it shows (`hello.resume`); an empty room adopts it, so a lone player's network
blip or a Worker restart doesn't change the world. A reconnect into a room with a different world reloads the page.
While reconnecting, `state` is `"connecting"` and `seaTime()` keeps running on the last clock estimate.

The `Net` interface (`src/net.ts`) adds the room's crew and ships to the above: `room`, `id` (my player id), `crew`,
`ships` (every ship's authoritative pose by crew ship id), `serverNow()`, `refused`, `sendHelm(throttle, rudder)` and the
crew requests `op(id)` (a ship operation, shared/ops.ts: `"helm"` takes the helm, `"hornet"` launches; the DEPLOY
menu's only path), `board(ship, as?: "helm" | "pilot")`, `newShip()`, `recover(how)` (the jet is gone,
the pilot waits on deck), and the captain powers `promote(player)`, `kick(player)`, `lock(locked)`. Client messages
`op`, `promote`, `kick`, `lock` (no `takehelm` / `launch`). `connect({ room, seed, name, private, onFull })`.
Chat (`shared/chat.ts`): client `chat { text, crew? }` (decoded with `cleanChat`: control/bidi stripped, ≤ 120 code
points), server `chat { from, name, team, text, crew? }` stamped from the room's crew, 5 lines per 5 s per player
(over it dropped silently; `Net.sendChat` refuses first and the feed says TOO FAST), crew lines only to the sender's
team (`hearsChat`). `Net.chat` queues lines for `src/ui/chat.ts`; offline they echo locally.
Offline (`?seed`) the same crew rules run locally on a crew of one.
Wire format (`shared/protocol.ts` `encode`/`decodeClient`/`decodeServer`, codecs in `shared/wire.ts` on
`@arcade/kit/net/bytes`): the high-rate messages travel as binary frames (first byte a `WIRE` kind; client `plane`,
`aim`, `boat`, `gun`, `hits`, `shiphits`, `thits`, `tshiphits`, `bhits`; room `planes`, `ships`, `boats`, `turrets`,
`gun`), everything else (hello/welcome, crew, chat, ops, objective, hulls, combat events, errors) as JSON text on the
same socket (`binaryType = "arraybuffer"`). A binary frame decodes to the same message object JSON would and passes the
same checks; malformed, truncated, trailing or oversized frames (512 B client, 64 KiB room) decode to null. Grids: jets
1 ms, 1 cm, quaternion 1/32767 (landing angles 1e-4 rad), velocity 0.1 m/s, controls 1/100 (`compactPlane` is that
grid, so the room's combat sim sees exactly the jet its clients draw); ships and boats keep the room's own rounding
(lossless). Each timed list carries one f64 of whole ms plus a varint offset per entry. `scripts/net-bandwidth.ts`
measures a full 32-player room (JSON before: 32.0 KB/s down per client; binary: 10.7 KB/s).

## Multiplayer (`shared/{crew,squad,ops}.ts`, `server/{lobby,matchmaking,core,room}.ts`, `src/ui/{lobby,menu,team-menu,ops-menu}.ts`)

- Load screen (`menu.ts`, over an offline sea, seed 7): name, QUICK JOIN, CREATE GAME, JOIN GAME by code. `?room=X`
  joins straight away, `?seed=N` plays offline; both skip it. The chosen room goes into the address bar as `?room=`.
- Lobby Durable Object (`Lobby`, binding `LOBBY`, singleton, room reports persisted): `GET /api/quick` (fullest open
  public room, else a shared fresh code), `POST /api/create` (fresh private code; quick join never hands it out),
  `GET /api/room/:code`, `GET /api/stats`. Rooms report `{ code, players, private }` (1 s throttle, 10 s heartbeat,
  30 s stale). Codes are 4 characters of `CODE_CHARS`. `/ws?room=CODE[&private=1]`.
- Crew rules (`shared/crew.ts` header): every carrier for itself. A room holds `CREW.roomMax` (32) players on
  `CREW.ships` (4) carriers, `CREW.capacity` (8) people per ship whatever their roles (helm, pilots, gunners; the op caps
  still apply). Each carrier is its own team: `CrewShip.team` (0..3) is its side, its colour (`TEAM_COLORS` / `teamCss`:
  orange, cyan, pink, lime; `src/render/team.ts teamColor` for the shaders) and its spawn on the ring (`shared/spawn.ts
  fleetSpawn(arch, team)`, evenly spaced), no two afloat share one, and `CrewPlayer.team` is always the player's ship's.
  That one value is the whole hostility rule: `canHurt` (shared/weapons.ts), missile and SAM locks, gun, CIWS, shell and
  boat rounds, ship damage, crash damage, kill credit and the kill feed all compare it, so friendly is your own
  carrier's crew only. The room keeps every team afloat (`ensureFleet`: all four come out on the first join, crewed or
  not; empty ones stay afloat). Roles: one HELM per ship, PILOTs (flying or waiting on deck, `plane: -1`) and GUNNERs
  (`role: "gunner"`, `CrewPlayer.mount` = the `WEAPON_MOUNTS` index, -1 otherwise; gunners sit in `CrewShip.pilots`,
  which lists everyone but the helm). Joining the room puts you aboard the least crewed unlocked ship with room (ties:
  the older), so the first four players each get a carrier; at the helm if free, else as a pilot on deck. JOIN (Tab)
  moves you to any ship with room, unlocked and not banning you, and its side becomes yours (no balancing). CREATE SHIP
  only while a team has no carrier (`freeTeam`: one sunk and its replacement not out; `fleet-full` otherwise), and the
  new ship takes that team. A vacated helm holds the throttle and centres the rudder; a reconnecting helm gets the helm
  back if free, else is a pilot on deck (a reconnecting gunner too; a locked ship still takes a reconnecting member
  back).
- Ship operations (`shared/ops.ts`, data): `OPS` lists `{ id, label, name, kind: "helm" | "vehicle" | "gun", vehicle?,
  mount?, cap, recharge (s) }`. The guns (see "Gunnery"): CIWS PORT, CIWS STBD, SAM PORT, SAM STBD, 5-INCH GUN
  (`ciws-port` … `gun-5in`), cap 1 per mount, no recharge; taking one frees the helm or another gun, launching or taking
  the helm leaves it (`at-gun` when it is yours, `in-use` when someone else's). Today TAKE HELM (`helm`, cap 1, only while free), LAUNCH HORNET (`hornet`, cap 2 per ship,
  recharge 30 s) and LAUNCH F-35C (`f35`, cap 1 per ship, recharge 45 s: the scarcer strike jet costs more to lose).
  Each vehicle op gives every ship `cap` slots (`CrewShip.aircraft`, each `{ op, pilot, readyAt }`,
  room-clock ms; `CREW.aircraft`/`CREW.recharge` are derived from the Hornet entry). A destroyed jet
  (`recover(.., "crashed")`: a crash into the sea, an island or a ship, shot down, or lost off the map) leaves its slot
  recharging for its op's `recharge`; landing on its carrier (`recover(.., "landed")`) frees it at once. There is no
  manual way out of a flight (no R key, no "returned"; an old client's `returned` is ignored), so a pilot who wants
  the helm lands first or dies: TAKE HELM reads AIRBORNE while they fly. Nothing launches by itself: a pilot on deck (or the helm, who hands off the helm) runs LAUNCH HORNET when a slot
  is ready (`runOp`, a `launch` event, `sortie` + 1: a fresh jet on the catapult). Slots are tagged with their op, so
  Hornets and the F-35C recharge independently; `slotVehicle(ship, slot)` / `playerVehicle(crew, id)` give the type a
  slot flies (the room uses it for the combat sim and to stamp relayed jets, the client for the model). The room validates with `opError`
  (member of the ship, not already flying, helm free / a ready slot, the ship's one catapult free; errors `flying`,
  `in-use`, `recharging`, `catapult-busy`, `helm-taken`, `at-helm`, `bad-op`). One catapult per ship: `runOp` sets
  `CrewShip.catapultUntil` (room ms) to `catapultTime(kind)` (shared/launch.ts: parked, the stroke, 1 s slack) after a
  jet launch and `opError` refuses further jet launches until then (CATAPULT BUSY). `shipOps(crew, me, now)` is the menu's view (state AVAILABLE / active / IN USE /
  RECHARGING with `readyIn` / unavailable with a reason, and per-slot who / countdown). A new vehicle type = one `OPS`
  entry plus its client module keyed on the slot's `op`.
- Squads (`shared/squad.ts`): every crewed ship has a `captain`: its creator (CREATE SHIP), or on a room-made ship the
  first aboard; when the captain leaves the ship (room, another ship, kicked) the longest-serving member (`since`, then
  the lower id) takes over (a `captain` event); a role change aboard keeps it; an emptied ship has none and unlocks.
  Captain powers on their own ship only, validated by the room (`not-captain`, `not-member`, `self`), 400 ms cooldown
  per player: PROMOTE a member; LOCK/UNLOCK (`locked`: no new members at all, neither JOIN nor auto-assign; members
  stay; invite links only pick the room); KICK a member, who moves to another carrier with room as a joiner would
  (unlocked, least crewed), else a new ship of their own in a free berth (as its captain), else a locked ship with room
  (an enemy from then on), and is in the ship's
  `bans` for 60 s (`SQUAD.kickMs`; JOIN refused with `kicked`). Crew snapshot fields: `CrewShip.captain`, `locked`,
  `bans: { player, until }[]`, `CrewPlayer.since`.
- The room is authoritative: `RoomCore` holds the crew and runs every ship (`shipStep`, fixed SHIP.tick on sea time,
  ticked every 50 ms by the Room), takes `helm` orders only from that ship's helm, and sends `ships` at 10 Hz and the
  whole `crew` after every change. The helm's client predicts its own ship and glides it onto the room's pose
  (`src/game/game.ts`); every other hull is a remote (plan pose only, heave/pitch/roll floated on the local sea).
- The role decides controls and camera: helm = helm keys + chase camera, pilot with a jet = the flight module
  through `FlightSeam` (`game.setFlight`): the game calls `start({ ship, slot, deck, recover })` at every sortie (each
  new `sortie` with an aircraft slot), `update` per frame, `stop` when it ends (a pilot on deck watches the ship); the
  flight side calls `recover("landed" | "crashed")` (`crashed` covers shot down and lost). See Flight below.
- Tab menu (`team-menu.ts`, `carrier.teams`, alias `carrier.roster`): hold Tab, tap (or PIN) to pin, Esc closes; frees
  the pointer. Header CARRIER · FREE FOR ALL. One card per team in team order, in that carrier's colour (swatch, name,
  top rule): crew count n/8, hull bar, captain (★), lock, helm and pilots (airborne / on deck / down) and a K/D column
  once `teams.stats` is set; a sunk carrier whose replacement is not out yet is a dashed NO CARRIER · REFITTING berth.
  Actions: JOIN (disabled buttons say FULL / LOCKED / KICKED 48S), + CREATE SHIP in the free berth, and on your own
  ship as captain LOCK, ★ CAPTAIN (promote) and KICK, each of the last two needing a second click within 3 s. The load
  screen's footer reads TAB SHIPS · E DEPLOY.
- DEPLOY (`ops-menu.ts`, `carrier.ops`): hold E to see it, tap E to pin, tap again or Esc closes; frees the
  pointer. The seat line (`Hud.seat`) shows "E DEPLOY" with the layout's label for physical E. E is matched by physical
  key only (code KeyE; the "e" character is Dvorak's D, a movement key). In a jet (catapult, flight, landing, the wait
  after a crash) E is the rudder: `main.ts` decides once (`inJet`) and both shuts the menu (`ops.airborne`) and hides the
  prompt (`hud.deployKey`); on deck, at the helm, in a gun seat and in the boat it works. Each op a row with its number key,
  its slots (name, READY / FREE, or a recharge ring with seconds) and its state; click or press its number to run it
  (the menu closes; digits never reach the helm's throttle presets while it is open). The only way to take the helm or
  launch: there is no LAUNCH button, no F/Enter launch and no take-helm key. In the air it is read-only (TAKE HELM:
  AIRBORNE). The HUD's bottom-left line is only state: `★ PILOT · CV-07 RESOLUTE · ON DECK`.
- Mouse (`src/input.ts` owns Pointer Lock on the canvas, `src/game/chase.ts`): aboard (helm, on deck or flying) and
  not in the free camera, the first left click takes Pointer Lock; then plain mouse movement orbits the chase camera
  around the ship's centre (`CHASE.sensitivity` rad/px both axes, no invert, pitch 6-80°, fixed distance, back behind
  the ship after 4.5 s without movement). In the air the same lock is the flight stick (`FlightInput.grab = false` in
  the game; `?invert` flips only the stick), so ship ↔ jet hand-offs, crashes and recoveries keep it. Esc releases it
  (the browser's), the next click takes it again. Tab, DEPLOY and the debug menu `input.suspend()` it (free
  cursor); when the last one closes, `input.resume()` takes it back only if it was held when they opened (allowed
  without a click because the page released it). The free camera (C) unlocks and keeps drag-orbit, wheel and WASD;
  if Pointer Lock is denied, dragging orbits the chase camera. LMB at the helm only takes the lock.
- Previews with fake data: `menu.html?seed=7&show=menu|teams|ops` (`&as=N` views the crew as player N; the Tab preview
  has three crewed carriers and a refitting berth). Real-GPU checks: `scripts/ffa-shot.ts` (three pages on three
  carriers damage each other; Tab, kill feed and colours in `captures/ffa/`), `scripts/ui-shot.ts` (Tab, captains,
  ship operations; captures in `captures/ui/`) and `scripts/mp-shot.ts` (older, still drives the removed roster, seats
  and teams).

URL params (read in `main.ts`): `?room=name` (join that room, skipping the menu), `?seed=N` (offline, fixed world, no menu), `?t=S` (freeze sea
time at S), `?cam=x,z,yaw,pitch,dist` (initial camera; yaw and pitch in degrees, yaw 0 looks north (-z), 90 east,
pitch is the eye's elevation seen from the focus, 8-85), `?weather=clear|light|medium|heavy` (local manual weather from
the start, for scripted captures: the room's physics keep the room's weather), `?lab=weather` (debug menu open on the
weather tab), `?tod=H` (local clock frozen at hour H, 0-24; the room's clock is untouched).

## Bots (dev only: `shared/bots.ts`, `server/bots.ts`, `src/dev/{bots-tab,local-room}.ts`, `tests/bots.test.ts`)

- Bots are crew players without a socket, run by the room (dev rooms only, `RoomCore.dev`). A bot's `role` is a ship
  operation id (`hornet`, `f35`, `boat`, a gun op, `helm`): it joins the chosen carrier (`joinCrew`, `joinShip`) and
  runs that op through `opError`/`runOp` like a player, so caps, recharges, sides and capacity apply (`rules` off lets
  a bot take an extra slot, trimmed when it goes; an air start doesn't hold the catapult). Named `BOT·VIPER` etc.
- Each room step `RoomBots.step` flies jets on `planeStep` (air start or the real catapult), steers boats through the
  room's own boat sim, aims turrets with `slewTurret`, fires `Bullets`/`TurretRounds`/`BoatRounds`, AIM-9s, bombs
  (`bombImpact` decides the release), SAMs, shells and flares, and hands it all to `RoomCore.handle` as the messages a
  client sends (`plane`, `gun`, `hits`, `shiphits`, `fire`, `flare`, `seek`, `boat`, `bhits`, `aim`, `gfire`, `thits`,
  `intercept`, `helm`, `op`, `recover`): the same validation, damage, kill credit and relays as a player's. Invulnerable
  bots drop damage events (`RoomBots.absorb`); infinite ammo refills stores and budgets.
- Behaviors (`BotSettings`, ranges in `BOT_RANGES`): jets straight / orbit / eight / evasive (jinks, breaks, flares on a
  seeker or missile) / dogfight (lead pursuit, gun, AIM-9) / bomber (F-35C bomb runs, Hornet strafing); boats idle /
  patrol / attack; gunners hold / engage; helms stop / cruise / circle / chase. Skill, aggression, accuracy, weapons,
  flares, ammo, invulnerable, respawn, target player, target ship.
- Wire: client `{ type: "bot", cmd }` (`BotCmd`: spawn, set, kill, remove, clear; `botCmdOf` validates and clamps);
  server `bots` (`BotInfo[]`, ~2 Hz while any exist) and `welcome.dev`.
- BOTS tab: scenarios (1v1 dogfight · 2 km, bomber run on my carrier, swarm of 4, carrier battle, target practice ×3,
  boat attack ×2, remove all), a spawner and behavior on the shared Lab panel, the live list (LOAD, APPLY, SHOOT DOWN,
  REMOVE, per group APPLY/REMOVE). Real-GPU check: `scripts/bots-shot.ts` (captures in `captures/bots/`).

## Weather (`shared/weather.ts`, `src/render/{rain,weather-fx,weather-system}.ts`, `src/dev/{debug-menu,weather-lab}.ts`)

- Weather is a pure function of (room seed, sea time, room override), like the sea. `weatherAt(seed, t)` is the seeded
  timeline: ~270 s slots (±50 s), a neighbour-only Markov chain over clear/light/medium/heavy evaluated exactly by
  coupling from the past (shares ~45/26/18/10%), the first two slots of a room clear, 60-120 s smootherstep fades.
  `Weather` is 16 linear parameters (rain, wind, windDir, sea, swell balance, foam, cloud, dark, fog (unused, always 0:
  storms read without haze), sun, lightning, streak, density, splash, desat, darken). Lightning strikes are hashed
  per 0.5 s slot (`lightningAt`, `strikesBetween`).
- Room override: client `{ type: "weather", to: kind | "auto" | packWeather(w), f: fade s }`; the room builds
  `overrideTo(seed, cur, seaNow + 1 s, to, f)` (its `from` is the room's weather at that moment, rounded like the wire
  form) and sends `{ type: "weather", o: packOverride(o) | null }` to everyone, and to every joiner. Clients hold it in
  `net.weather` (`RoomWeather`: the previous override still rules until the new one starts). Offline, `sendWeather`
  applies it locally.
- Sea: `makeWeatherSea(sea)` returns a stable `Sea` view whose amplitudes (and Gerstner Q) follow `set(weather)`;
  wavelengths, ω, directions and phases never change. The long swell grows most (×1.9-2.02 at full storm), chop
  ×1.8-3.4, the steepness cap 0.9 takes Q from the chop first. Heavy big sets 20-26 m crest to trough, medium 12-15 m.
  The room steps every ship on its view (`server/core.ts`), the client hands its view to the ocean and the game, so
  physics and visuals agree for everyone. `shared/ship.ts` blends to a lively storm response above Hs 9.6-15 m
  (`seaStorm`): calm and light seas feel as before. `Ship.slam` (0..1, decays), `Ship.slams` (count) and `Ship.bowAir`.
- Client (`WeatherSystem`): `setWorld(seed, sea)` returns the view; `room = net.weather`; per frame `update(dt, t, look)`
  writes the shown atmosphere/grade/ocean look from the sunny bases, then `draw(dt, t, view, frame, fov)` runs the rain
  pass ("alpha" slot, ~0.13 ms at heavy on the M4 Max). `manual` is the lab's local preview (never synced).
- Storm look: `Atmosphere.overcast` (Frame `zenith.w`, `overcast()`/`sunVeil()` in ATMOSPHERE_WGSL) hides the sun disc,
  halo, glow and glints and turns the far sea grey; `Clouds.storm` (`CloudStorm`, written by the weather) grows the
  cumulus into a low, slate, faceted deck with dark undersides and lightning glow near the strike; the ocean look's
  `stormFoam`, `rain`, `wind`, `windX/Z` (look slots 10-11) draw wind-streak foam (crests torn into streaks, densest on
  crests and swell backs) and rain dimples near the camera. All zero / absent: the sunny look exactly.
- Debug menu: ` / F2, `DebugMenu.addTab`, `wantsInput` pauses the game's input while the pointer is over it. Captures:
  `scripts/weather-shot.ts` (kinds, low storm, lab, chase-camera storm sequence, rain benchmark).

## Day-night (`shared/daycycle.ts`, `src/render/{daynight,daynight-wgsl,daynight-lab,stars,lights}.ts`)

Look targets: `concept/time-*.png`, palettes in `concept/README-time.md`. Captures: `scripts/daynight-shot.ts`.

- Time of day is a pure function of (room seed, sea time, room override), like the weather. A day is `DAY_CYCLE`
  (600 s = 10 min) of sea time. The clock runs unevenly through it (`DAY_KNOTS`): ~350 s of day (07:00-17:00), ~62 s
  of golden hour, sunset and dusk, ~125 s of night, ~62 s of dawn. Rooms start at 09:00-11:00 (seeded).
  - `timelinePhase(seed, t)`: phase in days. `hourOfPhase` and `phaseOfHour` convert between phase and clock hour.
  - `skyAt(seed, phase)`: hour, sun and moon directions, the moon's lit fraction, the star rotation.
  - The sun's path is stylised for the views players get: it rises in the north at 06:00, stands 60° up at a bearing
    of 26° at noon, and sets in the north-east at 18:00. Dawn and sunset happen ahead of a camera looking north.
  - The moon runs about opposite in time, offset per day, and is nearly full.
- Room override: client `{ type: "time", h: hour | null, s: speed, f: fade s }`.
  - The room builds `timeOverride(seed, cur, seaNow + 1 s, h, s, f)` and sends `{ type: "time", o: packTime(o) | null }`
    to everyone and to every joiner.
  - Clients hold it in `net.time` (`RoomTime`). Offline, `sendTime` applies it locally.
  - A fade runs the sky forward through the hours in between. Speed 0 freezes the clock.
  - The server only relays it: physics never reads the time of day.
- `DayNight` (client): `update(dt, t, bases, ocean.look)` turns the sunny bases (`atmosphere`, `grade`, `baseOcean`)
  into this moment's `daynight.atmosphere/grade/ocean`. Those are the weather's bases, so the weather applies on top.
  - `fill(frame)` writes the Frame's `extra`. `passes(view, stars, lights, ...)` drives the star/moon and lights passes.
  - `state.daylight` dims the weather's overcast greys, lightning, desaturation and storm water toward navy, so a storm
    at night is dark and lightning is its key light.
  - Palettes key on the true sun elevation, with separate evening and morning rows (`DAYNIGHT_PALETTE`).
  - The light and the painted disc are compressed elevations (`DAYNIGHT_SKY`). Noon lands exactly on the sunny base, so
    clear noon is the sunny look, unchanged.
  - Below −8° the moon takes over as the key light (`MOON`).
- Shaders: `DAYNIGHT_WGSL` is part of `ATMOSPHERE_WGSL`.
  - `ambientSky(n)`, `ambientBounce()` and `rimLight()` are used by `lit`, `ship-pass`, `plane-pass` and `weapon-fx`.
  - `cloudAmbient` is used by the clouds: sky-lit at dusk and at night.
  - `nightSurf` gives reef surf a soft cyan glow at night.
  - The sky disc is skipped while the moon is the key light. The `Stars` pass draws a faceted moon with its phase.
  - Every term is 0 in daylight.
- `Stars` ("sky" slot): about 12k instanced star sprites, a Milky Way band and the moon. It fades with the night and
  hides under the overcast.
- `Lights` ("alpha" slot): additive point sprites with a minimum pixel size, plus flat deck pools.
  - The carrier set covers the deck edges, the amber centreline and drop line, red/green sidelights, the masthead light,
    the mast beacon, the bridge windows and the floodlit deck.
  - Each jet model gets its own set via `lights.addJet(model)`: red/green wingtips (`PlaneModel.tips`), double-flash
    strobes on the fin tips (found in `model.body`), a belly beacon, and an engine glow from the nozzles that shows only
    at night. A new model (the F-35C) gets its lights from its own geometry.
  - Create `Lights` before the game: `ShipPass` and `PlaneFx` find it through `lightsFor(renderer)` and add every ship
    and jet they draw.
- TIME debug tab (`daynight-lab.ts`): readouts, local hour scrub, presets, speed/freeze, BROADCAST TO ROOM / ROOM TO
  TIMELINE.

## Flight (`shared/{plane,launch,vehicles}.ts`, `src/flight/**`, `src/render/plane*.ts`)

- `shared/plane.ts`: the arcade flight model (Battlefield-style), fixed 60 Hz `planeStep(s, c, dt, world, tuning,
  probes)`, every tunable in a `PlaneTuning`; `PLANE` is the F/A-18E's. Body frame = the GLBs' (+Z nose, +Y up, +X the
  pilot's left; right-handed, never mirrored).
- `shared/vehicles.ts`: `VEHICLES[kind]` per aircraft type (`VehicleKind` = `"hornet" | "f35"`, wire code = index in
  `VEHICLE_KINDS`): flight tuning, collision probes, engines, gear height, catapult stroke, approach speed, missile
  rails and bomb stations (body frame from the centre, release order; the first `bay` are inside the weapons bay).
  The Hornet is `PLANE` unchanged. The F-35C: centre 1.2 m, gear 1.05 m, stall 58, blue zone 134, top 180 (230 with
  the burner) m/s, thrust 14.5, pitch 0.86 / roll 3.0 / yaw 0.36 rad/s, one engine; stroke 4.3 s (137 m/s).
  `deckCentreY(kind)` and `landingVehicle(kind)` (shared/landing.ts `LandingVehicle`) carry the geometry into the
  launch and the landing. `LandingVehicle.touch` moves a type's touchdown point (`Landing.touchZ`) so its hook tip
  (`VEHICLES[kind].hookZ`) meets the wires where the Hornet's does: the F-35C's centre touches down ~2 m further aft.
  `shipQuat`/`shipToWorld`/`worldToShip` map ship-local carrier-spec points exactly as `ShipPass` does.
- `shared/launch.ts` (`startLaunch(ship, plane, kind)`, `launchPose(z, ship, plane, kind)`, `catapult(kind)`,
  `catapultTime(kind)`): parked at idle on the shuttle at the stern end of the runway for `LAUNCH.hold` 1 s, then on
  one step full thrust, the burner and the stroke: `STROKE` 285 m (87% of the runway) on `CENTERLINE_X` to the bow in
  `VEHICLES[kind].strokeTime` (Hornet 4.2 s, ~141 m/s; `catapult(kind)` derives the acceleration), glued to the hull
  pose every step; leaves with the ship's plan velocity plus the launch speed, nose up.
- `shared/landing.ts`: `landTarget(plane, airborne, ship, hull, t, vehicle)` is the "R LAND" prompt (your own
  carrier only, its deck open, within `LANDING.range` 1.2 km, under `ceiling` 600 m, the nose within `look` 30° of the
  line to it, above stall, `cooldown` 5 s after launch); `startLanding` / `landingStep` fly a scripted landing in the carrier's ship-local frame (curves to a
  join point behind the stern, a 3.5° glideslope, the trap, a hold) that always ends on the deck (`LANDING.timeout`
  hard stop) and reports done exactly once. Input is ignored meanwhile.
- `src/flight/seam.ts` (`FlightModule`) is the game's `FlightSeam`: LAUNCH HORNET in DEPLOY → the room gives
  a ready aircraft slot → `start` → deck → catapult → flight; R (physical KeyR) at the prompt lands it (`Flight.land`,
  `recover("landed")`), or 2.5 s after a crash, a shoot-down or the edge timeout (`recover("crashed")`) → on deck until
  the pilot launches again (a destroyed jet's slot recharges for 30 s). Nothing else ends a flight. The seam's `frame` runs every frame for every role
  (every jet drawn). No LAUNCH button and no launch key in the game; the offline harness launches with Enter. Camera handoffs ease over ~1.2 s (`flight/blend.ts`);
  `Camera.lookAlong` takes a free up vector and FOV and `main.ts` feeds them to the sea/sky through `FlightView`.
- Models (`src/render/plane-glb.ts`): `loadPlaneModels()` builds every type's `PlaneModel` (registry `MODEL_SPECS`):
  body, canopy, stabilisers, tailhook (`hookDown`: negative about X lowers the aft-pointing hook), bay doors
  (`doorOpen` about ±Z), stores (one piece per bomb, release order), procedural gear sized per type, and anchors for
  effects and lights: `nozzles` (one per engine), `tips`, `fins`, `beacon`, `eye`, `centre`. Accent faces: the
  Hornet's fin tops and rails, the F-35C's own `F35_accent` material; both tinted per jet. `PlanePass`/`PlaneFx` take
  the registry; `PlaneDrawPose.kind`, `doors` (0..1) and `stores` (bombs aboard) pick and pose the model.
- Net: the pilot sends `plane` (`PlaneTuple`, 17 numbers plus an optional vehicle code and bay doors: 19) at 20 Hz; the room relays airborne players' jets as
  `planes` every 50 ms (always 19 long: the room stamps the code of the pilot's slot, whatever the client sent; a
  17-long tuple from an old client is a Hornet) and drops a jet when its slot is freed or its sortie ends (took the helm, recover, leave, sink). Mode 0 = on the deck (x = the
  catapult z: receivers place it on their own copy of the hull), 1 = flying, 2 = crashed. Remote jets are drawn
  120 ms behind with Hermite position and slerped orientation (`flight/remote-planes.ts`). A pilot reconnecting
  mid-flight comes back on deck (the jet was lost with the connection).
- Dev harness (not built): `flight.html` (offline, `?seed ?ship ?rudder ?invert ?cockpit ?f35`). Real-GPU checks:
  `scripts/flight-shot.ts` (harness) and `--mp` (two pages in one room; still written for the old seats and roles);
  `scripts/explosion-shot.ts` (kills and crashes, day and night, and the explosions' GPU cost; captures in
  `captures/explosions/`); `scripts/f35-shot.ts` (the F-35C in the game: ops, deck, catapult, flight, bay, bombs, landing, and a Hornet and an
  F-35C in one room; captures in `captures/f35/`).

## Pilot's map (`src/flight/{radar,target-markers}.ts`, `src/dev/radar-lab.ts`)

- Built only from what the client already draws (no messages): `FlightModule.frame` fills one `RadarScene` (the crew
  player, our jet's draw pose while flying or landing, the drawn carriers and hulls, `Weapons.jets`, `Weapons.boats`
  (the boats handed to `surface`), `Weapons.world.missiles`) and hands it to `Radar` and `TargetMarkers`. Enemy means
  `hostile(me, team, id)` = the weapons' `canHurt`, colours `teamCss`: no team comparisons of its own.
- Radar (bottom left, above the hull bar, while flying): heading-up on our jet's nose, rings at half and full range,
  N on the rim, islands baked once per world into a 640² mask (±9.6 km, land with coastlines and the reef shelf; 24
  rows per frame, skipping open sea), the world edge dashed. Enemy carriers are filled hulls in their colour (pinned
  to the rim as a triangle when out of range), ours an outline; jets arrows along their nose (filled enemies,
  outlined friends; a tick above or below past ±250 m), boats diamonds, missiles homing on us blinking red dots. Range
  2/5/10/20 km: auto covers the nearest enemy jet or boat, else the nearest enemy carrier (up at once, down after
  1.5 s), easing on the wall clock.
- Full map: physical G held (tap < 250 ms pins, a second tap or Esc closes), any role, not while a menu is open:
  north-up over the world edge (`PLANE.edge`) with a 2 km grid and scale bar, every carrier named, every jet and boat,
  our jet.
- Target markers (flying): corner brackets on enemy carriers in view, diamonds on enemy jets (within `markerJets`
  km) and boats (4 km), each with its distance; a chevron at the screen edge toward the nearest enemy carrier when it
  is out of view, kept clear of the radar's corner (`Radar.box`).
- Settings: `RADAR` (`RadarSettings`, `RADAR_DEFAULTS`, `RADAR_CONTROLS`) on the Lab panel in the debug menu's RADAR
  tab; read live. Real-GPU check: `scripts/radar-shot.ts` (fresh rooms: offline draws only our own carrier); captures
  in `captures/radar/`.

## Capture zones (`shared/objective.ts`, `server/core.ts`, `src/objective/**`)

- The game's objective. Zones are 650 m circles of open water (clear of islands, 1.4 km+ from every spawn); fewer
  than 4 active carriers (crewed, not sinking) → one zone, 4 → two, decided at each reveal. A zone stays put for
  5 minutes (`cycle` 300 s); 30 s before it moves the next spot shows as a dashed ghost ring and the HUD counts down
  (ZONE MOVING IN 20S). A round's first zone sits within 1 km of the middle (about 3 minutes' sail from every spawn);
  later ones hop 1.3-2.8 km.
- A carrier whose hull centre is inside a zone alone captures it in 10 s (someone else's drains to neutral first);
  two or more inside: contested, frozen. The holder scores 2 points/s per zone while inside alone, and must stay: a held zone left empty drains to neutral in 10 s. No clock: first to
  1,200 points wins the round; the result shows 15 s, then scores reset and a new round starts. Nothing in the
  objective touches ships, crew or aircraft: relocations, round ends and new rules never move or respawn anything.
- Authority: the room's `Objective` steps with the ships and sends `obj` (`packObjective`, a flat number array) at
  ~4 Hz while a zone is being taken or held, at once on a capture, reveal, relocation or round end, 1 Hz otherwise,
  and to joiners. Offline the client runs its own on the local ship. Dev rooms take `objective` (rules, clamped;
  the round restarts) from the debug menu's ZONES tab (rules + look, APPLY TO ROOM).
- Client: `Zones` (`src/objective/zones.ts`) draws `ZonePass` (a glowing boundary on the displaced sea with the
  capture arc and turning dash marks, a faint tint, a low light curtain on the boundary; no centre beam) and the
  top-centre `ObjectiveHud` (zone pips, scores in carrier colours with bars to the target, MOVE countdown, a capture
  meter, one event line, the WINS banner). `objectiveZones()` gives other HUD pieces (the radar) the zones.
- Real-GPU check: `scripts/zones-shot.ts` (dev room; captures in `captures/zones/`).

## Weapons (`shared/{weapons,combat}.ts`, `src/weapons/**`, `src/render/weapon-fx.ts`, `src/audio/weapon-audio.ts`)

- Loadouts are per aircraft (`LOADOUTS` in `shared/weapons.ts`), keyed by `VehicleKind`. The F/A-18E (`hornet`) has
  the M61 gun, 2 AIM-9s and 2 flare bursts. The F-35C strike bomber (`f35`) has no gun: 2 AIM-9s on the outboard
  wing stations, 4 bombs (2 in the bay, then 2 on the wing pylons) and 2 flare bursts. Selecting bombs opens its bay
  doors (0.6 s, `Weapons.doors`, relayed in the plane tuple); a bay bomb leaves once they are open, wing bombs at
  once; each release hides that station's bomb on the model and the bomb falls from it with the model's store mesh;
  switching away shuts the doors. Bombs are plain gravity bombs that burst on sea, land or ships and only hurt jets in the blast; ships
  and ground targets take no damage yet. Their burst (`WeaponFx.bombBlast`) is a tall white spout with a crown and a
  rolling base surge on the sea, a fireball, flung earth and a dust column on land or a deck. Guided bombs are planned. Weapon kinds are `"gun" | "missile" | "bomb"`;
  slot order is the 1/2/3 key order. Every sortie starts on the first slot (`rearm`): the F-35C launches on its
  missiles, never its bombs.
- Bombsight (F-35C). Selecting bombs turns the flight camera into a first-person view from just ahead of and under the
  nose, tipped down and zoomed (`FlightCam.setBombs`/`sighting`, fed by `Flight.bombsight`; 1.5 s after the catapult,
  never while landing or crashed); another weapon gives back chase or cockpit, and C toggles between the sight and
  that view while bombs are selected. `src/weapons/bombsight.ts` draws a CCIP sight: the bomb fall line from the
  flight-path marker to a pipper on the continuously computed impact point, solid in the cue colour when the bomb
  would hit an enemy carrier, damage one with a near miss or catch an enemy boat in the blast, with the fall time and
  slant range beside it, and a horizon and pitch bars in the sight view. The impact comes from the game's own bomb:
  `bombLaunch` (shared/combat.ts, also what `Weapons.tick` releases) then `bombImpact`, which flies `fall` at the
  world's step against the sea at each step's sea time, the islands and every carrier drifted along its course
  (`driftShip`); `tests/bombsight.test.ts` checks it against released bombs in a `CombatWorld`. Near a moving enemy the
  pipper is drawn in that enemy's frame (where it is now). Tunables: SIGHT tab of the debug menu (the shared Lab panel:
  `SIGHT_CAM` in `src/flight/camera.ts`, `SIGHT_STYLE` in `src/weapons/bombsight.ts`). GPU check:
  `scripts/bombsight-shot.ts` (captures in `captures/bombsight/`).
- Controls in flight (`src/weapons/input.ts`), as in Battlefield 3/4 (fire on Space + LMB, 1/2 select). Space or LMB
  under Pointer Lock fires the selected weapon; 1/2/3 select (only weapons the aircraft has); the mouse wheel or V
  cycles; F always drops flares (F launches and lands nothing). Space is no longer nose-up (`src/flight/input.ts`). R
  (physical KeyR) lands while the HUD offers "R LAND" (`FlightInput.land`). None of these keys is a movement key on
  QWERTY, AZERTY or Dvorak. Weapons stay hot while the scripted landing has the jet: it can
  be shot and locked, but cannot fire or flare.
- Tuning is in `WEAPONS`:
  - Gun: 50 rps, 1,050 m/s muzzle speed plus the jet's velocity, gravity, 0.32° dispersion hashed from (owner, round),
    a tracer every 3rd round, about 1.4 km range. 2 damage per round within a 6.5 m hit sphere. Overheats after 3.2 s
    of fire and cools to 0.3 before it fires again.
  - AIM-9: a tight 6° lock cone (the lock builds only while the target stays in it, bleeding off outside), 2.5 km range, locks in 1.4 s, then holds within the keep cone (×3, 18°). Rails rearm one missile every 10 s. Pure PN
    (N 3.4) at up to 35 g with a 0.12 s autopilot lag and a 42° gimbal: Battlefield-style, a locked missile out-turns
    any jet, so flares are the escape (a break turn alone does not beat it). 12 m proximity fuse at closest approach,
    74 damage at the centre to 42 at the edge. Firing without a lock is a dumbfire.
  - Flares: 3 pairs on a closed-form path with linear drag, reload 16 s each. They seduce a missile homing on their jet
    within 0.9 s of release if the missile is within 2 km and the flare is inside its gimbal. They also break and
    block locks for 1.6 s.
  - Health is 100. Below 50 the jet smokes, below 25 it burns. After 10 s without damage it repairs at 4 per second.
    A crash within 12 s of damage credits the attacker. Friendly fire is off (`canHurt`).
- Authority and wire (`shared/protocol.ts`, `server/core.ts`, `src/net.ts`, `src/flight/seam.ts`):
  - Rounds are shooter-authoritative. Each client flies its own rounds against jets as drawn and reports
    `hits` (`{ on, n }`) every 0.1 s. The room's `CombatWorld.gunHit` checks: alive enemies, the shooter has a gun,
    a round budget refilled at the gun's rate, and range between the relayed jets.
  - Missiles, bombs and flares are events (pose, velocity, target, sea time). The room runs the authoritative
    `CombatWorld` against the latest relayed jets, extrapolated (landing jets placed on the room's copy of their
    carrier), and sends `boom` (`BoomTuple`), `hp` and `kill`. Client `fire` (`FireTuple`) and `flare` (`FlareTuple`)
    are validated against the room's budgets and relayed to everyone else; clients run the same world without
    authority to draw them and snap to the room's `boom`.
  - Trigger state (`gun` on/off) lets others draw cosmetic rounds. Seeker state (`seek`) is relayed only to an enemy
    target (`seek { by, s: 0 off | 1 tracking | 2 locked }`) for its LOCK warning; MISSILE comes from its own world
    copy.
  - Jets enter the room's world on `launch` (full health) and leave it on recovery. A kill (`kill { on, by, w }`) makes
    the victim's client shoot the jet down: `CrashKind` "shot", the SHOT DOWN card, and the normal crash recovery
    (`recover("crashed")`, so the slot recharges 30 s). A relayed crashed jet (`mode` 2) that was still alive is a crash,
    credited to a recent attacker. The room counts kills and deaths per player and sends `stats` (`[id, kills,
    deaths][]`) after every kill and to joiners; the Tab menu's K/D column reads `net.stats`.
  - Effects: a shot-down jet breaks apart and its burning wreck falls (`Weapons.wreckPoses`, drawn by
    `Explosions.drawWreck` as what is left of it); the crash breakup is skipped for it (`recentlyKilled`), and the crash
    camera follows the wreck.
  - Offline (`?seed`, harnesses), the local world has the authority.
- `Weapons` (`src/weapons/weapons.ts`) is the controller, owned by `FlightModule` (`flight.weapons`). Calls:
  `setPilot`, `sortie(vehicle)`, `land()`, `crashed()`, `tick(plane, armed)` per fixed step while flying or landing, and per frame `beginJets()`, `jet(...)`, `setOwnModel(m)`, `frame(...)`.
  Room events go to `apply(event)`, `remoteLaunch`, `remoteFlare`, `remoteGun` and `lockedBy`. `onDestroyed`, `trauma`,
  `wreckPoses()` and `ownWreck` are for the host.
- `WeaponFx` draws in the alpha slot, from fixed pools with no per-frame allocation:
  - Sprites are soft capsules, additive glow or lit smoke, at least 1.3 px wide.
  - Rocks are flat-shaded instanced icosahedra and an AIM-9 mesh: fireballs, smoke balls, spray, debris, missiles on
    rails and in flight.
- Explosions (`src/render/explosions.ts` choreography, `explosion-fx.ts` GPU, `jet-chunks.ts` model cuts), owned by
  `FlightModule` (`flight.boom`), found by others with `explosionsFor(renderer)`. Pure presentation, deterministic from
  the event and a seed (`seedOf(id, sortie)`), so every client sees the same breakup with no extra messages:
  - `airKill` (via `Weapons.breakup`): a 1-2 frame flash, a faceted fireball whose facets cool to soot and roll into
    dark smoke drifting with the sea's wind for ~10 s, sparks, shards, and a seeded set of the jet's own pieces
    (canopy, wingtips, fins, stabilisers, sometimes a wing or the nose) flung off burning with smoke ribbons; the rest
    stays on the falling wreck until `wreckImpact`.
  - `crash` (own crash once per sortie, remote crashes once per first crashed pose): the whole jet in pieces. Sea: spray
    column, crown, droplets, rooster tail, foam ring drawn into the wake field (`ocean-wake.ts`), steam if burning, light
    pieces bobbing on the swell then sinking. Land or deck: fireball rising into a column, pieces that bounce and skid
    and keep burning (on a deck they ride the ship, in its frame), flung earth or deck debris, dust, sparks, a scorch.
  - `blast(seed, x, y, z, size, surface)` and `boatKill(seed, x, y, z, vx, vz, heading, size)` for anything else.
  - Fireballs throw a short light (an additive glow and a pool on the surface, strong at night); nearby bursts add
    camera trauma (`takeTrauma`, the seam shakes the chase and crash cameras; falloff `attenuateShake` from
    `@arcade/kit/client/camera`). Puffs are opaque alpha-to-coverage
    icospheres (no blended overdraw), pieces opaque, trail smoke one premultiplied ribbon, sparks additive; fixed pools.
- Dev harness (not built): `weapons.html` (`src/weapons/harness.ts`), offline with AI drones (`src/weapons/drones.ts`).
  Params: `?drone=N`, `?hostile`, `?flares`, `?air`, `?f35`. Real-GPU checks: `scripts/weapons-shot.ts`; captures go
  to `captures/weapons/`.

## Gunnery (`shared/gunnery.ts`, `src/gunnery/**`, `src/render/turret-*.ts`, `src/audio/turret-audio.ts`)

- Crewed from DEPLOY (`gun` ops above). The game's role `gunner` hands the camera to `Gunnery.update` (first
  person at the weapon's sight, `TURRET_GEOMETRY`, on the ship's live settled pose: heave, pitch, roll and the sink
  offset come through; up = the deck's up). The mouse (the game's Pointer Lock) moves a world-stabilised aim, clamped to
  the mount's `yawArc`/`pitchArc` as the ship turns (the view stops at a limit; the arc gauge's end and a soft screen-edge
  glow light up); the turret slews toward it at its own rates (`slewTurret`: CIWS 2.3/1.8 rad/s, SAM 1.2/1.0, gun
  0.65/0.5), the amber ring is where the barrel points. LMB/Space fires, RMB zooms (CIWS 30°, SAM 24°, gun 16°).
- CIWS: 75 rps, 1,100 m/s, ~1.6 km, 1.6 dmg/round on jets (5 m sphere), heat 2.6 s. Rounds passing within 3 m of a
  missile, bomb, SAM or shell shoot it down. SAM: 8 cells (each reloads 3 s, starting 2 s after a launch), seeker 9°
  cone / 5.8 km / 2.2 s lock, PN (N 4, 30 g from 380 m/s), 15 m fuse, 110→50 damage; a flare burst fools it by a fixed
  coin per missile and burst (35%). 5-inch: one round per 1.5 s, 800 m/s with drag (~8.4 km flat), 16 m proximity
  burst on jets (75→25), 35 hp on a carrier (a fire), near misses within 14 m 28→6 hp; HUD splash marker
  (`predictImpact`, the world's own steps). Friendly fire off everywhere; kills credit the gunner (`KillWeapon`
  `ciws`/`sam`/`shell` in kill feed and stats).
- Authority: CIWS rounds are shooter-authoritative (`TurretRounds`): the client reports `thits` (jets), `tshiphits`
  (enemy hulls) and `intercept` claims; the room's `GunneryWorld` checks a manned CIWS, the round budget, range from
  the mount and (intercepts) the claim within 22° of the reported aim and a fired trigger. SAMs and shells are events
  (`gfire`, `GunFireTuple`) the room validates (manned mount, budget, starts at the mount) and simulates; bursts go out
  as `gboom` (`GunBoomTuple`); damage lands in `CombatWorld.hurt` (jets) and `Fleet.hit` (`shipHitOf`). Gunners send
  `aim` (`AimTuple`, mrad) ~10 Hz; the room sends every manned turret as `turrets` (`TurretTuple`) every 100 ms and
  everyone draws them (`TurretPass`, slewing to the reports at their rates, unmanned ones easing back to rest) with
  cosmetic rounds, muzzle flashes, SAM smoke and trails, shell tracers and bursts (`Gunnery.frame`, its own WeaponFx).
  The hull buffer bakes only the pedestals (`turretMountVerts`).
- Dev harness (not built): `gunnery.html?gunner=ciws|ciws-stbd|sam|sam-port|gun` (offline, drones, an enemy carrier;
  keys 1-5 switch mounts). Real-GPU checks: `scripts/gunnery-shot.ts` (views, ciws, intercept, sam, gun, mp); captures
  in `captures/gunnery/`.

## Boat (`shared/boat.ts`, `src/boat/**`, `src/render/boat-*.ts`, `src/audio/boat-audio.ts`)

- The Mk VII fast interceptor (`art/boat.glb`, `art/boat-README.md`): DEPLOY → LAUNCH BOAT (`shared/ops.ts`
  `boat: true` vehicle op, cap 1 per ship, recharge 40 s). The driver holds the boat's slot like a pilot holds a jet's
  (`plane` = the slot, `playerBoat`, `slotIsBoat`), but only the room ends the sortie: picked up alongside its carrier
  (`recover(.., "landed")`, the slot frees at once) or sunk (`"crashed"`, 40 s). Either way `recover` puts the driver back
  in the role they launched from (`CrewPlayer.back`: the helm or their gun, if still free; else a pilot on deck). A
  client's `recover` for a boat is ignored. Tab shows drivers as BOAT; the ops menu opens read-only at sea (AT SEA).
- Sim (`boatStep`, fixed 60 Hz, deterministic): 110 kn (the carrier's 92 kn plus a margin), ~4 s to 90%, Shift boost
  (×1.2 speed for 3 s, 10 s recharge), astern, ~85 m circle at speed heeling into the turn, planing trim and lift, 10 buoyancy points with real gravity
  (airborne off storm crests: up to ~2 s and ~11 m in heavy seas, slams on landing; calm swells hop < 3 m), jets only
  push and steer while the stern is wet, island grounding and carrier-hull bounces (`carrierHalfBeam`), soft world edge.
  Remote boats float locally (`boatFloat`) on the plan pose.
- Crane (`CRANE`, `cranePose`): the port deck-edge elevator. Launch: sits, swings out, lowered 26 m, released at 2.95 s
  (`releaseBoat`: the carrier's velocity at that point). Recovery (`recoverable`): within 45 m of the crane point or 80 m
  astern of the stern, < 6 m/s relative, in the water, armed only after the boat has left the zone; glide in, hoist,
  swing in (`recoverTime`).
- Turret and rounds: 25 mm (`GUN`): 7 rps, 1,100 m/s, ~1.25 km, heat 6 s, yaw ±145° from the bow, -10..70°. The
  mouse aims in the world (`BoatCam`, the crosshair is the aim; the pip is the barrel). `BoatRounds` hits jets
  (spheres), boats (`boatSegmentHit`, hull boxes) and the world; friendly fire off.
- Health and damage: a boat is a fighter in the room's `CombatWorld` (`spawn(.., boat = true)`, `Fighter.boat`), so hp,
  repair, kill credit, the kill feed (`cannon` kill weapon) and stats are the jets'. `BOAT_ARMOR` scales every weapon's
  jet damage (gun 0.4, missile 0.85, bomb 1, CIWS 0.7, SAM 0.6, shell 1.2). Boats are `Target.surface`: jets' rounds,
  blasts, CIWS rounds and shells hit them (the client hands them to `Weapons.surface` and to the gunnery's jets);
  heat-seekers and SAM seekers never lock them. Its own 25 mm: 6 per round on a jet, 4.5 (armored) on a boat, 1.2 on a
  carrier through `damageShip(.., "gun")`.
- Authority and wire: the room runs every boat (`server/core.ts stepBoats`) on its driver's `boat` orders
  (`BoatCtlTuple`: throttle, steer, boost, turret yaw/pitch mrad, trigger; sent on change, ≥ 1 Hz) and sends every boat
  as `boats` (`BoatTuple`, 10 Hz). The driver predicts with the same sim and glides onto the room's pose; the room
  decides the release, pickup and sinking. Rounds are shooter-authoritative: `bhits { k: 0 jet | 1 boat | 2 carrier,
  on, n }`, checked against the room's `BoatBudget`, a boat alive and on the water, and the gun's reach.
- Client: `BoatModule` (`src/boat/seam.ts`, `game.setBoat`) starts on a new boat sortie; `BoatDriver` (`src/boat/boat.ts`:
  phases launch/drive/recover/sunk, HUD, camera), `RemoteBoats` (`src/boat/remote-boats.ts`), `BoatPass` (team accent,
  radar spin, turret aim, nozzles, nav lights through `Lights.addLights`), `BoatWake` (into the ocean wake field after
  the carriers' Wake), `BoatFx` (spray via `WeaponFx.spray`, rooster tail, slams, smoke, fire, explosion), `BoatAudio`
  (the sfx bank's `boat-engine` loop once loaded, procedural twin diesel + waterjet whine before; slams, 25 mm).
- Ship viewer: `ship.html?model=boat`. Dev harness (not built): `boat.html` (`?weather ?tod ?water ?targets ?drone`).
  Real-GPU checks: `scripts/boat-shot.ts` (launch, drive, storm, gun, night, recover, hero, mp, strafe); captures in
  `captures/boat/`.

## Ship damage (`shared/fleet.ts`, `server/core.ts`, `src/weapons/{ship-fx,ship-hud}.ts`)

- The room is authoritative. `RoomCore` holds one `Fleet`: a `Hull` per carrier, added on `new` and removed on `sink`.
  It steps with the ships and broadcasts every hull as `hulls` (`HullTuple[]`, `packHull`), at most every 100 ms when one
  changes, and to joiners. Clients keep `net.hulls`, unpacked at their sea time (`unpackHull`).
- Health is 1,000. Damage (`shipDamage`):
  - Gun: 0.25 per round, so a 160-round overheat run takes ~4%.
  - Missile: 50 (5%).
  - Direct bomb hit: 175 (17.5%), so an F-35C's four bombs take ~70%.
  - Bomb bursting in the water within 25 m of the waterline (`waterlineDistance`): 70 at the hull, falling to 15 at
    25 m.
  - Enemy jet crashing into the ship: 50.
  - Ramming (`"ram"`, see "Carrier collisions" below): 6 · (closing speed − 1.5 m/s)^1.5, at most 650; the hull that
    brought the speed takes up to 40% less. A 15 m/s T-bone: ~300 to the rammed side, ~180 to the rammer.
  - Friendly fire is off: `Fleet.hit` refuses the ship's own team (its own crew; every other carrier is an enemy).
- Zones (`hullZone`, ship-local):
  - ISLAND hits also wreck the bridge (`island` 0..1: bomb 0.4, missile 0.15, round 0.0015). `hullLimits`
    scales top speed (to 55%) and rudder (to 60%). The room's sim and the helm's prediction both apply it.
  - DECK hits by bombs, missiles or crashes start a 15 s deck fire (the HUD counts it down: "DECK FIRE 12S"). While the deck burns (or the ship sinks),
    `deckOpen` is false: launching is refused (`deck-fire`, `sinking`) and the "R LAND" prompt skips it.
  - Anything else is the HULL side.
- Fires: each bomb, missile or crash hit leaves a fire at its ship-local point (at most 8). A fire burns for 45 s,
  and all of them stay lit below 60% health.
- Repair: after 20 s without damage, 3 hp/s (a bomb hit back in ~1 min, near-sunk to full in ~5.5 min) and the bridge 1% per second, back to full (like jet repair).
- Settle (`settleOf`, `settled`): up to 3.2 m lower and 5° of list toward the side that took the hits, growing with
  damage. It's an offset on the pose that is drawn and hit-tested, never inside the buoyancy physics. `game.ts` settles
  every drawn hull and the room settles the poses its combat world hits, so health alone decides it everywhere.
- Hit detection:
  - Rounds are shooter-authoritative. `Bullets` reports the carrier it struck (`shipAt`, the settled hull box and
    island). The client batches `shiphits { ship, n }` for enemy ships. The room checks the shooter has a gun, is
    within 1.8 km of the ship, and spends the same round budget as jet hits (`CombatWorld.spendRounds`).
  - Missiles and bombs are room-simulated in `CombatWorld`. A strike emits `{ k: "ship", ship, owner, w, x, y, z,
    near }` with the ship-local entry point; a bomb that came down through the deck counts as on the deck. A bomb in
    the sea emits a near miss for every ship within 25 m.
  - Heat-seekers only lock jets, but a dumbfire (or any missile that strikes a hull) hits it.
  - A jet the room sees reported crashed inside or near a ship's box damages that ship, if it is another carrier's.
- Sinking: at 0 health `sinkAt` is set. The ship loses power, the helm is ignored, and the room sends `sunk { ship,
  name, team, by }`, which shows on the kill feed as "ADA SUNK CV-07 VALIANT" with a SUNK confirmation for the killer.
  It goes down by the bow over 25 s, 70 m deep. Then the room scuttles it (`shared/crew.ts scuttle`):
  - Its crew moves at once to a replacement of the same team (a new name, at the team's spawn, unlocked, the first
    aboard captains it); with nobody aboard the replacement comes out after `CREW.refitMs` (15 s).
  - Airborne pilots move with their jet: same sortie, a slot on the new ship (an extra one past the cap if needed,
    trimmed when free). The client keeps flying: `flightChange` only restarts on a new sortie.
- Landing only on your own carrier (`landTarget` offers only it; `recover` carries no ship). The plane tuple's landing
  `qw` (mode 3, 0 = own) is always 0 now.
- Client:
  - `ShipFx` draws the fires (taller and blacker as health falls), the deck fire, an island smoke column below half
    health, and the sinking (walking explosions, deck fires, spray), all in ship-local space.
  - `ShipHud` shows a thin HULL bar above the role line (DECK FIRE / SINKING beside it), a red screen-edge flash when
    your ship is hit, and in the air a small bar over the enemy carrier nearest the sights.
  - The Tab menu shows a hairline health bar per ship (`teams.hull`).
- Hooks for ship guns (gunnery), on `RoomCore`:
  - `damageShip(shipId, amount, at, by, kind = "shell")` damages a ship by an explicit amount from a world-space hit
    point. The zone, fires and list come from where the point lands. Friendly fire is refused by `by`'s team (their
    carrier). It
    broadcasts like any other hit.
  - `stores()` lists the room's missiles and bombs in flight (owner, seq, kind, position, velocity, team) for CIWS/SAM
    targeting.
  - `interceptStore(owner, seq)` destroys one: it bursts harmlessly for everyone (`CombatWorld.intercept`).
  - `hullPoseList` gives the settled ship poses with id and team, for gunnery's own hit tests.
  - `ShipHit.amount` / `ShipDamageKind` carry the shell type into `Fleet.hit`.
- Real-GPU check: `scripts/ships-shot.ts`. Three pages on three carriers: A's F-35C bombs B's carrier (direct hit, near
  miss), C's Hornet strafes it and fires dumbfires, A's bombs finish it, B moves to its replacement. Captures go to `captures/ships/damage/`.

## Carrier collisions (`shared/ship-collide.ts`, hook in `server/core.ts` `collideShips`, `src/game/game.ts`)

- Carriers don't pass through each other. The colliding shape is the flight deck's plan (330 × 76 m, notched bow
  corners; it overhangs the waterline hull boats bounce off), a convex polygon: separating-axis contact, at most two
  clipped points. Sequential impulses with equal masses, heavier sideways (×2) and in yaw (×1.5) for the water moving
  with the hull: closing speed cancelled, bounced by `SHIP.bounce` above 1 m/s (none below: resting contact), sliding
  resisted up to 0.3 of the normal impulse (a glancing blow slides and yaws), off-centre points yaw. The leftover overlap
  is pushed out 25% per step past 5 cm (≤ 0.5 m). Deterministic; no jitter resting under power; < 2 m overlap at top
  speed from any heading. Sinking hulls stay solid for their first 10 s.
- The room steps every ship one fixed tick at a time and resolves every pair after each (`ShipCollider.step`, id order).
  A bump faster than 0.8 m/s is broadcast (`bump { a, b, k }`, k 0..1 at 12 m/s); damage goes through `Fleet.hit`
  (`w: "ram"`, credited to the other ship's helm, else its captain; a ram of 20+ leaves a fire at the contact). Each
  pair then takes only the excess of a harder blow for 1.5 s, so grinding doesn't drain health.
- The helm's client resolves its predicted hull against the remotes it draws (`collideHulls(.., onlyA)`), so it stops
  where the room's does; `net.bumps` set `slam` on both hulls (chase shake) and one `slams` count (the `hull-slam`
  sound, ship-audio.ts) when k ≥ 0.05. The red hit flash comes from the hull's health as for any hit.
- Real-GPU check: `scripts/collide-shot.ts` (two helms, a 14 m/s T-bone and a pushing grind; `captures/collide/`).

## Sound (`src/audio/{mixer,mixer-lab,sfx-*,sounds-lab,jet-*,ship-audio,ui-audio,weapon-audio,weather-audio}.ts`, `public/sfx/`, `scripts/{sfx-cinematic,sfx-picks-plugin,audio-demo,audio-render}.ts`)

- **One mix** (`mixer()` in `src/audio/mixer.ts`), started on the first gesture: buses `engines` (other jets), `flyby`,
  `weather` (sea, weather, ship ambience) behind a canopy low-pass that closes in the cockpit; `own` (your engine and
  cockpit), `sfx`, `weapons`, `ui` (dry). Sends: `reverb` (a synthesized 3.4 s open-air ocean impulse), `echo` (a dark
  140 ms slapback off the water), `room` (a small metal cockpit). Then a gentle glue compressor, a -3 dB peak limiter,
  an output trim (loudness: the 60 s montage measures -16.1 LUFS integrated, -1.7 dBTP), master, soft clip. `duck()`
  dips engines, flybys and ambience under explosions and passes. `mixer.listener` (camera pose, set by jet-audio.ts each
  frame) lets anything place a sound in the world. Levels and mute persist (`carrier.audio.v4`); **M mutes**.
- **Live, state-driven sounds are procedural, by design** (user decision): everything that follows a jet's live state
  (engines, afterburner, cockpit engine, canopy wind, buffet, breathing, creaks, wind rush, flybys, the sonic crack, the
  stall warning) or the trigger (the M61, rounds cracking past) is synthesized every frame from rpm, throttle,
  afterburner, speed, g, stall, the gun's fire state and the listener's geometry, so it never drifts. Only discrete
  events are recorded.
- **The M61** (`gun-audio.ts`, driven by `weapon-audio.ts` `update(dt, firing, farGun, …)`): a loop of 24 synthesized
  rounds, each exactly 1 / `WEAPONS.gun.rate` long (a low thump, a saturated mid rip, a high crackle, the feed's
  metallic tick at mid-period, small per-round variation), gated on round boundaries the frame the fire state changes
  (trigger, weapon, overheat), with a low rumble under it, the barrels' spin-up and spin-down whine, and an airy tail on
  release. Outside: weapons bus, reverb and water slapback; in the cockpit: muffled through the airframe (own bus, cockpit
  room). The loudest other jet's gun (`farGun` → distance) plays the same train darker, wetter, and late by d / 343 s.
  Rounds passing within 14 m of the camera (`weapon-audio.ts` `zips(bullets, dt)`, from `weapons.ts`' cosmetic rounds)
  get a supersonic crack and a falling whiz at the closest-approach moment, panned to their side. Levels: a burst -14
  dBFS RMS (the recorded loop was -15), cockpit -17, another jet's gun at 600 m -34. The boat's 25 mm and the CIWS were
  already procedural (boat-audio.ts, turret-audio.ts).
- **One clear sound per moment** (user decision): a moment gets one sound, not layers. The launch is one continuous
  event (shared/launch.ts hooks): parked, a quiet steady idle; at `launchStart` the engine surges from idle to full over
  ~0.7 s with the afterburner lighting 0.3 s in, and one live catapult voice (`jet-catapult.ts`: a strong shove, then a
  steam-and-shuttle rush whose low-pass and level follow `launch.progress`) runs the stroke; at `launchEnd` the rush lets
  go over about a second; then engine and wind. Remote launches play the same voice at their
  jet (progress from the relayed catapult z), distance-attenuated. Your own jet keeps a steady perspective: no Doppler,
  a fixed from-behind cone, no air absorption, no flyby or crack. The landing is one trap take (no tailhook, gear-down or
  capture chime). Interface: one very quiet tick per button click, nothing on hover or when panels open. A kill is one
  confirm. The bank's voice budget enforces it: at most 6 recorded one-shots at once, a per-slot cooldown (150 ms by
  default, hull slams 2 s, creaks 6 s), and priority (explosions 5 > weapons 4 > deck events 3 > thunder 2 > ship
  accents and interface 1, horn and creaks 0): a higher one ducks lesser ones already playing, replaces the least
  important when the budget is full, and keeps accents from starting for half a second. Decorative levels are low by
  default (interface bus 0.45, deck bed 0.45, a rare quiet horn). `captures/audio/v6-*` and `v6-sounds.md` compare the
  launch and the landing before and after.
- **The sound bank** (`sfx-bank.ts`, `sfx()`): 40 slots (`sfx-slots.ts`: carrier, gun impacts, missile, bomb, boom,
  ship, sea, ui, hooks) with 3-4 ElevenLabs candidate takes each, 140 takes in `public/sfx/v3/<slot>-<n>.ogg` (48 kHz
  stereo Ogg Opus 96-112 kb/s, 8.4 MB; one-shots -16 LUFS, loops -20 LUFS, interface -26 LUFS, true peak ≤ -1
  dBTP; loops crossfade-looped; `manifest.json` has each take's length, loop length, loudest moment, loudness).
  Prompts in `sfx-slots.ts`, processing in `scripts/sfx-cinematic.ts`. After the first gesture the bank loads every
  slot's playing takes category by category (~90 takes, ~4.5 MB); `play`/`loop` return null until a slot has loaded and
  callers play their procedural placeholder. API for every module (gunnery and boat audio included):
  `sfx().play(slot, { at: worldXYZ | local | dist, gain, rate, delay, travel, reverb, echo, ref, rolloff, bus })` and
  `sfx().loop(slot, …)` → `{ set({ gain, rate, at, tc }), stop(fade) }`. Pooled one-shots (explosions, impacts, thunder,
  hull slams, flares) play a random 4-5★ take (else any not rated down).
- **Picks**: `public/sfx/picks.json` (shipped defaults: take, trim dB, ratings per slot), overridden live by the SOUNDS
  tab in localStorage (`carrier.sfx.picks`). The dev server's `POST /__sfx/picks` (`scripts/sfx-picks-plugin.ts`)
  writes picks.json; the SOUNDS tab's SAVE does that, COPY PICKS exports the JSON anywhere.
- **SOUNDS tab** (`sounds-lab.ts`, ` menu, `?sounds=1` opens it): every slot, its takes (▶ dry or in context at 40 m,
  300 m, 1.5 km with the reverb, from the chase view or behind the canopy; ★ pick, live; level trim; 1-5 rating),
  category filter, COPY / SAVE / RESET. The AUDIO tab keeps the bus levels, engine/cockpit tuning, a recorded on/off
  switch and test buttons.
- **Procedural jets**: the engine (`jet-engine.ts`, Wings-style): a soft triangle whine with a ×2.76 overtone (front of
  the cone), pink roar behind a throttle-opened low-pass (rear; your own Hornet's two engines decorrelated left/right),
  brown body and a deep sub, an afterburner rumble that breathes plus a soft crackle and sub; spool inertia
  (`jet-math.ts`); distance gain, air absorption, a reverb send that grows with distance and a close water slapback;
  the F-35 one deeper engine. The afterburner lighting in flight adds a soft whump (`jet-sfx.ts`). The cockpit (`jet-cockpit.ts`):
  the engine through the airframe and the cockpit room, canopy wind by dynamic pressure, buffet, breathing under g,
  creaks, the stall warble, plus recorded `rain-canopy` when it rains. Flybys (`jet-sfx.ts`): an air rush, a low
  thunder body and (fast/burner) a bright tear, peaking on the closest approach predicted each frame (`jet-math.ts`)
  and panned with the jet, on top of the engine's own Doppler; head-on merges above 300 m/s get a procedural N-wave
  crack. Levels (offline, 0.5 s RMS): your Hornet in chase idle -38, military -33, afterburner -28 dBFS against a gun
  burst at -15 and medium weather at -21; a close pass peaks at -20, a distant one at -27.
- **Where each recorded slot plays**: carrier ops (the trap). Weapons (`weapon-audio.ts`): missile launch, flares, bomb release (+ whistle),
  impacts (metal when we are hit); cockpit tones synthesized (sine seeker growl and
  lock, two-tone warning chimes) on the UI bus. Explosions (`jet-boom.ts`, `boomsFor().play(kind, dist, size)`): the
  scenario's take crossfading into `boom-far` from 400 m to 2.2 km, travel delay, heavy reverb and slapback, a water
  geyser for bombs in the sea. Sea and weather (`weather-audio.ts`): ocean beds by sea state (fading with altitude),
  wind light/gale, rain light/heavy, thunder near/far with the lightning crack. Ships (`ship-audio.ts`, fed by
  `seam.ts` `audio.ships(...)`): the deck bed near a hull, hull slams (`Ship.slams`), creaks in heavy seas, a rare horn.
  Interface (`ui-audio.ts`): a very quiet tick per button click; the kill confirm (`weapon-audio.ts`). Registered but wired by their owners: `deck-fire`, `sinking`, `missile-motor`, `impact-water`,
  `ciws`, `sam-launch`, `naval-gun`, `boat-engine`.
- Offline renders: `scripts/audio-render.ts` (instructions at its top) renders the `scripts/audio-demo.ts` scenes (the
  60 s montage, engines, flybys, carrier ops, gun, weather, a mix, the explosion reel) on hailmary into
  `captures/audio/v5-gun-*` (the M61), `v4-*` (engines and flybys) and `v3-*` (recorded slots); `captures/audio/v3-candidates-<category>.mp3` are every take back to back (index in
  `v3-candidates.md`). `public/sfx/boom/{far-1,bomb-water-2}.mp3` stay only for `scripts/video-epic.ts`.
