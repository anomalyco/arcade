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

Building shell, lamp, parking markings and diamond fence are generated here. Pines use Arcade's shared foliage generator.
Aiden's Ashwood exterior informed the metre scale, camera, palette and arrangement. This scene is a smaller independent composition, not an asset-for-asset port.
No Mixamo assets or Three.js runtime are included.

Regenerate downloads with `bun run fetch-assets` in `games/lot`. The script refuses a wagon licence other than the verified CC BY grant. Original licence metadata and source SHA-256 are retained in `assets/source-metadata.json`.
