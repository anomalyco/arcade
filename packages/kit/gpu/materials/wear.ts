/**
 * Surface wear for finished props (`finish.ts`): edge wear on convex edges, grime in cavities, rising damp with a tide
 * line, rain streaks and sheltered dust driven by sky exposure, rust on metal, per-region albedo variation and the
 * wet term, each changing albedo, roughness and metalness together (Frostbite's rule for layers: a layer that changes
 * only colour reads as paint). Wet is porous darkening plus a gloss (Lagarde's water film, as `reflections/wet.ts`).
 *
 * It reads the per-vertex finishing data (`finish-bake.ts`: AO, curvature, sky exposure and a look index, decoded in
 * the vertex stage by `wearDecodeWgsl`) and a CC0 scan through triplanar projection, so nothing needs UVs. A game
 * supplies how to sample its texture array and where its ground is (`wearWgsl`), packs the looks it uses into its own
 * uniform (`packWear`), and binds the typed Lab knobs (`wearControls`).
 *
 * Lifted from Lot's interior finishes (`games/lot/src/interior/finishes.ts`: stains, damp and tide lines, wax) and the
 * Outbreak wall wear, generalised from walls to any surface.
 */
import type { LabControl } from "../../lab-navigation"

export type Rgb = readonly [number, number, number]

// ------------------------------------------------------------------ albedo validator

/** Linear luminance (Rec. 709). */
export const luminance = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

/**
 * Measured albedo ranges (linear luminance). Sources: Unity's material validator (non-metals 50–243 sRGB, metals
 * 180–255), the Adobe/Substance PBR guide (charcoal 0.04, dark values not below 30 sRGB), Unity's dark dielectrics
 * guide (X-Rite measured black plastic 31, rubber 50, leather 35, painted metal 35 sRGB), and published pavement and
 * concrete albedos (`research-lighting.md` §4c).
 */
export const ALBEDO_RANGES = {
  dielectric: { min: srgbToLinear(50 / 255), max: srgbToLinear(243 / 255), label: "Non-metal (50–243 sRGB)" },
  metal: { min: srgbToLinear(180 / 255), max: 1, label: "Metal (180–255 sRGB)" },
  "dark-manufactured": { min: srgbToLinear(30 / 255), max: srgbToLinear(60 / 255), label: "Black plastic, rubber, paint (30–60 sRGB)" },
  charcoal: { min: 0.03, max: 0.05, label: "Charcoal (0.04)" },
  "asphalt-new": { min: 0.04, max: 0.05, label: "New asphalt (0.04–0.05)" },
  "asphalt-aged": { min: 0.1, max: 0.18, label: "Aged asphalt (0.10–0.18)" },
  "concrete-aged": { min: 0.2, max: 0.3, label: "Aged concrete (0.2–0.3)" },
  "concrete-new": { min: 0.4, max: 0.55, label: "New concrete (0.40–0.55)" },
  paper: { min: 0.6, max: 0.7, label: "White paper (0.6–0.7)" },
} as const
export type AlbedoClass = keyof typeof ALBEDO_RANGES

export type AlbedoCheck = { ok: boolean; luminance: number; min: number; max: number; verdict: "dark" | "bright" | "ok" }

/** Checks a linear albedo against its class's measured range. */
export function checkAlbedo(albedo: Rgb, cls: AlbedoClass = "dielectric"): AlbedoCheck {
  const r = ALBEDO_RANGES[cls], l = luminance(albedo)
  const verdict = l < r.min ? "dark" : l > r.max ? "bright" : "ok"
  return { ok: verdict === "ok", luminance: l, min: r.min, max: r.max, verdict }
}

