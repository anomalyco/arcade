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

2. **TRELLIS.2**, `trellis-batch.py` (via `generate.ts`, or alone): BiRefNet cutout, image → 3D on the Studio's
   Metal port at `~/code/experiments/image-to-3d/trellis2-mac`, exported as a 40k-triangle GLB with 2048² base colour
   and metallic/roughness. One job at a time: `hivemind run --kind render --worker studio`.
3. **Blender cleanup**, `blender-cleanup.py` (headless Blender 5.2, one process for all props):
   - drop floater islands, orient the front to game +Z (yaw from `fixups.json` or the long axis), scale to the
     catalogue size (footprint within ±12% of a uniform fit, height exact), pivot on the floor;
   - octree remesh (depth 7) plus a voxel pass, because TRELLIS meshes are open and collapse decimation stalls on
     their holes. Shreds under 0.4% of the surface go. Each LOD takes the finest remesh that reaches its budget:
     depth 7, then 8, then the source itself, then 6 and 5. A thin wall riddled with voxel holes has a high genus,
     which sets a floor on decimation; a finer or coarser grid closes the holes;
   - per-corner colour from the source texture (nearest point, filtered to the triangle's size), kit material from
     metallic/roughness, Cycles AO with a floor plane (only the LOD and the floor occlude);
   - write `.prop` (format in `packages/kit/props/format.ts`) and three preview renders to `<work>/preview/`.

```sh
bun scripts/props/generate.ts                  # all steps after source images
bun scripts/props/generate.ts --skip-trellis   # re-run cleanup only (2.5 min for 26 props)
bun scripts/props/generate.ts --ids bed,stove --force
```

`generate.ts` writes `<work>/report.json` (per prop: TRELLIS seconds, remesh depth per LOD, triangles, bytes) and
lists failures. `bun test props/` in `packages/kit` checks every shipped file against the catalogue (2 LODs, floor
pivot, size within 16%, triangles within 2% of budget).

## Fixups

`fixups.json`, per id: `yaw` (degrees, overrides the auto orientation), `octree` (force one remesh depth, 0 for the
source mesh), `smooth` (normal smoothing angle, default 40°).

## Measured (Mac Studio, M5 Max, 2026-10-16)

- TRELLIS.2: 66 s per asset on average (38–104 s; cutout 8 s, generation 52 s, texture bake 4 s), plus 47 s to load
  the pipeline once per batch. 26 props in 29 minutes.
- Blender cleanup: 154 s for all 26 (1–29 s each; the slow ones fall back through several remesh depths).
- Output: 1,073 KB for 26 props, two LODs each.

Weak results to regenerate first: plate stack, typewriter, book stack, cardboard boxes (thin parts shred), and the
fern's fronds were lost, so `potted-plant` ships as a cracked plant pot.

## Licences

TRELLIS.2 code and weights are MIT. The port uses BiRefNet (MIT) for the cutout instead of RMBG-2.0 (non-commercial),
and DINOv3 from the `camenduru` mirror; DINOv3 has its own licence, so accept it at
https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m before relying on it commercially. The study is
`~/code/home/artifacts/2026-10-14-local-image-to-3d.md`.
