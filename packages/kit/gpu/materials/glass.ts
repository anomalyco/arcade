import type { LabControl } from "../../lab-panel"
import type { SceneHooks } from "../shaders"

/**
 * Glass that reads as glass, as `SceneHooks` composed over a game's physical-light hooks (`lights/physical.ts`).
 *
 * - **Thin glass** (`thinGlassHooks`, a blended pass): a two-interface slab. Opacity follows Fresnel (≈ 8 % head-on,
 *   most of the light at grazing), the reflection is the game's own environment and lamps through the physical
 *   path scaled to the slab's reflectance `2R / (1 + R)`, and a procedural grime and condensation layer (Heartfelt's
 *   idea, written from scratch) raises roughness, scatters light from both sides and dims what shows through. The
 *   room behind is the real geometry seen through the pane.
 * - **Interior-mapped windows** (`interiorWindowHooks`, an opaque pass whose base texture is a room atlas): each pane
 *   shows a room by intersecting the view ray with a box behind it (van Dongen 2008) and re-projecting the hit onto one
 *   pre-lit one-point-perspective room image (three-fenestra's `imRoomBoxUV`, MIT, Edgar Perez), with venetian blinds,
 *   the same front glass and grime. Pane size, frame and identity come from the screen derivatives of world position
 *   and the pane's 0..1 UVs, so any quad works without extra vertex data.
 *
 * WGSL credits: `kitRoomBoxUV` and `kitPaneHash` are ports of three-fenestra's `imRoomBoxUV` and `imHash`
 * (https://github.com/codedgar/three-fenestra, MIT). The grime/condensation layer is original.
 */

export type GlassMode = "today" | "thin"
export type RoomMode = "today" | "rooms"

export type GlassSettings = {
  /** Thin glass (Fresnel opacity, reflections, grime) or the game's flat see-through pane. */
  mode: GlassMode
  /** Index of refraction: F0 = ((n − 1) / (n + 1))². */
  ior: number
  /** Reflection strength (× the slab reflectance). */
  reflection: number
  /** Smudges and dust at the frame edges, 0..1. */
  grime: number
  /** Condensation band rising from the sill, with drips cut through it, 0..1. */
  condensation: number
  /** How much light dirty or fogged glass scatters back toward the eye (dust albedo). */
  scatter: number
}

export type RoomSettings = {
  /** Interior-mapped rooms behind lit windows, or the game's flat glowing panes. */
  mode: RoomMode
  /** Room depth behind the pane, metres. */
  depth: number
  /** Room light (× the window's own brightness; 1 keeps the far look matched to flat panes). */
  brightness: number
  /** Share of windows with venetian blinds part-way down, 0..1. */
  blinds: number
  /**
   * Mullion edges: "today" smoothsteps over one pixel, which keeps a sub-pixel bar at full strength over its centre
   * pixel (far bars flash as they cross pixel centres); "box" covers each pixel by the exact share of the bar in it.
   */
  mullions: "today" | "box"
}

export const GLASS_DEFAULTS: Readonly<GlassSettings> = { mode: "today", ior: 1.52, reflection: 1, grime: 0.3, condensation: 0.35, scatter: 0.4 }
export const ROOM_DEFAULTS: Readonly<RoomSettings> = { mode: "today", depth: 3.2, brightness: 1, blinds: 0.45, mullions: "today" }

export const createGlassSettings = (overrides: Partial<GlassSettings> = {}): GlassSettings => ({ ...GLASS_DEFAULTS, ...overrides })
export const createRoomSettings = (overrides: Partial<RoomSettings> = {}): RoomSettings => ({ ...ROOM_DEFAULTS, ...overrides })

