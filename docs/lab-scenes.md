# Focused labs

Status: board feature AR-25, decision D-16 (Kit chose Home and Labs), being built in slices. Shipped: Home, opening a
lab, the top-bar path and its keys ([lab.md](lab.md#home-and-labs)). Still to come: each lab showing only its kind's
panels (no Library drawer, World footer or station list), the rest of the keyboard model, and making, keeping,
archiving and deleting labs from Home.

A **lab** is one focused workspace about one subject: an explosion, a tree, rain, the walk cycle, a HUD, a car. Its
**kind** decides which shared patterns it shows (knobs controls, choices, an add-picker, the variant strip, compare,
readouts, measured numbers, views, notes and voice, a timeline) and nothing else, so there is no global asset browser.
A kind's **choices** are its own short pickers: the subject's preset (Storm, Noir) and the backdrop it is shown against.
Only kinds whose subject needs company have an add-picker (the Vehicle kind adds course obstacles and lights). Labs live
in **collections**, one per feature, area or review, and are Draft, Kept or Archived. Stations become kept labs, tours
become review collections, and the three variant systems (station variants, knobs saved variants, A/B and grid) become
lab variants.

In code a lab is a `LabScene`, because "lab" already names the whole app.

## The spike

| File | What it holds |
| --- | --- |
| `packages/kit/lab/scenes/model.ts` | `LabScene`, `SceneCollection`, `checkScene`/`checkCollection` (whole-object validation, every problem listed, nothing partial), ids, `sceneJson` (repo-file format), share links (`#lab=` base64url, read back as a draft) |
| `packages/kit/lab/scenes/kinds.ts` | `LabKind` (subject, host, patterns, choices, add-picker, actions, play verb), `ACTION_KEYS` (the letters a kind may give its actions), `checkKinds`, and `checkAgainstKind`, which rejects choices, parts and extras the lab's kind doesn't have |
| `packages/kit/lab/scenes/store.ts` | `createSceneStore`: repo labs merged with this browser's labs and edits, the lifecycle (create, duplicate, keep, archive, restore, delete, revert an edited repo lab, move), collections (create, archive with their labs) and the sweep (drafts untouched for 7 days are archived; local archived labs are deleted 30 days later). Storage is a port with memory and `localStorage` adapters. |
| `packages/kit/lab/scenes/migrate.ts` | `liftCommands` (setup commands → choices, values and leftover commands, only when their order allows), `choiceCommands` and `openCommands` (the inverse, what opening a lab will run), and migrations from station files, `LabPresetSchema` v1 exports and tour steps |
| `games/lab/src/scenes/kinds.ts` | The 24 kinds: one per Lab section and one per page station |
| `games/lab/src/scenes/examples/feel-arena.ts` | The Feel lab worked example: survivor and three dummies, six featured knobs, Feel on/off, Punchy and Reduced motion; impacts are the Feel kind's actions (`S` shot, `V` shove, `T` hit taken, `X` kill, `B` explosion) |
| `games/lab/src/scenes/from-stations.ts` | The area collection for each station, and `migrateStations` |
| `games/lab/scripts/stations-to-scenes.ts` | Writes the would-be `games/lab/scenes/**` files and migration notes to `captures/scenes-preview` |

The 21 station files migrate to 22 kept labs in 6 collections, and each one passes its kind's check. Two Explosions
variants switched to the Splatter section, so they became a Splatter lab (a variant can't change what a lab runs);
Outbreak's "Fog of War" variant only opened a grid, so it became the lab's grid; Vegetation's setup stays as commands
because `foliage.preset` sets plants, lighting and look in one call. `games/lab/tests/scenes.test.ts` checks that
opening each migrated lab, and each of its variants, runs the same commands the station ran.

## Migration phases

1. **Model, kinds and storage**: this spike.
2. **Focused labs on today's sections**: a lab opens by selecting its kind's section and running `openCommands`, then
   restoring extras, camera and seeds, and the shell draws only the kind's patterns. The panes are `knobs/ui` `split`s
   and the labs list (collections → labs, drag to move between collections) is a `tree`, on top of the lab-panels move
   of today's columns and Outliner onto them. Station files are generated into
   `games/lab/scenes/`; the Library drawer, station list, World footer and Game picker give way to the chosen layout;
   the keyboard model in the design lands.
3. **Backdrop choices**: kinds declare backdrop choices backed by real commands (street, light, walker), and a backdrop
   can link to another lab.
4. **More kinds**: Tree, Bush and Grass split from Vegetation; Rug once its generator is in the Lab.
