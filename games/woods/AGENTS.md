# Woods

- Unlisted co-op toy at `/arcade/woods/` (Phase 1: solo with bots). Keep `noindex`, no landing panel. Kit: "in the woods… we're exploring something together." Concepts 1 (flashlights on a forest trail), 2 (fog survey with compass, map and flagging tape) and 4 (summer camp '87, the spawn and base) are one game.
- Kit decides keep, pivot or kill on the toy before Phase 2 (a real room on `@arcade/kit/server`, modelled on Outbreak's co-op, 2–6 players with shared tapes and markers). Don't build Phase 2 without his OK.

## Layout

- `shared/world.ts`: the forest as plain data from `WorldParams` (seed, half size, trunk density, marker count). Terrain height (`terrainHeight`/`groundHeight`, `standHeight` adds the dock), lake, camp buildings and place lights, the old path, trees, rocks, survey markers, the ridge mast light, a tree grid for reach and collisions (`treesNear`, `solidsNear`). No trig or `Math.random` in generation, so a server builds the same world.
- `shared/sim.ts`: `WoodsState` (players, bot brains, tapes, found markers, map knowledge per player) and `stepWoods(state, world, inputs, dt, feel)`. `FEEL` and `FEEL_CONTROLS` are every feel constant, bound to the LabPanel (Backquote). People send their position in `PlayerInput.pos` (the shared walking camera moves them); bots and a future server use `movePlayer` (the same `stepBody`, radius and accel).
- `src/world-view.ts`: the only module that turns world data into pictures (greybox cylinders, cones and boxes today). See "Swapping the look" below.
- `src/friends-view.ts`: friends on the shared human rig, torch in hand; returns their beams.
- `src/map.ts`: the paper map and compass (DOM canvases, CSS 3D raise), printed from the shared terrain function; pencil layer from `MapKnowledge`. Lit by your flashlight or camp light.
- `src/shaders.ts`: stock physical lights + shared fog medium, plus two tags (sky dome, tape). `src/audio.ts`: library placeholders + shared quiet footsteps.
- `scripts/capture.ts` (stills at scripted poses: camp, hall, beam, signal, ridge, marker, trail, map; `--set key=value` overrides settings) and `scripts/clip.ts` (tie + map clip). Both headless and muted; run through `hivemind run --kind browser` after a build, output in `captures/woods`.

## Swapping the look

A real forest renderer replaces `src/world-view.ts` internals and keeps its entry points; the sim never changes.

- `WorldView.setWorld(world)`: upload static content. Called again when the world regenerates (trunk density knob).
- `WorldView.draw(fp, world, state, t, eye, feel)`: per-frame content (tapes from `state.tapes`, the ridge beacon, the sky dome).
- `WorldView.lights(world, t, feel)`: the place's `SceneLight`s and `FogLamp`s (mess hall windows, string lights, porches, ridge beacon).
- `WorldView.occluders(world)`: trunk/rock/building footprints for polar shadows.
- `shared/forest-world.ts` `toForestWorld(world, tapes)` / `forestFlags(world, tapes)`: the same data in the look agent's `ForestWorld` shape (branch `woods-look`, `@arcade/kit/sim/forest-world`). Its types are a structural mirror until that file merges; then import them. Swapping to `createForestView` means feeding it `toForestWorld(world)`, flags from `forestFlags` each frame, and torches from the beams `main.ts` already builds.
- Data to read: `world.trees` (`id, x, z, y, species: pine|fir|birch|snag, radius, height, seed`), `world.rocks` (`x, z, y, w, d, h, yaw, seed`), `world.buildings` (`kind, rect, y, h, windows`), `world.lamps`, `world.lake` (`x, z, rx, rz, depth, level`), `world.trail.points`, `world.markers`, `world.ridgeLight`, `world.camp`, and `terrainHeight(world.terrain, x, z)` as the one ground height. Tapes are `{ id, tree, x, y, z, yaw, by, at }` (yaw = plan angle of the knot from the trunk centre, `atan2(dz, dx)`).
