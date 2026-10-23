# Assets: where to find them, or generate them

Where Arcade gets models, textures, motion and sound, which licences it accepts, and when to generate an asset
instead. Licences were checked on October 22, 2026; the licence attached to the actual download governs, so check
again at download time.

## Rules

- **CC0, or CC BY with credits.** Nothing NC (non-commercial), ND (no derivatives) or SA (share-alike) without Kit's
  approval. **No Mixamo** (forbids redistribution and ML use) and **no Bandai Namco motion data** (non-commercial),
  not even as shipped reference data ([animation.md](animation.md#reference-clips)).
- **Every game ships a `CREDITS.md` next to its assets**: asset, author, source URL, licence link, what changed. CC BY
  items need all five. Shared kit assets carry their own (`packages/kit/people/assets/CREDITS.md`) and a game that
  loads them ships that file too.
- **Record provenance in a manifest**: source URL, licence and the SHA-256 of every downloaded file, written by the
  fetch script, so a rebuild is reproducible and a changed upstream file fails loudly. Pattern:
  `scripts/woods/fetch-assets.ts` → `packages/kit/forest/assets/sources.json`; also
  `games/lot/public/ashwood/{surfaces,models}/sources.json` and `games/lot/public/assets/source-metadata.json`. Fetch
  scripts should refuse an unexpected licence (Lot's `fetch-assets` refuses any wagon licence but the verified CC BY).
- **Compress.** Textures as WebP (lossy colour, lossless for packed data) or KTX2 (Basis UASTC, mipmapped). Pack
  channels: ORM, or Ashwood's `albedo` (RGB + roughness) and `surface` (normal XY, AO, metalness). Models decimated
  to a triangle budget and packed (kit vertex buffers, `.prop`, or meshopt glTF). 1k sources are usually enough;
  ship 512–1024 px unless the surface fills the screen.
- **Load lazily**: fetch an asset when its scene, look or Lab preset first needs it (Night Shift's office look loads
  only when on). **Every file stays under 25 MiB**, Cloudflare Workers' per-file static-asset limit; split anything
  larger. Never hotlink an asset site at runtime: serve local copies.

## Sources Arcade already uses

| Source | Licence | Used by, for what |
| --- | --- | --- |
| [Poly Haven](https://polyhaven.com) scans, models, HDRIs | CC0 1.0 ([licence](https://polyhaven.com/license)); API and site have separate terms | Lot: asphalt, concrete, wood scans and 19 Ashwood props (`games/lot/public/ashwood/*/CREDITS.md`), interior props, rusted can. Woods: every forest scan and model (`packages/kit/forest/assets/CREDITS.md`). Night Shift office look: dirty carpet, notepads, stapler, clipboard, clock, box. |
| [ambientCG](https://ambientcg.com) PBR textures | CC0 1.0 ([licence](https://docs.ambientcg.com/license/)) | Lot: gravel, ground, bark, metals, ceiling tile, terrazzo, plaster. Night Shift: Carpet001, Fabric030, OfficeCeiling001, Plastic004. |
| [Kenney](https://kenney.nl) | CC0 ([support](https://kenney.nl/support)) | Night Shift: earlier mug and desk-chair placeholders. |
| [Poly Pizza](https://poly.pizza) | Per model: CC0 or CC BY 3.0, shown on each model page | Night Shift: office phone, 90s computer (CC BY 3.0), mugs (CC0), mostly retained placeholders. |
| [Objaverse](https://huggingface.co/datasets/allenai/objaverse) on Hugging Face | Dataset ODC-By; each object has its own licence in `metadata/*.json.gz` (721K CC BY, 3.5K CC0, ~93K NC or SA) | Lot: the CC BY 4.0 station wagon (a Sketchfab model). Read the per-object metadata; take only CC0 and CC BY. |
| [Sketchfab](https://sketchfab.com) | Per model; check the badge and the downloaded licence | Night Shift office look: phone, desk lamp, mug (CC BY 4.0, credited). CC0 and CC BY only. |
| [MakeHuman / MPFB 2](https://extensions.blender.org/add-ons/mpfb/) | Assets CC0; MPFB code GPL-3.0 but its output is CC0 ([licence](https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md)) | Kit people cast: bodies, rig, clothes, hair, brows, skins (`packages/kit/people/assets/CREDITS.md`). |
| [100STYLE](https://zenodo.org/records/8127870) mocap | CC BY 4.0 (Mason, Starke, Komura 2022) | Gait measurement in `games/blackout/scripts/animation/reference-clips.ts`; not shipped. Credit it if any frame ships. |
| [Quaternius](https://quaternius.com) UAL animation packs | CC0 ([FAQ](https://quaternius.com/faq.html)) | Reference clips beside 100STYLE (same script). |
| [CMU mocap database](http://mocap.cs.cmu.edu/) | "Free for all uses" (home page); credit and NSF grant acknowledgement requested | Not used yet. The next stop for actions 100STYLE lacks. |
| MIT code ports | MIT | three.js (contact shadows, fog), three-fenestra (interior-mapped windows), Tidewater, web-ocean, Neon Zenith: see `games/lot/public/CREDITS.md`. Port with the copyright line; GPL and CC BY-NC-SA work is technique only. |
| ElevenLabs sound generation | ElevenLabs commercial licence on Anomaly's paid plan ([help](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform)) | The shared sound library (`packages/kit/audio/`, [sfx-library.md](sfx-library.md)); Night Shift's caller voice (Kit's authorized voice). Free-plan output needs attribution and is not commercial. |
| Fonts from [google/fonts](https://github.com/google/fonts) | SIL OFL 1.1, Apache 2.0 | Lot's document atlas, rendered into the texture (`games/lot/public/interior/DOCUMENT-CREDITS.md`). |

Much of the sound is original synthesis (Outbreak's weapons, Night Shift and Lot foley): nothing to license.

## Sources to evaluate

| Source | Licence | Notes |
| --- | --- | --- |
| [NVIDIA SimReady](https://huggingface.co/datasets/nvidia/simready-assets) ([search](https://huggingface.co/spaces/nvidia/simready-central)) | **Unverified licence, check before use.** The dataset card shows none; each asset folder has `.metadata/LICENSE.txt`, and the four sampled were CC BY 4.0, but only 1,663 of 2,575 folders have one. | 2,500+ OpenUSD industrial, hospital, kitchen and warehouse props, sim-grade not game-grade. Needs USD → glTF (Blender's USD importer or usd2gltf), decimation and texture re-encoding. Fits Night Shift's basement, Outbreak's hospitals, Lot warehouses. Found by Kit ([post](https://x.com/calebfahlgren/status/2113308155270541536)). |
| [Smithsonian 3D](https://3d.si.edu) | CC0 only for items marked with the CC0 icon ([terms](https://www.si.edu/termsofuse)); other items are not | Museum scans: tools, vehicles, artefacts. High-poly; decimate. |
| [Quaternius](https://quaternius.com) models | CC0 ([FAQ](https://quaternius.com/faq.html)) | Low-poly, atlas-textured: toy prototypes and bots. |
| [Freesound](https://freesound.org) | Per sound: CC0, CC BY, CC BY-NC (and legacy Sampling+) ([FAQ](https://freesound.org/help/faq/)) | CC0 or CC BY only; record the sound URL and author. |
| Megascans via [Fab](https://www.fab.com/eula) | Fab Standard License: commercial use in any engine, **no standalone redistribution**; not CC. Some Fab items are CC BY instead. | Our repo and fetchable web assets are public, which may count as redistribution. Not without Kit's approval and a read of the binding EULA. Old Unreal-only Megascans entitlements do not transfer. |
| [Textures.com](https://www.textures.com/about/license) | Proprietary, credit-based, no redistribution | **No.** Use Poly Haven or ambientCG. |

`~/code/home/artifacts/arcade-asset-sources.md` is the running list of candidates; add new finds there first, and
here once they are checked. The woods licence screen (Poly Haven, ambientCG, Sketchfab, Fab, SpeedTree) is section H
of `~/code/home/artifacts/woods-2026-10-21/RESEARCH.md`.

## Pick the right method

| Need | Best method |
| --- | --- |
| Natural surfaces: bark, ground, rock, asphalt, concrete, plaster | Scans (Poly Haven, ambientCG). Nothing generated matches them. |
| Natural props: logs, stumps, roots, rocks, ferns | Scanned models, decimated; procedural for anything repeated thousands of times. |
| Trees, terrain, buildings, wires, fences | Procedural (`packages/kit/forest/`, Ashwood builders). |
| Background furniture and clutter | TRELLIS from a generated image, or a CC0 model. |
| Hard-surface hero props (CRT, phone, keypad) | Authored geometry (Blender script or kit code); a CC0/CC BY model if one matches. |
| Creatures and animals | A scanned or CC0/CC BY model if one fits; otherwise procedural kit geometry on a rig (`packages/kit/creature/`), finished and judged against a paint-over. |
| Rooms and interiors | Kit geometry with bevels and scanned surfaces, furniture from the prop pipeline or CC0 models, judged against a paint-over. The Lot's interior (`games/lot/src/interior/`) is the most finished example. |
| Maps, instruments, signage text, labels, forms | Procedural vector graphics rendered to a texture. |
| Concept targets, paint-overs, decals, grime, stains, signage art, tileable detail | Image model. |
| Characters | MPFB pipeline (`scripts/people`) on the kit rig. |
| Sound effects | ElevenLabs through `scripts/sfx/library.ts`, or original synthesis. |

## Generating assets

**Image model: targets and material layers.** The global `concept-art` skill makes a round of distinct looks to pick
from; `paint-over` paints over a real screenshot to make the target a rebuild is judged against (the `arcade-lookdev`
skill wires both into Arcade). `gpt-image-2` also
supplies TRELLIS source images (`scripts/props/source-images.ts`), Lot's document photos and the raw texture
candidates. Good at: concept targets, paint-overs, decals, grime, stains, water damage, signage art, tileable detail
layers. Bad at: accurate geometry, maps, crisp small text, instrument markings and anything that must line up. Draw
those procedurally as vector graphics (Lot's document atlas sets its forms in real fonts, `games/lot/public/interior/DOCUMENT-CREDITS.md`).

**Generated textures, `scripts/textures/prepare.ts`.** Takes raw image-model candidates, scores them for baked
lighting, clipping and saturation drift, flattens low-frequency light, makes them tile (mirror, cosine cross-blend or
symmetric clamp), packs colour + roughness and a luminance-derived detail normal, and writes 256 px WebP and
`packages/kit/textures/manifest.ts`. Outbreak's floors and walls. Also `paint-rooms.ts` (ray-traced interior-window
atlas) and `rug-sheet.ts`.

**Image → 3D props, `scripts/props/` (TRELLIS.2).** Image → TRELLIS.2 GLB on the Apple Silicon port (routed to
`mini`, never Studio) → Blender cleanup (orient, scale to the catalogue, decimate to two LODs, vertex colour and AO)
→ `.prop`. 26 props in 4.2 MB. Read `scripts/props/README.md`; `setup-trellis.sh` provisions the runtime and
`generate.ts` runs it. Meshes are blobby up close, thin panels tear and small text is mush: use them for background
props seen from Outbreak's camera, not held or inspected objects. Night Shift replaced its TRELLIS CRT, phone and
rolodex with authored models (`games/nightshift/scripts/author-hard-surface.py`) for this reason. The `arcade-props`
skill runs the pipeline end to end. The textured candidate (`kit-textured-props`) adds
`generate.ts --textured --texture-size 512`: density-normalised UVs, Cycles high-to-low base/normal/AO/ORM,
then lossless WebP GLB. Three regenerated furniture props use the shared instanced `TexturedMeshPass` in Outbreak
(Lab › Props › PBR textures, off by default); an authored cooler uses it in BARBARA's camp detail. The `.prop`
fallback and far LOD remain. WebP saves download bytes, not GPU memory: each 512² three-map set is about 4 MiB
with mips. Source albedo is transferred without new lighting; existing generated lighting is not removed.

**People, `scripts/people/`.** `build-people.ts` downloads MPFB 2 and the CC0 MakeHuman assets, runs
`build-person.py` in headless Blender per `cast.json` (body, clothes, hair, procedural beanies, packs, headlamps),
then tints, prunes and meshopt-compresses each GLB. Run it through `hivemind run --kind render`. See
[people.md](people.md) and [human-rig.md](human-rig.md).

**Procedural, `packages/kit/forest/`.** Trees, needle sprays, birch bark, flagging tape, buildings and
terrain are generated in code and mixed with Poly Haven scans; no licence, no download, any amount of variation.
Prefer code for anything repeated, seeded or parametric.

**Sound, `scripts/sfx/library.ts`.** `generate` asks ElevenLabs `eleven_text_to_sound_v2` for takes per id, `curate`
trims, slices, scores and contact-sheets them, `build` normalises and encodes Ogg Opus with per-file provenance in
`library-files.ts` ([sfx-library.md](sfx-library.md)). It cannot judge whether a sound is right: listen in the Lab.

## Close-up hero objects

Held props, maps, notes, instruments and anything the player brings to the face are judged at a few centimetres:

- **Print**: vector or procedural artwork (text, grid lines, scales, markings) rendered to a 2–4K texture, never
  image-generated.
- **Wear**: image-model material layers (folds, stains, grime, scuffs) composited over the print.
- **Geometry**: real folds, bevels and thickness, not a flat quad with a normal map.
- **Camera**: a viewmodel near plane so it never clips, anisotropic filtering (16×, as `renderer.ts`'s detail
  sampler) and a negative mip bias (`textureSampleBias`) so the print stays sharp at grazing angles.
- **TAA**: exclude it from temporal blur (reactive mask, `packages/kit/gpu/reactive.ts`) or the print smears as it
  moves.
- **Light**: lit by the in-world lights (flashlight, lamps), not drawn as a HUD overlay; it should go dark when the
  light leaves it.

## Licence of generated output

What we know, not legal advice:

- **Image model (OpenAI).** OpenAI's terms assign the output to us; Arcade treats generated images and textures as
  our own work and notes "generated with an image model" in CREDITS.md.
- **ElevenLabs.** Paid-plan output carries a commercial licence, indefinitely; free-plan output does not. The library
  records "ElevenLabs commercial sound-generation license (Anomaly)" per file.
- **TRELLIS.2.** Code and weights are MIT, the Apple port MIT, `mtldiffrast` the NVIDIA Source Code License, BiRefNet
  MIT; DINOv3 conditioning has Meta's own licence, to accept before relying on it commercially
  (`scripts/props/README.md#licences`).
- **Procedural and MPFB output** is ours, or CC0.
- **Copyright** may not protect purely machine-generated material (the US Copyright Office's position), so others
  may be free to reuse it. That does not stop us using it.
- Prompts must not name real brands, logos, products or people; Night Shift's props are unbranded period hardware.
