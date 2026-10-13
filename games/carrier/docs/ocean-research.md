# Ocean: technique brief for `src/render/ocean.ts`

Target: `concept/shot-5-fleet.png`, `island-2-jungle-hero.png`, `island-4-cliffs-low.png`, `island-5-archipelago.png`.
What those images actually show:

- **Facets are real geometry.** Irregular triangles about 15–40 px across at every distance. They read as "many blues"
  because each facet catches a different amount of sky reflection, sun and scatter. Even the calm lagoons are faceted,
  so the variety has to come from per-facet tint and tilt as well as from the waves.
- Colours sampled from the concepts (final sRGB after grading):

  | where | colours |
  | --- | --- |
  | deep water | `#004472` `#004487` |
  | mid facets | `#1c5d94` `#196fb1` `#2274a3` |
  | turquoise shallows | `#1bc9cd` `#2dbec3` `#34d8cc` |
  | pale aqua near sand | `#5de5d4` `#54dddb` |
  | coral seen through water | `#228c90` `#25898d` (dark teal clumps about 5–15 m across) |
  | haze band at the horizon | `#6ba9d7` `#75baf1` |

- Foam is crunchy, broken-up white in long bands on the swell crests (finer than the facets), plus surf along reef
  edges and beaches. Glints are star-like HDR sparkles that bloom picks up, packed into a sun path that widens toward
  the horizon. The horizon is a crisp line: the sea there is slightly darker than the sky.

The recommendation below fits the existing contracts: `SEA_WGSL`, the `packSea` origin scheme, the Frame uniform,
reversed-Z with the far plane at 40 km, MSAA x4, and the HDR target with bloom.

---

## 1. Mesh and LOD pipeline

### Decision: camera-centred nested square levels, CDLOD-style morphing, faceting from the geometry itself

- **Rejected: projected grid.** Vertices resample the surface every frame, so flat facets boil. That is unusable for
  this look.
- **Rejected: per-pixel procedural facets.** Facet edges would be pixel edges that MSAA cannot antialias, and
  silhouettes at low camera angles would stay smooth.
- **Chosen: geometric facets.** MSAA x4 antialiases the facet edges for free, and lighting is constant inside each
  facet, so there is no specular aliasing within a facet.

### Lattice

| symbol | value | meaning |
| --- | --- | --- |
| `s0` | 0.5 m | cell size of level 0 |
| `s_L` | `s0 · 2^L`, `L = 0..12` | cell size of level L (level 12 = 2048 m cells, reaching ≥ 100 km, past the 40 km far plane at the frustum corners) |
| `N` | 64 | half-extent of a level in its own cells (each level is 128 × 128 quads) |
| `T` | 8 | tile size in quads. Each level is 16 × 16 tiles. A ring level draws 192 tiles; the innermost drawn level also draws its 8 × 8 hole tiles. |

- **One mesh, instanced.** A single 9 × 9-vertex tile (8 × 8 quads, 128 triangles) is drawn with one instanced
  `drawIndexed`. Each instance reads `{ globalIndex: vec2i, level: u32, rel: vec2f }` from a storage buffer.
  - `globalIndex` is the lattice index of the tile's corner in level-L cells (an i32, computed in f64 on the CPU).
  - `rel = globalIndex · s_L − sea.origin`, computed in f64 on the CPU and stored as f32, so it is always a small number.
- **CPU per frame.** Build the tile list, frustum-cull each tile's AABB (y ± 6 m), and upload it. That is roughly
  2.5k candidate tiles and about 600–900 drawn, around 150k triangles. Negligible.
- **Snapping, which removes swimming.** The centre of level L is `C_L = snap(cameraXZ, 2·T·s_L = 16·s_L)`. This puts
  each level on the tile lattice of the next coarser level, so the hole that level L+1 leaves for level L is always a
  whole 8 × 8 block of tiles. No L-shaped fixup strips are needed. Vertices sit on a world-anchored lattice, so moving
  the camera never moves a facet.
- **Guaranteed coverage.** Since `|C_L − cam| ≤ 8·s_L`, level L always covers Chebyshev distance up to 56·s_L from the
  camera, and level L−1 never reaches past 36·s_L.
