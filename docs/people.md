# Realistic people (`@arcade/kit/people`)

Skinned MakeHuman people any game can draw in place of the blocky rig figures, driven by the same shared human rig,
so foot placement, stepping over logs, torch aiming and every game's `animate` call keep working. Barbara is the first
user: realistic friends are its default, with the blocky ones one setting away (Lab › Friends › Realistic people, or
`?people=blocky`); every other game still draws blocky people by default.

Proof: feasibility https://studio.taila8e7c7.ts.net:8444/raw/people-2026-10-21/index.html, cast
https://studio.taila8e7c7.ts.net:8444/raw/people-cast-2026-10-22/index.html

## The cast

Six adults (`scripts/people/cast.json`): a (thirties man), b (late-twenties woman), c (fifties man, heavy), d
(forties woman), e (tall, slim man), f (sixties woman, short). Each has three looks on the same body, one GLB per
person-look (`<person>-<look>.glb`, 720–970 KB):

| Look | Outfit | Gear |
| --- | --- | --- |
| `woods` | hooded rain shell (a, b), puffer vest over flannel (c), fleece (d), hoodie (e), puffer jacket (f); trail trousers; boots | beanies, headlamps (b, d, e), backpacks (b, c, e) |
| `survivor` | tee, jeans, trainers | backpacks (a, c, d, f) |
| `office` | suit, shirt and tie (a, c, e) or blouse and skirt (b, d, f); dress shoes | — |

Each look has a generated manifest, `@arcade/kit/people/cast/<look>.gen.ts` (`CAST: CastMember[]`), so a game's bundle
carries only the looks it imports. Vite emits each GLB as a lazily fetched asset.

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

Build one or all on a render worker (≈15–20 s per person-look; Blender and the asset pack are cached). Filters are
people, looks or person-looks (`c`, `woods`, `c-woods`); `--manifest` only rewrites the manifests:

```
hivemind run --kind render --fetch packages/kit/people -- bun scripts/people/build-people.ts [a | woods | a-woods ...]
blender -b --factory-startup --python scripts/people/lineup.py -- out.png <glb> ...   # front, side and back lineup stills
```

- Clothes are split into pieces (`jacket`, `shirt`, `trousers`, `boots`) by colour regions of their UV texture.
  Each piece's texture is stored as AO-baked luminance averaging `MEAN = 0.72`, so `baseColorFactor = albedo / MEAN`
  and the runtime retints a piece with `PersonInstance.tint(piece, albedo)` (linear albedo). One body and outfit can
  therefore dress a whole cast, and Outbreak survivors or office workers swap outfits in `cast.json`.
- Materials are named `kind.piece` (`nylon.jacket`, `cloth.trousers`, `knit.beanie`, `skin`, `hair`, `brow`, `eye`);
  `extras.people` carries `kind`, `piece`, `albedo` and `mean`.
- Gear is procedural: the backpack (a daypack about 44 × 27 × 18 cm: its back panel is sampled from the wearer's
  back and flattened a little across, so it rests on the shoulder blades and lower back 1 cm off the clothes; tapered,
  fuller at the bottom, rounded walls, mesh side pockets, a zipped lid and front pocket, compression straps; each
  vertex takes the averaged weights of the body under it, so it bends with the back) and its shoulder straps (ribbons traced
  over the clothes' outer surface, skinned by copying the nearest body vertex's weights), the headlamp band (traced
  round the head, beanie and hair at brow height) with its housing and lens on `head`, and the knit beanie. Ripstop
  and webbing are generated luminance textures; the housing and lens are untextured (`plastic`, `lens` kinds).
