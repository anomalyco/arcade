# Boot architecture: what the time goes into, and the setup we should move to

Measured 2026-10-16 with `scripts/boot-profile.ts` (cold cache per run, `view=road`, 1728×1117). "Loaded laptop" =
`--cpu 4` (CDP 4× main-thread throttling, a fair stand-in for a MacBook shared with other agents' browsers and
builds). `--chrome` runs the installed Google Chrome in new headless mode, which has the real compositor; the default
headless-shell lets GPU work queue up unthrottled and flatters frame times.

## Findings

**Runtime procedural generation is not what makes boot slow.** At 4× CPU the whole boot spends (CPU profile, whole
run, ms):

| activity | ms | share |
|---|---|---|
| shader node building (TSL → WGSL) + pipeline setup | 7300–7800 | ~45% |
| frame loop while streaming (render + per-frame updates) | 4500 → 3600 after capping streaming frames to 15 fps | ~25% |
| texture JPEG decode + upload (57 scanned 2K maps, synchronous in `copyExternalImageToTexture`) | 2200–2600 | ~15% |
| browser internals, GC, other | ~2300 | |
| **world generators (all `build()`s: terrain, roads, compound, facility, interior, forest)** | **~630** | **~4%** |
| GLB model load/parse | ~260 | ~2% |

The scene compiles to **86 fragment / 100 vertex programs, 143 pipelines from 232 materials** (372 meshes, 45
clustered point lights + 3 shadowed spots). Each new program costs ~15 ms of main-thread JS at 1× (~60 ms at 4×), and
there is no cross-session cache for three's node building (Chrome does cache the compiled Metal shaders on disk, but
the TSL → WGSL step reruns every visit). **Shader count is the lever.**

Why "lights and trees appear 30 s late":

1. **Lights**: until today the boot kept each module's lamps hidden until that module streamed in (roads ~5 s,
   compound ~8 s, facility ~11 s at 4×). Fixed: lamps light the world from the first frame now.
2. **Trees and the rest**: streaming is limited by shader building on the main thread. Under 4× load, roads arrive at
   ~5.5 s and everything at ~12–15 s. Two more things made it worse and are now fixed: rendering at full rate during
   streaming took ~30% of the main thread, and JPEG decoding on the main thread ran during shader builds.
3. **Retina GPU cost** (post owner): at devicePixelRatio 2 the canvas is 3456×2234 and one frame is ~85 ms of GPU work
   (headless-shell, `onSubmittedWorkDone` after a frame) vs ~9.5 ms at 1536×1024@1×. In real Chrome that backs up
   rAF to ~12 fps, slows texture uploads and pipeline completion, and feels like "nothing happens".
4. The Vite dev server is **not** the cause: at 4×, prod (`vite preview`) boots in about the same time as dev
   (first frame 2.4 vs 2.0 s, all in 13.9–15.1 vs 11.7–13.6 s). The bottleneck is CPU work in the page, not module
   serving.

