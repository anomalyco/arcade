# Textured props candidate, 2026-10-23

Implemented on `kit-textured-props`, pending independent review and Kit's visual pick. No deployment claim.

## Delivery

- Shared `TexturedMeshPass`: cached static/instanced pipelines, 12-float instance records, matching yaw/scale
  shadow instances. Source geometry and material textures are shared across placements.
- Shared `TexturedPropBatches`: lazy loads visible IDs; pending/failed assets retain the `.prop` fallback.
  Outbreak offers **Props › PBR textures**, off by default; far LOD remains `.prop`.
- Outbreak supplies its actual lighting, fog, colour-rule, grade and shadow hooks. BARBARA supplies forest hooks;
  the cooler follows camp detail outside smoke. Neither adapter changes exposure or light power.
- Cycles selected-to-active transfers base colour, normal, AO, roughness and metallic from the source onto
  decimated, density-normalised UVs. ORM is one texture. Lossless WebP via glTF-Transform 4.3.0.

## Assets

All have three 512² maps, ~4 MiB GPU texture memory including mips, one material. Blender 5.2.2 LTS on mini.
Error is the sum of both directions' 90th-percentile surface distances divided by the source bounding diagonal.

| Asset | Triangles | GLB bytes | Error (limit .025) | UV coverage | Texels/m | Bake seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rotary phone | 2,968 | 929,736 | .001954 | 51.2% | 929.8 | 11.7 |
| TV | 6,914 | 1,280,820 | .000719 | 31.0% | 174.3 | 5.8 |
| Kitchen counter | 11,992 | 1,402,464 | .000077 | 32.0% | 129.1 | 5.1 |
| Camp cooler | 2,999 | 371,260 | .000278 | 57.1% | 360.7 | 9.6 |

The first three were regenerated from existing source images with the PBR TRELLIS route: 175.45, 209.97 and
163.91 s respectively, plus 9.56 s cold load. The cooler is original scripted geometry with four source materials,
bevels, inset lid, gasket, handles, feet and latch. It is not TRELLIS output. Source and output SHA-256 hashes live
beside the assets. UV packing initially wasted space (TV 3% coverage); pixel-based spacing raised it to 31%.

## Game-exposure proof

`scripts/props/textured-proof.ts`, headless/muted Chromium Metal through HiveMind on mini, 1280×900 High.
Production counter placement, with the TV and phone staged nearby by a proof-only Vite transform.

- Final aligned interior pair: seed 7, hour 21, zoom 18, player (33.2, 32.6), aim −π/2, same frozen sim time.
  All three textured IDs ready; no failed assets, browser errors or GPU errors.
- BARBARA: cooler beside the picnic table at (−18.25, 66.5), own torch on, production forest exposure 0.375.
  Loaded geometry has a shadow caster. The still is readable, with the existing warm beam/bloom.
- Rough ABBA GPU medians: final interior **6.779 → 6.862 ms (+0.083 ms)**; earlier close window view
  **5.444 → 6.317 ms (+0.873 ms)**. 16 retained samples per variant; substantial worker drift.
  Bracketed batch medians give −0.030 / +0.833 ms respectively. This is not a stable ≤0.4 ms result.
  Timings include changed geometry/materials and the whole scene. BARBARA's cooler delta was not measured.
- The first capture attempt stopped before timing because its harness did not request `timestamp-query`;
  fixed in the proof script. The first successful Outbreak pair clipped the counter at the top and advanced time
  between variants; the final interior-only run corrects both. BARBARA was captured once successfully.

Evidence: `artifacts/kit-textured-props-2026-10-23/index.html` on the gallery host, with raw reports and targets.
The kitchen cabinetry at the back is procedural and not one of the replacements; the counter is along the right wall.
Captures used main base `7d9cd092`; the final rebase includes `d3f4350e` (BARBARA's friend-halo correction).
Composed shader validation passed after that rebase; the stills were not repeated for the unrelated halo fix.

## Limits and decisions

- **Full-library memory gate unmet.** This batch is 16 MiB textures (12 MiB Outbreak, 4 MiB BARBARA), plus geometry.
  26 complete 512² sets would be 104 MiB, not 32 MB. WebP only compresses downloads; even KTX2 is currently
  decoded to RGBA by `gpu/gltf.ts`. Expanding the library needs 256² maps or native GPU compression/residency.
- **No de-lighting claim.** Base-only transfer avoids new baked lights but preserves any old generated lighting.
  Multi-view image conditioning and automatic intrinsic-image separation were not implemented.
- **Art quality is pending.** Textures retain detail but do not repair TRELLIS topology or guarantee a better look.
  The phone/counter remain dark outside the torch; the source target is not a guarantee of readable tiny detail.
  Outbreak stays opt-in. The authored cooler has no separately approved photographic target or hand-painted wear;
  its source/shape is a pipeline example. No motion stability proof was recorded (still/static-asset scope).
- **Licences:** BiRefNet, not RMBG-2.0. DINOv3's separate Meta licence remains documented; this task does not
  establish commercial acceptance. All procedural cooler geometry/materials are original.
- **Integration:** material hooks now run after texture sampling for the finish/wear branch. No changes to
  `gpu/mesh.ts`. CRT screens, emissive maps and lightmaps are outside this asset path.

## Checks

- Actual Naga compile: plain, physical, forest and three Outbreak textured shader variants; 3 tests, 23 expectations.
- Kit, Outbreak, BARBARA and root scripts typecheck; Outbreak import-cycle check passes.
- Targeted prop/architecture tests: 26 pass, 1,620 expectations. Script/typecheck runner tests: 8 pass.
- Asset tests inspect real GLBs: finite positions/normals/UVs, budget, one material, three 512² WebP maps,
  shared ORM/AO texture and per-file size limit. Architecture map is current.
