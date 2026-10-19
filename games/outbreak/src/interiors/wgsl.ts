/**
 * WGSL for baked rugs (material 25) and themed interiors (wallpaper and parquet on existing walls and floors).
 * Rugs carry their texture UV in the vertex colour (corners 0/1 survive the vertex shader's pow(2.2)), their
 * directory key in `aux`, and sample the renderer's detail texture array at bindings 15/16. Layer 0 holds the
 * packed interior tile masks; rug layers come from the directory in the game's own uniform block.
 */

/** Material id for baked rugs; Outbreak-local (not part of the kit `MAT` table). */
export const MAT_RUG = 25

/** Outbreak interior block appended to `OutbreakLightingUniforms` (offsets in floats from its start). */
export const INTERIOR_UNIFORM_FLOATS = 64
export const RUG_DIRECTORY_SLOTS = 9

export const interiorUniformFieldsWgsl = /* wgsl */ `
  rugDir: array<vec4f, ${RUG_DIRECTORY_SLOTS}>, // per stream slot: texture layer of rugs 0..3, -1 = not baked
  rugCfg: vec4f, // mip bias (log2), brightness, pile relief, painted plate (layer + brightness / 4, 0 off)
  bldTheme: array<vec4f, 2>, // theme id per window building (0..7)
  bldPlate: array<vec4f, 2>, // floor plate per window building: layer + brightness / 4, 0 none
  floorCfg: vec4f, // plate tile (m), decal density, decal strength, decal atlas layer (0 off)
  floorCfg2: vec4f, // skirting grime, decal seed, wall wear, unused`

/**
 * Kinds in the 4×4 decal atlas (`decals/floor-decals.webp`, row-major): 0 cup ring, 1 water stain, 2 mould,
 * 3 scuffs, 4 muddy prints, 5 mould spots, 6 blood pool, 7 blood spatter, 8 letter, 9 envelope, 10 newspaper,
 * 11 index cards, 12 burn, 13 tar, 14 dusty prints, 15 leaves. Thirty-two slots weight how often each turns up.
 */
const DECAL_SLOTS = [0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 3, 4, 4, 5, 12, 13, 14, 14, 14, 8, 8, 9, 9, 10, 10, 11, 15, 15, 6, 7]
const decalWords = [0, 1, 2, 3].map(w => DECAL_SLOTS.slice(w * 8, w * 8 + 8).reduce((acc, k, i) => (acc | (k << (i * 4))) >>> 0, 0))
const hexU = (n: number) => `0x${n.toString(16)}u`

export type InteriorWgslRefs = {
  /** Expression returning the directory vec4 for a slot `s` (i32). */
  dir: (s: string) => string
  cfg: string
  /** Expression returning the theme id (f32) of building index `i` (i32). */
  theme: (i: string) => string
  /** Expression returning the floor plate (layer + brightness / 4) of building index `i` (i32). */
  plate: (i: string) => string
  /** The floorCfg and floorCfg2 vectors. */
  floor: string
  floor2: string
  /** Number of buildings to search and the rect of building `i`. */
  buildingCount: string
  buildingRect: (i: string) => string
  /** Flashlight origin in plan (vec2f) for the pile rake. */
  flashXZ: string
  /** True when the hand-built origin houses (and their tiled kitchens) are on screen. */
  classicLayout: string
  /** Whether building `i` (i32) of a streamed window is a hand-built origin house with a tiled kitchen. */
  authoredKitchen: (i: string) => string
}

export const outbreakInteriorRefs: InteriorWgslRefs = {
  dir: s => `OL.rugDir[clamp(${s}, 0, ${RUG_DIRECTORY_SLOTS - 1})]`,
  cfg: "OL.rugCfg",
  theme: i => `OL.bldTheme[clamp(${i}, 0, 7) >> 2][${i} & 3]`,
  plate: i => `OL.bldPlate[clamp(${i}, 0, 7) >> 2][${i} & 3]`,
  floor: "OL.floorCfg",
  floor2: "OL.floorCfg2",
  buildingCount: "i32(OL.win.w)",
  buildingRect: i => `OL.bldRects[clamp(${i}, 0, 7)]`,
  flashXZ: "OL.u3.xy",
  classicLayout: "OL.win.z < 0.5",
  authoredKitchen: i => `((u32(OL.u17.w) >> u32(8 + clamp(${i}, 0, 7))) & 1u) == 1u`,
}