/** Typed Lab rows: the mode row first so Today is one setting away. */
export function glassControls(group = "Glass", prefix = "glass."): LabControl[] {
  const key = (k: keyof GlassSettings) => ({ key: prefix + k, ...(prefix ? { field: k } : {}) })
  const range = (k: keyof GlassSettings, label: string, min: number, max: number, step: number, unit?: string): LabControl => ({
    ...key(k), label, group, subsection: "Glass", min, max, step, ...(unit ? { unit } : {}),
  })
  return [
    { ...key("mode"), label: "Glass", group, subsection: "Glass", type: "select", options: [{ value: "today", label: "Today" }, { value: "thin", label: "Thin glass (Fresnel, grime)" }] },
    range("reflection", "Reflections", 0, 2, 0.05, "×"),
    range("ior", "Index of refraction", 1.3, 1.8, 0.01),
    range("grime", "Grime", 0, 1, 0.01),
    range("condensation", "Condensation", 0, 1, 0.01),
    range("scatter", "Grime scattering", 0, 1, 0.01),
  ]
}

export function roomControls(group = "Glass", prefix = "rooms."): LabControl[] {
  const key = (k: keyof RoomSettings) => ({ key: prefix + k, ...(prefix ? { field: k } : {}) })
  const range = (k: keyof RoomSettings, label: string, min: number, max: number, step: number, unit?: string): LabControl => ({
    ...key(k), label, group, subsection: "Windows", min, max, step, ...(unit ? { unit } : {}),
  })
  return [
    { ...key("mode"), label: "Lit windows", group, subsection: "Windows", type: "select", options: [{ value: "today", label: "Today" }, { value: "rooms", label: "Rooms behind the glass" }] },
    range("depth", "Room depth", 0.5, 8, 0.1, "m"),
    range("brightness", "Room light", 0, 3, 0.05, "×"),
    range("blinds", "Blinds", 0, 1, 0.01),
    { ...key("mullions"), label: "Mullion edges", group, subsection: "Windows", type: "select", options: [{ value: "today", label: "Today (smoothstep)" }, { value: "box", label: "Box filtered" }] },
  ]
}

export const GLASS_KNOB_FLOATS = 12

/** F0 of one dielectric interface. */
export const glassF0 = (ior: number) => ((ior - 1) / (ior + 1)) ** 2

/** Packs the live knobs: glass (f0, reflection, grime, condensation), (scatter, -, -, -), rooms (depth m, brightness, blinds, box-filtered mullions). */
export function packGlassKnobs<T extends Float32Array>(glass: GlassSettings, rooms: RoomSettings, out: T = new Float32Array(GLASS_KNOB_FLOATS) as T, offset = 0): T {
  out.set([glassF0(glass.ior), glass.reflection, glass.grime, glass.condensation, glass.scatter, 0, 0, 0, rooms.depth, rooms.brightness, rooms.blinds, rooms.mullions === "box" ? 1 : 0], offset)
  return out
}

/**
 * Room atlas layout (`rooms.ts`): `cols × rows` cells, `variants` consecutive cells per kind, the back wall's share of
 * the frame, and each cell's gain (texel × gain has mean luminance 1, so a far window matches a flat pane).
 */
export type RoomAtlasLayout = { cols: number; rows: number; variants: number; backScale: number; gains: readonly number[] }

export type GlassHookOptions = {
  /** Three WGSL `vec4f` expressions of the packed knobs (`packGlassKnobs`), e.g. fields of the game's custom uniform. */
  knobs: readonly [string, string, string]
  /**
   * Thin glass: WGSL `f32` of (`p`, `n`), 1 where the camera-facing normal `n` points into a lit room. That face mirrors
   * the room (its walls lit as the pane is, × `roomAlbedo`) instead of the sky: at night a lit room's far windows are
   * mirrors, which is what keeps a booth reading as a warm box rather than a hollow one. Default 0 (sky both sides).
   */
  roomSide?: string
  /** Thin glass: WGSL `vec3f`, the room's average wall albedo for that reflection (default 0.45 grey). */
  roomAlbedo?: string
}

