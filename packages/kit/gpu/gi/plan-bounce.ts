import { LIGHT_CAPSULE, OCC_FLOATS } from "../../limits"
import { common } from "../shaders"

/**
 * One-bounce coloured light in plan space for top-down scenes (Outbreak's "Bounced light", AR-115).
 *
 * Every frame, after the polar shadow pass, three compute stages run on a world-anchored grid around the camera:
 *
 * 1. Emission: each texel takes the light the frame's lights put on it (the same falloff and cones as the scene's
 *    `lightSum`, or a game hook), shadowed by the polar map for lights that cast shadows and by a short march through a
 *    height map of the occluders for those that don't, times a reflectance. Wall texels take the light on their face.
 *    rgb is the light leaving the texel, alpha how much it blocks bounced light (walls, not low furniture).
 * 2. A mip chain of that grid (2×2 box).
 * 3. Gather: 16 cones per texel march outward, each step reading the mip whose texel matches the cone's width, adding
 *    the light it sees and losing what walls in that footprint block. The kernel is inverse-square with a soft core,
 *    normalised so a uniformly lit neighbourhood returns its own leaving light; `strength` scales it.
 *
 * The cost depends on the grid size, not on the number of lights beyond the emission loop, and the result is a pure
 * function of the world (the grid snaps to the coarsest mip cell, nothing is jittered or accumulated), so it holds still
 * under temporal AA. Scenes read it with `planBounceSceneWgsl`'s `planBounceAt`, which weights the four nearest texels
 * by how open they are so light never bleeds through a wall into the room behind it.
 *
 * Technique: the bonfire article (https://algorythmic-explorations.vercel.app/pages/bounced-light/bonfire.html) and
 * pull-cord-lamp (MIT) compute one bounce from emitters times albedo with radiance cascades; this is the cheaper
 * cone-traced cousin of a single cascade level, which is enough for one bounce over a few metres.
 */

/** Scene bindings the renderer gives the bounce texture and its uniform. */
export const PLAN_BOUNCE_BINDINGS = { texture: 23, uniform: 24 } as const
/** Metres the grid covers on each side. */
export const PLAN_BOUNCE_EXTENT = 64
/** Mip levels in the emission chain; the grid snaps to the coarsest level's cell. */
export const PLAN_BOUNCE_LEVELS = 4
/** Cones per texel in the gather. */
export const PLAN_BOUNCE_DIRS = 16
export const PLAN_BOUNCE_UNIFORM_FLOATS = 16
/** Texel sizes the grid supports (each divides the extent into a power-of-two-friendly count). */
export const PLAN_BOUNCE_TEXELS = [0.25, 0.5, 1] as const
/** Occluder heights are stored as height / this in the r8 height map. */
export const PLAN_BOUNCE_HEIGHT_SCALE = 4

export type PlanBounceInput = {
  /** Plan point the grid centres on (the camera's ground focus). */
  centerX: number
  centerZ: number
  /** × one bounce; 0 skips the passes and the scene adds nothing. */
  strength: number
  /** How far bounced light travels, in metres. */
  range: number
  /** Metres per texel (one of `PLAN_BOUNCE_TEXELS`). */
  texel: number
  /** How much light floors send back (0..1). */
  albedo?: number
  /** How much more a lit wall sends back than a floor texel (it is taller and faces the light). */
  walls?: number
  /** Height the floor lights are evaluated at. */
  floorY?: number
  /** Three floats for the game's scene hook (`planBounceU.d.yzw`). */
  params?: readonly [number, number, number]
}

/**
 * Game WGSL for the emission pass. `attenuation` must declare `var att` for light `L` at the texel; in scope: `L`, `i`
 * (slot), `p` (texel plan point), `lp` (light plan point, the capsule's nearest point for capsules), `hl` (light
 * height), `dv` (p − lp), `dPlan2`, `r` (reach), `power`, `win` ((1 − d²/r²)²), `d3`, `dy` (hl − point height), `wall`
 * (the texel is a wall face). `continue` skips the light. `declarations` adds functions or uniforms it needs.
 */
export type PlanBounceShader = { attenuation?: string; declarations?: string }