/** Scales a linear albedo into its class's range (keeping hue); unchanged when it already fits. */
export function clampAlbedo(albedo: Rgb, cls: AlbedoClass = "dielectric"): Rgb {
  const r = ALBEDO_RANGES[cls], l = luminance(albedo)
  if (l <= 0) return [r.min, r.min, r.min]
  // A hair inside the range, so the result passes `checkAlbedo` despite rounding.
  const k = l < r.min ? (r.min / l) * (1 + 1e-6) : l > r.max ? (r.max / l) * (1 - 1e-6) : 1
  return [Math.min(1, albedo[0] * k), Math.min(1, albedo[1] * k), Math.min(1, albedo[2] * k)]
}

// ------------------------------------------------------------------ looks

/** Scans the looks use: CC0, from Poly Haven (`scripts/finish/fetch-scans.ts`; credits in `scans/CREDITS.md`). */
export const FINISH_SCANS = {
  "worn-metal": { source: "polyhaven", id: "rusty_metal_02", use: "worn lab metal, scratches and rust blooms" },
  "painted-steel": { source: "polyhaven", id: "green_metal_rust", use: "chipped painted steel" },
  "concrete-block": { source: "polyhaven", id: "rough_concrete", use: "damp cinderblock (block faces; joints come from the geometry)" },
  "old-wood": { source: "polyhaven", id: "fine_grained_wood", use: "old wood grain" },
  bark: { source: "polyhaven", id: "bark_brown_02", use: "wet bark" },
  stone: { source: "polyhaven", id: "lichen_rock", use: "weathered stone" },
} as const
export type FinishScanId = keyof typeof FINISH_SCANS

export type WearAmounts = {
  /** Convex edges worn through to the under-layer (0–1). */
  edge: number
  /** Dirt in cavities and concave corners. */
  grime: number
  /** Rising damp from the ground, with a tide line. */
  damp: number
  /** Rain streaks on exposed faces and dust in sheltered ones. */
  streaks: number
  /** Rust where water sits on metal. */
  rust: number
  /** Per-region albedo variation (10–25% is real; flat albedo is the commonest CG tell). */
  variation: number
}

export type FinishLook = {
  id: string
  label: string
  /** Validator class of the base albedo. */
  albedoClass: AlbedoClass
  /** Linear base albedo, roughness and metalness, used when `replace` is 1. */
  base: Rgb
  rough: number
  metal: number
  /** 0 keeps the surface's own albedo (texture or vertex colour) and wears it; 1 takes `base` × the scan. */
  replace: number
  /** What worn edges expose: bare metal under paint, raw wood under grey weathering. */
  under: Rgb
  underRough: number
  underMetal: number
  /** How much water darkens it (0 sealed … 1 very porous). */
  porosity: number
  wear: WearAmounts
  /** Tide line height above the ground (m). */
  dampHeight: number
  scan: FinishScanId
  /** Scan tile size (m) and how strongly its detail shows. */
  scanScale: number
  scanStrength: number
}

const look = (l: FinishLook) => l

/**
 * The kit's looks. Index order is the look index finished vertices carry (3 bits), so append, never reorder. Base
 * albedos are inside their validator class (`wear.test.ts`).
 */
