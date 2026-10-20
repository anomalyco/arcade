# Lot — asset credits

## Station wagon — CC BY 4.0

**Fairheaven SW '84 – Low poly model**, by **Daniel Zhabotinsky**.
The Objaverse snapshot names it **'80s Generic USA Station wagon – Low poly model**.

- Original: https://sketchfab.com/3d-models/aa0becb6e854422596cac6b21bf79787
- Licence: https://creativecommons.org/licenses/by/4.0/
- Download: https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-124/aa0becb6e854422596cac6b21bf79787.glb
- Licence metadata: https://huggingface.co/datasets/allenai/objaverse/resolve/main/metadata/000-124.json.gz
- Changes: rotated −90° about Y, scaled to 5.05 m long, centred on its footprint and grounded. Original textures retained. Runtime placement and lighting changed. No endorsement implied.

## Worn asphalt — CC0 1.0

**Worn Asphalt**, Poly Haven. Original 1k diffuse, OpenGL normal, and AO/roughness/metalness maps.

- Original: https://polyhaven.com/a/worn_asphalt
- Licence: https://polyhaven.com/license
- Public-domain dedication: https://creativecommons.org/publicdomain/zero/1.0/
- Downloads are resolved from https://api.polyhaven.com/files/worn_asphalt
- Runtime modifications: repeated at 6 m, darkened when wet, normal strength reduced, procedural puddles and sky/lamp reflections.

## Procedural work and reference

The exterior geometry is converted from Aiden's Ashwood procedural builders: building shell, dish, guard booth and furniture, barriers, lamps, roads, utility poles, wires, fence, facility grounds, seeded conifers, undergrowth and deadwood. Near trees use branch cards; distant trees use the original impostor painter with camera-facing quads. `ashwood/scene.json` records source hashes for the conversion.
Ashwood's home drift supplies the camera. The shared kit fog and physical-light ports supply the height fog, sky, lamp scattering, reflected airlight and specular lighting. Scanned building materials, playable facility interiors and SSR are outside this exterior conversion.
No Mixamo assets or Three.js runtime are included.

Regenerate downloads with `bun run fetch-assets` in `games/lot`. The script refuses a wagon licence other than the verified CC BY grant. Original licence metadata and source SHA-256 are retained in `assets/source-metadata.json`.

## Booth dressing, CC0 1.0

Poly Haven **Metal Trash Can** and **Utility Box 01**, downloaded from their original 1k glTF sources. The rusted trash-can variant is selected; both pivots are centred and grounded, with original textures and metre scale retained.

- https://polyhaven.com/a/metal_trash_can
- https://polyhaven.com/a/utility_box_01
- Licence: https://polyhaven.com/license
- Regenerate with `bun scripts/fetch-dressing.ts`; download URLs and output hashes are in `assets/dressing-metadata.json`.