/** The kit's default: `lightSum`'s windowed falloff and plan spot cone. */
export const PLAN_BOUNCE_DEFAULT_ATTENUATION = /* wgsl */ `let dn = max(d3, max(hl, 1.25));
    var att = power * win * (0.1 + 2.6 / (1.0 + dn * dn * 0.3));
    if (L.cone.w > 0.5 && L.cone.w < 2.5 && dPlan2 > 1e-6) {
      let c = dot(dv * inverseSqrt(dPlan2), L.cone.xy);
      let t = clamp((c - L.cone.z) / 0.25, 0.0, 1.0);
      att *= t * t * (3.0 - 2.0 * t);
    }`

/** Grid placement for a frame: origin snapped to the coarsest mip cell, so every level stays world-anchored. */
export function planBounceWindow(centerX: number, centerZ: number, texel: number): { originX: number; originZ: number; size: number } {
  const t = PLAN_BOUNCE_TEXELS.reduce((best, v) => (Math.abs(v - texel) < Math.abs(best - texel) ? v : best), PLAN_BOUNCE_TEXELS[1] as number)
  const size = Math.round(PLAN_BOUNCE_EXTENT / t)
  const snap = t * (1 << (PLAN_BOUNCE_LEVELS - 1))
  const half = PLAN_BOUNCE_EXTENT / 2
  return { originX: Math.round(centerX / snap) * snap - half, originZ: Math.round(centerZ / snap) * snap - half, size }
}

/**
 * Rasterises the frame's occluders (kit layout: rect x0, z0, x1, z1, then height, round flag) into a `size`² height map
 * of bytes (height / `PLAN_BOUNCE_HEIGHT_SCALE`), conservatively, so a wall thinner than a texel still fills one. Round
 * casters (people) are skipped. Returns whether `out` changed.
 */
export function rasterPlanOccupancy(
  occluders: Float32Array,
  count: number,
  originX: number,
  originZ: number,
  texel: number,
  size: number,
  out: Uint8Array,
  scratch: Uint8Array,
): boolean {
  scratch.fill(0, 0, size * size)
  const x1w = originX + size * texel
  const z1w = originZ + size * texel
  for (let i = 0; i < count; i++) {
    const o = i * OCC_FLOATS
    if (occluders[o + 5]! > 0.5) continue
    const x0 = occluders[o]!, z0 = occluders[o + 1]!, x1 = occluders[o + 2]!, z1 = occluders[o + 3]!
    if (x1 <= originX || x0 >= x1w || z1 <= originZ || z0 >= z1w) continue
    const h = Math.max(1, Math.min(255, Math.round((occluders[o + 4]! / PLAN_BOUNCE_HEIGHT_SCALE) * 255)))
    const a0 = Math.max(0, Math.floor((x0 - originX) / texel))
    const a1 = Math.min(size - 1, Math.floor((x1 - originX - 1e-4) / texel))
    const b0 = Math.max(0, Math.floor((z0 - originZ) / texel))
    const b1 = Math.min(size - 1, Math.floor((z1 - originZ - 1e-4) / texel))
    for (let b = b0; b <= b1; b++) {
      const row = b * size
      for (let a = a0; a <= a1; a++) if (scratch[row + a]! < h) scratch[row + a] = h
    }
  }
  let changed = false
  for (let i = 0; i < size * size; i++) {
    if (out[i] !== scratch[i]) {
      changed = true
      break
    }
  }
  if (changed) out.set(scratch.subarray(0, size * size))
  return changed
}

/** Packs the uniform both the passes and `planBounceSceneWgsl` read. */
export function packPlanBounceUniforms(
  input: PlanBounceInput,
  win: { originX: number; originZ: number; size: number },
  lightCount: number,
  shadowLightCount: number,
  out = new Float32Array(PLAN_BOUNCE_UNIFORM_FLOATS),
): Float32Array {
  const texel = PLAN_BOUNCE_EXTENT / win.size
  out[0] = win.originX
  out[1] = win.originZ
  out[2] = texel
  out[3] = win.size
  out[4] = Math.max(0, input.strength)
  out[5] = Math.max(1, input.range / texel)
  out[6] = input.albedo ?? 0.35
  out[7] = input.walls ?? 1.5
  out[8] = lightCount
  out[9] = shadowLightCount
  out[10] = input.floorY ?? 0.05
  out[11] = 1 / texel
  // Fade the last 3 m of the grid so its edge never shows when it snaps.
  out[12] = 3 / texel
  out[13] = input.params?.[0] ?? 0
  out[14] = input.params?.[1] ?? 0
  out[15] = input.params?.[2] ?? 0
  return out
}