/** Shared WGSL: pane frame from derivatives, Fresnel, grime. Needs the kit `common` (noise2, hash2). */
export const glassWgsl = /* wgsl */ `
struct KitPane { t: vec3f, b: vec3f, n: vec3f, size: vec2f, centre: vec3f, local: vec2f, du: vec2f, dv: vec2f }
var<private> kitPane: KitPane;
var<private> kitGlassAlpha: f32 = 1.0;
var<private> kitGlassSlab: f32 = 1.0;
var<private> kitGlassEmit: vec3f = vec3f(0.0);
var<private> kitGlassInner: f32 = 0.0;

/**
 * The pane under this fragment from the screen derivatives of world position and its 0..1 UV: exact for any planar
 * quad with affine UVs. Frame: t right and b up as seen from the side n faces (b has b.y ≥ 0), size in metres, local
 * in -0.5..0.5 (y up). Call in uniform control flow.
 */
fn kitPaneFrame(world: vec3f, uv: vec2f, normal: vec3f) -> KitPane {
  let dp1 = dpdx(world);
  let dp2 = dpdy(world);
  let du1 = dpdx(uv);
  let du2 = dpdy(uv);
  let det = du1.x * du2.y - du2.x * du1.y;
  let inv = select(0.0, 1.0 / det, abs(det) > 1e-24);
  let pu = (dp1 * du2.y - dp2 * du1.y) * inv;
  let pv = (dp2 * du1.x - dp1 * du2.x) * inv;
  var p: KitPane;
  p.size = vec2f(max(length(pu), 1e-3), max(length(pv), 1e-3));
  p.centre = world - pu * (uv.x - 0.5) - pv * (uv.y - 0.5);
  var b = pv / p.size.y;
  if (b.y < 0.0) { b = -b; }
  p.n = normalize(normal);
  p.b = b;
  p.t = normalize(cross(b, p.n));
  // From the interpolated UV, not world - centre: the centre is rebuilt per 2×2 quad and its rounding error would
  // show as quad-sized speckle in the grime noise.
  p.local = (uv - 0.5) * vec2f(select(-1.0, 1.0, dot(pu, p.t) >= 0.0), select(-1.0, 1.0, dot(pv, b) >= 0.0));
  p.du = du1;
  p.dv = du2;
  return p;
}

/** three-fenestra imHash (MIT): a stable 0..1 hash of a window id. */
fn kitPaneHash(p0: vec3f, seed: f32) -> f32 {
  var p = fract(p0 * 0.3183099 + vec3f(0.1, 0.2, 0.3) + seed);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

/** The pane's identity: its centre on a 25 cm lattice (centre noise is ~1 mm), offset off round-number boundaries. */
fn kitPaneId() -> vec3f { return floor(kitPane.centre * 4.0 + vec3f(0.31, 0.43, 0.17)); }

fn kitSchlick(f0: f32, c: f32) -> f32 { let x = 1.0 - clamp(c, 0.0, 1.0); let x2 = x * x; return f0 + (1.0 - f0) * x2 * x2 * x; }
fn kitSlab(r: f32) -> f32 { return 2.0 * r / (1.0 + r); }

/**
 * Grime on a pane: x = coverage 0..1 (scatters, dims transmission), y = roughness. Smudges from two octaves of value
 * noise in pane metres, dust collecting at the frame, and condensation that rises from the sill with clear drips cut
 * through it. Everything is in pane space, so it is stable under TAA jitter and camera motion.
 */
fn kitGrime(grime: f32, condensation: f32) -> vec2f {
  let m = kitPane.local * kitPane.size;
  let id = kitPaneId();
  let seed = vec2f(kitPaneHash(id, 1.7), kitPaneHash(id, 4.1)) * 50.0;
  let smudge = noise2(m * 2.3 + seed) * 0.7 + noise2(m * 5.3 - seed) * 0.3;
  let smear = smoothstep(0.5, 0.9, smudge);
  let edge = min(0.5 - abs(kitPane.local.x), 0.5 - abs(kitPane.local.y)) * min(kitPane.size.x, kitPane.size.y);
  let dust = 1.0 - smoothstep(0.0, 0.07, edge);
  var cover = grime * (smear * 0.35 + dust * 0.45 + 0.03);
  // Condensation: a band from the sill, ragged at its top, with vertical drips that wipe it clear.
  let fromSill = (kitPane.local.y + 0.5) * kitPane.size.y;
  let ragged = 0.18 + 0.32 * kitPaneHash(id, 7.3) + (noise2(vec2f(m.x * 6.0, 1.3) + seed) - 0.5) * 0.12;
  var fog = (1.0 - smoothstep(ragged * 0.5, ragged + 0.1, fromSill)) * (0.8 + 0.2 * noise2(m * vec2f(4.0, 9.0) + seed));
  let col = floor(m.x * 34.0 + seed.x);
  let drip = step(0.82, hash2(vec2f(col, seed.y)));
  let dripTop = ragged + 0.25 * hash2(vec2f(col, 3.1));
  let inDrip = drip * (1.0 - smoothstep(0.18, 0.42, abs(fract(m.x * 34.0 + seed.x) - 0.5) * 2.0)) * step(fromSill, dripTop);
  fog *= 1.0 - inDrip * 0.92;
  cover = clamp(cover + condensation * fog * 0.7, 0.0, 1.0);
  let rough = clamp(0.03 + grime * (smear * 0.25 + dust * 0.2) + condensation * fog * 0.55, 0.02, 0.85);
  return vec2f(cover, rough);
}
`

