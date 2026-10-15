/**
 * WGSL for baked rugs (material 25) and themed interiors (wallpaper and parquet on existing walls and floors).
 * Rugs carry their texture UV in the vertex colour (corners 0/1 survive the vertex shader's pow(2.2)), their
 * directory key in `aux`, and sample the renderer's detail texture array at bindings 15/16. Layer 0 holds the
 * packed interior tile masks; rug layers come from the directory in the game's own uniform block.
 */

/** Material id for baked rugs; Outbreak-local (not part of the kit `MAT` table). */
export const MAT_RUG = 25

/** Outbreak interior block appended to `OutbreakLightingUniforms` (offsets in floats from its start). */
export const INTERIOR_UNIFORM_FLOATS = 48
export const RUG_DIRECTORY_SLOTS = 9

export const interiorUniformFieldsWgsl = /* wgsl */ `
  rugDir: array<vec4f, ${RUG_DIRECTORY_SLOTS}>, // per stream slot: texture layer of rugs 0..3, -1 = not baked
  rugCfg: vec4f, // mip bias (log2), brightness, pile relief, debug
  bldTheme: array<vec4f, 2>, // theme id per window building (0..7)`

export type InteriorWgslRefs = {
  /** Expression returning the directory vec4 for a slot `s` (i32). */
  dir: (s: string) => string
  cfg: string
  /** Expression returning the theme id (f32) of building index `i` (i32). */
  theme: (i: string) => string
  /** Number of buildings to search and the rect of building `i`. */
  buildingCount: string
  buildingRect: (i: string) => string
  /** Flashlight origin in plan (vec2f) for the pile rake. */
  flashXZ: string
  /** True when the hand-built origin houses (and their tiled kitchens) are on screen. */
  classicLayout: string
}

export const outbreakInteriorRefs: InteriorWgslRefs = {
  dir: s => `OL.rugDir[clamp(${s}, 0, ${RUG_DIRECTORY_SLOTS - 1})]`,
  cfg: "OL.rugCfg",
  theme: i => `OL.bldTheme[clamp(${i}, 0, 7) >> 2][${i} & 3]`,
  buildingCount: "select(4, i32(OL.win.w), OL.win.z > 0.5)",
  buildingRect: i => `OL.bldRects[clamp(${i}, 0, 7)]`,
  flashXZ: "OL.u3.xy",
  classicLayout: "OL.win.z < 0.5",
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
  if (${r.classicLayout}) {
    let qId = select(select(3, 2, p.y < 45.0), select(1, 0, p.y < 45.0), p.x < 45.0);
    if (qId >= ${r.buildingCount}) { return -1; }
    let b = select(
      select(vec4f(53.0, 54.0, 72.0, 68.0), vec4f(53.0, 23.0, 73.0, 38.0), p.y < 45.0),
      select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 45.0),
      p.x < 45.0
    );
    return select(-1, qId, p.x > b.x && p.x < b.z && p.y > b.y && p.y < b.w);
  }
  let n = ${r.buildingCount};
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
    let b = ${r.buildingRect("i")};
    if (p.x > b.x && p.x < b.z && p.y > b.y && p.y < b.w) { return i; }
  }
  return -1;
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
        if (th > 0) {
          if (mat == 4) {
            if (interior(o.world.xz + n.xz * 0.3)) { albedo = themedWall(albedo, o.world.x + o.world.z, o.world.y, th, variant); }
          } else {
            ${classicKitchen ? `let kb = select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), o.world.z < 44.0);
            let pk = o.world.xz;
            let inKitchen = (${r.classicLayout}) && pk.x > kb.z - 6.08 && pk.x < kb.z - 0.05 && pk.y > kb.y + 5.68 && pk.y < kb.w - 0.05;` : "let inKitchen = false;"}
            if (!inKitchen) { albedo = themedFloor(albedo, o.world.xz, th, variant); }
          }
        }
      }
    }
`
}