const uniformStruct = /* wgsl */ `
struct PlanBounceUniforms {
  a: vec4f, // origin x, origin z, metres per texel, texels per side
  b: vec4f, // strength, range (texels), floor reflectance, wall reflectance
  c: vec4f, // light count, shadow light count, floor height, 1 / texel
  d: vec4f, // edge fade (texels), game params (PlanBounceInput.params)
}`

/** Scene-side declarations: the bounce texture and uniform at bindings 23–24, and `planBounceAt(p)`. */
export const planBounceSceneWgsl = /* wgsl */ `
${uniformStruct}
@group(0) @binding(${PLAN_BOUNCE_BINDINGS.texture}) var planBounceTex: texture_2d<f32>;
@group(0) @binding(${PLAN_BOUNCE_BINDINGS.uniform}) var<uniform> planBounceU: PlanBounceUniforms;
/** Strength of bounced light this frame (0 when off). */
fn planBounceStrength() -> f32 { return planBounceU.b.x; }
/**
 * Bounced light arriving at plan point p, already scaled by strength. The four nearest texels are weighted by how open
 * they are, so a sample beside a wall reads the room it is in and not the far side.
 */
fn planBounceAt(p: vec2f) -> vec3f {
  if (planBounceU.b.x <= 0.0) { return vec3f(0.0); }
  let n = i32(planBounceU.a.w);
  let g = (p - planBounceU.a.xy) * planBounceU.c.w - 0.5;
  let i0 = vec2i(floor(g));
  if (any(i0 < vec2i(0)) || any(i0 + vec2i(1) >= vec2i(n))) { return vec3f(0.0); }
  let f = g - floor(g);
  let s00 = textureLoad(planBounceTex, i0, 0);
  let s10 = textureLoad(planBounceTex, i0 + vec2i(1, 0), 0);
  let s01 = textureLoad(planBounceTex, i0 + vec2i(0, 1), 0);
  let s11 = textureLoad(planBounceTex, i0 + vec2i(1, 1), 0);
  let b00 = (1.0 - f.x) * (1.0 - f.y);
  let b10 = f.x * (1.0 - f.y);
  let b01 = (1.0 - f.x) * f.y;
  let b11 = f.x * f.y;
  let w = vec4f(b00 * s00.a, b10 * s10.a, b01 * s01.a, b11 * s11.a);
  let ws = w.x + w.y + w.z + w.w;
  if (ws < 1e-3) { return (s00.rgb * b00 + s10.rgb * b10 + s01.rgb * b01 + s11.rgb * b11); }
  return (s00.rgb * w.x + s10.rgb * w.y + s01.rgb * w.z + s11.rgb * w.w) / ws;
}`