/** Interior-mapping WGSL (atlas in the textured pass's `baseMap`). */
export function roomWgsl(layout: RoomAtlasLayout): string {
  const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x))
  return /* wgsl */ `
const KIT_ROOM_COLS: f32 = ${f(layout.cols)};
const KIT_ROOM_ROWS: f32 = ${f(layout.rows)};
const KIT_ROOM_VARIANTS: f32 = ${f(layout.variants)};
const KIT_ROOM_BACK: f32 = ${f(layout.backScale)};
var<private> KIT_ROOM_GAINS: array<f32, ${layout.gains.length}> = array<f32, ${layout.gains.length}>(${layout.gains.map(f).join(", ")});

/**
 * three-fenestra imRoomBoxUV (MIT): the view ray from the camera (pane units, z along the outward normal scaled by the
 * larger side) through the pane point exits a box [-0.5, 0.5]² × [-depth, 0]; the exit point re-projects onto one
 * one-point-perspective room image whose back wall spans \`backScale\` of the frame. Image v points down.
 */
fn kitRoomBoxUV(cam: vec3f, local: vec2f, depth: f32, backScale: f32) -> vec2f {
  let origin = vec3f(local, 0.0);
  let dir = normalize(origin - cam);
  let safe = select(dir, sign(dir + vec3f(1e-9)) * 1e-5, abs(dir) < vec3f(1e-5));
  let inv = 1.0 / safe;
  let tn = (vec3f(-0.5, -0.5, -depth) - origin) * inv;
  let tf = (vec3f(0.5, 0.5, 0.0) - origin) * inv;
  let tmax = max(tn, tf);
  let t = min(min(tmax.x, tmax.y), tmax.z);
  let hit = origin + dir * t;
  let bs = clamp(backScale, 0.05, 0.999);
  let camDist = bs * depth / (1.0 - bs);
  let s = camDist / (camDist - hit.z);
  return vec2f(hit.x * s + 0.5, 0.5 - hit.y * s);
}

fn kitRoomCell(kind: f32, variant: f32) -> f32 {
  return clamp(kind, 0.0, KIT_ROOM_COLS * KIT_ROOM_ROWS / KIT_ROOM_VARIANTS - 1.0) * KIT_ROOM_VARIANTS + min(floor(variant * KIT_ROOM_VARIANTS), KIT_ROOM_VARIANTS - 1.0);
}

/** Atlas UV inside a cell, inset 2 % so low mips don't bleed between rooms. */
fn kitRoomAtlasUV(cellUV: vec2f, idx: f32) -> vec2f {
  let cell = vec2f(1.0 / KIT_ROOM_COLS, 1.0 / KIT_ROOM_ROWS);
  let origin = vec2f(idx % KIT_ROOM_COLS, floor(idx / KIT_ROOM_COLS)) * cell;
  let inset = cell * 0.02;
  return origin + inset + clamp(cellUV, vec2f(0.0), vec2f(1.0)) * (cell - 2.0 * inset);
}

/** Pre-lit room radiance seen through the pane (linear), for room \`kind\`. Camera behind the pane sees nothing. */
fn kitRoom(kind: f32, depthM: f32) -> vec3f {
  let rel = F.cam.xyz - kitPane.centre;
  let side = max(kitPane.size.x, kitPane.size.y);
  let cam = vec3f(dot(rel, kitPane.t) / kitPane.size.x, dot(rel, kitPane.b) / kitPane.size.y, dot(rel, kitPane.n) / side);
  if (cam.z <= 0.0) { return vec3f(0.0); }
  let id = kitPaneId();
  let uv = kitRoomBoxUV(cam, kitPane.local, depthM / side, KIT_ROOM_BACK);
  let idx = kitRoomCell(kind, kitPaneHash(id, 5.43));
  // Footprint from the flat pane UV, so the box's face seams don't select a tiny mip.
  let cell = vec2f(1.0 / KIT_ROOM_COLS, 1.0 / KIT_ROOM_ROWS);
  return textureSampleGrad(baseMap, texSampler, kitRoomAtlasUV(uv, idx), kitPane.du * cell, kitPane.dv * cell).rgb * KIT_ROOM_GAINS[u32(idx)];
}

/**
 * Window bars over the pane, 0..1 coverage, footprint-filtered: \`cols\` lights across (bars between them), a transom
 * \`transom\` m above the pane's bottom edge (only on panes centred above \`transomAbove\` m), all \`width\` m wide.
 */
fn kitMullions(cols: f32, width: f32, transom: f32, transomAbove: f32) -> f32 {
  let m = (kitPane.local + 0.5) * kitPane.size;
  let fw = max(vec2f(length(vec2f(kitPane.du.x, kitPane.dv.x)) * kitPane.size.x, length(vec2f(kitPane.du.y, kitPane.dv.y)) * kitPane.size.y), vec2f(1e-4));
  let hw = width * 0.5;
  let cell = kitPane.size.x / max(cols, 1.0);
  var dx = abs(fract(m.x / cell + 0.5) - 0.5) * cell;
  dx = select(dx, 1e3, m.x < cell * 0.5 || m.x > kitPane.size.x - cell * 0.5);
  dx = min(dx, min(m.x, kitPane.size.x - m.x) + hw - 0.012);
  var dy = min(m.y, kitPane.size.y - m.y) + hw - 0.012;
  if (transom > 0.0 && kitPane.centre.y > transomAbove) { dy = min(dy, abs(m.y - transom)); }
  // Box (Windows › Mullion edges): the share of the pixel's footprint the bar covers. Today's smoothstep kept a
  // sub-pixel bar at full strength over its centre pixel, so far bars flashed between ~1 and ~0 crossing pixel centres.
  let box = kitKnobsC().w > 0.5;
  let vx = select(1.0 - smoothstep(hw - fw.x * 0.5, hw + fw.x * 0.5, dx), kitBarCoverage(dx, hw, fw.x), box);
  let hy = select(1.0 - smoothstep(hw - fw.y * 0.5, hw + fw.y * 0.5, dy), kitBarCoverage(dy, hw, fw.y), box);
  return max(vx, hy);
}
/** Share of a footprint fw centred at distance d from a bar's axis that lies within the bar's half-width hw. */
fn kitBarCoverage(d: f32, hw: f32, fw: f32) -> f32 {
  return clamp((min(d + fw * 0.5, hw) - max(d - fw * 0.5, -hw)) / fw, 0.0, 1.0);
}

/** Venetian blinds part-way down from the head: x = transmission through the slats, y = slat coverage (lit by the room). */
fn kitBlinds(share: f32) -> vec2f {
  let id = kitPaneId();
  if (kitPaneHash(id, 8.8) >= share) { return vec2f(1.0, 0.0); }
  let drop = mix(0.15, 0.95, kitPaneHash(id, 6.6));
  let fromHead = (0.5 - kitPane.local.y) * kitPane.size.y;
  if (fromHead > drop * kitPane.size.y) { return vec2f(1.0, 0.0); }
  let period = 0.045;
  let y = fromHead / period;
  let fw = length(vec2f(kitPane.du.y, kitPane.dv.y)) * kitPane.size.y / period;
  let open = mix(0.18, 0.55, kitPaneHash(id, 3.3));
  let sharp = smoothstep(open - 0.08, open + 0.08, fract(y));
  let gap = mix(1.0 - sharp, open, clamp(fw * 1.5 - 0.3, 0.0, 1.0));
  return vec2f(gap, 1.0 - gap);
}
`
}