export function interiorDeclarationsWgsl(r: InteriorWgslRefs): string {
  return /* wgsl */ `
@group(0) @binding(15) var detailTex: texture_2d_array<f32>;
@group(0) @binding(16) var detailSamp: sampler;

fn rugLayer(key: i32) -> f32 {
  let e = ${r.dir("key >> 2")};
  let k = key & 3;
  return select(select(select(e.x, e.y, k == 1), e.z, k == 2), e.w, k == 3);
}

fn interiorBuildingAt(p: vec2f) -> i32 {
  let n = ${r.buildingCount};
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
    let b = ${r.buildingRect("i")};
    if (p.x > b.x && p.x < b.z && p.y > b.y && p.y < b.w) { return i; }
  }
  return -1;
}

/**
 * Painted floor plate (Lab spike, AR-42): one unique top-down albedo for the first house's living room and hall,
 * rectified from a paint-over through the gameplay camera. Returns alpha 0 outside it or when off.
 */
fn interiorPlate(p: vec2f) -> vec4f {
  let w = ${r.cfg}.w;
  if (w < 1.0 || !(${r.classicLayout})) { return vec4f(0.0); }
  let b0 = ${r.buildingRect("0")};
  let rect = vec4f(b0.x, b0.y + 5.5, b0.x + 8.92, b0.w);
  let uv = (p - rect.xy) / (rect.zw - rect.xy);
  if (any(uv <= vec2f(0.0)) || any(uv >= vec2f(1.0))) { return vec4f(0.0); }
  // 1024 texels over the plate's 6 m depth (its denser axis).
  let lod = clamp(log2(max(surfaceFootprint * 171.0, 1.0)), 0.0, 9.0);
  let t = textureSampleLevel(detailTex, detailSamp, uv, i32(floor(w)), lod);
  return vec4f(t.rgb * fract(w) * 4.0, 1.0);
}

/**
 * Generated floor plate for building bi (AR-42): one 1024² top-down albedo per building, chosen from its theme's
 * library and tiled every floorCfg.x metres in world space. A slow tone noise hides the repeat. Alpha 0 when none.
 */
fn interiorFloorPlate(p: vec2f, bi: i32) -> vec4f {
  let w = ${r.plate("bi")};
  if (w < 1.0) { return vec4f(0.0); }
  let tile = max(${r.floor}.x, 0.5);
  let lod = clamp(log2(max(surfaceFootprint * 1024.0 / tile, 1.0)), 0.0, 9.0);
  // The detail sampler clamps, so wrap by hand (explicit LOD, so the wrap leaves no derivative seam).
  let t = textureSampleLevel(detailTex, detailSamp, fract(p / tile), i32(floor(w)), lod);
  let macroV = 0.84 + 0.32 * surfaceNoise(p * 0.21 + vec2f(3.7, 8.1));
  return vec4f(t.rgb * fract(w) * 4.0 * macroV, 1.0);
}

/** Four hashes in [0, 1) for an integer cell (pcg4d). */
fn interiorHash4(c: vec2i, seed: u32) -> vec4f {
  var v = vec4u(u32(c.x), u32(c.y), seed, u32(c.x) ^ u32(c.y) ^ 0x9e3779b9u) * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> vec4u(16u);
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return vec4f(v >> vec4u(8u)) / 16777216.0;
}

/**
 * Floor dressing (AR-42): seeded stains, scuffs, papers, leaves and the odd blood mark from the decal atlas, one
 * candidate per 1.7 m cell kept inside its cell so one fetch covers it, then grime darkening the floor along the
 * skirting from the baked floor occlusion. Rugs and furniture draw over all of it.
 */
fn interiorFloorDetail(albedoIn: vec3f, p: vec2f, seed: u32) -> vec3f {
  var albedo = albedoIn;
  let cfg = ${r.floor};
  let grime = ${r.floor2}.x;
  if (grime > 0.0) {
    let occ = smoothstep(0.06, 0.55, floorData(p).r) * grime;
    let l = dot(albedo, vec3f(0.2126, 0.7152, 0.0722));
    albedo = mix(albedo, vec3f(l) * vec3f(0.80, 0.74, 0.62), occ * 0.5) * (1.0 - 0.45 * occ);
  }
  if (cfg.w < 1.0 || cfg.y <= 0.0) { return albedo; }
  let cell = 1.7;
  let c = floor(p / cell);
  let h = interiorHash4(vec2i(c), seed);
  if (h.x >= cfg.y) { return albedo; }
  let s = u32(h.y * 32.0) & 31u;
  let word = select(select(${hexU(decalWords[0]!)}, ${hexU(decalWords[1]!)}, s >= 8u), select(${hexU(decalWords[2]!)}, ${hexU(decalWords[3]!)}, s >= 24u), s >= 16u);
  let kind = (word >> ((s & 7u) * 4u)) & 15u;
  let paper = (kind >= 8u && kind <= 11u) || kind == 15u;
  let blood = kind == 6u || kind == 7u;
  let size = select(mix(0.62, 1.05, h.z), mix(0.42, 0.52, h.z), paper);
  let room = cell - size * 1.42;
  let centre = (c + 0.5) * cell + (fract(h.zw * vec2f(37.13, 53.71)) - 0.5) * room;
  let a = h.w * 6.2831853;
  let d = p - centre;
  let q = vec2f(d.x * cos(a) + d.y * sin(a), -d.x * sin(a) + d.y * cos(a)) / size + 0.5;
  if (any(q <= vec2f(0.0)) || any(q >= vec2f(1.0))) { return albedo; }
  let uv = (vec2f(f32(kind & 3u), f32(kind >> 2u)) + 0.03 + q * 0.94) * 0.25;
  let lod = clamp(log2(max(surfaceFootprint * 256.0 / size, 1.0)), 0.0, 5.0);
  let t = textureSampleLevel(detailTex, detailSamp, uv, i32(cfg.w), lod);
  let fade = 1.0 - smoothstep(3.5, 5.0, lod);
  if (paper) { return mix(albedo, t.rgb * 0.5, t.a * fade * min(cfg.z, 1.0)); }
  if (blood) { return mix(albedo, t.rgb * 0.42, t.a * fade * 0.9 * min(cfg.z, 1.0)); }
  let tl = dot(t.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return mix(albedo, mix(vec3f(tl), t.rgb, 0.5) * 0.55, t.a * fade * clamp(0.75 * cfg.z, 0.0, 1.0));
}

fn interiorThemeOf(i: i32) -> i32 {
  let e = ${r.theme("i")};
  return i32(round(e));
}

/** Wallpaper for theme t on an interior wall at along-wall coordinate a and height y. */
fn themedWall(base: vec3f, a: f32, y: f32, t: i32, variant: f32) -> vec3f {
  if (t == 1 || t == 4) {
    // Flocked damask: crimson, bottle green or navy (mansion), deep teal with gold (castle).
    let scale = 1.0 / 0.53;
    let uv = vec2f(a, -y) * scale;
    let m = textureSampleLevel(detailTex, detailSamp, uv, 0, materialMipLod(scale)).r;
    var ground = vec3f(0.115, 0.018, 0.016);
    var motif = vec3f(0.048, 0.006, 0.006);
    if (t == 4) { ground = vec3f(0.018, 0.045, 0.042); motif = vec3f(0.16, 0.11, 0.035); }
    else if (variant > 0.66) { ground = vec3f(0.022, 0.045, 0.026); motif = vec3f(0.009, 0.020, 0.011); }
    else if (variant > 0.4) { ground = vec3f(0.020, 0.026, 0.060); motif = vec3f(0.008, 0.010, 0.026); }
    let grime = 0.82 + 0.18 * surfaceNoise(vec2f(a * 0.9, y * 0.6) + vec2f(3.1, 7.7));
    return mix(ground, motif, m) * grime;
  }
  if (t == 2) {
    // Farmhouse: yellowed floral stripe paper, water-stained and grimy toward the floor.
    let scale = 1.0 / 0.34;
    let uv = vec2f(a, -y) * scale;
    let m = textureSampleLevel(detailTex, detailSamp, uv, 0, materialMipLod(scale)).g;
    let paper = mix(vec3f(0.30, 0.25, 0.15), vec3f(0.20, 0.17, 0.09), variant);
    let stripe = mix(vec3f(0.13, 0.15, 0.08), vec3f(0.17, 0.07, 0.05), step(0.5, variant));
    let stain = smoothstep(0.55, 0.85, surfaceNoise(vec2f(a * 0.7, y * 0.35) + vec2f(1.7, 4.2)));
    let low = 1.0 - smoothstep(0.9, 1.8, y) * 0.35;
    return mix(paper, stripe, m * 0.85) * (1.0 - stain * 0.35) * (0.62 + 0.38 * (1.0 - low * 0.6));
  }
  if (t == 3) {
    // Precinct: cream paint over a two-tone dado line.
    let cream = vec3f(0.36, 0.33, 0.25);
    return mix(base * 0.4 + cream * 0.6, vec3f(0.10, 0.17, 0.12), step(y, 1.05));
  }
  return base;
}

/**
 * 70s plaster for unthemed rooms (AR-69): warm putty paint over a darker painted dado below the chair rail.
 * Replaces the façade colour the walls carried inside; its tone variation comes from interiorWallWear's mottling.
 */
fn plasterWall(y: f32, variant: f32) -> vec3f {
  let paint = mix(vec3f(0.30, 0.27, 0.20), vec3f(0.25, 0.26, 0.20), variant);
  let dado = mix(vec3f(0.12, 0.085, 0.055), vec3f(0.075, 0.09, 0.07), step(0.5, variant));
  return select(paint, dado, y < 0.92);
}

/**
 * Wear on every interior wall face (AR-69), held to the floors' scale: a cove shade under the ceiling and a contact
 * shade down to the skirting, corner and furniture occlusion from the floor bake in front of the face, water streaks
 * running down from the top, an uneven rising-damp tide line with a darker rim, and 0.5–2 m mottling so long walls
 * never read flat. Streaks run vertically (the wall's uncompressed screen axis) and every narrow term widens or fades
 * with the pixel footprint, so it holds still while walking. \`k\` scales it all (0 = Today). Two noise taps and one
 * bake fetch: this is compiled into every surface pipeline variant, so it stays small (SwiftShader smoke startup).
 */
fn interiorWallWear(albedoIn: vec3f, a: f32, y: f32, front: vec2f, k: f32) -> vec3f {
  if (k <= 0.0) { return albedoIn; }
  let fw = surfaceFootprint;
  let shade = mix(0.6, 1.0, smoothstep(0.13, 0.8, y)) * mix(1.0, 0.68, smoothstep(2.0, 2.62, y));
  let occ = smoothstep(0.08, 0.6, floorData(front).r);
  let sn = surfaceNoise(vec2f(a * 2.6, y * 0.22 + 3.7));
  let streak = smoothstep(0.6, 0.84, sn) * smoothstep(0.9, 2.6, y) * (1.0 - smoothstep(0.035, 0.09, fw));
  let tide = 0.53 + 0.065 * (sin(a * 1.73 + 0.4) + sin(a * 0.61 + 2.3));
  let below = 1.0 - smoothstep(tide - 0.03 - fw, tide + 0.02 + fw, y);
  let rimW = max(0.035, fw * 1.5);
  let rim = exp(-abs(y - tide) / rimW) * (0.035 / rimW);
  let mottle = 0.86 + 0.28 * surfaceNoise(vec2f(a * 0.7, y * 0.9) + vec2f(5.3, 2.1));
  let l = dot(albedoIn, vec3f(0.2126, 0.7152, 0.0722));
  let stain = vec3f(l) * vec3f(0.62, 0.52, 0.36);
  var c = mix(albedoIn, stain, clamp(streak * 0.5 + below * 0.3 + rim * 0.4, 0.0, 1.0) * min(k, 1.0));
  c *= mix(1.0, shade * (1.0 - 0.4 * occ) * mottle, min(k, 1.0));
  return c * mix(1.0, 0.9, max(k - 1.0, 0.0) * 2.0);
}

/** Themed floor: herringbone parquet, checker tiles or tired planks. */
fn themedFloor(base: vec3f, p: vec2f, t: i32, variant: f32) -> vec3f {
  if (t == 1 || t == 4) {
    let plank = 0.075;
    let scale = 1.0 / (plank * 8.0);
    let s = textureSampleLevel(detailTex, detailSamp, p * scale, 0, materialMipLod(scale));
    let wood = select(vec3f(0.115, 0.058, 0.026), vec3f(0.070, 0.036, 0.018), t == 4 || variant > 0.6);
    let tone = 0.62 + 0.62 * s.b;
    let macroV = 0.85 + 0.3 * surfaceNoise(p * 0.45 + vec2f(5.2, 1.3));
    return wood * tone * mix(0.28, 1.0, s.a) * macroV;
  }
  if (t == 3) {
    let c = floor(p / 0.32);
    let checker = (i32(c.x) + i32(c.y)) & 1;
    let tile = select(vec3f(0.30, 0.29, 0.26), vec3f(0.035, 0.035, 0.032), checker == 1);
    let f = fract(p / 0.32);
    let grout = smoothstep(0.0, 0.03, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    return tile * mix(0.5, 1.0, grout) * (0.9 + 0.2 * surfaceNoise(p * 2.3));
  }
  if (t == 2) {
    let dirt = smoothstep(0.35, 0.8, surfaceNoise(p * 0.8 + vec2f(9.1, 2.4)));
    return base * vec3f(0.78, 0.72, 0.62) * (1.0 - dirt * 0.3);
  }
  return base;
}
`
}