- Outfits are made from the few CC0 garments by cutting and re-texturing (`cast.json` part options): `drop` removes a
  piece (cargo pockets, the vest's sleeves) and `fillHoles` closes the openings it leaves on the front; `patterns`
  draws `quilt` baffles (luminance and relief), a `plaid` check, `seams` and `marks` (a hoodie pocket) in UV space;
  `inflate` lofts a puffer; `normalStrength` softens the source wrinkles. An outfit's `hood` is a procedural hood lying
  down, traced over the shoulders (short under a pack) in its garment's cloth and tint. Shells and puffers use the
  `cloth` kind, so nothing is glossy. Hair above a beanie's rim is cut whatever its volume, and drawn in to the rim
  below it. `lineup.py` renders front, side and back.
- Blender exports a file-backed image's source file, not its scaled pixels, so `load()` copies a downscaled image
  into a new packed image. Without this the 4096² MakeHuman normal maps shipped at full size (1.46 MB → 804 KB).

## Runtime

| Module | Owns |
| --- | --- |
| `view.ts` | `People`: lazy `load(cast)` (fetch + meshopt decode), `spawn`, `drive(person, avatar, opts)` (mocap gait unless `gait: "rig"`), LOD by eye distance, `idleShift`; the members come from `cast/<look>.gen.ts` (`CAST`). `new People(ctx, hooks, lod, { material, look })`. |
| `gait.ts` | `gaitBody`: walking and running from mocap cycles (`gait.gen.ts`, baked by `scripts/people/bake-gait.ts` from CMU 07_12 brisk walk and 09_11 run). Walk and run blend by speed (2.4–3.1 m/s); phase advances with distance over a stride that scales with √speed, so the stance foot stays put; standing, strafing and walking backward hand back to the rig. One foot lock over whichever gait leads keeps planted feet still through starts, stops and turns; hand reaches (torch carry, tying) apply on top by arm IK. Feeds `terrainFeet` its own plants and landing targets. |
| `asset.ts` | GLB reader: skeleton, LOD ranges, materials. Bakes vertices into the joint-world bind pose (MPFB IBMs carry the armature's 0.1 scale), so runtime IBMs are rigid. |
| `retarget.ts` | Rig frame → game_engine bone rotations: spine/neck/head from the rig's torso and look, two-bone IK on the mesh's own bone lengths for legs and arms, ankle target putting the mesh ball on the rig ball (blended to the heel pivot at heel strike), pelvis sink when a leg cannot reach (at once, easing back up at 10/s so a stretched swing leg cannot bounce the body), fingers and a wrist bend so the torch barrel follows the beam. Breathing on the chest. Arms hang from the mesh's own shoulder, scaled to its arm (the mesh arm is 10–13% shorter than the rig's), and reach eases toward a soft limit so no elbow locks (`ARM_REACH`: 97.5% free, 86% holding a torch). A torch lies diagonally in the palm; each hand solves its own grip at load (`solveTorchGrip`, ~14 ms per person) so every finger rests on the barrel and the thumb closes over it. `torchCarry(pitch)` is where to carry it (`Avatar.reach.r`): low by the hip, thumb forward, so the wrist stays nearly straight. |
| `terrain.ts` | `terrainFeet`: a planted boot pitches to the tangent from its ball over whatever lies under its own sole (6 samples, the mesh's footprint, hung off the rig's ball pivot), rising when it hits the pitch limit; at heel strike it also clears the ground under the rig's heel point; swing feet arc over anything on the swing path and keep their heels above what is under them (no tilt on flat ground); hips drop on a spring. Ground is a `(x, z) => y` the game provides (woods adds its logs). |
| `pass.ts` | `PeoplePass`: one compute dispatch per visible person writes world-space skinned triangles in the kit's 32-byte textured vertex layout; the stock textured scene pipeline draws them as `MAT.lit` (pass `MAT.actor` for the blocky actors' fill and rim), so people get only the game's own lights, beams, fog and shadows, and are as dark as the forest when nothing lights them. `shadowCasters()` for spot shadows. |
| `hooks.ts` | `personHooks(gameHooks, look)`: per-kind roughness for physical-light games, a subsurface wrap on skin from each scene light (`scatter`, red-weighted, so unlit skin stays dark), an optional fibre sheen (off by default: it read as a glow), and a torch beam that does not light its holder behind the lens (otherwise the spill burns the sleeve and chest). |

A standing person shifts their weight (`idleShift`, `PoseInput.shift`): after about a second still they settle onto
one leg for 3–5 s and cross over in about a second, each at their own rate; the hips slide 3.5 cm and drop on the free
side, the chest leans back, the free knee unlocks through the leg IK and the hands ride with the shoulders. Any step
eases it out within a quarter second.