/** Front glass on an opaque pane or a thin pane: physical combine with the slab reflectance. */
function slabCombine(): Pick<SceneHooks, "combineLighting" | "specularCombine"> {
  return {
    combineLighting: `let pbrR = pbrPerceptual(gloss.x);
    let pbrF0 = vec3f(kitKnobsA().x);
    let pbrAo = 1.0;
    let kitSky = pbrEnvSpecular(n, V, pbrR, pbrF0, pbrAo);
    let kitRoomMirror = kitRoomAlbedo() * direct * pbrEnvBRDF(pbrF0, pbrR, max(dot(n, V), 1e-4)) * pbrKnobs().z;
    col = albedo * (amb + direct + moon) + mix(kitSky, kitRoomMirror, kitGlassInner) * kitGlassSlab`,
    specularCombine: "(pbrF0 * lit.spec + pbrSpecF) * GAIN * kitGlassSlab",
  }
}

function knobDecls(o: GlassHookOptions): string {
  return `fn kitRoomSide(p: vec3f, n: vec3f) -> f32 { return ${o.roomSide ?? "0.0"}; }
fn kitRoomAlbedo() -> vec3f { return ${o.roomAlbedo ?? "vec3f(0.45)"}; }
fn kitKnobsA() -> vec4f { return ${o.knobs[0]}; }
fn kitKnobsB() -> vec4f { return ${o.knobs[1]}; }
fn kitKnobsC() -> vec4f { return ${o.knobs[2]}; }`
}