export const FINISH_LOOKS = [
  look({
    id: "worn-lab-metal", label: "Worn lab metal", albedoClass: "metal",
    base: [0.56, 0.57, 0.58], rough: 0.42, metal: 1, replace: 1,
    under: [0.62, 0.62, 0.62], underRough: 0.22, underMetal: 1, porosity: 0.1,
    wear: { edge: 0.7, grime: 0.45, damp: 0, streaks: 0.25, rust: 0.2, variation: 0.12 }, dampHeight: 0.25,
    scan: "worn-metal", scanScale: 1, scanStrength: 0.5,
  }),
  look({
    id: "damp-cinderblock", label: "Damp cinderblock", albedoClass: "concrete-aged",
    base: [0.26, 0.255, 0.24], rough: 0.92, metal: 0, replace: 1,
    under: [0.34, 0.33, 0.31], underRough: 0.95, underMetal: 0, porosity: 0.8,
    wear: { edge: 0.35, grime: 0.6, damp: 0.75, streaks: 0.55, rust: 0, variation: 0.22 }, dampHeight: 0.55,
    scan: "concrete-block", scanScale: 2, scanStrength: 0.7,
  }),
  look({
    id: "old-wood", label: "Old wood", albedoClass: "dielectric",
    base: [0.2, 0.16, 0.12], rough: 0.82, metal: 0, replace: 0,
    under: [0.36, 0.28, 0.2], underRough: 0.62, underMetal: 0, porosity: 0.7,
    wear: { edge: 0.55, grime: 0.55, damp: 0.5, streaks: 0.45, rust: 0, variation: 0.2 }, dampHeight: 0.35,
    scan: "old-wood", scanScale: 0.6, scanStrength: 0.45,
  }),
  look({
    id: "painted-steel", label: "Painted steel", albedoClass: "dielectric",
    base: [0.11, 0.17, 0.13], rough: 0.5, metal: 0, replace: 1,
    under: [0.6, 0.6, 0.61], underRough: 0.3, underMetal: 1, porosity: 0.05,
    wear: { edge: 0.65, grime: 0.4, damp: 0.1, streaks: 0.35, rust: 0.35, variation: 0.1 }, dampHeight: 0.2,
    scan: "painted-steel", scanScale: 1, scanStrength: 0.35,
  }),
  look({
    id: "wet-bark", label: "Wet bark", albedoClass: "dielectric",
    base: [0.075, 0.06, 0.045], rough: 0.78, metal: 0, replace: 0,
    under: [0.16, 0.12, 0.08], underRough: 0.7, underMetal: 0, porosity: 0.9,
    wear: { edge: 0.25, grime: 0.5, damp: 0.6, streaks: 0.3, rust: 0, variation: 0.18 }, dampHeight: 0.4,
    scan: "bark", scanScale: 1, scanStrength: 0.3,
  }),
  look({
    id: "weathered-stone", label: "Weathered stone", albedoClass: "dielectric",
    base: [0.2, 0.2, 0.19], rough: 0.9, metal: 0, replace: 0,
    under: [0.3, 0.29, 0.27], underRough: 0.85, underMetal: 0, porosity: 0.6,
    wear: { edge: 0.3, grime: 0.65, damp: 0.55, streaks: 0.2, rust: 0, variation: 0.2 }, dampHeight: 0.3,
    scan: "stone", scanScale: 2, scanStrength: 0.35,
  }),
] as const satisfies readonly FinishLook[]

export type FinishLookId = (typeof FINISH_LOOKS)[number]["id"]
export const FINISH_LOOK_IDS = FINISH_LOOKS.map(l => l.id) as FinishLookId[]
export const lookIndex = (id: FinishLookId) => FINISH_LOOK_IDS.indexOf(id)
export const finishLook = (id: FinishLookId): FinishLook => FINISH_LOOKS[lookIndex(id)]!

// ------------------------------------------------------------------ settings

/** Live wear knobs: master scales over every look's own amounts, and the validator view. */
export type WearSettings = {
  /** Shade finished surfaces with wear (off shows the bare finish: chamfers and baked AO only). */
  finishWear: boolean
  finishEdge: number
  finishGrime: number
  finishDamp: number
  finishStreaks: number
  finishRust: number
  finishVariation: number
  finishScan: number
  /** Extra surface wetness on finished props (0 dry … 1 soaked); weather adds its own. */
  finishWet: number
  /** Bring a finished non-metal's albedo into the measured range (50–243 sRGB) before wearing it. */
  albedoClamp: boolean
  /** Debug view: false colour where albedo is outside its measured range (blue too dark, red too bright). */
  albedoCheck: boolean
}

export const WEAR_DEFAULTS: Readonly<WearSettings> = {
  finishWear: true, finishEdge: 1, finishGrime: 1, finishDamp: 1, finishStreaks: 1, finishRust: 1, finishVariation: 1, finishScan: 1, finishWet: 0, albedoClamp: true, albedoCheck: false,
}