/** Emission pass: one invocation per texel. */
export const planBounceEmitShader = (shader: PlanBounceShader = {}) => /* wgsl */ `
${common}
${uniformStruct}
@group(0) @binding(3) var<uniform> PB: PlanBounceUniforms;
@group(0) @binding(4) var heightTex: texture_2d<f32>;
@group(0) @binding(5) var emitOut: texture_storage_2d<rgba16float, write>;
${shader.declarations ?? ""}

fn occluderHeight(c: vec2i) -> f32 {
  let n = i32(PB.a.w);
  if (any(c < vec2i(0)) || any(c >= vec2i(n))) { return 0.0; }
  return textureLoad(heightTex, c, 0).r * ${PLAN_BOUNCE_HEIGHT_SCALE.toFixed(1)};
}

/** Visibility from a light slot's polar row (the first full-height occluder), between the two nearest rays. */
fn polarVis(slot: u32, lp: vec2f, p: vec2f) -> f32 {
  let dv = p - lp;
  let d = length(dv);
  if (d < 0.05) { return 1.0; }
  var a = atan2(dv.y, dv.x);
  if (a < 0.0) { a += TAU; }
  let f = a / TAU * f32(RAYS) - 0.5;
  let lo = floor(f);
  let i0 = u32(i32(lo) + i32(RAYS) * 4) % RAYS;
  let i1 = (i0 + 1u) % RAYS;
  let f0 = polar[(slot * RAYS + i0) * 2u].x;
  let f1 = polar[(slot * RAYS + i1) * 2u].x;
  let v0 = 1.0 - smoothstep(f0 - 0.08, f0 + 0.12, d);
  let v1 = 1.0 - smoothstep(f1 - 0.08, f1 + 0.12, d);
  return mix(v0, v1, f - lo);
}

/** Visibility of a light at (lp, hl) from plan point p at height y, marched through the occluder height map. */
fn marchVis(p: vec2f, y: f32, lp: vec2f, hl: f32) -> f32 {
  let t = PB.a.z;
  let dv = lp - p;
  let d = length(dv);
  // Fixtures sit on or in walls: stop short of the light's own texel.
  let len = d - max(0.45, t * 0.75);
  if (len <= t * 0.5) { return 1.0; }
  let dir = dv / d;
  let stepLen = t * 0.7;
  let steps = min(i32(ceil(len / stepLen)), 64);
  var vis = 1.0;
  for (var k = 0; k < steps; k++) {
    let s = min(len, t * 0.5 + f32(k) * stepLen);
    let q = p + dir * s;
    let rayY = y + (hl - y) * (s / d);
    let h = occluderHeight(vec2i(floor((q - PB.a.xy) * PB.c.w)));
    vis *= 1.0 - smoothstep(rayY - 0.05, rayY + 0.15, h);
    if (vis < 0.01) { return 0.0; }
  }
  return vis;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = u32(PB.a.w);
  if (gid.x >= n || gid.y >= n) { return; }
  let cell = vec2i(gid.xy);
  let t = PB.a.z;
  let center = PB.a.xy + (vec2f(gid.xy) + 0.5) * t;
  let hOcc = occluderHeight(cell);
  let wall = hOcc >= 1.6;
  let floorY = PB.c.z;
  let count = min(u32(PB.c.x), MAX_LIGHTS);
  let shadowCount = u32(PB.c.y);
  var e = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let L = lights[i];
    let power = L.color.w;
    if (power <= 0.001) { continue; }
    var lp = L.pos.xz;
    var hl = L.pos.y;
    var r = L.pos.w;
    // A wall texel is lit on the face toward the light, at mid height.
    var p = center;
    let y = select(floorY, 1.0, wall);
    if (L.cone.w < -1.5 && L.cone.w > -2.0) {
      // Capsule (cone.w ${LIGHT_CAPSULE}): nearest point of pos ± cone.xyz.
      let a = L.pos.xyz - L.cone.xyz;
      let ab = L.cone.xyz * 2.0;
      let q = a + ab * clamp(dot(vec3f(p.x, y, p.y) - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      r = max(r - length(L.cone.xz), 0.05);
      lp = q.xz;
      hl = q.y;
    }
    var dv = p - lp;
    var dPlan2 = dot(dv, dv);
    if (dPlan2 >= r * r) { continue; }
    if (wall) {
      let dPlan = sqrt(dPlan2);
      if (dPlan < t * 0.8) { continue; }
      p = p - dv / dPlan * t * 0.8;
      dv = p - lp;
      dPlan2 = dot(dv, dv);
    }
    let dy = hl - y;
    let d3 = max(sqrt(dPlan2 + dy * dy), 0.05);
    var win = 1.0 - dPlan2 / (r * r);
    win *= win;
    ${shader.attenuation ?? PLAN_BOUNCE_DEFAULT_ATTENUATION}
    if (att <= 0.0005) { continue; }
    let ndl = select(max(dy, 0.0), sqrt(dPlan2), wall) / d3;
    if (ndl <= 0.0) { continue; }
    var vis = 1.0;
    if (L.extra.y > 0.5 && i < shadowCount) {
      vis = polarVis(i, lp, p);
    } else {
      vis = marchVis(p, y, lp, hl);
    }
    e += L.color.rgb * (att * ndl * vis);
  }
  let reflectance = PB.b.z * select(1.0, PB.b.w, wall);
  let block = smoothstep(1.0, 2.0, hOcc);
  textureStore(emitOut, cell, vec4f(e * GAIN * reflectance, block));
}
`