/**
 * Glass grime, reflectance and back-lit scattering in the material hook. Needs `kitPane` set; `twoSided` lights the
 * grime from behind too (a second light loop over this pixel's lights, glass pixels only).
 */
function glassMaterial(twoSided: boolean): string {
  return /* wgsl */ `
    let kitA = kitKnobsA();
    let kitGr = kitGrime(kitA.z, kitA.w);
    var kitN = kitPane.n;
    if (dot(kitN, V) < 0.0) { kitN = -kitN; }
    n = kitN;
    kitGlassInner = kitRoomSide(o.world, kitN);
    let kitCos = max(dot(kitN, V), 1e-3);
    let kitR = kitSlab(kitSchlick(kitA.x, kitCos));
    kitGlassSlab = kitSlab(kitSchlick(kitA.x, kitCos)) / max(kitSchlick(kitA.x, kitCos), 1e-4) * kitA.y;
    let kitScatter = kitGr.x * kitKnobsB().x;
    albedo = vec3f(0.62, 0.6, 0.55) * kitScatter;
    pbrRough = kitGr.y;
    pbrMetal = 0.0;
    kitGlassAlpha = 1.0 - (1.0 - min(kitR * kitA.y, 1.0)) * (1.0 - kitGr.x * 0.8);
    ${twoSided ? `let kitBack = lightSum(o.world, -kitN, V, 1.0, 0.0).diff * GAIN;
    pbrSpecF = vec3f(0.0);
    kitGlassEmit = albedo * kitBack * 0.5;` : "kitGlassEmit = vec3f(0.0);"}
  `
}