- **Morph band.** Morph is driven by the continuous camera position, not by the snapped centre:

  ```
  d = max(chebyshev(p_lattice − camXZ), camHeight)
  m = saturate((d / s_L − 36) / 20)   // 0 at 36 cells, 1 at 56 cells
  ```

  Level L is unmorphed wherever it can meet L−1, and fully morphed wherever it can meet L+1. Where two levels meet they
  are therefore identical, so there are no cracks and nothing pops when a level re-snaps.
- **Altitude.** Because `camHeight` is included in `d`, climbing smoothly morphs the whole sea coarser. Skip level L
  once `camHeight ≥ 56·s_L` (it is then fully morphed, and exactly equal to level L+1). The finest drawn level fills
  its hole.
  - Camera at 10 m: level 0 is drawn, with nadir facets of 0.5 m.
  - Camera at 3 km: level 7 is the finest drawn (64 m cells), and nadir facets are about 22 px.
- **Facet size on screen.** A level spans 32–64 cells of distance, so a facet subtends 1/32 to 1/64 rad. With a 50°
  vertical FOV at 1080p (about 1240 px/rad), that is 19–39 px, matching the concept. `N` is the "facet size" knob:
  - N = 48 gives bigger facets.
  - N = 96 gives finer ones. Keep N a multiple of 2T. The morph band becomes `[N/2 + T/2, N − T]` cells.

### Irregular triangles (stable)

- **Jitter.** Each lattice vertex is offset by `s_L · 0.3 · (hash2(g, L, seed) − 0.5) · 2`, where `g` is the global
  lattice index. This is a deterministic integer hash of the lattice index, so it is identical on every client and
  across origin re-snaps.