/** One mip step of the emission chain (2×2 box). */
export const planBounceDownShader = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = textureDimensions(dst);
  if (gid.x >= n.x || gid.y >= n.y) { return; }
  let c = vec2i(gid.xy) * 2;
  let s = textureLoad(src, c, 0) + textureLoad(src, c + vec2i(1, 0), 0) + textureLoad(src, c + vec2i(0, 1), 0) + textureLoad(src, c + vec2i(1, 1), 0);
  textureStore(dst, vec2i(gid.xy), s * 0.25);
}
`

/** Gather pass: 16 cones per texel through the emission mips; alpha out is how open the texel is. */
export const planBounceGatherShader = /* wgsl */ `
const TAU: f32 = 6.2831853;
const DIRS: i32 = ${PLAN_BOUNCE_DIRS};
const LEVELS: f32 = ${PLAN_BOUNCE_LEVELS}.0;
${uniformStruct}
@group(0) @binding(0) var<uniform> PB: PlanBounceUniforms;
@group(0) @binding(1) var emitTex: texture_2d<f32>;
@group(0) @binding(2) var emitSamp: sampler;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;

/** Cone width as a share of distance: 2 tan(π / DIRS). */
const CONE: f32 = ${(2 * Math.tan(Math.PI / PLAN_BOUNCE_DIRS)).toFixed(6)};

