# Lot — asset credits

## Station wagon — CC BY 4.0

**Fairheaven SW '84 – Low poly model**, by **Daniel Zhabotinsky**.
The Objaverse snapshot names it **'80s Generic USA Station wagon – Low poly model**.

- Original: https://sketchfab.com/3d-models/aa0becb6e854422596cac6b21bf79787
- Licence: https://creativecommons.org/licenses/by/4.0/
- Download: https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-124/aa0becb6e854422596cac6b21bf79787.glb
- Licence metadata: https://huggingface.co/datasets/allenai/objaverse/resolve/main/metadata/000-124.json.gz
- Changes: rotated −90° about Y, scaled to 5.05 m long, centred on its footprint and grounded. Original textures retained. Runtime placement and lighting changed. No endorsement implied.

## Exterior surface scans — CC0 1.0

The road and lot use Ashwood's separate **Asphalt 02** and **Worn Asphalt** scans. Gravel, forest floor, grass, dirt, concrete, pole wood and metal scans come from the same CC0 Poly Haven and ambientCG library used by Ashwood.

- Original: https://polyhaven.com/a/worn_asphalt
- Licence: https://polyhaven.com/license
- Public-domain dedication: https://creativecommons.org/publicdomain/zero/1.0/
- Downloads are resolved from https://api.polyhaven.com/files/worn_asphalt
- Full asset-by-asset credits: [surface credits](ashwood/surfaces/CREDITS.md).
- Source KTX2 hashes, metre tiling, tint, roughness remapping and normal strength: [surface recipes](ashwood/surfaces/sources.json).
- Changes: decoded to PNG offline; source albedo and packed surface channels split into base colour, OpenGL normal and AO/roughness/metalness maps. The road darkens when wet and uses the kit's physical lighting and reflected airlight.

## Procedural work and reference

The exterior geometry is converted from Aiden's Ashwood procedural builders: building shell, dish, guard booth and furniture, barriers, lamps, roads, utility poles, wires, fence, facility grounds, seeded conifers, undergrowth and deadwood. Trees are exported as Ashwood's own per-variant models (two detail levels of branch cards) plus one instance per seeded tree, drawn by the kit's instanced forest; distant trees use the original impostor painter with camera-facing quads. Card shading (inner-crown darkening, face normals) and species colours follow Ashwood's forest material. `ashwood/scene.json` records source hashes for the conversion.
Ashwood's home drift supplies the camera. The shared kit fog, physical-light and reflection ports supply the height fog, sky, lamp scattering, reflected airlight, specular lighting and SSR. The exterior conversion includes scanned building materials, source terrain heights, roadside lamps, furniture, roof and dock geometry.
The entrance, lobby and storey-0 corridor use separately baked native geometry, authored finish maps and CC0 props: [interior credits](interior/CREDITS.md).
No Mixamo assets or Three.js runtime are included.

Regenerate downloads with `bun run fetch-assets` in `games/lot`. The script refuses a wagon licence other than the verified CC BY grant. Original licence metadata and source SHA-256 are retained in `assets/source-metadata.json`.

## Authored model props, CC0 1.0

The CC0 props in Ashwood's compound, facility and road builders use their original placements and metre-normalized geometry. Their KTX2 atlases are decoded to PNG and only LOD0 is retained. This includes the roadside utility cabinet, trash cans, tyres, bags, hydrant and exterior fixtures. Each imported model has its own source hash and credit in `ashwood/models/`.

- https://polyhaven.com/a/metal_trash_can
- https://polyhaven.com/a/utility_box_01
- Licence: https://polyhaven.com/license
- [Imported model credits](ashwood/models/CREDITS.md) and [source hashes](ashwood/models/sources.json).
- Regenerate with `bun scripts/import-ashwood.ts <afterhours-project>`, then `bun scripts/import-props.ts <afterhours-project>`. Surface scans use `bun scripts/import-surfaces.ts <afterhours-project>`.
- Additional CC BY and CC BY-SA source props are recorded as excluded in `ashwood/scene.json`; they require approval before reuse. The wagon above was separately approved.

## Forest LOD and ground-dressing techniques, MIT

The kit's forest cross-fade (complementary Bayer 4×4 screen door shifted each frame), far-forest thinning (fewer crowns grown by 1/√(1−f)) and the rule-based debris placement (feature-anchored clusters, padded 2D SDF obstacle hash) follow **Tidewater** by Dan Greenheck: `src/materials/LODFade.js`, `src/world/vegetation/Impostors.js`, `src/world/debris/DebrisPlacement.js`.

- https://github.com/dgreenheck/tidewater
- MIT License, Copyright (c) 2026 DRG Software Solutions LLC. Reimplemented in `packages/kit/gpu/forest.ts` and `packages/kit/sim/debris.ts`; no Tidewater assets are included.

## Ground dressing, CC0 1.0 and procedural

Poly Haven **Can Rusted** (Rahul Chaudhary), original 1k glTF, centred and grounded: https://polyhaven.com/a/can_rusted (licence https://polyhaven.com/license). Regenerate with `bun scripts/fetch-dressing.ts can_rusted`; URL and hash in `assets/dressing-metadata.json`.
Weed, grass, salal, fern and twig clumps are Ashwood's own undergrowth templates; leaves (an atlas painted at load), pebbles and paper scraps are procedural.

## Glass, lit rooms and contact shadows (code)

- Interior-mapped windows: `kitRoomBoxUV` and `kitPaneHash` in `@arcade/kit/gpu/materials/glass` are WGSL ports of `imRoomBoxUV` and `imHash` from **three-fenestra** by Edgar Perez, MIT licence (https://github.com/codedgar/three-fenestra). Its room images are not used: the room atlas is painted by our own ray tracer (`scripts/textures/paint-rooms.ts`).
- Screen-space contact shadows (`@arcade/kit/gpu/contact-shadows`) follow Bend Studio's technique as implemented by three.js r181 `SSSNode`, MIT licence (https://github.com/mrdoob/three.js); the WGSL is written for the kit's volume pass.
- The glass grime and condensation layer takes the idea of Martijn Steinrucken's *Heartfelt* (fogged glass with drips cut through it); no code is reused.

## Atmosphere techniques, MIT

The drifting fog bank, fog-depth blur and lit cloud deck (`packages/kit/gpu/fog-scatter.ts`, `fog-blur.ts`) are WGSL
written for the kit after these MIT-licensed examples; no source files are included:

- three.js `webgpu_postprocessing_fog` (ray–slab fog layer, two counter-drifting warped noise octaves with a threshold
  and height falloff) and `webgpu_custom_fog_scattering` (blurred scene mixed in by the fog factor). © 2010–2026
  three.js authors, MIT: https://github.com/mrdoob/three.js/blob/dev/LICENSE
- Tidewater `src/post/AirHaze.js` (a low analytic haze layer over the height fog), © 2026 DRG Software Solutions LLC,
  MIT: https://github.com/dgreenheck/tidewater
- Neon Zenith street-light map (one top-down glow texture lighting the cloud underside and fog), © Bill Chan, MIT:
  https://github.com/billpwchan/neon-zenith
- web-ocean footprint-filtered cloud octaves and analytic edge width, © 2026 Maksymilian Dendura, MIT:
  https://github.com/Noniv/web-ocean
