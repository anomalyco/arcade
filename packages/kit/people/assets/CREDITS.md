# People cast: credits and licences

Every `<person>-<look>.glb` here is built by `scripts/people/build-people.ts` from `scripts/people/cast.json` (Blender
5.2 + MPFB 2); the `*-rocketbox.glb` files by `scripts/people/build-rocketbox.ts`. Ship this file with any game that
loads them.

## Bodies, skeleton, weights, clothes, hair, eyes, brows: CC0 1.0

- **MakeHuman base mesh, macro targets, `game_engine` rig and its weights**, generated with MPFB 2.0.18
  (https://extensions.blender.org/add-ons/mpfb/). MPFB's code is GPL-3.0; its output (mesh, rig, weights) is CC0 per
  the MakeHuman licence (§C assets CC0, §D output unrestricted):
  https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md
- **MakeHuman system assets**, CC0 1.0, released September 2020 by Data Collection AB, Joel Palmius and Jonas
  Hauquier. Pack: https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
  Used by `scripts/people/cast.json` (people a–f; woods, survivor and office looks):
  - clothes: `male_casualsuit02`, `male_casualsuit03`, `male_casualsuit05`, `male_casualsuit06`, `male_elegantsuit01`,
    `female_elegantsuit01`, `shoes02`, `shoes03`, `shoes04`
  - hair: `bob02`, `braid01`, `ponytail01`, `short01`, `short02`, `short04`
  - eyebrows: `eyebrow001`, `eyebrow002`, `eyebrow004`, `eyebrow006`, `eyebrow008`, `eyebrow010`
  - skins: `young_caucasian_male` (young_lightskinned_male_diffuse), `young_asian_female`
    (young_lightskinned_female_diffuse3), `middleage_african_male` (middleage_darkskinned_male_diffuse),
    `middleage_caucasian_female` (middleage_lightskinned_female_diffuse), `young_asian_male`
    (young_lightskinned_male_diffuse3), `old_african_female` (old_darkskinned_female_diffuse)
  - eyes: `eyes/low-poly` with the `brown`, `brownlight` and `green` eye materials
- **Procedural pieces made by `scripts/people/build-person.py`** (CC0 1.0, this repository): the knit beanie and its
  knit texture; the hoods (lying down); the backpack, its shoulder straps, the headlamp band, housing and lens; the
  ripstop and webbing textures; the quilted baffle, flannel check, seam and pocket patterns drawn over the clothes.
- Changes: clothes split into pieces (jacket, shirt, trousers, boots, ...) and re-textured as AO-baked luminance for
  runtime tints; cargo pockets and (for the vest) sleeves removed, the openings under them closed, puffers lofted; the office
  shoes' socks retinted as bare skin; d's fringe lifted above the brows; skin desaturated; hidden skin under clothes deleted; decimated LOD1.

No attribution is required for any of the above.

## Rocketbox avatars (`m05`, `f04`, `m04`, `f07`, `m07` `-rocketbox.glb`): MIT

From the Microsoft Rocketbox Avatar Library, https://github.com/microsoft/Microsoft-Rocketbox, commit `0943055d`, under
`Assets/Avatars/Adults/`: `Male_Adult_05` (m05), `Female_Adult_04` (f04), `Male_Adult_04` (m04), `Female_Adult_07`
(f07) and `Male_Adult_07` (m07). Source files and their SHA-256s are in `rocketbox-sources.json`. Changes: the Biped
bones renamed to the `game_engine` names, thighs moved under the pelvis and clavicles under the chest, the mesh split
by material and bone weights into clothes, skin, eyes and hair, a decimated LOD1, textures downscaled from 2048 to
1024 and re-encoded as WebP, specular maps dropped, the clothes' lining strips given the UVs and normals of the
panels over them, and a colour factor on the skin moving its hue onto measured skin.

```
MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Motion

The walk and run cycles in `../gait.gen.ts` come from the CMU Graphics Lab Motion Capture Database,
http://mocap.cs.cmu.edu (created with funding from NSF EIA-0196217), free for all uses: trials 07_12 (brisk walk) and
09_11 (run), in Bruce Hahne's cgspeed BVH conversion. Changes: one gait cycle each, retargeted onto the arcade rig and
resampled (`scripts/people/bake-gait.ts`).