/**
 * A blended thin-glass pass over the game's physical hooks (built with `withPhysicalLights`, textured: 0..1 pane UVs).
 * The game's own `surface` (fog) runs twice so the in-scatter in front of the pane is not counted twice:
 * out = fogged(glass radiance) − inscatter · (1 − α), premultiplied.
 */
export function thinGlassHooks(base: SceneHooks, opts: GlassHookOptions): SceneHooks {
  return {
    ...base,
    declarations: `${base.declarations ?? ""}\n${glassWgsl}\n${knobDecls(opts)}`,
    fragmentStart: `${base.fragmentStart ?? ""}\nkitPane = kitPaneFrame(o.world, o.uv, o.normal);`,
    material: `${base.material ?? ""}\n${glassMaterial(true)}`,
    ...slabCombine(),
    surface: `col += kitGlassEmit;
    let kitSurface = col;
    col = vec3f(0.0);
    { ${base.surface ?? ""} }
    let kitInscatter = col;
    col = kitSurface;
    { ${base.surface ?? ""} }
    alpha = kitGlassAlpha;
    col = max(col - kitInscatter * (1.0 - alpha), vec3f(0.0));`,
    fragmentReturn: "return vec4f(col * o.extra.z, a);",
  }
}

/**
 * An opaque interior-mapped window pass (the textured pass's base texture is the room atlas). Per vertex: colour is
 * the room's light tint, `aux = kind · 4 + brightness` (brightness < 4), pane UVs 0..1.
 */
export type MullionLayout = { cols: number; width: number; transom: number; transomAbove: number }

export function interiorWindowHooks(base: SceneHooks, opts: GlassHookOptions & { layout: RoomAtlasLayout; mullions?: MullionLayout }): SceneHooks {
  const m = opts.mullions
  const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x))
  return {
    ...base,
    declarations: `${base.declarations ?? ""}\n${glassWgsl}\n${roomWgsl(opts.layout)}\n${knobDecls(opts)}`,
    fragmentStart: `${base.fragmentStart ?? ""}\nkitPane = kitPaneFrame(o.world, o.uv, o.normal);`,
    material: `${base.material ?? ""}\n${glassMaterial(false)}
    let kitKind = floor(o.aux / 4.0);
    let kitBright = o.aux - kitKind * 4.0;
    let kitC = kitKnobsC();
    let kitRoomRgb = kitRoom(kitKind, kitC.x) * o.color * kitBright * kitC.y;
    let kitBl = kitBlinds(kitC.z);
    let kitSlat = vec3f(0.55, 0.5, 0.42) * dot(o.color, vec3f(0.3333)) * kitBright * kitC.y * 0.35;
    let kitBar = ${m ? `kitMullions(${f(m.cols)}, ${f(m.width)}, ${f(m.transom)}, ${f(m.transomAbove)})` : "0.0"};
    kitGlassEmit = (kitRoomRgb * kitBl.x + kitSlat * kitBl.y) * (1.0 - kitGlassAlpha) * (1.0 - kitBar);
    albedo = mix(albedo, vec3f(0.035, 0.038, 0.036), kitBar);
    pbrRough = mix(pbrRough, 0.45, kitBar);
    kitGlassSlab = mix(kitGlassSlab, 1.0, kitBar);`,
    ...slabCombine(),
    surface: `col += kitGlassEmit;\n${base.surface ?? ""}`,
  }
}