/** LabPanel rows for `WearSettings`, keys `prefix + field`. */
export function wearControls(prefix: string, group: string, subsection?: string): LabControl[] {
  const sub = subsection ? { subsection } : {}
  const range = (k: keyof WearSettings, label: string, max: number, unit = "×"): LabControl => ({ key: prefix + k, field: k, label, group, min: 0, max, step: 0.05, unit, ...sub })
  return [
    { key: prefix + "finishWear", field: "finishWear", label: "Surface wear", group, type: "toggle", ...sub },
    range("finishEdge", "Edge wear", 2),
    range("finishGrime", "Cavity grime", 2),
    range("finishDamp", "Rising damp", 2),
    range("finishStreaks", "Rain streaks and dust", 2),
    range("finishRust", "Rust", 2),
    range("finishVariation", "Albedo variation", 2),
    range("finishScan", "Scan detail", 2),
    range("finishWet", "Wetness", 1, ""),
    { key: prefix + "albedoClamp", field: "albedoClamp", label: "Albedo into measured range", group, type: "toggle", ...sub },
    { key: prefix + "albedoCheck", field: "albedoCheck", label: "Albedo validator view", group, type: "toggle", ...sub },
  ]
}

// ------------------------------------------------------------------ uniforms

/** vec4s per look in the packed table. */
export const WEAR_LOOK_VEC4 = 6
/** Floats `packWear` writes for `looks`: one global vec4, then each look. */
export const wearFloats = (looks: readonly FinishLookId[]) => 4 + looks.length * WEAR_LOOK_VEC4 * 4
/** vec4 count of the table, for the WGSL array declaration. */
export const wearVec4s = (looks: readonly FinishLookId[]) => 1 + looks.length * WEAR_LOOK_VEC4

export type WearPackOptions = {
  /** Texture-array layer of each look's scan in the game's array (missing = no scan detail). */
  scanLayers?: Partial<Record<FinishLookId, number>>
  /** Wetness from the weather (0–1), added to the knob's. */
  wetness?: number
}

/** Packs the global vec4 and `looks` into `out` at `offset` (see `wearFloats`). */
export function packWear(out: Float32Array, offset: number, looks: readonly FinishLookId[], s: Readonly<WearSettings>, opts: WearPackOptions = {}): void {
  out.set([s.finishWear ? 1 : 0, s.albedoCheck ? 1 : 0, Math.min(1, s.finishWet + (opts.wetness ?? 0)), s.albedoClamp ? 1 : 0], offset)
  looks.forEach((id, i) => {
    const l = finishLook(id), w = l.wear, o = offset + 4 + i * WEAR_LOOK_VEC4 * 4
    out.set([
      l.base[0], l.base[1], l.base[2], l.replace,
      l.under[0], l.under[1], l.under[2], l.underMetal,
      l.rough, l.metal, l.underRough, l.porosity,
      w.edge * s.finishEdge, w.grime * s.finishGrime, w.damp * s.finishDamp, w.streaks * s.finishStreaks,
      w.rust * s.finishRust, w.variation * s.finishVariation, l.scanStrength * s.finishScan, l.dampHeight,
      opts.scanLayers?.[id] ?? -1, 1 / l.scanScale, 0, 0,
    ], o)
  })
}

// ------------------------------------------------------------------ WGSL

/**
 * Vertex-stage decode of the finishing bytes (normal.w, colour.a) into (AO, curvature, sky exposure, look + 1);
 * unfinished vertices give (1, 0, 1, 0). Interpolate the result; `round(fin.w) - 1` is the look.
 */
export const wearDecodeWgsl = /* wgsl */ `
fn wearDecode(nw: f32, ca: f32) -> vec4f {
  let b = bitcast<u32>(i32(round(nw * 127.0))) & 255u;
  if ((b & 1u) == 0u) { return vec4f(1.0, 0.0, 1.0, 0.0); }
  let a = u32(round(ca * 255.0));
  var c = i32((b >> 4u) & 15u);
  if (c > 7) { c = c - 16; }
  return vec4f(f32((a >> 4u) & 15u) / 15.0, f32(c) / 7.0, f32(a & 15u) / 15.0, f32((b >> 1u) & 7u) + 1.0);
}
`

