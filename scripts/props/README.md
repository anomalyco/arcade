# Prop pipeline

Generated furniture and clutter for `@arcade/kit/props`: image → TRELLIS.2 GLB → Blender cleanup → `.prop` file.
The catalogue (ids, sizes in metres, placement, per-LOD triangle budgets) is `packages/kit/props/catalogue.ts`; the
files are `packages/kit/props/assets/<id>.prop`, served at runtime by `scripts/prop-assets.ts` (Outbreak and Lab).

Work files (source images, raw GLBs, previews, reports) live outside the repo, by default in
`~/code/home/artifacts/2026-10-16-props/` (`--work DIR` or `PROPS_WORK` to change).

## Steps

1. **Source images**, `scripts/props/source-images.ts`: one product shot per prop from `gpt-image-2` (1024², high),
   prompts in `sources.ts` in the paint-over palette, written to `<work>/source/` with `generations.jsonl`. The OpenAI
   call runs on pro; resolve the key locally and pipe it over (2password on pro cannot read its keychain over ssh):

   ```sh
   2password run --env "OPENAI_API_KEY=op://Automation/OpenAI API Key/credential" -- bun scripts/props/source-images.ts
   ```

2. **TRELLIS.2**, `trellis-batch.py` (via `generate.ts`, or alone): BiRefNet cutout (skipped when the source or cached cutout PNG already has alpha), image → 3D on the Apple Silicon Metal port at `~/code/experiments/image-to-3d/trellis2-mac` through the resident `trellis_worker.py` daemon (`low_vram=False`, 5-minute idle auto-unload), exported as a 40k-triangle GLB with a 2048² UV/PBR atlas (or `--vertex-color-only` for direct O-Voxel `COLOR_0`).
   - **Kit's fleet routing (default)**: `--worker mini` (or `--worker pro` fallback; `studio` is refused unless `ALLOW_STUDIO_TRELLIS=1`), one job at a time via `hivemind run --kind render --worker mini`.
   - **Standalone local Apple Silicon Mac**: pass `--worker local` (`bun scripts/props/generate.ts --worker local ...`) or invoke `trellis_worker.py` / `trellis-batch.py` directly after running `bash scripts/props/setup-trellis.sh`.
3. **Blender cleanup**, `blender-cleanup.py` (headless Blender 5.2, one process for all props):
   - drop floater islands, orient the front to game +Z (yaw from `fixups.json` or the long axis), scale to the
     catalogue size (footprint within ±12% of a uniform fit, height exact), pivot on the floor;
   - decimate candidates to each LOD budget and keep the one closest to the source: the source itself, the source
     with its small cracks filled (holes up to 24 edges), and only if neither fits the budget an octree remesh
     (depth 7, 8, 6, 5, each with a voxel pass and shreds under 0.4% dropped). The score is the 90th-percentile
     distance from source samples to the candidate (torn panels, lost legs) plus the reverse (webbing), over the
     bounding-box diagonal; `report.json` lists every candidate's score. At game budgets the source wins almost
     everywhere: the remesh that the first batch relied on closed or tore thin panels such as cabinet doors;
   - per-corner colour from the source texture or vertex `COLOR_0` (a short ray along the face normal, so a thin
     panel's front does not take its back's colour; nearest point as fallback), kit material from metallic/roughness,
     Cycles AO with a floor plane (only the LOD and the floor occlude);
   - write `.prop` (format in `packages/kit/props/format.ts`) and three preview renders to `<work>/preview/`.

```sh
bun scripts/props/generate.ts                           # all steps after source images (default --worker mini)
bun scripts/props/generate.ts --skip-trellis            # re-run cleanup only (2.5 min for 26 props)
bun scripts/props/generate.ts --ids bed,stove --force   # regenerate specific props
bun scripts/props/generate.ts --worker local --ids bed  # standalone Apple Silicon Mac (no HiveMind)
```

`generate.ts` writes `<work>/report.json` (per prop: TRELLIS seconds, remesh depth per LOD, triangles, bytes) and
lists failures. `bun test props/` in `packages/kit` checks every shipped file against the catalogue (2 LODs, floor
pivot, size within 16%, triangles within 2% of budget).

## Runtime Setup & Portable Patches (`scripts/props/patches/`)

The TRELLIS.2 runtime, Python `.venv`, and ~11.0 GB of 512-pipeline Hugging Face weights (`~/.cache/huggingface/hub`)
live outside Git. Our Stage 1 Apple Silicon changes are versioned in `scripts/props/patches/` alongside exact upstream
commit pins in `scripts/props/patches/manifest.json`:

| Repository | Upstream URL | Pinned Base Commit | Patch |
| :--- | :--- | :--- | :--- |
| `trellis-mac` | `https://github.com/shivampkumar/trellis-mac.git` | `d58628f4f5b9c3de8274cb110074154f4b31cef2` | `patches/trellis-mac.patch` |
| `TRELLIS.2` | `https://github.com/microsoft/TRELLIS.2.git` | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` | `patches/trellis2.patch` |
| `trellis2-apple` | `https://github.com/pedronaugusto/trellis2-apple.git` | `17347247c91c36c8cdc1896234983e878a457bba` | `patches/trellis2-apple.patch` |
| `mtlbvh` | `https://github.com/pedronaugusto/mtlbvh.git` | `6b2a0f63b476ad8225695d092902104beafd7f58` | — |
| `mtldiffrast` | `https://github.com/pedronaugusto/mtldiffrast.git` | `c9499ba2e4ed6849e95ce5da7aae5bf61addb528` | — |
| `mtlgemm` | `https://github.com/pedronaugusto/mtlgemm.git` | `566c133781ce4992de3f77c3a97dd6feaae9d013` | — |
| `mtlmesh` | `https://github.com/pedronaugusto/mtlmesh.git` | `7de3864f783407201486bf6c900a4bd76a4018a3` | — |
| `utils3d` | `https://github.com/EasternJournalist/utils3d.git` | `9a4eb15e4021b67b12c460c7057d642626897ec8` | — |

```sh
bash scripts/props/setup-trellis.sh                # clone pinned commits, apply patches, build .venv + Metal extensions
bash scripts/props/setup-trellis.sh --apply-only   # apply Stage 1 patches idempotently to an existing checkout
bash scripts/props/setup-trellis.sh --check-only   # verify base commits and patch applicability
```

### Ready-to-Paste Agent Prompt (`#arcade`)

Paste this prompt into an agent in an `arcade` checkout to generate a 3D model from any input image `<image>`:

```text
Generate a 3D GLB model from <image> using Arcade's Stage 1 TRELLIS.2 Apple Silicon pipeline:
1. Read `scripts/props/README.md` and `scripts/props/patches/manifest.json`.
2. If running on a standalone Apple Silicon Mac (not Kit's HiveMind fleet), ensure `~/code/experiments/image-to-3d/trellis2-mac` is provisioned by running `bash scripts/props/setup-trellis.sh` (requires Xcode Metal Toolchain and ~11 GB free in `~/.cache/huggingface` for the 512-pipeline weights on first run). If running on Kit's fleet, route the job to `mini` with `hivemind run --no-sync --kind render --worker mini` (never run heavy TRELLIS jobs on `studio`).
3. Run the resident worker on `<image>`:
   `~/code/experiments/image-to-3d/trellis2-mac/.venv/bin/python ~/code/experiments/image-to-3d/trellis2-mac/trellis_worker.py run --id <name> --image <image> --out-glb <out>/<name>.glb --fast-sampler --fill-interior --shape-seeds 3 --with-texture`
   (pass `--vertex-color-only` instead for an explicit legacy vertex-only source).
4. Render a quick 3-angle preview thumbnail (or run headless Blender cleanup if producing a `.prop`), and report:
   - Output GLB path and file size in KB
   - Raw vs simplified triangle count (`raw_tris` -> `out_tris`)
   - Total and per-stage seconds (`load_s`, `cutout_s`, `generate_s`, `bake_s`, `stages`)
   - Preview image path
```

## Fixups

`fixups.json`, per id: `yaw` (degrees, overrides the auto orientation), `candidates` (the mesh candidates to try, for
example `["octree 7"]`), `smooth` (normal smoothing angle, default 40°).

## Measured (2026-10-16 baseline vs 2026-10-17 Stage 1)

- **Baseline (2026-10-16)**: 71 s per asset on average (38–196 s; cutout 8 s, generation 52 s, texture bake 5 s), plus
  49.5 s to load the pipeline once per batch. The first 26 took 29 minutes.