/** Fragment-start derivatives (no extra private globals needed; uses `surfaceFootprint`). */
export const interiorFragmentStartWgsl = ""

/** Material code, run in `postLightMaterial` after the kit surface materials (so it can override their albedo). */
export function interiorMaterialWgsl(r: InteriorWgslRefs, classicKitchen: boolean): string {
  return /* wgsl */ `
    if (mat == ${MAT_RUG}) {
      let key = i32(round(o.aux));
      let layer = rugLayer(key);
      let uv = clamp(o.color.rg, vec2f(0.0008), vec2f(0.9992));
      if (layer >= 0.5) {
        let li = i32(round(layer));
        let rLod = clamp(log2(max(surfaceFootprint * 256.0, 1.0)) + ${r.cfg}.x, 0.0, 8.0);
        let t = textureSampleLevel(detailTex, detailSamp, uv, li, rLod);
        if (t.a < 0.035) { discard; }
        // Pile relief: height differences across one texel of the sampled mip, mapped to world xz through the
        // rug's (axis-aligned) uv basis from surfaceFootprint.
        let du = max(surfaceFootprint * 0.35, 1.0 / 1024.0);
        let dv = du;
        let hu = textureSampleLevel(detailTex, detailSamp, uv + vec2f(du, 0.0), li, rLod).a - t.a;
        let hv = textureSampleLevel(detailTex, detailSamp, uv + vec2f(0.0, dv), li, rLod).a - t.a;
        // Vertex blue marks rugs whose long side (v) runs along world x.
        let slopeUV = vec2f(hu / du, hv / dv) * 0.012 * ${r.cfg}.z;
        let slope = select(slopeUV, vec2f(slopeUV.y, slopeUV.x), o.color.b > 0.5);
        let flatN = n;
        if (n.y > 0.5) {
          n = normalize(vec3f(-slope.x * 0.35, 1.0, -slope.y * 0.35));
          // Bump the response to the flashlight and moon too: their direct light was summed with the flat normal.
          let toFlash = normalize(vec3f(${r.flashXZ}.x - o.world.x, 1.1, ${r.flashXZ}.y - o.world.z));
          let rake = clamp(dot(n, toFlash) / max(dot(flatN, toFlash), 0.08), 0.55, 1.6);
          albedo = t.rgb * mix(rake, 1.0, 0.35);
        } else {
          albedo = t.rgb;
        }
        albedo *= mix(0.62, 1.0, smoothstep(0.1, 0.8, t.a)) * ${r.cfg}.y;
      } else {
        albedo = vec3f(0.085, 0.032, 0.022) * ${r.cfg}.y;
      }
      gloss = vec2f(0.0);
    } else if ((mat == 4 && o.world.y < 2.75 && n.y < 0.5) || (mat == 20 && i32(round(o.aux)) == 4)) {
      let bi = interiorBuildingAt(o.world.xz + n.xz * 0.3);
      if (bi >= 0) {
        let th = interiorThemeOf(bi);
        let variant = clamp(fract(${r.theme("bi")}) / 0.45, 0.0, 1.0);
        if (mat == 4) {
          if (interior(o.world.xz + n.xz * 0.3)) {
            let wallA = o.world.x + o.world.z;
            let wear = ${r.floor2}.z;
            if (th > 0) { albedo = themedWall(albedo, wallA, o.world.y, th, variant); }
            else if (wear > 0.0) { albedo = plasterWall(o.world.y, variant); }
            albedo = interiorWallWear(albedo, wallA, o.world.y, o.world.xz + n.xz * 0.2, wear);
          }
        } else {
          ${classicKitchen ? `let kb = ${r.buildingRect("bi")};
          let pk = o.world.xz;
          let inKitchen = ${r.authoredKitchen("bi")} && pk.x > kb.z - 6.08 && pk.x < kb.z - 0.05 && pk.y > kb.y + 5.68 && pk.y < kb.w - 0.05;` : "let inKitchen = false;"}
          let plate = interiorPlate(o.world.xz);
          if (plate.a > 0.5) {
            albedo = plate.rgb;
          } else if (!inKitchen) {
            let fp = interiorFloorPlate(o.world.xz, bi);
            if (fp.a > 0.5) { albedo = fp.rgb; } else if (th > 0) { albedo = themedFloor(albedo, o.world.xz, th, variant); }
          }
          albedo = interiorFloorDetail(albedo, o.world.xz, u32(${r.floor2}.y));
        }
      }
    }
`
}
