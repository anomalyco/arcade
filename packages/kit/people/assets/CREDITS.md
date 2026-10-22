# People cast: credits and licences

Every file here is built by `scripts/people/build-people.ts` from `scripts/people/cast.json` (Blender 5.2 + MPFB 2).
Ship this file with any game that loads them.

## Bodies, skeleton, weights, clothes, hair, eyes, brows: CC0 1.0

- **MakeHuman base mesh, macro targets, `game_engine` rig and its weights**, generated with MPFB 2.0.18
  (https://extensions.blender.org/add-ons/mpfb/). MPFB's code is GPL-3.0; its output (mesh, rig, weights) is CC0 per
  the MakeHuman licence (§C assets CC0, §D output unrestricted):
  https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md
- **MakeHuman system assets** (clothes `male_casualsuit05`, `shoes03`; hair `short02`; skins; `eyes/low-poly` and
  eye materials; `eyebrow001`): CC0 1.0, released September 2020 by Data Collection AB, Joel Palmius and Jonas
  Hauquier. Pack: https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
- Changes: clothes split into pieces (jacket, shirt, trousers, boots) and re-textured as AO-baked luminance for
  runtime tints; skin desaturated; hidden skin under clothes deleted; a procedural knit beanie (made in the build
  script, CC0); decimated LOD1.

No attribution is required for any of the above.

## Motion

The people move with the kit's own procedural rig (`packages/kit/human-*.ts`); no motion capture is baked into these
files. Where the rig is measured or tuned against motion capture, see `docs/animation.md` (100STYLE, CC BY 4.0:
Ian Mason, Sebastian Starke, Taku Komura, 2022, https://zenodo.org/records/8127870; attribution required if any of it
is ever shipped).