- **CDLOD morph with jitter.** Odd-index vertices collapse onto their lower even neighbour (Strugar's CDLOD rule). Even
  vertices move from the level-L jitter to the level-L+1 jitter. One formula covers both:

  ```wgsl
  let odd     = vec2f(g & vec2i(1));
  let pFine   = pLattice + s * jitter(g, L);
  let pCoarse = (pLattice - odd * s) + 2.0 * s * jitter((g - vec2i(odd)) >> vec2u(1u), L + 1u);
  let p       = mix(pFine, pCoarse, m);   // rest position relative to sea.origin
  ```

  - WGSL `>>` on i32 is an arithmetic shift, so this floors correctly for negative indices.
  - Use the same quad diagonal everywhere (for example, always v00–v11). With a uniform diagonal, the collapsed fine
    mesh is exactly the coarse mesh. A union-jack pattern breaks that, and the jitter hides the regular diagonal anyway.
  - At m = 1 some fine triangles become zero-area and are not rasterised. Slivers near m = 1 need the degenerate-normal
    guard in §4.

### Wave detail versus distance (per vertex, band-limited)

- **Displacement, gradient and Jacobian are all evaluated per vertex**, in a filtered copy of the `SEA_WGSL` loop that
  lives in `ocean.ts`. That is fine because the faceted look wants per-facet normals anyway.
- **Filter weight per wave.** With `cell = s_L · (1 + m)`, which is continuous across the morph band:

  ```
  f_i = saturate(π / (k_i · cell) − 1)   // 1 when λ ≥ 4·cell, 0 when λ ≤ 2·cell
  ```

  Multiply `A` and `Q·A` (and the derived terms) by `f_i`. Approximate horizontal reach:

  | wave | survives to |
  | --- | --- |
  | 8 m chop | ~200 m |
  | 40 m chop | ~1 km |
  | 90 m swell | ~2 km |
  | 300 m swell | ~7 km |
- **Keep the lost slope as roughness.** Accumulate `σ²_lost += (1 − f_i²) · 0.5 · (A_i k_i)²` and pass it to the
  fragment shader as a varying. It widens the sun lobe, turning far-field glints into the broad glitter path toward
  the horizon instead of a mirror. (This is Atlas's and LEAN mapping's insight.)
- **Optional fragment band-split ("high" quality only).** Add the analytic slope of waves that the mesh dropped but the
  pixel can still resolve, weighted by `(1 − f_mesh) · saturate(π / (k · 2·footprint) − 1)`. Here `footprint` is
  metres per pixel, from `fwidth(p)`. This keeps swell banding readable as smooth shading where facets are tiny. It is
  a 16-iteration loop with uniform bounds.
- **Shallow damping.** In the vertex shader, `textureSampleLevel` the seabed at the rest position and scale every wave
  by `saturate(depth / 12 m)`. This calms the lagoons like the concepts and keeps swells from poking through low
  beaches. It is deterministic, because `seabedAt` is shared. If ship physics ever runs in water shallower than 12 m,
  mirror the factor in `sea.ts` using `seabedAt`.
- **Vertex outputs:**

  | output | meaning |
  | --- | --- |
  | `rel` | camera-relative position = `originToEye + vec3(p.x + D.x, D.y, p.y + D.z)` |
  | `p` | rest position |
  | `y` | height |
  | `foam` | crest foam |
  | `sigma2` | lost slope variance |
  | `nSmooth` | smooth normal from the filtered gradient |
  | `cell` | `s_L · (1 + m)` |
  | `facet` | per-facet hash, `@interpolate(flat)` |

  The clip position is `O.viewProjRel * vec4f(rel, 1)`. `viewProjRel` is a camera-relative view-projection with a
  rotation-only view, uploaded in the ocean's own uniform; see §4.

### Per-facet identity without `primitive_index`

`primitive_index` is not baseline WebGPU, so use the provoking vertex instead. Order each quad's triangles as
`(v00, v10, v01)` and `(v11, v01, v10)`. Each vertex is then the first vertex of two non-adjacent triangles, and a
`@interpolate(flat)` `u32 hash(g, L)` gives a per-facet random value. Use it for ±6% brightness, a slight hue shift,
and a small normal tilt that slowly rotates over time. This is what makes calm lagoons still read as faceted.

### Horizon to 40 km and beyond

- **Fog.** At 1e-4 per metre, haze is 63% at 10 km and 98% at 40 km.
- **Below the horizon.** The sky pass should paint `seaHaze(dir)` for `dir.y < 0`. That covers the band between the
  far-plane cut (4.3° below the horizon when the camera is 3 km up) and the true horizon line.
- **Same haze colour for the ocean.** Use `seaHaze` as the ocean's own fog target. Then the cut is invisible, and the
  horizon is the crisp line between the sky's horizon colour and the slightly darker `seaHaze`, which is what the
  concepts show.
- **Defining `seaHaze`.** For example `hazeColor(dir) * vec3f(0.80, 0.87, 0.95)` plus the sun glow. Add it to
  `ATMOSPHERE_WGSL` (sky owner) so the sky and ocean share it.
- No earth curvature is needed.

---

## 2. Shading recipe (pseudo-WGSL)

```wgsl
// ---------- uniforms beyond SeaUniform (group 1 binding 1) ----------
struct Ocean {
  viewProjRel: mat4x4f,  // proj * view without translation
  originToEye: vec4f,    // sea.origin - eye (xyz), computed in f64, stored as f32
  camRel: vec4f,         // camera x, z relative to sea.origin; camera height; time = sea time mod 3600
  bed: vec4f,            // bed.x0 - eye.x, bed.z0 - eye.z, 1/bed.size, unused
  anchor: vec4f,         // sea.origin - (bed.x0, bed.z0): stable "world" frame for noise, so re-snaps never pop
  params: vec4f,         // s0, seed (as f32 bits / u32), facet tilt, glitter strength
}

// Palette, linear, tuned so the graded output lands on the sRGB swatches above.
const DEEP   = vec3f(0.004, 0.060, 0.230);   // scattered colour of deep water (-> #0b4f8e .. #004487)
const SSS    = vec3f(0.020, 0.380, 0.360);   // crest glow (turquoise)
const SAND   = vec3f(0.800, 0.740, 0.550);
const CORAL  = vec3f(0.050, 0.220, 0.140);
const FOAM   = vec3f(0.950, 0.980, 1.000);
const SIGMA  = vec3f(0.450, 0.070, 0.035);   // per-metre absorption: red dies by ~4 m -> turquoise, then cobalt

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  // 1) ALL derivatives first, while still in uniform control flow (see §4).
  let dX = dpdx(v.rel);
  let dY = dpdy(v.rel);
  let footprint = max(length(dpdx(v.p)), length(dpdy(v.p)));   // metres per pixel
  let q = v.p + O.anchor.xy;                                   // stable plan coords (bed-local metres)
  let foamN = foamNoise(q, O.camRel.w);                        // 0..1
  let foamW = fwidth(foamN);

  // 2) Faceted normal: the exact plane of this triangle.
  var nF = cross(dX, dY);
  nF = nF * sign(nF.y);                       // winding-independent; water normals always point up
  let lenF = length(nF);
  nF = select(v.nSmooth, nF / lenF, lenF > 1e-8);   // degenerate or sliver guard
  let facetPx = v.cell / footprint;                 // approximate facet size in pixels
  let facetFade = smoothstep(2.0, 6.0, facetPx);    // facets give way to smooth shading below about 4 px
  var n = normalize(mix(v.nSmooth, nF, facetFade));
  let h = hash3(v.facet);
  n = normalize(n + vec3f(h.x - 0.5, 0.0, h.y - 0.5) * O.params.z * facetFade);   // tilt about 0.06
  let tint = 1.0 + (h.z - 0.5) * 0.12 * facetFade;

  let V = normalize(-v.rel);
  let L = F.sunDir.xyz;
  let sun = F.sunColor.rgb * F.sunDir.w;
  let amb = F.sunColor.w;
  let NoV = max(dot(n, V), 1e-3);
  let NoL = max(dot(n, L), 0.0);

  // 3) Seabed, sampled at the DISPLACED plan position (depth must not ride the waves). Warp it for organic outlines.
  let bedUV = (v.rel.xz - O.bed.xy + warp(q) * 8.0) * O.bed.z;
  let bed = textureSampleLevel(seabedTex, linearClamp, bedUV, 0.0);   // explicit LOD: legal in any control flow
  let depth = bed.r * 40.0;
  let shore = bed.b * 300.0;

  // 4) Water body: Beer-Lambert over the seabed, blending into the deep-water scatter colour.
  let cosT = sqrt(1.0 - (1.0 - V.y * V.y) / 1.777);   // refracted view angle (n = 1.333)
  let path = depth * (1.0 + 1.0 / max(cosT, 0.3));    // down to the bed and back up
  let T = exp(-SIGMA * path);
  let cor = coral(q, depth, shore, footprint);
  let bedAlb = mix(SAND, CORAL * (0.7 + 0.6 * hash1(cor.id)), cor.mask);
  let bedLit = bedAlb * (sun * max(L.y, 0.0) * 0.8 + amb * F.zenith.rgb);
  var body = bedLit * T + DEEP * (sun * 0.35 + amb * F.zenith.rgb) * (1.0 - T);
  body *= tint;

  // 5) Subsurface crest glow (Atlas, GDC 2019). Facet normals make backlit wave faces light up whole facets.
  let H01 = saturate(v.y / HS);                               // HS = significant height, from the uniform
  let k1 = 1.2 * H01 * pow(saturate(dot(L, -V)), 4.0) * pow(0.5 - 0.5 * dot(L, n), 3.0);
  let k2 = 0.25 * pow(NoV, 2.0);
  body += SSS * sun * (k1 + k2) + SSS * sun * 0.15 * NoL;

  // 6) Sky reflection. Use a sky WITHOUT the sun disc: the sun is the specular term below. Mirror R below the horizon.
  var R = reflect(-V, n);
  R.y = abs(R.y);
  let skyR = skyNoSun(R);                                // add next to skyColor in ATMOSPHERE_WGSL
  let Fr = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  let Fs = min(Fr, mix(0.55, 0.85, facetFade));         // stylised cap: keep grazing water blue, not white
  var col = mix(body, skyR, Fs);

  // 7) Sun specular: GGX, roughness widened by the slope the mesh filtered away.
  let a2 = 0.0025 + v.sigma2 + (1.0 - facetFade) * 0.01;
  let Hv = normalize(L + V);
  let NoH = max(dot(n, Hv), 0.0);
  let dd = NoH * NoH * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159 * dd * dd);
  col += sun * min(D * Fr * NoL / (4.0 * NoV), 60.0);    // clamp keeps bloom stars bounded

  // 8) Glitter: deterministic micro-facet sparkles, limited to the broad sun path.
  col += sun * glitter(q, n, V, L, footprint, O.camRel.w) * O.params.w * wideLobe(n, Hv);

  // 9) Foam: crest Jacobian (with "memory") + reef/shore surf, broken up by a procedural foam texture.
  let surf = surfFoam(depth, shore, v.y, q, O.camRel.w);
  let cover = saturate(max(v.foam, surf));
  var fm = saturate((foamN - (1.0 - cover)) / max(foamW, 1e-4) + 0.5);   // antialiased threshold
  fm = mix(cover * 0.6, fm, smoothstep(0.5, 2.0, 1.5 / footprint));      // sub-pixel noise -> mean coverage
  col = mix(col, FOAM * (sun * (0.35 + 0.65 * NoL) + amb * F.zenith.rgb), fm);

  // 10) Haze toward seaHaze (sky owner adds it; the sky pass paints the same below the horizon).
  let dist = length(v.rel);
  col = mix(col, seaHaze(-V), 1.0 - exp(-dist * F.horizon.w));
  return vec4f(col, 1.0);
}
```

### Helper functions

All of these are deterministic: they depend only on stable plan coordinates `q`, the global lattice index, the seed,
and sea time. Use integer hashes; see §4.

```wgsl
// Crest foam with memory, in the VERTEX shader. The sea is a pure function of time, so "foam left behind by a crest
// that passed" is just the Jacobian foam at the same rest point a few seconds ago. In Gerstner rest space the crest
// moves on and the foam stays put, which is physically right. Phase at t - dt is theta + omega * dt, omega = sqrt(9.81 k).
var foam = seaFoamFiltered(p, cell, 0.0);
foam = max(foam, 0.75 * seaFoamFiltered(p, cell, 1.2));
foam = max(foam, 0.50 * seaFoamFiltered(p, cell, 2.6));
foam = max(foam, 0.25 * seaFoamFiltered(p, cell, 4.5));
// Filtered chop removes Jacobian energy far away. Rescale the thresholds by the kept variance:
// lo, hi *= sqrt(sigma2_kept / sigma2_total) (pass both totals in the uniform), so foam bands survive into the distance.

// Two-octave Worley-style "crunchy" foam texture: 1.4 m and 4.5 m cells, slight drift downwind.
fn foamNoise(q: vec2f, t: f32) -> f32 {
  let a = 1.0 - worleyF1(q / 1.4 + WIND * t * 0.05);
  let b = 1.0 - worleyF1(q / 4.5 - WIND * t * 0.02);
  return saturate(0.6 * a + 0.55 * b - 0.1);
}

// Surf lines from the seabed bake, tied to the real swell so they pulse as crests arrive.
fn surfFoam(depth: f32, shore: f32, y: f32, q: vec2f, t: f32) -> f32 {
  let shoal = smoothstep(0.4, 1.8, depth) * (1.0 - smoothstep(4.0, 9.0, depth));   // where the swell breaks
  // Lines travel shoreward. 7.2 s divides 3600 exactly, so the hourly wrap of camRel.w is seamless.
  let ph = shore / 22.0 + t / 7.2 + 0.35 * valueNoise(q / 45.0);
  let line = pow(1.0 - fract(ph), 6.0);                                             // sharp front, fading tail
  let crest = smoothstep(-0.2, 0.6, y / HS);                                        // synced swell crest passing
  let wash = 1.0 - smoothstep(0.0, 5.0 + 3.0 * sin(6.2832 * (t / 9.0 + valueNoise(q / 30.0))), shore);
  return saturate(shoal * line * (0.35 + 0.65 * crest) * 1.5 + wash * 0.9);
}
// Better reef surf: have the islands owner bake A = saturate(|grad depth| * k) into the seabed's spare alpha channel.
// Where it is high and depth < 6 m, the swell "hits the reef": multiply shoal by (0.5 + A).

// Coral: blobby low-poly clumps from Worley cell IDs, in a 1.5-12 m depth band, away from the beach.
fn coral(q: vec2f, depth: f32, shore: f32, footprint: f32) -> Coral {
  let c = worleyCell(q / 9.0);                       // nearest jittered cell: id, F1 distance
  let cluster = valueNoise(q / 70.0);                // patches of patches
  let pick = f32(hash1(c.id) < 0.25 + 0.45 * cluster);
  let band = smoothstep(1.0, 2.5, depth) * (1.0 - smoothstep(9.0, 14.0, depth)) * smoothstep(8.0, 25.0, shore);
  let blob = 1.0 - smoothstep(0.45, 0.7, c.f1);
  let aa = 1.0 - smoothstep(1.5, 4.0, footprint);    // fade to an average tint before the cells alias
  return Coral(c.id, pick * band * mix(0.35, blob, aa));
}

// Glitter: a random micro-normal per power-of-two cell (at least 3 px), flickering with sea time.
fn glitter(q: vec2f, n: vec3f, V: vec3f, L: vec3f, footprint: f32, t: f32) -> f32 {
  let cs = exp2(ceil(log2(max(0.6, 3.0 * footprint))));   // fixed: computed from footprint, not a branch
  let id = vec2i(floor(q / cs));
  let h = hash3u(id, u32(cs));
  let mn = normalize(n + vec3f(h.x - 0.5, 0.0, h.y - 0.5) * 0.5);
  let flick = 0.5 + 0.5 * sin(6.2832 * (h.z * 7.0 + t * (1.0 + h.z)));   // integer rates per hour: no wrap pop
  let r = dot(reflect(-V, mn), L);
  return smoothstep(0.9990, 0.9998, r) * flick * 40.0 * (1.0 - smoothstep(4.0, 12.0, footprint));
}
```

### Tuning order

1. Get the body colour ramp right with the sun off (deep → turquoise → aqua).
2. Add the Fresnel sky reflection. Add facet tint and tilt until calm lagoons read as faceted.
3. Add the sun specular, then glitter (bloom threshold permitting).
4. Add SSS.
5. Add crest foam, then surf.
6. Fog and horizon last, together with the sky owner.

Expose the constants on `globalThis.carrier` for live editing, like `grade` and `atmosphere`.

---

## 3. Extra detail layer: FFT or more Gerstner waves?

**Recommendation: no FFT. Add an optional 8-wave cosmetic "detail Gerstner" band, and put the remaining detail into
shading** (facet tilt, glitter, foam texture, fragment band-split).

### Why not FFT

- **Facets swallow sub-facet detail.** Near-camera facets are 0.5–2 m, so waves shorter than about 2–4 m cannot be
  represented, and FFT's main value is millions of short waves.
- **Cost and complexity.** It needs a compute pipeline every frame (spectrum update, two butterfly passes per
  cascade), cascades to hide tiling, and its repetition shows from 3 km up.
- **Physics divergence.** The CPU physics cannot cheaply mirror it, so the visible surface would drift from the
  buoyancy surface.
- **Determinism is not the problem.** `h(k, t) = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt}` with a seeded `h0` is a pure
  function of (seed, t) with no accumulation, so it would be network-consistent apart from sub-millimetre vendor
  rounding. It is simply not worth it for this art style.

### What to add instead

- **Detail band.** 8 Gerstner waves, λ 2–8 m, `kA` 0.03–0.05, `Q` 0.5, within ±70° of the wind.
  - Seed them from `seed ^ 0xde7a11` with the same mulberry32. Pack them like `packSea`: float64 phases relative to
    the snapped origin, wrapped to [0, 2π), in a second uniform array `detail: array<vec4f, 8>` plus shape.
  - Ownership: either add `makeSeaDetail` / `packSeaDetail` to `sea.ts` (sea owner) or keep them in `ocean.ts`.
  - The LOD filter means they only ever render on levels 0–2, within about 100 m of the camera. They add life to
    low-angle shots.
  - Heights are 1–6 cm, irrelevant to buoyancy, so physics ignores them. That is consistent because they are a
    deterministic function of (seed, synced time) and only cosmetic.
  - Feed their Jacobian into crest foam so foam frays near the camera.
  - Also include them in the `sigma2` bookkeeping, so their slope becomes roughness once they are filtered out.
- **Do not accumulate state per client.** No ping-pong foam textures, no wave-equation simulation for persistent
  effects. Two clients that joined at different times would see different foam. The foam-memory trick above replaces
  accumulation.
- **Future ship wakes.** If they ever need persistence, derive them analytically from the synced ship track history:
  a sum of decaying Kelvin-wedge segments from the last N seconds of positions. They should not live in a client-side
  texture.

---

## 4. Pitfalls: WebGPU, WGSL and large worlds

- **Camera-relative everything.** The Frame `viewProj` has the eye baked in. Feeding it world positions of about
  10 km makes vertices wobble by millimetres. Worse, `dpdx(worldPos)` near the camera has about 1 mm of f32 noise
  against roughly 1 cm per-pixel deltas at a 10 m camera height, which gives visibly noisy facet normals. So:
  - Compute `rel = (origin − eye) + p + D` from small numbers. `origin − eye` comes from the CPU in f64.
  - Use a rotation-only `viewProjRel` in the ocean uniform.
  - Take derivatives of `rel` only.
  - `applyFog`-style maths should use `rel` too.
- **Rest coordinates.** `p` must be built as `tile.rel + local · s` (small + small), never as `world − origin` in f32.
- **Far-ring wave precision.** Level 12 vertices sit up to about 100 km from the origin. Phase `k · d · p` stays
  accurate only because the filter has already removed short waves there (chop weight is 0). Skip waves with
  `f_i == 0` (the branch is uniform in the wave index, so it is fine), or the f32 phase of a 0.8 rad/m chop at 100 km
  turns to noise.
- **Stable noise across origin re-snaps.** `sea.origin` jumps by 1024 m. Never hash floor(p) directly:
  - Lattice hashes use the integer global index.
  - Procedural noise uses `q = p + anchor`, where anchor = `origin − bed.x0,z0`, so it is constant within a world.
  - Glitter and foam cell sizes are powers of two, at most 1024 m.
- **Integer hashes only.** Use pcg3d or xxhash32-style u32 hashes (Jarzynski and Olano). `fract(sin(x) · 43758)`
  hashes differ between GPUs and band at large inputs.
  - WGSL u32 arithmetic wraps at runtime, but constant expressions that overflow are compile errors.
  - Convert i32 indices with `bitcast<u32>()`.
- **Derivatives and uniformity.** `dpdx`, `dpdy`, `fwidth` and `textureSample` must run in uniform control flow, and
  Tint/Dawn rejects them after any branch on a varying.
  - Compute every derivative at the top of `fs`.
  - Use `select` instead of `if`.
  - Sample the seabed with `textureSampleLevel(…, 0.0)`. It is legal anywhere, and the bake has no mips anyway.
  - Avoid `discard`: it forces late-z on tile-based GPUs, and as a per-pixel kill under MSAA it opens seams.
  - In the vertex shader, only `textureSampleLevel` is allowed.
- **Faceted normals under MSAA.**
  - The fragment shader runs once per pixel at the pixel centre, which may be extrapolated outside the triangle on edge
    pixels. Derivatives of the interpolated `rel` are still the exact plane of that triangle, because helper lanes
    extrapolate the same plane.
  - Do not use `centroid` on `rel`: centroid shifts make derivatives inaccurate.
  - Do not enable per-sample shading: it costs 4× and gains nothing.
  - Procedural edges (foam, glitter, coral) are per-pixel, so antialias them with `fwidth`. MSAA only helps geometric
    edges.
- **Degenerate and sliver triangles.** CDLOD collapse produces zero-area triangles at m = 1 and slivers just before
  it. Guard the cross product's length, falling back to `nSmooth`. Flip by `sign(n.y)` instead of trusting the
  winding.
- **Flat interpolation.** `@interpolate(flat)` means `flat, first` (the provoking vertex is the first vertex) in core
  WebGPU. Compatibility mode allows only `flat, either`. That still works, but adjacent facets may occasionally share a
  tint.
- **Reversed-Z, far = 40 km.** Clip-space z is in [0, 1] with near mapped to 1. The sea beyond 40 km is clipped at
  the far plane, which is a plane, not a sphere, so at the frustum corners the mesh reaches about 57 km.
  - The sky pass must paint `seaHaze` below the horizon (§1).
  - Depth compare is `greater-equal` with clear 0, as the contract says.
  - Draw the ocean after the static island chunks in the opaque slot, so early-z rejects water under the islands.
  - Cull mode `back` is safe: with `Q·k·A ≤ 0.85` the surface is a height field and the camera is always above it.
    Verify the winding once.
- **Time.** `F.eye.w` wraps at 3600 s. Shader animation (surf period, glitter flicker, foam drift) must use whole
  cycles per 3600 s. Wave phases never use it: they come from `packSea` in float64 every frame.
- **Quick pitfalls.**
  - `pow` with a negative base is undefined: `saturate` first.
  - `normalize(vec3(0))` is NaN.
  - Sun specular at grazing facets can return inf: clamp it to about 60 before bloom.

### Cost estimate

- **Vertex shader:** about 100k visible vertices × (16 + 8 detail + 3 memory-foam evaluations × 16) ≈ 7M wave
  iterations, under 1 ms on an M1.
- **Fragment shader:** about 2M pixels; three Worley lookups (9 taps each) + one seabed tap + GGX + glitter. The
  optional band-split adds 16 iterations.

Quality knobs, cheapest first: drop the memory-foam samples; drop the band-split; drop to N = 48.

---

## 5. References worth reading

1. **Crest, SIGGRAPH 2017 Advances course** (Bowles et al.): https://advances.realtimerendering.com/s2017/index.html
   - The closest relative to §1: camera-centred clipmap rings with continuous LOD morph, a horizon skirt, scaling with
     camera height without pops, and dropping Gerstner wavetrains that are too short for each LOD.
   - Code: https://github.com/wave-harmonic/crest
2. **CDLOD** (Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps"):
   https://github.com/fstrugar/CDLOD
   - The exact morph rule: odd vertices collapse onto even neighbours as a function of camera distance. It is the
     reason level seams are watertight here.
3. **Atlas, GDC 2019** (Mihelich and Tcheblokov):
   https://gpuopen.com/gdc-presentations/2019/gdc-2019-agtd6-interactive-water-simulation-in-atlas.pdf
   - Subsurface scatter formula (k1–k4), roughness from filtered slope variance, why Fresnel and specular must not go
     mirror-like at distance, and foam from the Jacobian.
4. **Acerola's water** (GarrettGunnell/Water): https://github.com/GarrettGunnell/Water
   - Readable HLSL of the Atlas scatter, Beckmann specular, Fresnel and Jacobian foam.
   - The video "How Games Fake Water" (https://www.youtube.com/watch?v=PH9q0HNBjT4) covers analytic sum-of-waves
     normals and their pitfalls.
5. **Hash Functions for GPU Rendering** (Jarzynski and Olano, JCGT 2020): https://jcgt.org/published/0009/03/02/
   - Pick pcg3d / pcg2d for the jitter, facet tint, glitter, foam and coral hashes: fast, high quality, integer-only,
     and identical on every GPU.
6. **Flat shading from derivatives** (Hextant Studios): https://hextantstudios.com/unity-flat-low-poly-shader/
   - `normalize(cross(ddy(worldPos), ddx(worldPos)))` keeps vertices shared.
   - The alternative is ThinMatrix's LowPolyWater (https://github.com/TheThinMatrix/LowPolyWater): each vertex carries
     its triangle's other two vertices so the vertex shader computes the facet normal. Only worth it if derivative
     normals prove noisy, which they will not be in camera-relative space.