export type WearWgslOptions = {
  /** Looks this game packs, in `packWear` order. */
  looks: readonly FinishLookId[]
  /** WGSL expression of the packed table, an `array<vec4f, wearVec4s(looks)>` (e.g. `N.wear`). */
  params: string
  /** WGSL sampling the game's texture array: base colour (linear rgb) at a layer, uv, and uv derivatives. */
  sample?: (layer: string, uv: string, dx: string, dy: string) => string
  /** WGSL of the same layer's mean colour (its smallest mip), so the scan adds detail without shifting albedo. */
  sampleMean?: (layer: string) => string
  /** WGSL of the ground height under a world point (rising damp climbs from it); default world y 0. */
  ground?: (p: string) => string
}

/**
 * The wear functions: `wearApply(surface, fin, p, g, dpx, dpy)` returns the worn `WearSurface` (albedo, roughness,
 * metalness, wetness) for a fragment with decoded finishing data `fin`, world position `p`, geometric normal `g` and
 * world-position derivatives (take them at fragment entry). `wearCheck(albedo, metal)` is the validator's false colour.
 */
export function wearWgsl(o: WearWgslOptions): string {
  const P = (k: string) => `${o.params}[${k}]`
  const slots = o.looks.map((id, i) => `    case ${lookIndex(id)}: { return ${i}; }`).join("\n")
  const ground = o.ground ? o.ground("p") : "0.0"
  const dark = ALBEDO_RANGES.dielectric.min.toFixed(5), bright = ALBEDO_RANGES.dielectric.max.toFixed(5), metalMin = ALBEDO_RANGES.metal.min.toFixed(5)
  const triplanar = o.sample && o.sampleMean ? /* wgsl */ `
/** Power-4 triplanar of a scan layer at \`scale\` tiles per metre: detail relative to its mean (1 = no change). */
fn wearScan(layer: i32, p: vec3f, g: vec3f, scale: f32, dpx: vec3f, dpy: vec3f) -> vec3f {
  var w = pow(abs(g), vec3f(4.0));
  w = w / max(w.x + w.y + w.z, 1e-5);
  var c = vec3f(0.0);
  // Skip planes under 5%: one or two fetches on most pixels.
  if (w.x > 0.05) { c += w.x * ${o.sample("layer", "p.zy * scale", "dpx.zy * scale", "dpy.zy * scale")}; }
  if (w.y > 0.05) { c += w.y * ${o.sample("layer", "p.xz * scale", "dpx.xz * scale", "dpy.xz * scale")}; }
  if (w.z > 0.05) { c += w.z * ${o.sample("layer", "p.xy * scale", "dpx.xy * scale", "dpy.xy * scale")}; }
  c = c / max(dot(w, vec3f(step(0.05, w.x), step(0.05, w.y), step(0.05, w.z))), 1e-5);
  let mean = ${o.sampleMean("layer")};
  return clamp(c / max(mean, vec3f(1e-3)), vec3f(0.25), vec3f(2.5));
}
` : /* wgsl */ `
fn wearScan(layer: i32, p: vec3f, g: vec3f, scale: f32, dpx: vec3f, dpy: vec3f) -> vec3f { return vec3f(1.0); }
`
  return /* wgsl */ `
struct WearSurface { albedo: vec3f, rough: f32, metal: f32, wet: f32 }

fn wearSlot(look: i32) -> i32 {
  switch look {
${slots}
    default: { return -1; }
  }
}

fn wearHash3(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn wearNoise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(wearHash3(i), wearHash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(wearHash3(i + vec3f(0.0, 1.0, 0.0)), wearHash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(wearHash3(i + vec3f(0.0, 0.0, 1.0)), wearHash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(wearHash3(i + vec3f(0.0, 1.0, 1.0)), wearHash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}

/** Noise at frequency \`f\` (1/m), faded to its mean once the pixel footprint \`fw\` (m) can't hold it. */
fn wearBand(p: vec3f, f: f32, fw: f32) -> f32 {
  let keep = 1.0 - smoothstep(0.12, 0.45, fw * f);
  return mix(0.5, wearNoise3(p * f), keep);
}
${triplanar}
fn wearApply(s: WearSurface, fin: vec4f, p: vec3f, g: vec3f, dpx: vec3f, dpy: vec3f) -> WearSurface {
  var r = s;
  let on = ${P("0")}.x;
  let slot = wearSlot(i32(round(fin.w)) - 1);
  if (fin.w < 0.5 || slot < 0 || on < 0.5) { return r; }
  let o = 1 + slot * ${WEAR_LOOK_VEC4};
  let base = ${P("o")};
  let under = ${P("o + 1")};
  let mat = ${P("o + 2")};
  let amt = ${P("o + 3")};
  let amt2 = ${P("o + 4")};
  let scanCfg = ${P("o + 5")};
  r.wet = clamp(s.wet + ${P("0")}.z, 0.0, 1.0);
  let fw = max(length(dpx), length(dpy));
  let ao = fin.x;
  let curv = fin.y;
  let expo = fin.z;
  let vertical = 1.0 - smoothstep(0.55, 0.85, abs(g.y));

  // Base: keep the surface's own albedo or take the look's, then the scan's detail on top.
  r.albedo = mix(r.albedo, base.rgb, base.w);
  r.rough = mix(r.rough, mat.x, base.w);
  r.metal = mix(r.metal, mat.y, base.w);
  let layer = i32(scanCfg.x);
  var detail = vec3f(1.0);
  if (layer >= 0 && amt2.z > 0.0) { detail = wearScan(layer, p, g, scanCfg.y, dpx, dpy); }
  let dl = dot(detail, vec3f(0.2126, 0.7152, 0.0722));
  r.albedo *= mix(vec3f(1.0), detail, amt2.z);
  r.rough = clamp(r.rough + (1.0 - dl) * 0.12 * amt2.z, 0.03, 1.0);
  // The finish starts from a plausible albedo: non-metals scaled into the measured range, hue kept (wear may then
  // darken it, as grime does).
  let l0 = dot(r.albedo, vec3f(0.2126, 0.7152, 0.0722));
  if (${P("0")}.w > 0.5 && r.metal < 0.5 && l0 > 1e-5) { r.albedo *= clamp(l0, ${dark}, ${bright}) / l0; }

  // Per-region variation at two scales (a board, a panel; then a hand's width).
  let v1 = wearBand(p + vec3f(17.3, 3.1, 9.7), 0.7, fw);
  let v2 = wearBand(p + vec3f(4.2, 11.8, 2.6), 3.1, fw);
  let vary = (v1 - 0.5) * 0.5 + (v2 - 0.5) * 0.3;
  r.albedo *= 1.0 + vary * amt2.y;
  r.rough = clamp(r.rough * (1.0 - vary * 0.25 * amt2.y), 0.03, 1.0);

  // Breakup noise for every mask: a fine and a coarse octave, plus the scan's own contrast.
  let n1 = wearBand(p, 9.0, fw);
  let n2 = wearBand(p + vec3f(5.1), 31.0, fw);
  let breakup = n1 * 0.65 + n2 * 0.35 + (dl - 1.0) * 0.4;

  // Edge wear: convex edges rubbed through to the under-layer, chipped by the breakup.
  let edge = smoothstep(0.38, 0.72, max(curv, 0.0) + (breakup - 0.5) * 0.7) * amt.x;
  r.albedo = mix(r.albedo, under.rgb * mix(0.85, 1.15, n2), edge);
  r.rough = mix(r.rough, mat.z, edge);
  r.metal = mix(r.metal, under.w, edge);

  // Cavity grime: baked occlusion and concave corners hold dirt.
  let cavity = clamp(smoothstep(0.85, 0.35, ao) + smoothstep(0.0, -0.6, curv), 0.0, 1.0);
  let grime = smoothstep(0.25, 0.75, cavity + (breakup - 0.5) * 0.6) * amt.y;
  r.albedo *= mix(vec3f(1.0), vec3f(0.42, 0.37, 0.31), grime);
  r.rough = mix(r.rough, 0.93, grime);
  r.metal *= 1.0 - grime;

  // Rising damp: from the ground to a ragged tide line, with a darker rim where salts collect.
  let h = p.y - ${ground};
  let tide = amt2.w * (0.75 + 0.5 * wearBand(vec3f(p.x + p.z, 0.0, p.x - p.z) * 0.5, 1.6, fw));
  let below = 1.0 - smoothstep(tide * 0.8, tide, h);
  let rim = smoothstep(tide * 0.86, tide * 0.97, h) * (1.0 - smoothstep(tide * 0.97, tide * 1.08, h));
  let damp = (below * 0.85 + rim * 0.6) * vertical * amt.z * step(-0.05, h);
  r.albedo *= mix(vec3f(1.0), vec3f(0.62, 0.58, 0.5), rim * vertical * amt.z);

  // Rain streaks on exposed faces, running down from the top; dust settles where rain never washes: sheltered tops
  // most, sheltered sides a little.
  let along = select(p.x, p.z, abs(g.x) > abs(g.z));
  let run = wearBand(vec3f(along * 6.0, p.y * 0.35, along * 2.3), 1.0, fw * 6.0);
  let streak = smoothstep(0.58, 0.82, run + (n1 - 0.5) * 0.2) * vertical * expo * amt.w;
  let dust = (1.0 - expo) * mix(0.25 * vertical, 1.0, smoothstep(0.6, 0.9, g.y)) * smoothstep(0.2, 0.6, breakup + 0.15) * 0.7 * amt.w;
  r.albedo *= mix(vec3f(1.0), vec3f(0.6, 0.57, 0.52), streak);
  r.albedo = mix(r.albedo, r.albedo * vec3f(0.86, 0.84, 0.8) + vec3f(0.012), dust);
  r.rough = mix(r.rough, min(1.0, r.rough + 0.12), dust);

  // Rust: metal where water sits (grime, streaks, damp, scratches), never on painted wood.
  let wetSpots = clamp(grime + streak + damp + edge * 0.5, 0.0, 1.0);
  let rust = smoothstep(0.35, 0.7, wetSpots * (0.6 + n1 * 0.8)) * amt2.x * max(r.metal, step(0.5, under.w));
  r.albedo = mix(r.albedo, vec3f(0.19, 0.075, 0.03) * mix(0.7, 1.3, n2), rust);
  r.rough = mix(r.rough, 0.86, rust);
  r.metal = mix(r.metal, 0.0, rust);

  // Wet: porous surfaces darken and every wet surface turns glossy (water F0 0.02 sits over the dielectric's own).
  r.wet = clamp(r.wet + damp * 0.9 + streak * 0.5 * r.wet, 0.0, 1.0);
  r.albedo *= mix(1.0, 1.0 - 0.45 * mat.w, r.wet * (1.0 - r.metal));
  r.rough = mix(r.rough, min(r.rough, 0.14), r.wet * 0.85);
  return r;
}

/** Validator false colour: blue below the measured range, red above, grey (its luminance) inside. */
fn wearCheck(albedo: vec3f, metal: f32) -> vec3f {
  let l = dot(albedo, vec3f(0.2126, 0.7152, 0.0722));
  let lo = select(${dark}, ${metalMin}, metal > 0.5);
  let hi = select(${bright}, 1.0, metal > 0.5);
  if (l < lo) { return vec3f(0.02, 0.1, 0.9); }
  if (l > hi) { return vec3f(0.95, 0.05, 0.02); }
  return vec3f(l);
}
`
}