A game keeps its avatars: animate them in rig space (`world / people.scale(cast)`), then call
`people.drive(person, avatar, { dt, time, ground, torch: { side, dir }, look, eye })`. It returns the torch frame (world)
for the beam and the torch mesh. Woods' adapter is `games/barbara/src/people-view.ts` (≈80 lines) plus a
`FriendsView.people: "blocky" | "real"` switch that draws blocky friends while the GLB loads.

## Measured (Oct 22)

| | |
| --- | --- |
| Assets | 18 GLBs, 15.3 MB in the repo; a game fetches only what it spawns (woods: six, 5.3 MB, as friends arrive) |
| Triangles | LOD0 28.5–33.1 k, LOD1 7.3–9.2 k (beyond 9 m from the pelvis); 53 joints; heights 1.59–1.86 m |
| CPU | 0.03 ms per person-frame (terrain, retarget, IK, skin matrices; `bun scripts/people/measure.ts <id>`) |
| GPU (woods, mini, five friends in view, your torch on) | whole frame median 26.4 ms realistic vs 25.3 ms blocky (3 alternating rounds of 48: 24.5/27.7/26.4 vs 25.4/17.9/25.3); the difference is inside the run-to-run noise on a shared mini |
| Planted ball slip, flat walk 1.4 m/s | 0 mm (max 0.1 mm), every body |
| Rolling ground + 30 cm log at 1.2 m/s, sole points | worst sink 11–14 mm (heel strikes on the slope), planted float ≤ 4.4 mm except f's 35 mm (a flat boot touching a round log at one point between heel and ball), swing clearance over the log 5–62 mm |
| Torch barrel vs beam | 0° worst over a 1.4 m/s walk |
| Backpack to back (7 packs, `measure.ts` `pack`) | 0.9–1.0 cm clear at rest (bridging the spine groove: median 1.5–2.1 cm along the back's normal); smallest gap over walk, run and weight shift +2.2 mm (never inside the clothes) |
| Gait (`scripts/people/gait-metrics.ts`, all six woods) | mocap: worst planted-ball slip per stance 5–13 mm walking 1.9 m/s, 3–10 mm running 3.4 m/s, ≤ 13 mm through starts, stops, walk-to-run and a 4 m turn; planted leg pulled straight 1–4% walking. Knees never behind the hip–ankle line, planted feet within 2 cm of the ground through the blend (tests). The rig on the same meshes: 14–28 mm and 16–18% |
| Arms | torch arm at 78–84% of the mesh's reach in every beam direction (was 91–100%, locked straight); wrist bend 8–47° (was 44–66° holding the torch out at chest height) |
| Torch grip | every finger joint 23–36 mm from the barrel's axis (an 18 mm barrel plus a finger's half-thickness is 26.5), thumb tip 25–28 mm; was 5–20 mm (inside the barrel) and the thumb 6–9 cm off it |

## Known gaps

- In your own beam at 4 m a person (blocky or realistic) clips: square-on to the beam with 3–4× the litter's albedo,
  they read about ten times the ground pool the meter exposes for. A woods exposure question (meter or shoulder),
  not a people one.
- Mocap covers forward walk and run only; standing, turning on the spot, strafing and backward walking are the rig's.
  `jointsToBody` keeps the mocap pelvis's yaw but not its tilt or roll.
- Faster than ~3.5 m/s the run plays above its captured cadence.
- Up close the MakeHuman textures are the ceiling: flat skin with no pores and cloth with no weave or fold maps.
  Microsoft Rocketbox (MIT, 115 avatars, photo-sourced 2K colour and normal maps) is clearly more real beside it
  (`scripts/people/model-compare.sh`), but it is MIT rather than CC0 or CC BY and uses a Biped skeleton; not adopted.
- Hair cards are alpha-tested and can shimmer at a distance under TAA.
- Torch shadows from people re-render the torch's shadow slot every frame while anyone is in reach.

## Licences

All shipped assets are CC0: MakeHuman/MPFB 2 bodies, clothes, hair, skins, eyes and eyebrows from
`makehuman_system_assets_cc0`; the beanie and its knit texture are procedural. The gait cycles are from the CMU
Graphics Lab Motion Capture Database (free for all uses; credited in `gait.gen.ts` and `CREDITS.md`). See
`packages/kit/people/assets/CREDITS.md`. No Mixamo, no Bandai Namco data, nothing with ML or redistribution limits.
