# Realistic people (`@arcade/kit/people`)

Skinned MakeHuman people any game can draw in place of the blocky rig figures, driven by the same shared human rig,
so foot placement, stepping over logs, torch aiming and every game's `animate` call keep working. Woods is the first
user (behind `?people=real`); every game still draws blocky people by default.

Feasibility proof, Oct 22: https://studio.taila8e7c7.ts.net:8444/raw/people-2026-10-21/index.html

## Pipeline

```
scripts/people/cast.json ──► build-people.ts ──► headless Blender + MPFB 2.0.18 (build-person.py) ──► gltf-transform
  (people, outfits,           (downloads MPFB and       body, proxy, clothes, hair, eyes,          prune, dedup, meshopt,
   tints, macros)              the CC0 asset pack        game_engine skeleton, procedural          extras.people per material
                               into ~/Library/Caches/    beanie, LOD1 by decimation, WebP
                               arcade-people)            textures ≤ 1024
                                                                  │
                                                                  ▼
                                              packages/kit/people/assets/<id>.glb  (+ CREDITS.md)
```

Build one or all on a render worker (≈30 s per person on mini; Blender and the asset pack are cached):

```
hivemind run --kind render --fetch packages/kit/people/assets -- bun scripts/people/build-people.ts [id ...]
```

- Clothes are split into pieces (`jacket`, `shirt`, `trousers`, `boots`) by colour regions of their UV texture.
  Each piece's texture is stored as AO-baked luminance averaging `MEAN = 0.72`, so `baseColorFactor = albedo / MEAN`
  and the runtime retints a piece with `PersonInstance.tint(piece, albedo)` (linear albedo). One body and outfit can
  therefore dress a whole cast, and Outbreak survivors or office workers swap outfits in `cast.json`.
- Materials are named `kind.piece` (`nylon.jacket`, `cloth.trousers`, `knit.beanie`, `skin`, `hair`, `brow`, `eye`);
  `extras.people` carries `kind`, `piece`, `albedo` and `mean`.
- Blender exports a file-backed image's source file, not its scaled pixels, so `load()` copies a downscaled image
  into a new packed image. Without this the 4096² MakeHuman normal maps shipped at full size (1.46 MB → 804 KB).

## Runtime

| Module | Owns |
| --- | --- |
| `view.ts` | `People`: lazy `load(cast)` (fetch + meshopt decode), `spawn`, `drive(person, avatar, opts)`, LOD by eye distance, `PEOPLE_CAST`. |
| `asset.ts` | GLB reader: skeleton, LOD ranges, materials. Bakes vertices into the joint-world bind pose (MPFB IBMs carry the armature's 0.1 scale), so runtime IBMs are rigid. |
| `retarget.ts` | Rig frame → game_engine bone rotations: spine/neck/head from the rig's torso and look, two-bone IK on the mesh's own bone lengths for legs and arms, ankle target putting the mesh ball on the rig ball (blended to the heel pivot at heel strike), pelvis sink when a leg cannot reach, fingers (relaxed, torch grip) and a wrist bend so the torch barrel follows the beam. Breathing on the chest. |
| `terrain.ts` | `terrainFeet`: planted feet take the ground under the ball and pitch so the heel rests on it; swing feet arc over anything on the swing path; hips drop on a spring. Ground is a `(x, z) => y` the game provides (woods adds its logs). |
| `pass.ts` | `PeoplePass`: one compute dispatch per visible person writes world-space skinned triangles in the kit's 32-byte textured vertex layout; the stock textured scene pipeline draws them as `MAT.actor`, so people get the game's own lights, beams, fog, shadows and the actor fill and rim. `shadowCasters()` for spot shadows. |
| `hooks.ts` | `personHooks(gameHooks)`: per-kind roughness for physical-light games, a fibre sheen from the scene's ambient at grazing angles, and a torch beam that does not light its holder behind the lens (otherwise the spill burns the sleeve and chest). |

A game keeps its avatars: animate them in rig space (`world / people.scale(cast)`), then call
`people.drive(person, avatar, { dt, time, ground, torch: { side, dir }, look, eye })`. It returns the torch frame (world)
for the beam and the torch mesh. Woods' adapter is `games/woods/src/people-view.ts` (≈80 lines) plus a
`FriendsView.people: "blocky" | "real"` switch that draws blocky friends while the GLB loads.

## Measured (hiker-a, Oct 22)

| | |
| --- | --- |
| Asset | 804 KB GLB (meshopt + WebP); LOD0 28,550 tris, LOD1 7,334 (beyond 9 m); 53 joints; 1.741 m |
| GPU | ≈32 B × 3 × tris of skinned output per visible LOD (LOD0 2.7 MB); one compute dispatch per person |
| CPU | 0.028 ms per person-frame (terrain, retarget, IK, skin matrices; `bun scripts/people/measure.ts`) |
| Planted ball slip, flat walk 1.4 m/s | 0 mm (mean, p95, max over 6 s) |
| Rolling ground + 30 cm log at 1.2 m/s | worst sink 28 mm, worst planted float 52 mm, swing clearance over the log −28 mm (sole estimated as ankle − 6 cm, so these over-report) |
| Torch barrel vs beam | 0° worst over a 1.4 m/s walk |
| Gait | unchanged: the rig drives it (`gait-metrics.ts --tag after` matches main) |

## Known gaps

- One cast member. The full cast (4–6 varied adults) is `cast.json` entries plus outfit tints; the build already
  takes macros (gender, age, weight, muscle, height, proportions), skins, hair and eyebrows per person.
- No weight-shift idle yet (breathing only); no backpack or headlamp asset; boots are MakeHuman shoes, tinted.
- The planted foot can float a few cm when its heel and ball straddle a log edge; `terrain.ts` takes the ball's
  ground and only tilts by the heel's.
- People do not yet cast torch shadows in woods (`PeoplePass.shadowCasters()` exists; the forest's caster list does
  not take it).
- No mocap layer; 100STYLE (CC BY 4.0) is only the pose-diff reference.

## Licences

All shipped assets are CC0: MakeHuman/MPFB 2 bodies, clothes, hair, skins, eyes and eyebrows from
`makehuman_system_assets_cc0`; the beanie and its knit texture are procedural. See
`packages/kit/people/assets/CREDITS.md`. No Mixamo, no Bandai Namco data, nothing with ML or redistribution limits.
