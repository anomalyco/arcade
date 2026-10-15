# Lab scenes (proposal)

Status: proposal and data-model spike for board feature AR-25, decision D-16. Nothing here is wired into the Lab yet;
[lab.md](lab.md) and [lab-workbench.md](lab-workbench.md) still describe what ships.

A **scene** is what you are looking at, saved: a Stage (environment, lighting, look, weather), the Things placed on it
(effects, characters, props, lights), Views to look from and Variants to compare. Scenes live in **collections**, one
per feature, area or review, and are Draft, Kept or Archived. Stations become kept scenes, tours become review
collections, and the three variant systems (station variants, knobs saved variants, A/B and grid) become scene
variants.

## The spike

| File | What it holds |
| --- | --- |
| `packages/kit/lab/scenes/model.ts` | `LabScene`, `SceneCollection`, `checkScene`/`checkCollection` (whole-object validation, every problem listed, nothing partial), ids, `sceneJson` (repo-file format), share links (`#scene=` base64url, read back as a draft) |
| `packages/kit/lab/scenes/store.ts` | `createSceneStore`: repo scenes merged with this browser's scenes and edits, the lifecycle (create, duplicate, keep, archive, restore, delete, revert an edited repo scene, move), collections (create, archive with their scenes) and the sweep (drafts untouched for 7 days are archived; local archived scenes are deleted 30 days later). Storage is a port with memory and `localStorage` adapters. |
| `packages/kit/lab/scenes/migrate.ts` | `liftCommands` (setup commands → stage choices, values and leftover commands, only when their order allows), `stageCommands` and `openCommands` (the inverse, what opening a scene will run), and migrations from station files, `LabPresetSchema` v1 exports and tour steps |
| `games/lab/src/scenes/from-stations.ts` | The area collection for each station, and `migrateStations` |
| `games/lab/scripts/stations-to-scenes.ts` | Writes the would-be `games/lab/scenes/**` files and migration notes to `captures/scenes-preview` |

The 17 station files migrate to 18 kept scenes in 6 collections. Two Explosions variants switched to the Splatter
section, so they became their own scene (a variant can't change what a scene runs); Outbreak's "Fog of War" variant only
opened a grid, so it became the scene's grid; Vegetation's setup stays as commands because `foliage.preset` sets plants,
lighting and look in one call. `games/lab/tests/scenes.test.ts` checks that opening each migrated scene, and each of its variants,
runs the same commands the station ran.

## Migration phases

1. **Model and storage**: this spike.
2. **Scenes on today's sections**: a scene opens by selecting its host section and running `openCommands`, then
   restoring placements, lighting, camera and seeds. Station files are generated into `games/lab/scenes/`; the station
   list, World footer and Game picker give way to the chosen scenes UI; the keyboard model in the design lands.
3. **Stage slots**: sections declare the stage slots and Things they provide. The shared Playground becomes the first
   stage several sections draw into.
4. **Things from any section**: effects, foliage and splatter mount into the current stage. Sections that can't share a
   stage (the Materials swatch room, page demos) stay single-host scenes.

Until phase 3 a scene runs one section, so merging scenes from different sections only carries Spawn's props,
characters and lights across.