fn stepOf(r: f32) -> f32 { return max(1.0, r * CONE * 0.75); }
fn kernel(r: f32, range: f32, core: f32, stepLen: f32) -> f32 {
  let x = r / range;
  let w = 1.0 - x * x;
  return w * w * r * stepLen / (r * r + core * core);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = i32(PB.a.w);
  if (i32(gid.x) >= n || i32(gid.y) >= n) { return; }
  let nf = f32(n);
  let c = vec2f(gid.xy) + 0.5;
  let range = PB.b.y;
  // Soft core of the kernel: about a metre, so a texel's own neighbourhood doesn't dominate.
  let core = PB.c.w;
  var total = 0.0;
  var r0 = 1.0;
  loop {
    if (r0 >= range) { break; }
    let s = stepOf(r0);
    total += kernel(r0, range, core, s);
    r0 += s;
  }
  var acc = vec3f(0.0);
  for (var k = 0; k < DIRS; k++) {
    let ang = (f32(k) + 0.5) / f32(DIRS) * TAU;
    let dir = vec2f(cos(ang), sin(ang));
    var r = 1.0;
    var T = 1.0;
    loop {
      if (r >= range || T < 0.02) { break; }
      let q = c + dir * r;
      if (any(q < vec2f(0.0)) || any(q > vec2f(nf))) { break; }
      let fp = max(1.0, r * CONE);
      let lod = min(log2(fp), LEVELS - 1.0);
      let s = textureSampleLevel(emitTex, emitSamp, q / nf, lod);
      let stepLen = stepOf(r);
      acc += s.rgb * (T * kernel(r, range, core, stepLen));
      // A wall crossing the cone fills only a 1/footprint share of the cell, but blocks the whole cone.
      T *= 1.0 - min(1.0, s.a * fp);
      r += stepLen;
    }
  }
  let edge = min(min(c.x, c.y), min(nf - c.x, nf - c.y));
  let fade = smoothstep(0.0, PB.d.x, edge);
  let open = 1.0 - textureLoad(emitTex, vec2i(gid.xy), 0).a;
  let bounce = acc / max(total * f32(DIRS), 1e-4) * PB.b.x * fade;
  textureStore(outTex, vec2i(gid.xy), vec4f(bounce, open));
}
`

/** Buffers the renderer shares with the passes. */
export type PlanBounceShared = { frame: GPUBuffer; lights: GPUBuffer; polar: GPUBuffer; compile: (code: string, label: string) => GPUShaderModule }

type Grid = {
  size: number
  height: GPUTexture
  emit: GPUTexture
  out: GPUTexture
  outView: GPUTextureView
  emitGroup: GPUBindGroup
  downGroups: GPUBindGroup[]
  gatherGroup: GPUBindGroup
  heights: Uint8Array<ArrayBuffer>
  scratch: Uint8Array<ArrayBuffer>
}

/**
 * Owns the bounce grid's textures and passes. The renderer calls `encode` after the polar pass while bounced light is on
 * and binds `view` / `uniform` into the scene group (rebuilding it when `version` changes).
 */
export class PlanBounce {
  readonly uniform: GPUBuffer
  private readonly data = new Float32Array(PLAN_BOUNCE_UNIFORM_FLOATS)
  private readonly emitPipe: GPUComputePipeline
  private readonly downPipe: GPUComputePipeline
  private readonly gatherPipe: GPUComputePipeline
  private readonly emitLayout: GPUBindGroupLayout
  private readonly downLayout: GPUBindGroupLayout
  private readonly gatherLayout: GPUBindGroupLayout
  private readonly sampler: GPUSampler
  private readonly placeholder: GPUTextureView
  private grid: Grid | null = null
  private lastOriginX = NaN
  private lastOriginZ = NaN
  private active = false
  /** Bumped whenever `view` changes, so the renderer rebuilds its scene bind group. */
  version = 0

  constructor(
    private readonly device: GPUDevice,
    private readonly shared: PlanBounceShared,
    shader: PlanBounceShader = {},
  ) {
    const d = device
    const S = GPUShaderStage.COMPUTE
    this.uniform = d.createBuffer({ label: "plan bounce uniforms", size: PLAN_BOUNCE_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.placeholder = d.createTexture({ size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING }).createView()
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.emitLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S, buffer: { type: "uniform" } },
        { binding: 1, visibility: S, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: S, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: S, buffer: { type: "uniform" } },
        { binding: 4, visibility: S, texture: { sampleType: "float" } },
        { binding: 5, visibility: S, storageTexture: { access: "write-only", format: "rgba16float" } },
      ],
    })
    this.downLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: S, storageTexture: { access: "write-only", format: "rgba16float" } },
      ],
    })
    this.gatherLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S, buffer: { type: "uniform" } },
        { binding: 1, visibility: S, texture: { sampleType: "float" } },
        { binding: 2, visibility: S, sampler: { type: "filtering" } },
        { binding: 3, visibility: S, storageTexture: { access: "write-only", format: "rgba16float" } },
      ],
    })
    const pipe = (layout: GPUBindGroupLayout, code: string, label: string) =>
      d.createComputePipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: shared.compile(code, label), entryPoint: "main" } })
    this.emitPipe = pipe(this.emitLayout, planBounceEmitShader(shader), "plan bounce emit")
    this.downPipe = pipe(this.downLayout, planBounceDownShader, "plan bounce down")
    this.gatherPipe = pipe(this.gatherLayout, planBounceGatherShader, "plan bounce gather")
    d.queue.writeBuffer(this.uniform, 0, this.data)
  }

  /** What the scene samples at binding 23 (a 1×1 placeholder until the first frame with bounce on). */
  get view(): GPUTextureView {
    return this.grid?.outView ?? this.placeholder
  }

  private ensureGrid(size: number): Grid {
    if (this.grid?.size === size) return this.grid
    this.grid?.height.destroy()
    this.grid?.emit.destroy()
    this.grid?.out.destroy()
    const d = this.device
    const U = GPUTextureUsage
    const height = d.createTexture({ label: "plan bounce heights", size: [size, size], format: "r8unorm", usage: U.TEXTURE_BINDING | U.COPY_DST })
    const emit = d.createTexture({ label: "plan bounce emission", size: [size, size], format: "rgba16float", mipLevelCount: PLAN_BOUNCE_LEVELS, usage: U.TEXTURE_BINDING | U.STORAGE_BINDING })
    const out = d.createTexture({ label: "plan bounce", size: [size, size], format: "rgba16float", usage: U.TEXTURE_BINDING | U.STORAGE_BINDING })
    const level = (l: number) => emit.createView({ baseMipLevel: l, mipLevelCount: 1 })
    const grid: Grid = {
      size,
      height,
      emit,
      out,
      outView: out.createView(),
      emitGroup: d.createBindGroup({
        layout: this.emitLayout,
        entries: [
          { binding: 0, resource: { buffer: this.shared.frame } },
          { binding: 1, resource: { buffer: this.shared.lights } },
          { binding: 2, resource: { buffer: this.shared.polar } },
          { binding: 3, resource: { buffer: this.uniform } },
          { binding: 4, resource: height.createView() },
          { binding: 5, resource: level(0) },
        ],
      }),
      downGroups: Array.from({ length: PLAN_BOUNCE_LEVELS - 1 }, (_, l) =>
        d.createBindGroup({ layout: this.downLayout, entries: [{ binding: 0, resource: level(l) }, { binding: 1, resource: level(l + 1) }] }),
      ),
      gatherGroup: d.createBindGroup({
        layout: this.gatherLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: emit.createView() },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: out.createView() },
        ],
      }),
      heights: new Uint8Array(size * size),
      scratch: new Uint8Array(size * size),
    }
    // Force the first raster to upload.
    grid.heights.fill(255)
    this.grid = grid
    this.lastOriginX = NaN
    this.version++
    return grid
  }

  /**
   * Runs the three stages for this frame, or turns the scene's bounce off when `input` is null or has no strength, or
   * the frame has no lights.
   * Returns whether it encoded a pass; `timestampWrites` lets the renderer's frame timer start here.
   */
  encode(enc: GPUCommandEncoder, input: PlanBounceInput | null | undefined, occluders: Float32Array, occluderCount: number, lightCount: number, shadowLightCount: number, timestampWrites?: GPUComputePassTimestampWrites): boolean {
    // No lights, nothing to bounce (daylight): skip the passes like off.
    if (!input || !(input.strength > 0) || lightCount <= 0) {
      if (this.active) {
        this.data.fill(0)
        this.device.queue.writeBuffer(this.uniform, 0, this.data)
        this.active = false
      }
      return false
    }
    const win = planBounceWindow(input.centerX, input.centerZ, input.texel)
    const grid = this.ensureGrid(win.size)
    const texel = PLAN_BOUNCE_EXTENT / win.size
    const moved = win.originX !== this.lastOriginX || win.originZ !== this.lastOriginZ
    if (rasterPlanOccupancy(occluders, occluderCount, win.originX, win.originZ, texel, win.size, grid.heights, grid.scratch) || moved) {
      this.device.queue.writeTexture({ texture: grid.height }, grid.heights, { bytesPerRow: win.size }, [win.size, win.size])
    }
    this.lastOriginX = win.originX
    this.lastOriginZ = win.originZ
    packPlanBounceUniforms(input, win, lightCount, shadowLightCount, this.data)
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    this.active = true
    const groups = (n: number) => Math.ceil(n / 8)
    const cp = enc.beginComputePass({ label: "plan bounce", timestampWrites })
    cp.setPipeline(this.emitPipe)
    cp.setBindGroup(0, grid.emitGroup)
    cp.dispatchWorkgroups(groups(win.size), groups(win.size))
    cp.setPipeline(this.downPipe)
    for (let l = 0; l < PLAN_BOUNCE_LEVELS - 1; l++) {
      const n = win.size >> (l + 1)
      cp.setBindGroup(0, grid.downGroups[l]!)
      cp.dispatchWorkgroups(groups(n), groups(n))
    }
    cp.setPipeline(this.gatherPipe)
    cp.setBindGroup(0, grid.gatherGroup)
    cp.dispatchWorkgroups(groups(win.size), groups(win.size))
    cp.end()
    return true
  }
}
