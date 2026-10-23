# Textured props candidate, 2026-10-23

Outbreak's phone, TV and kitchen counter as textured GLBs, opt-in under **Lab › Props › PBR textures** (off by
default). Kit's visual pick is pending.

## Delivery

- Shared `TexturedMeshPass`: cached static/instanced pipelines, 12-float instance records, matching yaw/scale
  shadow instances. Source geometry and material textures are shared across placements.
- Shared `TexturedPropBatches`: lazy loads visible IDs; pending/failed assets keep the `.prop` fallback, far LOD stays
  `.prop`. Off, Outbreak draws exactly what it drew before (no textured pass exists).
- **Every look mode.** The renderer reports which scene shader it draws each frame (`PassContext.sceneVariant`:
  plain, noir, painterly or generic). A pass given `SceneHookVariants` compiles that variant's pipelines on first use;
  one material bind group layout per device fits them all. Outbreak's `outbreakTexturedSceneHooks()` is the level's
  own hooks in each variant, including its flat post-light material, so there is no shared specular and no
  textured-only lighting.
- **Furniture look.** `propLookHooks` grades the base map exactly as `propMesh` grades vertex colours (Rec. 601
  saturation in display space, then AO weighted into the base colour); brightness rides in the instance tint
  (brightness^2.2, through the new `SceneHooks.instanceVertex`). `TexturedPropBatches.setLook` takes the same
  `PropLook` Outbreak gives `PropModels` (brightness ×0.94, saturation ×1.16, AO floor 0.62).
- **Why the counter went black.** The old textured hooks dropped Outbreak's `postLightMaterial` (vertical tone,
  interior material and practical-light irradiance) and skipped the furniture brightness the vertex path bakes in
  (1.6 × 0.94). With both restored the counter matches its vertex version (stills below).
- Cycles selected-to-active transfers base colour, normal, AO, roughness and metallic from the source onto
  decimated, density-normalised UVs. ORM is one texture. Lossless WebP via glTF-Transform 4.3.0.

## Texel density

Map size comes from one library-wide target: the smallest power of two giving **256 texels/m** over the packed UVs,
`nextPow2(256 × √(surface area / UV coverage))`, clamped to 128–512 (`--texel-density`, `--max-texture-size`;
`--texture-size` pins one size). UV coverage counts because a 31%-packed sheet needs 1.8× the side of a full one.
The cap stays at 512 until textures are GPU-compressed (below): a 1024² RGBA set is 16 MiB.

| Asset | Triangles | GLB bytes | Error (limit .025) | UV coverage | Wants | Ships | Texels/m | GPU MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Rotary phone | 2,968 | 372,076 | .001954 | 31.2% | 256² | 256² | 363.3 | 1 |
| TV | 6,914 | 1,280,820 | .000719 | 31.0% | 1024² | 512² | 174.3 | 4 |
| Kitchen counter | 11,992 | 1,402,464 | .000077 | 32.0% | 1024² | 512² | 129.1 | 4 |

Re-baked on mini with Blender 5.2.2 LTS from the cached TRELLIS outputs (58 s for all three). The bake is
deterministic: the TV and counter came out byte-identical; the phone dropped from 512² (930 texels/m, 4 MiB) to 256².
The batch is 9 MiB of textures, down from 12 MiB. Error is the sum of both directions' 90th-percentile surface
distances divided by the source bounding diagonal.

## Memory: GPU-compressed textures (next step)

`gpu/gltf.ts` decodes every map, KTX2 included, to RGBA8: 4 bytes per texel, ~4 MiB for a 512² three-map set with
mips. Block-compressed formats are 1 byte per texel:

| Per prop, with mips | RGBA8 today | BC7 base + BC5 normal + BC7 ORM (or ASTC 4×4) |
| --- | ---: | ---: |
| 256² | 1 MiB | 0.25 MiB |
| 512² | 4 MiB | 1 MiB |
| 1024² | 16 MiB | 4 MiB |
| This batch (256, 512, 512) | 9 MiB | 2.25 MiB |
| 26 props at 512² | 104 MiB | 26 MiB (inside the 32 MB target) |

Plan: bake to KTX2 UASTC (normals as two-channel UASTC for BC5, AO stays in ORM's red), ship the Basis Universal
transcoder (WASM) with the loader, and transcode on load to BC7/BC5 where the device has `texture-compression-bc`,
ASTC 4×4 where it has `texture-compression-astc`, RGBA8 otherwise. The renderer must request those features at
device creation (`gpu/boot`), which touches every game, so it is its own change. With it the cap rises to 1024 and
the TV and counter reach the 256 texels/m target at 4 MiB each.

## Game-exposure proof

`scripts/props/textured-proof.ts`, one headless, muted Chromium Metal session through HiveMind on mini, 1280×900 High.
Production counter placement, with the TV and phone staged beside it by a proof-only Vite transform. Seed 7, hour 21,
zoom 18, player (33.2, 32.6), aim −π/2, frozen sim time; vertex and textured stills per look preset.

Mean brightness (0–255) over the counter and TV, vertex → textured:

| Look (scene variant) | Counter | TV |
| --- | --- | --- |
| Current (generic) | 47.4 → 55.8 | 116.5 → 118.1 |
| Noir (noir, default) | 43.7 → 49.9 | 111.8 → 109.6 |
| Painterly (painterly) | 61.4 → 69.4 | 126.9 → 128.7 |
| Cinematic dusk (generic) | 39.8 → 46.4 | 107.3 → 107.5 |

All three textured IDs loaded; no failed assets, browser or GPU errors. Outbreak keeps the look pipes on even for
"current", so it never draws the plain variant; the WGSL tests cover plain. The counter's textured top is slightly
brighter than its vertex version because the bake keeps wood grain the vertex colours average away.
GPU timings from this run are not usable: mini was fully booked and the per-look ABBA medians swung from −2.5 to
+4.1 ms. The previous round, on the old hooks and a quieter worker, measured +0.08 ms for this view.

Evidence: `artifacts/kit-textured-props-2026-10-23/index.html` on the gallery host (stills, crops, reports; the
previous round with the dropped BARBARA cooler is under `previous/`).

## Limits and decisions

- **BARBARA's scripted cooler is dropped.** It delayed world start and had no art target.
- **No de-lighting claim.** Base-only transfer avoids new baked lights but preserves any old generated lighting.
- **Art quality is pending.** Textures retain detail but do not repair TRELLIS topology. Outbreak stays opt-in.
- **Licences:** BiRefNet, not RMBG-2.0. DINOv3's separate Meta licence remains documented; this task does not
  establish commercial acceptance.
- **Integration:** host material hooks run after texture sampling. CRT screens, emissive maps and lightmaps are
  outside this asset path. Instances accept yaw and uniform scale only.

## Checks

- Naga 30.0.1 compiles the textured shader on Outbreak's hooks in all four scene variants with the furniture look,
  plus plain, physical and forest kit hooks. Naga now lives on mini (`~/.cargo/bin/naga`) and ios-devbox
  (`~/.cache/naga-cli/bin/naga`) as well as Studio and pro, so worker test runs validate WGSL instead of skipping it
  (checked on mini).
- `TexturedMeshPass` switches pipelines with the renderer's variant, compiles each once and keeps one bind group
  layout; `makeSceneShader` text is unchanged when `instanceVertex` is unset.
- Asset tests inspect the real GLBs: finite geometry, budget, one material, three WebP maps at each prop's size,
  shared ORM/AO texture and file size limit.
