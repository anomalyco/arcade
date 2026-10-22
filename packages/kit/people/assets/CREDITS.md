# People cast: credits and licences

Every file here is built by `scripts/people/build-people.ts` from `scripts/people/cast.json` (Blender 5.2 + MPFB 2).
Ship this file with any game that loads them.

## Bodies, skeleton, weights, clothes, hair, eyes, brows: CC0 1.0

- **MakeHuman base mesh, macro targets, `game_engine` rig and its weights**, generated with MPFB 2.0.18
  (https://extensions.blender.org/add-ons/mpfb/). MPFB's code is GPL-3.0; its output (mesh, rig, weights) is CC0 per
  the MakeHuman licence (§C assets CC0, §D output unrestricted):
  https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md
- **MakeHuman system assets**, CC0 1.0, released September 2020 by Data Collection AB, Joel Palmius and Jonas
  Hauquier. Pack: https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
  Used by `scripts/people/cast.json` (people a–f; woods, survivor and office looks):
  - clothes: `male_casualsuit02`, `male_casualsuit05`, `male_casualsuit06`, `male_elegantsuit01`,
    `female_elegantsuit01`, `shoes02`, `shoes03`, `shoes04`
  - hair: `bob01`, `braid01`, `ponytail01`, `short01`, `short02`, `short04`
  - eyebrows: `eyebrow001`, `eyebrow002`, `eyebrow004`, `eyebrow006`, `eyebrow008`, `eyebrow010`
  - skins: `young_caucasian_male` (young_lightskinned_male_diffuse), `young_asian_female`
    (young_lightskinned_female_diffuse3), `middleage_african_male` (middleage_darkskinned_male_diffuse),
    `middleage_caucasian_female` (middleage_lightskinned_female_diffuse), `young_asian_male`
    (young_lightskinned_male_diffuse3), `old_african_female` (old_darkskinned_female_diffuse)
  - eyes: `eyes/low-poly` with the `brown`, `brownlight` and `green` eye materials
- **Procedural pieces made by `scripts/people/build-person.py`** (CC0 1.0, this repository): the knit beanie and its
  knit texture; the backpack, its shoulder straps, the headlamp band, housing and lens; the ripstop and webbing
  textures.
- Changes: clothes split into pieces (jacket, shirt, trousers, boots, ...) and re-textured as AO-baked luminance for
  runtime tints; skin desaturated; hidden skin under clothes deleted; decimated LOD1.

No attribution is required for any of the above.

## Motion

The people move with the kit's own procedural rig (`packages/kit/human-*.ts`); no motion capture is baked into these
files. Where the rig is measured or tuned against motion capture, see `docs/animation.md` (100STYLE, CC BY 4.0:
Ian Mason, Sebastian Starke, Taku Komura, 2022, https://zenodo.org/records/8127870; attribution required if any of it
is ever shipped).