- **Stage 1 (2026-10-17)**:
  - Pipeline load: **0.0 s** warm via resident `trellis_worker.py` (auto-unloads after 5 idle minutes; cold load cut from
    49.5 s to **17.7–20.0 s** by skipping redundant `initialize_weights` + `reset_parameters`, skipping unused `1024`
    cascade models, lazy-loading `BiRefNet`, and using `local_files_only=True` HF cache lookup).
  - **Stage 1A (lossless, bit-identical raw mesh `max_vert_abs_diff = 0.0`)**: `chesterfield-sofa` drops from **85.3 s**
    (plus 29.2 s CPU BiRefNet) to **44.5 s** (`generate_s`: 69.9 s → 30.1 s; `shape_dec_s`: 28.5 s → 2.4 s via
    vectorized `_CPUHashMap`; `cond_s`: 1.07 s → 0.20 s with `low_vram=False`).
  - **Stage 1B (8-step `[0.70, 1.0]` CFG + exterior voxel flood-fill + direct O-Voxel vertex colour sampling)**:
    - On Studio (`M5 Max`, measured before remote offload): `chesterfield-sofa` drops to **24.1 s** total (`sparse_s` 7.8 s, `shape_slat_s` 3.4 s, `tex_slat_s` 2.4 s, `shape_dec_s` 1.9 s, `tex_dec_s` 0.5 s, `bake_s` 3.9 s), with two-sided mesh distance `mean_rel = 0.0286` vs baseline.
    - On `mini` (`M4 Pro`, 64 GB, remote render worker under `taskpolicy -b`): `plate-stack` single-seed drops from **707.2 s** (`11,631` tokens, `10.44M` raw triangles) to **125.4 s** (**5.64× faster**; `shape_slat_s` 194.4 s → 20.4 s, `tex_slat_s` 111.5 s → 12.4 s, `shape_dec_s` 275.7 s → 30.8 s, `bake_s` 23.0 s → 3.3 s), and `chesterfield-sofa` Stage 1A is bit-identical (`max_vert_abs_diff = 0.0`) with Stage 1B surface distance `mean_rel = 0.0142` (`p90_rel = 0.0243`).
    - Regenerated weak props (`plate-stack`, `typewriter`, `book-stack`) on `mini` with Best-of-3 shape seeds + crack-closed exterior flood-fill: `plate-stack` surface error dropped `0.0175 → 0.0077` (`−56%`, hidden faces `20,257 → 8,733`), `book-stack` hidden faces dropped `14,239 → 3,640` (`−74%`), and `typewriter` LOD1 error dropped `0.0274 → 0.0227`.
- Blender cleanup: about 50 s for all 26.
- Output: 4.2 MB for 26 props, two LODs each, at 2–15k triangles for LOD0 and 400–4k for LOD1.

The first batch used 0.4–3k-triangle budgets and an octree remesh, which tore thin panels (cabinet doors, chair
slats). Six small props (typewriter, phone, books, boxes, plates, plant) were redone from chunkier pictures; the first
pictures had flaps, fronds and levers that shredded. Plates and the typewriter are still the weakest.

## Textured props

```sh
bun scripts/props/generate.ts --ids rotary-phone,tv-set,kitchen-counter --textured --texture-size 512 --worker mini
```

TRELLIS now defaults to a UV/PBR source; `trellis-batch.py --vertex-color-only` requests the older fast route.
Vertex-only cache entries regenerate when PBR is requested. `--skip-trellis` reuses a valid textured raw GLB.
The default cleanup still emits two-LOD `.prop`; `--textured` emits one LOD0 `.glb` alongside it.

The textured cleanup selects a decimated candidate within the catalogue budget and rejects two-sided p90 surface
error above 0.025 of its bounding diagonal. It normalises UV island density, packs with two-texel spacing, then
uses Cycles selected-to-active to transfer base colour, tangent normal, AO, roughness and metallic. AO/roughness/
metallic share one ORM image. Base and scalar passes use emission, so no new direct lighting enters the albedo.
Existing lighting in generated source colour remains; this is not an intrinsic-image de-lighting algorithm.

`@gltf-transform/cli@4.3.0` writes lossless WebP textures in the GLB. Three 512² RGBA maps with mips cost ~4 MiB,
regardless of compressed file size. All 26 at 512² would cost ~104 MiB, not the proposed 32 MB. The current
loader decodes KTX2 to RGBA too. A full-library rollout needs lower resolution or GPU-native compression/residency.

Runtime: `TexturedPropBatches` registers one pass per loaded prop, batching placements per material. Outbreak
opts in with `propTextures`; failed/loading assets and far LOD use `.prop`. BARBARA uses the forest hooks for an
authored cooler (source script `author-camp-cooler.py`). Textured instances accept yaw and uniform scale;
other rotations belong in glTF node transforms. Host material hooks apply after texture sampling.

Measured assets, game-exposure proof and remaining limits: [perf/textured-props.md](../../perf/textured-props.md).

## Licences

TRELLIS.2 code and weights are MIT (`microsoft/TRELLIS.2-4B`, `microsoft/TRELLIS-image-large`). The Apple Silicon port
(`shivampkumar/trellis-mac`, `pedronaugusto/trellis2-apple`, `mtlbvh`, `mtlgemm`, `mtlmesh`, `utils3d`) is MIT, and
`mtldiffrast` is under the NVIDIA Source Code License. The cutout uses `ZhengPeng7/BiRefNet` (MIT) instead of
`briaai/RMBG-2.0` (non-commercial), and image conditioning uses `camenduru/dinov3-vitl16-pretrain-lvd1689m`; DINOv3 has
its own Meta DINOv3 licence, so accept it at https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m before
relying on it commercially. The study is `~/code/home/artifacts/2026-10-14-local-image-to-3d.md`.
