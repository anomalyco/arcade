# Performance audit: where the time goes, and what would actually help

Measured 2026-10-16 on frozen production builds (`vite build --outDir $TMP/…`, minified for timings, `--minify false`
for readable CPU profiles), headless Chromium 151 on Metal, Apple M5 (10 cores, 24 GB), 1536×1024 @1×, view `road`
unless noted. The machine was shared (load average 8–12 throughout), so absolute boot times move ±30% between runs;
ratios and counts are stable. Every number below comes from a script in `games/afterhours/bench/` (see
[Reproduce](#reproduce)). No game code was changed.

## TL;DR

- **Steady frame on an M5 at 1×: GPU-bound, with headroom.** GPU ≈ 8.4 ms/frame, main-thread CPU ≈ 4.3–5.5 ms, so
  ~120 fps is possible. On a loaded laptop (4× CPU throttling) the CPU side is 19–40 ms per frame and the game runs
  at ~24 fps: **CPU-bound, and almost all of it is three's per-object cost** (~10 µs per draw × ~475 draws).
- **Boot is main-thread-bound by three's TSL → WGSL node building:** 60–64% of main-thread time (3.3–5.2 s at 1×,
  27 s of a 49 s boot at 4×). The GPU-process shader compile (Tint + Metal) is off the main thread and not on the
  critical path (forcing it down from 255 to 94 pipelines changed boot time by 0). World generators are 0.7–1.0 s at
  1× (interior alone 0.5 s), textures and GLBs are ~0 now (KTX2/meshopt).
- **The biggest single cause of node builds is small `InstancedMesh`es: 160 of 297 builds** (interior 136,
  facility 19, compound 4, roads 1). three r186 keys every InstancedMesh's build by its uuid and, for ≤1024
  instances, bakes a uniform array of that size into a unique vertex shader. Doing the instancing so builds are shared
  (merged meshes, or instancing in the material on a plain Mesh) is measured at **41 → 2 builds** for 40 props.
  Expected: about half the node-build time, i.e. **−2 s at 1×, −13 s at 4× (interior visible ~20 s sooner)**.
- **Rust → WebAssembly: real but irrelevant speed-ups.** The terrain kernels run 1.5–2× faster in WASM (bit-exact
  port; SIMD adds nothing measurable), but they are ~30 ms of a 5–10 s boot (<1%), and the expensive generator
  (interior, 0.5 s / 3 s at 4×) spends its time inside three's geometry API, which WASM can't call. Not worth it.
- **A custom raw-WebGPU renderer would cut per-draw CPU ~25–70×** (0.14 µs vs 3.5 µs per draw in the microbench), but
  at 1× the game is GPU-bound, and merging/instancing fixes get most of the CPU win for a fraction of the effort.
  Not worth it now.

## Regression since first audit (2026-10-17)

Measured on frozen builds of HEAD `8e630c5b` plus the working tree at the time. Tools: `bench/draw-census.ts` (every
draw the renderer issues in one frame, after three's frustum culling, attributed to pass / module / sub-group /
material, with triangles) and `bench/boot-trace.ts` (node builds and new pipelines per module, long tasks).
1536×1024 @1×. Storey views stand at (−12, storeyY + 1.65, 1.1) facing −x, like the integration audit. The mirror
view stands 1.6 m in front of the lowest mirror. The cost model is the measured ~10 µs of main-thread CPU per draw
(×4 on a loaded laptop).

### What changed

| | first audit | now |
|---|---|---|
| draws per frame, outdoors (lot / gate / road / entrance) | ~475 (road) | **1049 / 1162 / 1175 / 718** |
| draws per frame, storeys s0–s4 | 250 (corridor) | 501 / 590 / 577 / 541 / 433 |
| triangles drawn | 2.9 M | 2.4–4.1 M |
| meshes in scene | 565 | 1631 |
| node builds at boot / render pipelines | 297 / 255 | **179 / 127**: the instancing fix landed, only 4 InstancedMesh builds are left |
| TSL node-build time (1×) | 3.3–5.2 s | 2.0 s |
| **boot complete (1×)** | 5.5–8.7 s | **48.6–51.4 s**; interior `build()` alone takes 43–45 s |
| **long tasks (1×)** | 235 ms worst | **13.8 s, 13.1 s, 10.3 s, 4.5 s, 2.5 s**: the page is frozen while the interior builds |

### Boot: one function regressed it ~7×

`separateDepth()` in `src/world/interior/kit.ts`, called from `Builder.flush()` and added in `3cd2b0da`, takes
**49 of the 53 s** of interior CPU (the CPU profile's self time is `test` 21 s, `near` 7 s, `overlaps` 7 s,
`separateDepth` 6 s). Its buckets are keyed only by axis | sign | plane offset quantised to 3.5 mm. Every coplanar
triangle on a storey (all the floor finishes at one y, all the walls on one grid line) lands in the same bucket, so
`test` runs O(n²) per plane. It is then repeated for up to 10 passes, synchronously, once per builder, which gives
the 10–14 s long tasks. The integration audit (at `011b6dca`, before this commit) measured 7.0 s to `complete`.

Node builds and new pipelines per module at boot (1×, everything after the instancing fix):

| module | node builds | new pipelines |
|---|---|---|
| interior | 71 (+4 InstancedMesh) | 50 |
| forest | 20 | 4 |
| roads | 17 | 9 |
| compound | 17 | 14 |
| facility | 12 | 9 |
| post / lighting / background / player body (fixed) | ~35 | ~35 |
| **total** | **179** | **127** |

### Frame: where the draws go

Scene-pass draws (triangles in parentheses). No shadow-map draws happened in the recorded frames (the maps aren't
re-rendered every frame). Post adds 20 quads.

| group | lot | gate | road | entrance | s0 | s1 | s2 | s3 | s4 |
|---|---|---|---|---|---|---|---|---|---|
| **interior: doors** (3 draws per door, ~61 tris each; storeys + core) | **413** (27 k) | 413 | 413 | 274 | 134 | 178 | 160 | 136 | 88 |
| **interior: storey static** (walls, floors, fittings per material) | **193 (1.75 M)** | 193 | 193 | 171 (1.74 M) | 62 (0.60 M) | 90 (0.82 M) | 96 (1.40 M) | 94 (1.14 M) | 66 (0.92 M) |
| **interior: washrooms** (11 meshes each, 2 per storey) | **110** (57 k) | 110 | 110 | 45 | 56 | 78 | 78 | 78 | 56 |
| interior: furniture `props` + `small` (own storey, full models) | 0 | 0 | 0 | 4 (190 k, LOD1) | 38 (0.68 M) | 31 **(1.84 M)** | 36 (0.85 M) | 26 (0.62 M) | 20 (0.13 M) |
| interior: core static + lift + mirrors + misc | 59 | 59 | 59 | 27 | 48 | 50 | 44 | 44 | 41 |
| facility | 110 (0.48 M) | 110 | 110 | 79 | 60 (0.35 M) | 60 | 60 | 60 | 59 |
| compound | 78 (0.38 M) | **190 (0.48 M)** | **198** | 33 | 17 (0.18 M) | 17 | 17 | 17 | 17 |
| forest (of which zero-triangle draws) | 66 (19) | 66 (10) | 66 (8) | 66 (45) | 66 (43) | 66 (43) | 66 (43) | 66 (43) | 66 (43) |
| roads | 13 | 14 | 19 | 12 | 13 | 13 | 13 | 13 | 13 |
| terrain + background + player body + sprite | 7 | 7 | 7 | 7 | 7 | 7 | 7 | 7 | 7 |
| **total scene draws** | **1049** | **1162** | **1175** | **718** | **501** | **590** | **577** | **541** | **433** |

Mirror view (washroom, s0): 282 scene draws, plus **80 draws (171 k tris) in the mirror pass**: 62 washroom, 11 doors,
6 player. The washroom reflect layer works.

### Drawn but shouldn't be

| finding | draws (tris) per frame | evidence |
|---|---|---|
| **Every interior door on every storey drawn from outside.** `interior.ts` shows every storey group when the camera is outside (`s < 0`), and each door is its own 3-mesh group (leaf `door_steel`, `interior_wire_glass`, frame) | 413 outdoors (35% of the frame), 88–178 indoors | `interior:doors` row |
| **All five storeys' static interiors drawn from outside**, though from the lot or the road they're only visible as lit windows | 193 (1.75 M) | `interior:storey-static` row |
| **Washrooms drawn from outside** (internal rooms, never visible), and from adjacent storeys | 110 outdoors, ~22 per extra storey indoors | `interior:washrooms` |
| **Forest drawing empty LOD buckets**: InstancedMesh layers with 0 instances still issue a draw | 8–45 | zero-triangle draws, all in `forest/tree-*-lod*` and `undergrowth-*` |
| **Forest drawn from inside the windowless spine** | 66 (110 k) on every storey view | forest row |
| **Transparent double-sided materials drawn twice**: three's transparent double pass (back faces, then front) for `side: DoubleSide`. Affects `shell-glass:facility_glass_clear` (7.4 k tris ×2), entrance glass, compound `fence-mesh*:flat_47`, car glass, `interior_s4_poly`, glass in props | 9–32 extra | `exactDuplicates` (same object and material, drawn twice per frame) |
| Heavy geometry: `interior_paint` merged meshes on storey 3 are 760 k tris (493 k + 266 k), storey 1 is 383 k. Storey-1 furniture full models are 1.84 M tris (one `props` mesh is 504 k), drawn even at the far end of the storey | GPU vertex load | top-triangle meshes. Probably rbox (`RoundedBoxGeometry` with 2 segments ≈ 300 tris per box); verify by counting tris per Builder call |
| Compound barbed-wire/fence `flat_46` meshes: 74 k tris per side, 296 k in total | 25 (296 k) | `fence#` |
| Compound booth: 36 draws for 4.6 k tris | 36 | `booth` |
| Pine needles: **not duplicated at draw level**. `facility-details:pine_needles` is one draw (4.3 k tris). The overlap scan's 587 m² is coplanar faces inside the double-sided shrub geometry; the cost is negligible | 1 | `pine` check |
| Documents: one merged draw per storey (6–23 k tris), 3 from outside. Fine; hide them with the storey static | 1–3 | `documents` |
| Mirrors: 12 tiny draws from outside, and a mirror pass of 80 draws only within 8 m. Fine | 12 | `mirrors` |
| Non-adjacent storeys from inside: **none** (the ±1 rule works) | 0 | `nonAdjacentStoreys` |

Lamps (`ctx.lamps`, budget ≤ 48 per interior zone):

- **interior:0 = 52**: 30 fluorescent, 12 incandescent, 5 window, 3 warning, 2 exit. Two window lamps at
  (33.6, 1.4, 17.6/18.3) are 0.68 m apart: merge them.
- **interior:3 = 51**: 29 fluorescent, 9 window (other storeys have 2), 7 incandescent, 5 warning, 1 exit.
- Exterior: 42 (28 sodium).

### Ranked actions by owner (expected savings)

Draw savings are converted at ~10 µs per draw of main-thread CPU at 1× and ~40 µs at 4×. All savings are
estimates from the census except boot, which is measured.

| # | owner | action | expected saving |
|---|---|---|---|
| 1 | **interior kit** (`kit.ts separateDepth`) | Make the coplanar-separation pass near-linear. Key the buckets by plane **and** a coarse 2-D cell (e.g. 0.5 m in u/v) so `test` only meets overlapping neighbours. Skip pairs whose bounding rectangles don't touch, and stop re-testing primitives that didn't move. Until then, yield between primitives (or between passes) so it doesn't block. Better still, run it in a worker or bake it. Re-check with `bun bench/boot-trace.ts --no-replay` (`longTasks`, `mod:interior:build:end`) | **boot −42 s at 1× (48.6 → ~6 s)**; removes the 10–14 s freezes |
| 2 | **doors** (`world/doors.ts`) + **interior** (`interior.ts`) | Don't draw interior doors from outside (keep façade doors). Indoors, draw doors only for the camera's storey and the neighbour storeys the stair/lift can see. Merge closed static leaves, glass and frames per storey per material, and swap a door to its own mesh only while it animates | −413 draws outdoors (**−4 ms/frame at 1×, −16 ms at 4×**); −60 to −130 indoors |
| 3 | **interior** (`interior.ts` outdoor visibility) + **each storey** | Outside the block, don't show storey static groups. Show a per-storey "window-view" proxy: lit rooms behind façade windows, merged to a few meshes per storey (the boot already has `proxy` for lit rooms). Or show only the storeys and rooms whose windows face the camera within ~40 m | −150 to −190 draws (−1.5 to −2 ms at 1×) and **−1.5 M tris** outdoors |
| 4 | **washrooms** (`interior/washroom.ts`) | Hide from outside. Merge each washroom's 11 meshes per material (keep the `-reflect` layer objects as they are) | −110 draws outdoors; −30 to −50 indoors |
| 5 | **interior props / assets** (`interior/props.ts`, `render/models.ts`) + **storey 1, storey 3** | Use LOD1 for furniture beyond ~10 m even on the camera's storey, or split `props`/`small` into room chunks culled by distance. Cut rounded-box segments (`kit.ts rbox`: 2 → 1, or a chamfer) for small boxes. Storey 1 (1.84 M tris of furniture) and storey 3 (760 k tris of `interior_paint`) first | −1 to −2 M tris on s1/s3 (GPU; the integration audit had s1/s3 as the heaviest interiors) |
| 6 | **forest** (`world/forest*`) | Set `visible = count > 0` on instanced layers after each rebuild. Indoors with no window in view, hide undergrowth and LOD0/LOD1 layers (keep impostors) | −8 to −45 draws everywhere; −40 to −60 indoors |
| 7 | **compound** (`world/compound/*`) | Merge the booth (36 draws) and gate hardware per material. Reduce the barbed-wire/fence `flat_46` tessellation (296 k tris; fewer radial segments, or a distance LOD). Make `fence-mesh` single-pass (see 8) | −30 to −50 draws at gate/road, −200 k tris |
| 8 | **materials** (`render/materials.ts`) + **facility / compound / interior** glass owners | Give double-sided transparent materials `forceSinglePass = true`, or use `FrontSide` for thin glass. Today three draws every one of them twice | −9 to −32 draws per view |
| 9 | **facility** (`world/facility*`) | Merge `facility-details`/`facility-props` sub-meshes per material (23 + 23 draws). Hide fire-escape and roof details beyond ~80 m | −20 to −40 draws outdoors |
| 10 | **lighting** (storey owners for the counts) | s0: merge the two window lamps at (33.6, 1.4, 17.6/18.3) and drop 2 of the 3 warning lamps or fold 2 incandescents → 48. s3: merge the 9 window lamps to ≤5 → 47 | both storeys back under the 48 budget |
| 11 | **roads, terrain** | No regression (13–19 and 2 draws) | – |
| 12 | **documents, mirrors** | Fine as they are; hide them from outside with the storey static (3 + 12 draws) | −15 draws outdoors |
| 13 | **boot** (`main.ts`, `src/boot/*`) | Gate merges on `bench/boot-trace.ts`: `longTasks.top[0]` < 300 ms, node builds ≤ 180, `boot:complete` < 8 s at 1× | prevents the next 7× regression |

Combined, actions 2–4 and 6–9 should bring outdoor views from ~1050–1175 draws to roughly 350–450. That's about
−7 ms of main-thread CPU per frame at 1×, so the loaded-laptop case would go from ~24 fps to the target.

## 1. Baseline

### 1.1 Steady-state frame

`bench/frame-profile.ts` (instruments the renderer, then pauses the game loop and measures GPU throughput by issuing
frames back to back; per-pass timestamp queries are unusable on Apple/Dawn: every pass, even a 48×32 bloom blur,
reads ~5 ms because Metal timestamps at pass boundaries measure queueing, so GPU cost comes from throughput and
ablation instead).

| 1536×1024 @1× | road | lot | corridor |
|---|---|---|---|
| main-thread CPU per frame (median, minified) | 5.0–5.5 ms | 6.5 ms¹ | 3.9–4.5 ms |
| of which the scene pass (`renderer.render` of the G-buffer pass) | 4.3–4.7 ms | 5.8 ms | 3.0–5.5 ms |
| draw calls per frame | 475–527 | 397 | 250–280 |
| render passes per frame (scene + 19 post) | 20.5 | 20.4 | 20.8 |
| **GPU ms per frame (pipelined throughput)** | **8.4** | – | **7.2** |
| bare scene pass straight to canvas, pipelined | ≤4.4 (CPU-bound) | – | ≤3.7 |
| **Bottleneck** | **GPU** (≈2× CPU) | | **GPU** |

¹ unminified build. Scene: 565 meshes (430 visible), 160 InstancedMesh, 200 materials, 437 geometries, 185 lights
(3 shadowed), 2.9 M triangles drawn.

Main-thread CPU per frame by stage (sampled profile, road, ms per frame):

| stage | ms |
|---|---|
| three: per-object uniform/binding updates (`NodeFrame.update`, `updateForRender`, `updateByType`, `_updateBindings`) | 2.45–2.98 |
| three: `_renderObjectDirect` and render-object lookup / pipeline checks | 1.2–1.9 |
| WebGPU encoding (setPipeline/setBindGroup/setVertexBuffer/draw) | 0.39–0.54 |
| `queue.writeBuffer` (uniform uploads) | 0.33–0.42 |
| `updateMatrixWorld` | 0.27–0.43 |
| frustum cull + render list | 0.13–0.18 |
| submit / begin pass | 0.17–0.20 |
| everything outside `render` (all world-module `update`s, lighting, atmosphere, post JS) | 0.40–0.44 |

So ~90% of frame CPU is three walking ~475 render objects (≈10 µs each; the same work for a simple
`MeshStandardNodeMaterial` costs ~3.5 µs, the game's materials carry more uniform groups, textures and lights). The
post chain costs ~0.5 ms of CPU for 19 passes.

GPU ablation (pipelined ms/frame, road; ±0.5 ms noise):

| config | road | corridor |
|---|---|---|
| baseline | 8.4 | 7.2 |
| SSR off | 7.9 | 6.6 |
| GTAO off | 8.5 | 6.5 |
| fog scattering off (0 lights) | 8.6 | 7.0 |
| TAAU off | 7.9 | (8.5, noise/rebuild) |
| bloom 0 | 8.4 | – |
| **render scale 0.5** | **5.1** | **4.6** |

GPU cost is mostly resolution-proportional fill (scene G-buffer + full-res post), no single effect dominates. The
dynamic-resolution path that already exists is the right lever; at the 1.25 output-DPR cap (1920×1280 canvas on
Retina) the measured cost was the same ±1 ms.

Loaded laptop (`--cpu 4`): CPU 19.4 ms per frame when submitting serially, 40 ms per rAF tick in the loop (scene
pass 37 ms), rAF interval median 41.9 ms (≈24 fps), pipelined 29 ms. **CPU-bound.**

### 1.2 Boot

`bench/boot-trace.ts` (CPU profile of the whole boot bucketed by activity, every WebGPU call hooked, three's node
builder hooked).

| | 1× (3 runs) | 4× CPU |
|---|---|---|
| first frame (GPU done) | 0.6–1.3 s | 2.8 s |
| everything in (`boot:complete`) | 5.5–8.7 s² | **49.3 s** |
| interior: built → shown | 4.7 → 8.6 s | 21.8 → 49.1 s |
| main-thread busy | 5.2–8.1 s | 49.2 s |
| **TSL node build (→ WGSL)** | **3.3–5.2 s (60–64%)** | **27.4 s (56%)** |
| frame loop while streaming (15 fps cap) | 0.5–0.8 s | 10.6 s (22%) |
| world generators (`build()`s) | 0.7–1.0 s | 5.0 s (interior 3.0, roads 0.28, facility 0.26, height bake 0.26, compound 0.18, forest 0.10, terrain 0.10) |
| GC | 0.35–0.7 s | 1.4 s |
| texture upload/decode, GLB parse | ~0.01 s | ~0 |
| `createShaderModule` + `createRenderPipeline*` calls (main-thread part) | 0.03 s | 0.17 s |

² The boot has grown since `docs/boot-architecture.md` (interior now has 282 meshes). Runs vary with machine load.

What the GPU sees during boot: **297 node builds → 292 shader modules (4.0 MB of WGSL) → 255 render pipelines**
(205 async, 50 sync), 203 textures (~360 MB estimated), 3010 buffers (147 MB). Async pipeline latency median 22–33 ms,
p90 52–63 ms (GPU process).

Node builds by owner and kind (1×, road):

| owner | InstancedMesh (≤1024, uniform path) | Mesh |
|---|---|---|
| interior | **136** | 38 |
| facility | **19** | 7 |
| compound | **4** | 13 |
| roads | **1** | 17 |
| forest | – | 30 |
| terrain | – | 3 |
| post/lighting/background (fixed) | – | ~33 |

Why there are 211 vertex programs: 145 of them are the shared model material `opaque`, one per small InstancedMesh.
Normalising literals and identifiers collapses the 211 vertex programs to **45** distinct shapes: they differ only in
the size of the baked `array<mat4x4<f32>, N>` and the generated buffer name (`bench/dump-shaders.ts`). Fragment
programs are already shared (65, ~42 KB each).

GPU-process compile, measured by replaying every captured pipeline descriptor with cache-busted WGSL:

| | ms |
|---|---|
| one pipeline at a time (Tint + Metal) | 60 median, 69 p90 → 15.2 s if serial |
| all 255 at once (GPU process parallelism) | **1.46 s** |
| Tint parse/validate only, all 281 modules | 0.33 s |

A/B with three forced onto the vertex-attribute instancing path (`--emulate attr`): shader modules 292 → 136,
pipelines 255 → 94, **boot complete unchanged** (5.48 → 5.46 s, 6.71 → 6.63 s). On Metal the driver compile
overlaps the main-thread node builds and is not the bottleneck; the node builds are.

**Verdict per view:** frame on M5 = GPU-bound (fill-rate); frame on a loaded laptop = CPU-bound (three per-object
overhead); boot = main-thread-bound (TSL node builds, then the interior generator and the streaming frame loop).

## 2. Ideas, measured

### 2.1 Rust → WebAssembly for generators

Bit-exact Rust port (`bench/wasm/src/lib.rs`, no wasm-bindgen, `rustc` wasm32-unknown-unknown, 34 KB) of the
terrain work: height-grid bake (`height.ts`: road distance stamping, 512² × 5-octave fbm, micro tile), near-patch
fill (`terrain.ts fillPatch`, 259² `heightAt` + normals + surface weights), far-mesh loop (321²). The JS side is a
frozen copy (`bench/kernels/terrain-js.ts`) verified to reproduce the live module's grids exactly (max diff 0).
Outputs match JS exactly (max diff 0; SIMD f32 path 2.5e-5).

| ms (median of 7, warm) | Bun 1.4 (JSC) JS | WASM | WASM SIMD | Chrome 151 (V8) JS | WASM | WASM SIMD |
|---|---|---|---|---|---|---|
| height bake | 41.0 | 18.0 | 16.0 | 27.3 | 18.6 | 21.6 |
| near patch fill | 4.2 | 2.2 | 2.5 | 4.9 | 2.4 | 4.0 |
| far mesh loop | 6.0 | 3.5 | 3.5 | 8.3 | 4.8 | 5.8 |
| 1 M `heightAt` calls across the JS↔WASM boundary | 39 | 18 | 19 | 48 | 32 | 25 |
| copy results out of WASM memory (`.slice()`) | | 0.12–0.32 | | | 0.20–0.29 | |
| instantiate | | 1–4 | | | 0.4–2.7 | |

Cold (first run, what a one-shot boot bake really pays, Chrome): JS 52 ms vs WASM 34 ms including fetch and
instantiate. In a fresh Worker: JS 47–59 ms vs WASM 40–42 ms.

- WASM is 1.5–2× faster per kernel in V8, ~2× in JSC; boundary-crossing and copy costs are negligible (<0.3 ms).
- SIMD128 brings nothing measurable: the bake is dominated by scalar road-distance stamping and the integer-hash
  noise vectorises poorly (i32x4 multiplies); noise on the shared machine is larger than the difference.
- **Real-world gain for this game: ~20–30 ms of boot at 1× (<0.5%)**, ~0.4 ms/frame while walking (the near patch is
  already spread at 48 rows/frame). The expensive generator, interior (526 ms at 1×), spends its time in three's
  object API: `BoxGeometry`/`RoundedBoxGeometry` construction, `applyMatrix4`, `Float32BufferAttribute`,
  `computeBoundingSphere`, merging; WASM can't call three, and rewriting it as a direct typed-array writer in plain JS
  would remove most of that cost anyway.
- Effort: high (second language, build toolchain, two sources of truth). **Not worth it.**

### 2.2 Workers, OffscreenCanvas, baked data

| measured (Chrome) | ms |
|---|---|
| module Worker startup to first message | 3–16 |
| transferring the three terrain grids back (2.3 MB, transferable) | 0.1–0.4 |
| decoding the same grids from a baked binary blob (copy + views) | 0.2 |
| baking them (cold JS) | 52 |

- Workers cost almost nothing to use for pure-data generators (forest placement and atlases already run in one).
  The candidates left are the interior's geometry building (0.5 s / 3 s at 4×) and the terrain bake/patch (~60 ms).
  Only pure typed arrays cross; three objects are created on the main thread from them.
- Baked blobs decode in ~0.2 ms vs tens to hundreds of ms of generation. This only pays off for the interior
  (and, as the boot doc says, for KTX2 card atlases); it doesn't touch the node builds.
- OffscreenCanvas (rendering in a worker) moves node builds and the frame loop off the main thread, which helps input
  responsiveness, but the same single thread still does the same work, so boot and frame times don't drop. It also
  complicates pointer lock, the Lab panel and DOM HUD. Not worth it now.
- SharedArrayBuffer needs COOP/COEP headers on the deployed Worker; transfer is already ~0.3 ms, so no gain.

### 2.3 Rendering CPU: three per object vs batching vs raw WebGPU

`bench/pages/bench.ts draws`: N boxes, 16 `MeshStandardNodeMaterial`s, 8 geometries, one light, all in view;
main-thread CPU per frame (median of 200):

| CPU ms/frame | N=250 | 500 | 1000 | 2000 | per draw |
|---|---|---|---|---|---|
| three: N `Mesh` | 1.01 | 1.43 | 3.79 | 7.04 | ~3.5 µs |
| three: same in a `BundleGroup` (render bundle) | 0.23 | 0.42 | 1.56 | 2.97 | ~1.5 µs |
| three: 16 `InstancedMesh` | 0.13 | 0.14 | 0.13 | 0.16 | flat |
| three: 1 `BatchedMesh` | 0.15 | 0.19 | 0.27 | 0.67 | ~0.3 µs |
| raw WebGPU, one bind group per object | 0.03 | 0.11 | 0.14 | 0.29 | ~0.14 µs |
| raw WebGPU render bundle (replay + uniform upload) | 0.01 | 0.015 | 0.015 | 0.03 | flat |

- three r186 offers all of these: `BundleGroup` (static subtrees recorded into a `GPURenderBundle`; it still loops
  over render objects for uniform refresh, which is why it isn't flat, and it doesn't frustum-cull inside the
  bundle), `BatchedMesh` (one render object; WebGPU has no multi-draw, so the backend loops `drawIndexed` per range),
  `InstancedMesh`, and indirect draws (`IndirectStorageBufferAttribute` → `drawIndexedIndirect`, for compute-driven
  culling).
- For this game: ~475 draws at ~10 µs ≈ 4.7 ms. Merging static geometry per material and collapsing small instanced
  props should bring the road view to roughly 150–200 draws → **−2.5 to −3 ms/frame at 1×, −10 to −12 ms at 4×**
  (estimate from the per-draw cost; not measured in-game). `BundleGroup` on the remaining static groups would roughly
  halve their per-draw cost again, at the price of no culling inside a bundle and a `needsUpdate` when contents or
  visibility change.
- A custom raw-WebGPU path for the static world would get per-draw CPU to ~0.1 µs, but it would have to reproduce
  the TSL materials, clustered lights, shadows, the MRT G-buffer layout and velocity that the post chain relies on.
  At 1× the frame is GPU-bound (8.4 ms GPU vs 4.7 ms CPU), so frame rate on the target machine would not change. GPU-
  driven culling in compute has the same problem: there's not enough geometry (2.9 M tris) for culling to matter on
  the GPU. **Not worth it** unless the loaded-laptop case stays CPU-bound after merging.

### 2.4 WGSL compile, TSL build, caching

| per object kind, 40 props × 5 copies (`bench/pages/bench.ts compile`) | node builds | node-build ms | vertex programs | pipelines |
|---|---|---|---|---|
| `InstancedMesh(count 5)` (what `instanceModel` does today) | 41 | 87–161 | 41 | 41 |
| same, capacity ≥1025 (vertex-attribute path) | 41 | 73–135 | **2** | **2** |
| same, `StorageInstancedBufferAttribute` | 41 | 72–119 | 41 | 41 |
| same, a material clone per prop | 41 | 70–111 | 41 | 41 |
| **merged into one plain `Mesh` per prop** | **2** | **3–4** | 2 | 2 |
| **plain `Mesh` + `InstancedBufferGeometry`, instancing in the material (`positionNode` from a named instanced attribute)** | **2** | **11** | 2 | 2 |
| merged meshes with a material clone per prop | 2 | 2.5–3 | 2 | 2 |

- Why: three's render-object cache key appends `object.uuid` for every InstancedMesh (so no node-build sharing,
  ever), and for ≤1024 instances the instance matrices become a uniform buffer whose length and name are baked into
  the WGSL (so no program sharing either). Plain meshes with identical material settings and attribute layout share
  one build regardless of how many there are, even with cloned materials.
- In the game a node build costs 11–17 ms at 1× (TSL time ÷ builds), 3–4× the microbench's simple material.
  Removing ~150 of the 160 instanced builds: **≈ −1.8 to −2.5 s main-thread at 1×, ≈ −13 s at 4×.**
- Hand-written WGSL instead of TSL would remove node building entirely, but the game has 64 distinct fragment
  programs averaging 42 KB of generated WGSL that depend on three's lighting, shadows, clustered lights and MRT; the
  driver compile (1.46 s parallel) would remain. Fewer builds gets most of the win. **Not worth it.**
- There is no WebGPU API to persist pipelines; Chrome already caches compiled Metal binaries on disk across visits
  (repeat runs compiled the same pipelines several times faster). three has no supported way to serialise a
  `NodeBuilderState`. The only cache that works is not building in the first place.
- On Windows (D3D12 via Dawn, DXC/FXC) driver compiles are typically much slower than Metal, so the capacity-≥1025
  stopgap (255 → 94 pipelines, measured) is worth having even though it doesn't move boot time on the M5.

### 2.5 Other

- Texture upload and GLB parsing are already solved (KTX2 transcoding and meshopt decoding already run in WASM:
  `basis_transcoder.wasm`, three's meshopt decoder); together ~0.01 s at 1×.
- The streaming frame loop (15 fps cap) is 22% of the main thread during a 4× boot (10.6 s). Frames at 4× cost
  ~40 ms, so 15 fps is ~60% duty when pipelines are being built. A lower cap (8–10 fps) or skipping the expensive
  post passes while streaming would give ~3–5 s back at 4×.
- Wasm GC / a WASM-hosted engine: no workload here that is JS-bound in a way WASM fixes; the hot loops are three's
  dynamic object graph. No.
- Timestamp queries: three's per-pass `trackTimestamp` results are meaningless on Apple GPUs (all ~5 ms) and its
  total is their sum (~99 ms). Use throughput (`frame-profile.ts`) or ablation (`--ablate`) to attribute GPU cost.

## 3. Ranked recommendations

| # | change | measured basis | expected gain (this game) | effort / risk | verdict |
|---|---|---|---|---|---|
| 1 | Stop creating one InstancedMesh per prop group: merge static instanced props into plain meshes per material (models all share `opaque`/`glass` over one atlas), or instance in the material on a plain Mesh | 160/297 builds are small InstancedMeshes; 41 → 2 builds in microbench | boot: −1.8–2.5 s at 1×, ~−13 s at 4×; interior shows ~20 s sooner at 4×; also −100+ draws, −150 vertex programs | low–medium / low (TAAU velocity: static props have none) | **do now** |
| 2 | Merge static geometry per material per module (compound 142 meshes, interior 282, facility 61, roads 23) | ~10 µs CPU per draw; 475 draws | frame CPU −2.5–3 ms at 1×, −10–12 ms at 4× (≈24 → ~40 fps loaded) | medium / low | **do now** |
| 3 | Interior geometry: write vertices straight into preallocated typed arrays instead of building/merging three geometries per part; then move to a worker or bake | 526 ms at 1×, 3.0 s at 4× in three's geometry API | boot −0.4 s at 1×, −2.5 s at 4× | medium / low | **do now** |
| 4 | Lower the streaming frame cap / skip heavy post while streaming | frame loop = 10.6 s of a 4× boot | boot −3–5 s at 4× | low / low (first view less smooth while loading) | **do now** |
| 5 | InstancedMesh capacity ≥1025 wherever InstancedMesh stays (stopgap) | 292 → 136 modules, 255 → 94 pipelines; boot unchanged on M5 | GPU memory, slower-driver platforms (Windows) | trivial / none | **do now** (cheap) |
| 6 | Share forest materials across kinds/LODs (tint per instance) | 30 forest builds | −0.3 s at 1× | low–medium | later |
| 7 | Uber materials (boot doc option d) for remaining Mesh builds (interior 38, roads 17, compound 13) | ~70 builds left after #1 | −0.8 s at 1× | medium | later |
| 8 | `BundleGroup` for the remaining static groups | 2.4× cheaper per draw in microbench | frame CPU −1 ms at 4× after #2 | medium / medium (no culling, invalidation) | later, if still CPU-bound loaded |
| 9 | Dynamic resolution stays the GPU lever (render scale 0.5 → −3.3 ms) | ablation | – | exists | keep |
| – | Rust/WASM generators (with or without SIMD) | 1.5–2× on ~30 ms of work | <0.5% boot | high | **not worth it** |
| – | Hand-written WGSL / custom raw-WebGPU renderer / GPU-driven culling | GPU-bound at 1×; driver compile not critical | none on target machine | very high / high | **not worth it** |
| – | OffscreenCanvas renderer, SharedArrayBuffer, Wasm GC | moves work, doesn't remove it; transfer already 0.3 ms | ~0 | medium–high | **not worth it** |

## 4. Action list by owner

- **Assets (`render/models.ts`)**: change `instanceModel` so it no longer returns an `InstancedMesh` per sub-mesh. For
  static props, bake the placements into one merged `Mesh` per sub-mesh/material (they share the `opaque`/`glass`
  materials and one atlas, so several models can even merge into one mesh per chunk). If memory matters for a
  high-count prop, use a plain `Mesh` with an `InstancedBufferGeometry` and do the instancing in the material
  (`positionNode` from a named per-instance attribute; mind normals and `positionPrevious`/velocity), which shares one
  node build per material (measured 41 → 2). Until then, allocate capacity ≥1025 and set `.count` (shares programs
  and pipelines: 255 → 94 measured). Re-measure with `bun bench/boot-trace.ts --no-replay` → `nodeBuildsBy`.
- **Interior (`world/interior/*`)**: 136 of the 160 instanced builds come from `placeModels` (one `instanceModel`
  per model per bucket): after the assets change, make one call per model per storey or for the whole building.
  Replace the per-part `BoxGeometry`/`RoundedBoxGeometry` → `applyMatrix4` → merge pattern in `kit.ts` (`box`,
  `rbox`, `boxM`, `cyl`, `paintVerts`, `uvFor`, `flush`) with appending transformed vertices straight into growing
  typed arrays (the profile's top self-time functions); then the builder is pure data and can run in a worker or be
  baked. Merge static meshes per material (282 meshes, 63 materials today).
- **Facility (`world/facility/props.ts`, others)**: 19 small InstancedMeshes (same fix via assets); merge static
  meshes per material (61 meshes, 44 materials).
- **Compound (`world/compound/*`)**: 142 meshes / 80 materials: put per-colour variation in vertex colours and merge
  per material; 4 instanced prop groups (assets fix).
- **Roads (`world/roads*`)**: 23 meshes with 23 materials and 17 builds: share materials where only constants
  differ, merge per material.
- **Forest (`world/forest*`)**: already instanced the cheap way (no InstancedMesh builds); 30 builds come from one
  material per kind × LOD × part. Move per-kind tint into an instance attribute and share foliage/trunk materials
  across kinds (~30 → ~6 builds). Placement and atlases already run in a worker; nothing to gain from WASM.
- **Terrain (`world/terrain*`, `height.ts`)**: no action needed (bake ~30–50 ms, near patch ~0.8 ms/frame spread
  while moving). If anything, the near-patch fill can move to a worker; WASM would only halve already-small numbers.
- **Materials (`render/materials.ts`)**: uber-material classes (boot doc option d) for the ~70 builds that remain
  after the instancing fix; keep material settings identical across meshes that should share a build (three keys
  plain-mesh builds by material settings, not identity).
- **Lighting / post (`render/lighting.ts`, `render/post.ts`)**: GPU cost is resolution-bound (render scale 0.5 saves
  3.3 of 8.4 ms; SSR, GTAO, TAAU, scattering, bloom each ≤0.6 ms). Keep dynamic resolution as the main lever; don't
  trust per-pass timestamp queries on Apple (use `frame-profile.ts --ablate`). The `?perf` handle
  (`__afterhoursRender`) made ablation possible; keep it.
- **Boot (`main.ts`, `src/boot/*`)**: lower `STREAMING_FRAME_MS` to ~8–10 fps or render a cheaper frame (skip
  SSR/GTAO/bloom) while modules stream; keep `scripts/boot-profile.ts` plus `bench/boot-trace.ts` as the regression
  check, with the node-build count (`nodeBuilds.count`, now 297) as the number to drive down (target ≤120).

## Reproduce

All scripts write only to `$TMP=$TMPDIR/ah-perf` and run one
headless Chromium (Metal, `--mute-audio`, never visible). Build first, from `games/afterhours`:

```sh
bunx vite build --outDir $TMP/build --logLevel warn                    # minified, for timings
bunx vite build --outDir $TMP/build-dev --minify false --logLevel warn  # readable profiles
```

| script | what |
|---|---|
| `bun bench/frame-profile.ts --dir $TMP/build --view road,corridor [--ablate] [--cpu 4] [--dpr 1,2] [--profile f.cpuprofile]` | steady frame: scene stats, CPU per stage, draws/passes, GPU throughput, scene vs post, ablation |
| `bun bench/boot-trace.ts --dir $TMP/build-dev [--cpu 4] [--no-replay] [--emulate attr]` | boot buckets, WebGPU call counts, node builds by owner, pipeline replay (driver compile cost) |
| `bun bench/draw-census.ts --dir $TMP/build [--views lot,gate,road,entrance,s0,s1,s2,s3,s4,mirror] [--out f.json]` | per-frame draws/triangles by pass, module, sub-group, material; flags (interior from outside, non-adjacent storeys, duplicates, zero-triangle and tiny draws, documents, mirrors); scene inventory; lamp census per zone |
| `bun bench/dump-shaders.ts --dir $TMP/build-dev` | every WGSL program to `$TMP/shaders`, why there are so many, instanced meshes per module |
| `bun bench/wasm/build.ts` | Rust → `terrain.wasm` / `terrain-simd.wasm` (needs `rustup target add wasm32-unknown-unknown`) |
| `bun bench/gen-bench.ts` | generators in Bun: JS vs WASM vs WASM SIMD, with exactness checks |
| `bun bench/browser-bench.ts [--only cold,worker,compile,gen,draws]` | the same in Chrome, plus Worker, compile-per-object-kind and draw-call benchmarks |

`bench/tsconfig.json` typechecks the bench (`bunx tsc --noEmit -p bench`); the game's own typecheck doesn't include it.
