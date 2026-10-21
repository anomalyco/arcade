# Night Shift ’87

An original Arcade scene based on Kit's approved October 20, 2026 generated Night Shift concept.

- Geometry: original procedural office, receiver, continuously attached cord, paper clutter, blinds and plants, plus the authored, generated and imported props below.
- Materials: original analytic woven fabric, laminate, acoustic tile, wear and CRT phosphor recipes, generated prop colour/roughness/metalness maps, the pen-cup's source texture and ambientCG carpet.
- Audio: Kit Langton's explicitly authorized ElevenLabs v4 voice performs the fictional character Jay. This is not a recording or imitation of the real Jay. Offline processing adds telephone filtering, pitch shift, whisper double, hiss, codec grit, clicks and dial tone. Bells and ballast hum are original synthesis.
- Rendering: shared `@arcade/kit` WebGPU renderer, physical lights, spotlight shadows, stateless flicker, fog scattering and first-person controller. See shared engine credits for upstream technique attribution.
- Contact shadows: the shared kit's depth-march implementation of Bend Studio's technique, following three.js r181 `SSSNode` (MIT). Source and attribution are in `packages/kit/gpu/contact-shadows.ts`.
- Carpet: [ambientCG Carpet001](https://ambientcg.com/view?id=Carpet001), [CC0](https://docs.ambientcg.com/license). Base colour, OpenGL normal and roughness maps, converted to 1024px WebP by `scripts/prepare-carpet.py`; warm tint and 1.2 m tiling are scene adaptations. The source lists its technique as approximation, not a scan.

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
