# Night Shift ’87

An original Arcade scene based on Kit's approved October 20, 2026 generated Night Shift concept.

- Geometry: original procedural office, receiver, continuously attached cord, paper clutter, blinds and plants, plus the authored, generated and imported props below.
- Materials: original analytic woven fabric, laminate, acoustic tile, wear and CRT phosphor recipes, generated prop colour/roughness/metalness maps, the pen-cup's source texture and ambientCG carpet.
- Audio: Kit Langton's explicitly authorized ElevenLabs v4 voice performs the caller in the opening's ten-line script. Offline processing adds telephone filtering, pitch shift, whisper double, hiss, codec grit, clicks and dial tone. The descending terminal tone, bells and ballast hum are original synthesis.
- Rendering: shared `@arcade/kit` WebGPU renderer, physical lights, spotlight shadows, stateless flicker, fog scattering and first-person controller. See shared engine credits for upstream technique attribution.
- Contact shadows: the shared kit's depth-march implementation of Bend Studio's technique, following three.js r181 `SSSNode` (MIT). Source and attribution are in `packages/kit/gpu/contact-shadows.ts`.
- Carpet: [ambientCG Carpet001](https://ambientcg.com/view?id=Carpet001), [CC0](https://docs.ambientcg.com/license). Base colour, OpenGL normal and roughness maps, converted to 1024px WebP by `scripts/prepare-carpet.py`; warm tint and 1.2 m tiling are scene adaptations. The source lists its technique as approximation, not a scan.

## Movement and room audio

Carpet footsteps, cloth rustle, stop/pivot scuffs, chair impacts, HVAC, fluorescent hum and distant creaks are original deterministic synthesis in `src/foley.ts`. No third-party samples are used. The same synthesis and mixer render live audio and the offline proof soundtrack.

## Authored hard-surface props

The active CRT, phone base and rolodex are original Blender models authored against the approved concepts. Their earlier TRELLIS candidates had torn casing surfaces, an incomplete keypad and distorted cards. `scripts/author-hard-surface.py` rebuilds these forms with rolled bevels, curved glass, vent details, twelve numbered keys, a receiver-free cradle and separate radial index cards. Materials use unlit base-colour/roughness values and the game's live lighting; there are no painted or baked shadows. The glass uses the live phosphor shader.

Runtime files and hashes are in `props/authored/`. Editable Blender scenes and neutral three-angle renders are preserved in the Night Shift artifact gallery; the source script regenerates them. Geometry is merged by material for runtime export.

## Generated period props and retained candidates

The office chair and ceramic mug use TRELLIS.2 reconstructions from original gpt-image-2 product images based on the approved concepts. Earlier CRT, receiver-free multiline phone base and rolodex candidates remain in `props/period/` but have been replaced in the scene by the authored models above. They evoke unbranded 1980s office hardware rather than exact commercial replicas. Geometry and maps are generated estimates, not scans or measured material data. The phone uses the scene's single moving receiver.

`scripts/prepare-generated.ts` preserves geometry and converts colour/ORM maps to 1024px WebP; `props/period/generation.json` and `crt-generation.json` record source hashes, triangle counts and sizes. TRELLIS.2 code/weights and the Apple Silicon port use MIT licences; upstream component/licence details are recorded in the repository's `scripts/props/README.md`.

## Imported models and retained earlier assets

Licences checked October 20, 2026. Files are served locally; there are no runtime asset-site requests.

| Asset | Author/source | Licence | Changes |
| --- | --- | --- | --- |
| Office Phone | [dook / Poly Pizza](https://poly.pizza/m/YxfMuchpUF) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Earlier later-era placeholder, retained as an asset; replaced in the scene by the generated period base. |
| Computer 90s (CRT, keyboard, speakers, mouse) | [Charlie / Poly Pizza](https://poly.pizza/m/Bw55oYsbp8) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Earlier 1995 Gateway placeholder retained in the source asset; the scene uses the authored CRT and procedural keyboard. |
| Mug With Office Tool | [CreativeTrio / Poly Pizza](https://poly.pizza/m/4jSgnM5WWk) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Rescaled and turned; original texture retained. |
| Mug | [Kenney / Poly Pizza](https://poly.pizza/m/fis2ugeLbn) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Earlier placeholder retained as an asset; replaced in the scene. |
| Desk chair | [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Earlier placeholder retained as an asset; replaced in the scene. |

## Office look (AR-129, Lab: Office look → Lit office)

Loaded only when the look is on. Licences checked October 21, 2026. `scripts/prepare-look.ts` rebuilds `look/` from the vetted prop library: textures downsized to 256–512 px WebP, footprints re-centred on the origin.

Scanned surfaces in `look/surfaces.webp` (each reduced to 512 px and packed as detail, normal and roughness): [ambientCG Fabric030](https://ambientcg.com/view?id=Fabric030) (partition fabric), [ambientCG OfficeCeiling001](https://ambientcg.com/view?id=OfficeCeiling001) (ceiling tiles), [Poly Haven Dirty Carpet](https://polyhaven.com/a/dirty_carpet) and [ambientCG Plastic004](https://ambientcg.com/view?id=Plastic004), all [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

| Prop (`look/props/`) | Author/source | Licence | Changes |
| --- | --- | --- | --- |
| `phone-alt` | “[Office Phone](https://sketchfab.com/3d-models/4176a01b6d0b4d13ad165c0df278a6b5)” by maxdragonn | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Rescaled, re-origined, beige tint, textures re-encoded. |
| `desk-lamp` | “[office lamp](https://sketchfab.com/3d-models/d934c6b791c34e0fafc30e9625b4c55c)” by maxdragonn | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Rescaled, re-origined, textures re-encoded. |
| `mug` | “[Coffee Mug (School Project)](https://sketchfab.com/3d-models/5f5ccee1514c440887c072fae8e0d699)” by Ole Gunnar Isager | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Off-white tint, coffee surface, textures re-encoded. |
| `paper-stack`, `paper-sheet`, `yellow-pad`, `sticky-note` | [Office Notepads](https://polyhaven.com/a/office_notepads), Ulan Cabanilla / Poly Haven | CC0 | Split into pieces; notes tinted to a faded yellow in the scene. |
| `cardboard-box` | [Cardboard Box 01](https://polyhaven.com/a/cardboard_box_01), Rahul Chaudhary / Poly Haven | CC0 | Rescaled. |
| `clipboard` | [Clipboard](https://polyhaven.com/a/clipboard), ProgrammerOnCoffee / Poly Haven | CC0 | Rescaled. |
| `stapler` | [Vintage Stapler](https://polyhaven.com/a/vintage_stapler), Mateusz Sadek / Poly Haven | CC0 | Rescaled. |
| `wall-clock` | [Wall Clock](https://polyhaven.com/a/wall_clock), PierreB3D / Poly Haven | CC0 | Hands fixed in place. |
| `pen-cup-ph` | [Stationery Supplies](https://polyhaven.com/a/stationery_supplies), Mateusz Sadek / Poly Haven | CC0 | Pens recomposed upright into the cup. |
| `dead-plant` | Original model; pot from [Planter Pot Clay](https://polyhaven.com/a/planter_pot_clay), Amal Kumar / Poly Haven (CC0) | Original / CC0 | Stems, dry leaves and soil are original. |
| `waste-bin`, `file-box`, `letter-tray` | Original procedural models for Arcade | Original | — |

Coats over chair backs and the partition trim are original procedural meshes in `src/look/dressing.ts`.