Current state (after today's boot changes), median ms from navigation:

| | headless-shell 1× | headless-shell 4× | Chrome (new headless) 4×, DPR 2 |
|---|---|---|---|
| first frame (terrain, fog, all lamps) | 600–900 | 1900–2000 | 2470–2530 |
| trees (forest) | 1500–1650 | 4100–4500 | 4250–4300 |
| roads | 1900–2100 | 5400–5900 | 5280–5360 |
| everything | 4100–4500 | 11400–13600 | 11500–12800 |

## Options

Expected numbers are for the 4× "loaded laptop" case unless noted; "boot" = everything in.

### (a) Today: generate at runtime, compile in the background

First frame ~2 s, everything ~12–14 s, steady frame cost set by post/lighting. Generators cost ~0.6 s total and are
not worth caching for boot time alone. Iteration: best possible (edit a generator, reload).

### (b) Offline bake (`scripts/bake.ts`), runtime only fetches and uploads

Bake the deterministic outputs: terrain heightmap and far mesh, forest instance buffers, impostor/billboard atlases,
procedural card and noise textures, merged static meshes per module as meshopt `.glb`, all textures as KTX2
(Basis UASTC/ETC1S).

- Boot: removes ~0.6 s of generators and ~2.4 s of texture decode (KTX2 transcodes in a worker and uploads
  compressed: ~4–8× less GPU memory than today's ~1.2 GB of RGBA8 mips). Merged static meshes cut objects
  (372 → ~60) and so per-object compile/bind overhead and per-frame CPU. **Does not reduce shader count by itself.**
  Expected: everything ~8–9 s at 4×, first frame ~1.5 s.
- Frame cost: fewer draw calls (406 today), less texture bandwidth; small but real.
- Effort: medium-high. A bake script that imports the same generator modules (they are already pure functions of
  `layout.ts` and seeds), writes `public/baked/<module>.<hash>.glb|bin`, and a loader that uses the bake when its hash
  matches.
- Iteration: generators stay the source of truth; the bake is a cache keyed by a hash of the generator sources,
  `layout.ts` and seeds. In dev a Vite plugin serves fresh bakes on demand (rebakes in the background when stale) and the
  runtime falls back to live generation when there's no matching bake, so editing a generator costs nothing extra.

### (c) Baked lighting for static lamps (lightmaps or an irradiance probe grid) vs real-time lights

- Boot: ~0. The 45 lamps are clustered point lights; point lights are excluded from three's lights cache key, so
  adding lamps never adds shaders. Lighting is not a boot problem.
- Frame cost: clustered shading is cheap; the expensive per-pixel lighting work is post's fog in-scattering
  (up to 16 lights per pixel at half res) and the 3 shadow maps. A probe grid / irradiance volume would *add* bounce
  light (quality win) at ~1 ms; full lightmaps need UV2 for every mesh, lose dynamic wet-surface specular from the
  lamps, and are a large asset-pipeline project.
- Effort: probe grid medium (bake from the same lamp list, sample in the uber material); lightmaps high.
- Recommendation: keep real-time lamps (flicker, flashlight, wet reflections are the look). Consider a probe volume
  later for quality, not speed.

### (d) Shader-count reduction and pipeline precompile — biggest win

One uber material per surface class instead of one per colour/model material: opaque PBR (texture array or atlas plus
a per-instance/per-vertex material id), alpha-tested foliage/cards, glass, emissive, terrain, decals, plus a few
genuinely special ones (wet asphalt, waxed lino). Model materials get remapped at load (or in the asset pipeline) onto
these classes.

- Boot: 86 → ~20–25 programs. Shader building ~7.5 s → ~2 s at 4×, so **everything in ~4–5 s at 4×, ~2 s at 1×**;
  first frame also gets faster because terrain + post compile fewer programs.
- Frame cost: neutral to slightly positive (fewer pipeline switches); more merging possible.
- Effort: medium. Mostly materials.ts plus how builders and the model loader pick materials; look can be kept
  identical by moving per-material constants into instance/vertex data.
- Precompile: already done (background `compileAsync` before each module is shown, nothing compiles in a frame after
  frame 1). There is no WebGPU API to persist pipelines across visits, so the only real "precompile" is fewer shaders.
- Iteration: unchanged.

### (e) HTTP caching / service worker

- Localhost boot: ~0 (fetches are not the bottleneck: JS 0.4–0.8 s at 4×, textures overlap with builds).
- Deployed site: large. Today a first visit pulls ~44 MB of textures + 19 MB of models. Immutable hashed
  URLs with long cache headers (Vite already hashes JS; route `textures/` and `models/` through hashed names or
  `?v=<hash>`) plus a service worker that caches the versioned asset list make repeat visits network-free.
- Effort: low (headers) to low-medium (SW). Iteration: SW must be off in dev.

### Other measured issue: Retina frame cost (post)

The GPU frame at DPR 2 is ~9× the 1× cost. TAAU already reconstructs from a lower internal resolution; output-
resolution passes (resolve, bloom, grade) at 3456×2234 dominate. Cap output DPR to 1–1.25 by default, or run every
pass except the final composite at internal resolution.

## Recommended setup

1. **Now (done):** progressive boot, background pipeline warm-up, lamps on from the first frame, streaming frames
   capped at 15 fps, off-main-thread texture decode (a stop-gap in `src/boot/textures.ts` until KTX2 lands).
2. **Next, biggest win, medium effort:** (d) uber materials, aiming for ≤25 programs.
3. **Then:** KTX2 everywhere + merged static meshes from (b), as a hash-keyed cache with live-generation fallback.
   Bake the forest first (its card textures are the costliest generator).
4. **Before deploying publicly:** (e) caching headers and a service worker.
5. **Not for boot:** (c) baked lighting. Maybe a probe volume later for bounce light.

Target on a loaded laptop: first frame ≤1.5 s, view complete ≤3 s, everything ≤5 s; ≤2 s for everything at 1×.

## Step plan by owner

- **Materials (`render/materials.ts`)**: finish the KTX2 switch (already under way: `public/textures/*/albedo.ktx2`,
  `surface.ktx2`) with `KTX2Loader` transcoding in a worker, then delete `src/boot/textures.ts`. Build the uber
  material classes and a `materialFor(class, params)` API that returns shared materials; move `noise()` (66 ms at
  1×) into the bake or precompute it.
- **Assets (`render/models.ts`, `scripts/fetch-models.ts`)**: at fetch time, collapse each GLB to ≤2 materials
  (atlas) with KTX2 textures inside (`KHR_texture_basisu`) and meshopt geometry; remap loaded materials to the uber
  classes. Today every model material is its own program (cars ~10 each).
- **Forest (`world/forest*`)**: make the generator bakeable: `buildForestData(seed, layout) → { instances, cardAtlas }`
  as pure data, so `scripts/bake.ts` can write `public/baked/forest.<hash>.bin` + KTX2 atlas. Runtime build should
  drop from 160–250 ms (1×) to <20 ms.
- **Facility / compound / interior / roads**: use shared materials (no per-colour `compound_flat_<hex>_…`
  materials: put colour in vertex/instance attributes), and merge static geometry per material per module
  (`mergeGeometries`) so each module is a handful of meshes. Keep `build()` pure and deterministic for the bake.
- **Lighting (`render/lighting.ts`)**: support lamps added after `createLighting` (scan `ctx.lamps` in `update`,
  glow buffer with spare capacity). Then lamp-bearing modules can build after the first frame. No lightmaps needed.
- **Post (`render/post.ts`)**: Retina cost (default output DPR cap ≤1.25 or internal-res passes); expose a "booting"
  hook so dynamic resolution ignores streaming frames (main.ts currently turns `post.autoRes` off until the world is
  in); keep a single G-buffer scene pass (the warm-up depends on it).
- **Boot (`main.ts`, `src/boot/`)**: bake loader + Vite dev plugin (hash check, live fallback), service worker for
  deployed builds, keep the streaming/warm-up path and `scripts/boot-profile.ts` as the regression check
  (`--cpu 4 --chrome --dpr 2`).
