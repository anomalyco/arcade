# Afterhours: world build brief (shared by every agent)

We are building a walkable, near-photoreal night environment in the browser: a secret federal research facility in
the pine forest outside a small town, 1984. It has to look like the approved concept art, run fast in the browser
on WebGPU, and be walkable in first person.

## Target look (study these images first; they are the spec)

`games/afterhours/concept/` — the approved set. It is local-only: the folder is gitignored and not in the repository,
so ask the owner for a copy if it is missing.

- `r3-01-lab-exterior.png`, `r5-01-corridor-junction.png` (actually another exterior): parking lot, low concrete
  building, big radio dish on the roof, chain-link fence with barbed wire, sodium lamp, station wagon.
- `r5-03-lab-fence-road.png`: the access road through the pines, utility poles and wires, guard booth glowing orange,
  dish silhouetted in fog.
- `r3-05-small-town-main-street.png`, `r5-04-main-street-reverse.png`: wet asphalt, sodium streetlights, fog.
- `r3-02-lab-corridor-pov.png`, `r5-05-corridor-lab-room.png`, `r5-02-lab-lobby.png`, `r5-06-lab-loading-dock.png`.

The look: dense teal-green night fog, near-black but readable shadows, warm sodium-orange practical lights as the
only warm colour, glowing halos and light cones in the fog, wet reflective asphalt with streaked reflections, pine
silhouettes fading into fog, real 35 mm film grain, restraint and emptiness. Interior: pale green tile, waxed
linoleum reflecting fluorescent tubes, steel doors with wire-glass windows.

## Non-negotiables (user feedback)

- **Realism above all.** Anything that reads low-poly, boxy or procedural-toy (flat-sided cars, box trucks, cube
  furniture) is a failure. Prefer real CC0 scanned/modelled assets (`src/render/models.ts` loader, `public/models/`)
  over procedural boxes for hero props; when procedural, use bevels, curvature, real proportions and detail.
- **Fast boot.** The page must show a real frame within ~2–3 s and finish streaming in the rest. Heavy generation off
  the main thread or cached; no blocking work at startup that isn't needed for the first view.
- **The machine is shared.** Keep headless captures few and short; don't run many browsers at once.

## Tech

- three.js **r186** `WebGPURenderer` with TSL node materials. Import from `three/webgpu`, `three/tsl` and
  `three/addons/...`. Use node materials (`MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`); never
  `ShaderMaterial` / `onBeforeCompile`. `@types/three` is 0.185, so a few r186 APIs may need a narrow cast.
  r186 example sources are on GitHub (`https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/<name>.html`,
  e.g. `webgpu_postprocessing_ssr.html`, `webgpu_lights_clustered.html`, `webgpu_volume_lighting.html`) if you need
  reference usage; addon sources are in `node_modules/three/examples/jsm/`.
- Units are metres, Y up, +Z south. **`src/world/layout.ts` is the single source of truth for positions** (read-only
  for you; if you need a change there, say so in your report instead of editing it). `src/world/height.ts`
  `heightAt(x, z)` gives terrain height (owned by the terrain agent).
- `src/world/context.ts`: each world module exports `build(ctx)` and may return `{ update(dt, time, camera) }`.
  Register solids in `ctx.colliders` (AABBs), walkable slabs in `ctx.floors`, light fixtures in `ctx.lamps`
  (describe them; `render/lighting.ts` turns them into real lights, shadows, glows and fog in-scattering — you still
  build the visible fixture geometry). Tunables go in `ctx.settings` + `ctx.controls` (the shared Lab panel,
  Backquote) with labels, units, ranges, steps; never query parameters (those are for automation only).
- Materials come from `material(name)` in `src/render/materials.ts`. Give geometry **UVs in metres** (1 UV = 1 m) so
  materials tile at real scale. Don't edit materials.ts unless you own it; if you need a special one-off material,
  make it locally in your own file.
- Performance matters: instancing (`InstancedMesh`), merged static geometry (`mergeGeometries` from
  `three/addons/utils/BufferGeometryUtils.js`), no per-frame allocation, `castShadow` only where it matters, LODs
  for distant repeated objects. Target 60 fps at ~1536×1024 on an Apple M-series laptop for the whole scene.

## Running and verifying

- A dev server is already running on :5196 (`bun run dev` in `games/afterhours`); don't kill it.
- `bun scripts/shot.ts <views...> [--tag t] [--q "only=terrain,forest&flashlight=1"] [--frames 90]` captures named
  viewpoints headless on Metal into `games/afterhours/captures/` and prints frame/GPU ms and page errors. Views are in
  `VIEWPOINTS` in layout.ts: road, gate, lot, entrance, lobby, corridor, dock, county, forest. Use `--tag` with your
  area name so you don't overwrite other agents' captures. Use `only=` to isolate your module (plus `terrain`).
  **Look at your captures** (read the PNG) and compare against the concept images; iterate until it is genuinely
  convincing, not just present.
- Other agents are editing other files at the same time; the page may briefly break because of their work. Each
  module loads independently, so retry or isolate with `only=`. Make sure *your* files typecheck:
  `bun run typecheck 2>&1 | grep <your files>` must be empty.
- Never open visible browser windows, never play audio. Do not commit; do not touch files you don't own.

## Report

End with: what you built (files), screenshots you checked (paths), measured cost (frame/GPU ms with `only=`), known
gaps, and any layout.ts change requests.
