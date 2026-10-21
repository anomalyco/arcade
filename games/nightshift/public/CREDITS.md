# Night Shift ’87

An original Arcade scene based on Kit's approved October 20, 2026 generated Night Shift concept.

- Geometry: original procedural office, receiver, continuously attached cord, rolodex, paper clutter, blinds and plants. Imported props below are rescaled and restaged for this scene.
- Materials: original analytic woven fabric, carpet pile, laminate, acoustic tile, wear and CRT phosphor recipes, plus the imported pen-cup's source texture.
- Audio: Kit Langton's explicitly authorized ElevenLabs v4 voice performs the fictional character Jay. This is not a recording or imitation of the real Jay. Offline processing adds telephone filtering, pitch shift, whisper double, hiss, codec grit, clicks and dial tone. Bells and ballast hum are original synthesis.
- Rendering: shared `@arcade/kit` WebGPU renderer, physical lights, spotlight shadows, stateless flicker, fog scattering and first-person controller. See shared engine credits for upstream technique attribution.
- Contact shadows: the shared kit's depth-march implementation of Bend Studio's technique, following three.js r181 `SSSNode` (MIT). Source and attribution are in `packages/kit/gpu/contact-shadows.ts`.
- Carpet: [ambientCG Carpet001](https://ambientcg.com/view?id=Carpet001), [CC0](https://docs.ambientcg.com/license). Base colour, OpenGL normal and roughness maps, converted to 1024px WebP by `scripts/prepare-carpet.py`; warm tint and 1.2 m tiling are scene adaptations. The source lists its technique as approximation, not a scan.

## Imported models

Licences checked October 20, 2026. Files are served locally; there are no runtime asset-site requests.

| Asset | Author/source | Licence | Changes |
| --- | --- | --- | --- |
| Office Phone | [dook / Poly Pizza](https://poly.pizza/m/YxfMuchpUF) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Base only; beige recolour, LCD repurposed as directory, rescaled; original animated receiver/cord. Source is a later Cisco design, stylized here, not a period replica. |
| Computer 90s (CRT, keyboard, speakers, mouse) | [Charlie / Poly Pizza](https://poly.pizza/m/Bw55oYsbp8) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Rescaled, screen changed to green phosphor, viewer-facing. Source is a 1995 Gateway, not a period-exact 1987 model. |
| Mug With Office Tool | [CreativeTrio / Poly Pizza](https://poly.pizza/m/4jSgnM5WWk) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Rescaled and turned; original texture retained. |
| Mug | [Kenney / Poly Pizza](https://poly.pizza/m/fis2ugeLbn) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Rescaled and turned. |
| Desk chair | [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Rescaled and turned. |

The rolodex remains original procedural geometry; no suitable redistributable source was found.
