import type { LabControl } from "../../lab-panel"

/**
 * Perspective shadow maps for a small pool of spot lights, after Aiden's Ashwood rig (`render/lighting.ts`): the most
 * important shadow-casting spots near the camera get a slot (score = intensity / max(d − 0.3·range, 1)², with 1.6×
 * hysteresis for holders and a deterministic tiebreak), slots cross-fade over 0.35 s and fade with the camera's distance
 * over the last 10 m before the pool's cut-off (so walking toward a light grows its shadows in), and a slot's map is re-rendered
 * only when it changes hands, its light moves or the world changes (`invalidate`), because the world is static. The
 * scene samples them with a slope- and distance-scaled bias and a fixed 3×3 grid of hardware-filtered comparison taps
 * (36 effective, no per-pixel noise, so nothing crawls under TAA jitter).
 *
 * This complements the polar plan shadows: polar is cheap and omnidirectional for many lights seen from above; spot
 * maps add what plan space can't (overhangs, canopies, car undersides, fences) for the few lights that matter most in a
 * first-person view. A light with a spot shadow should be `unshadowed` for the polar pass.
 *
 * Scene bindings (group 0): 20 the depth array, 21 the comparison sampler, 22 the `SpotShadows` uniform
 * (`Renderer.setSpotShadows`). WGSL: `spotShadowWgsl` (`spotShadowVis(lightIndex, world, n)`).
 */

export type Vec3 = readonly [number, number, number]

export const MAX_SPOT_SHADOWS = 4
export const SPOT_SHADOW_BINDINGS = { map: 20, sampler: 21, uniform: 22 } as const
/** Floats per slot in the `SpotShadows` uniform: viewProj (16), light pos + near, params, far. */
const SLOT_FLOATS = 28
export const SPOT_SHADOW_UNIFORM_FLOATS = 4 + MAX_SPOT_SHADOWS * SLOT_FLOATS

export type SpotShadowSettings = {
  /** Shadowed spots (0 turns the pass off: Today). */
  count: number
  /** Map size per light, texels. */
  size: 512 | 1024 | 2048
  /** Slope-scaled bias, in shadow texels. */
  bias: number
}

export const SPOT_SHADOW_DEFAULTS: Readonly<SpotShadowSettings> = { count: 0, size: 1024, bias: 1 }

export function spotShadowControls(group = "Lighting", prefix = ""): LabControl[] {
  const key = (k: keyof SpotShadowSettings) => prefix + k
  const field = (k: keyof SpotShadowSettings) => (prefix ? { field: k } : {})
  return [
    { key: key("count"), ...field("count"), label: "Spot shadow maps", group, subsection: "Spot shadows", min: 0, max: MAX_SPOT_SHADOWS, step: 1 },
    { key: key("size"), ...field("size"), label: "Map size", group, subsection: "Spot shadows", type: "select", options: [512, 1024, 2048].map((v) => ({ value: v, label: String(v) })) },
    { key: key("bias"), ...field("bias"), label: "Bias (slope-scaled)", group, subsection: "Spot shadows", min: 0, max: 4, step: 0.05, unit: "texels" },
  ]
}

export type SpotCandidate = {
  /** Stable id (the game's light id): slots follow ids, not frame order. */
  id: number
  pos: Vec3
  /** Unit axis. */
  axis: Vec3
  cosOuter: number
  range: number
  /** Nominal intensity: not flicker, which would reshuffle slots every frame. */
  intensity: number
  /** Shadow near plane (m); default `SPOT_NEAR`. Lower it for a lamp held close to what it lights (a map in hand). */
  near?: number
}

/**
 * `weight` is the hand-over fade (time); `reach` fades the shadow with the camera's distance to the light over the last
 * `REACH_FADE_M` before the pool's cut-off (range + `REACH_M`), so walking toward a light grows its shadows in instead of
 * popping them on, and a still camera keeps a steady value. The scene sees `weight × reach`.
 */
export type SpotSlot = { id: number | null; weight: number; reach: number; dirty: boolean; light: SpotCandidate | null }

const HYSTERESIS = 1.6
const FADE_S = 0.35
/** Lights farther than range + REACH_M from the camera get no slot. */
const REACH_M = 15
/** Width of the distance fade before that cut-off. */
const REACH_FADE_M = 10
/** Shadow strength by camera distance: 1 within range + 5 m, 0 at range + 15 m (smoothstep). */
export function spotShadowReach(c: SpotCandidate, eye: Vec3): number {
  const d = Math.hypot(c.pos[0] - eye[0], c.pos[1] - eye[1], c.pos[2] - eye[2])
  const t = Math.max(0, Math.min(1, (c.range + REACH_M - d) / REACH_FADE_M))
  return t * t * (3 - 2 * t)
}

/** CPU slot assignment with hysteresis and cross-fades. Pure apart from its own slot state. */
export class SpotShadowPicker {
  readonly slots: SpotSlot[] = []
  private lastEye: Vec3 | null = null
  private worldDirty = true
  private snap = true

  constructor(count = 2) {
    this.resize(count)
  }

  /** Changing the slot count is a settings change, not motion: the next update snaps instead of fading in. */
  resize(count: number): void {
    const n = Math.max(0, Math.min(MAX_SPOT_SHADOWS, Math.round(count)))
    if (n !== this.slots.length) this.snap = true
    while (this.slots.length > n) this.slots.pop()
    while (this.slots.length < n) this.slots.push({ id: null, weight: 0, reach: 0, dirty: true, light: null })
  }

  /** The static world changed (streaming, a door, new colliders): every held map re-renders. */
  invalidate(): void {
    this.worldDirty = true
  }

  static score(c: SpotCandidate, eye: Vec3, held: boolean): number {
    const d = Math.hypot(c.pos[0] - eye[0], c.pos[1] - eye[1], c.pos[2] - eye[2])
    return (c.intensity / Math.max(d - c.range * 0.3, 1) ** 2) * (held ? HYSTERESIS : 1) || 0
  }

  update(candidates: readonly SpotCandidate[], eye: Vec3, dt: number): readonly SpotSlot[] {
    const jump = this.snap || !this.lastEye || Math.hypot(eye[0] - this.lastEye[0], eye[1] - this.lastEye[1], eye[2] - this.lastEye[2]) > 1.5
    this.snap = false
    this.lastEye = [eye[0], eye[1], eye[2]]
    const step = jump ? 1 : dt / FADE_S
    const held = new Set<number>()
    for (const s of this.slots) if (s.id !== null && s.weight > 0) held.add(s.id)
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const near = candidates.filter((c) => Math.hypot(c.pos[0] - eye[0], c.pos[1] - eye[1], c.pos[2] - eye[2]) < c.range + REACH_M)
    const ranked = near
      .map((c) => ({ c, s: SpotShadowPicker.score(c, eye, held.has(c.id)) }))
      .sort((a, b) => b.s - a.s || a.c.id - b.c.id)
      .slice(0, this.slots.length)
      .map((r) => r.c.id)
    const wanted = new Set(ranked)
    for (const s of this.slots) {
      s.dirty = false
      if (s.id === null) continue
      const c = byId.get(s.id)
      if (!c || !wanted.has(s.id)) {
        s.weight = Math.max(0, s.weight - step)
        if (s.weight === 0 || !c) Object.assign(s, { id: null, weight: 0, reach: 0, light: null })
        else s.reach = spotShadowReach(c, eye)
        continue
      }
      s.weight = Math.min(1, s.weight + step)
      const moved = !s.light || c.pos.some((v, i) => v !== s.light!.pos[i]) || c.axis.some((v, i) => v !== s.light!.axis[i]) || c.cosOuter !== s.light.cosOuter || c.range !== s.light.range || (c.near ?? SPOT_NEAR) !== (s.light.near ?? SPOT_NEAR)
      s.light = c
      s.reach = spotShadowReach(c, eye)
      if (moved || this.worldDirty) s.dirty = true
    }
    for (const id of ranked) {
      if (this.slots.some((s) => s.id === id)) continue
      const free = this.slots.find((s) => s.id === null)
      if (!free) break
      Object.assign(free, { id, weight: jump ? 1 : 0, reach: spotShadowReach(byId.get(id)!, eye), light: byId.get(id)!, dirty: true })
    }
    this.worldDirty = false
    return this.slots
  }
}

/** Perspective light view-projection (column-major, WebGPU depth 0..1) looking along `axis` from `pos`. */
export function spotViewProj(pos: Vec3, axis: Vec3, halfAngle: number, near: number, far: number): Float32Array<ArrayBuffer> {
  const fwd = normalize(axis)
  const upHint: Vec3 = Math.abs(fwd[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]
  const z: Vec3 = [-fwd[0], -fwd[1], -fwd[2]]
  const x = normalize(cross(upHint, z))
  const y = cross(z, x)
  const f = 1 / Math.tan(Math.min(halfAngle, 1.45))
  const nf = 1 / (near - far)
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, pos), -dot(y, pos), -dot(z, pos), 1]
  const proj = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0]
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += proj[k * 4 + r]! * view[c * 4 + k]!
    out[c * 4 + r] = s
  }
  return out
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

export const SPOT_NEAR = 0.25

/**
 * Writes the `SpotShadows` uniform: per slot the light's frame index (`frameIndexOf(id)`, −1 skips it), weight, the
 * world size of one texel per metre (2·tan(half) / size) and the bias, the view-projection, position and near/far.
 */
export function packSpotShadows(out: Float32Array, slots: readonly SpotSlot[], frameIndexOf: (id: number) => number, s: SpotShadowSettings): Float32Array {
  out.fill(0)
  let n = 0
  for (let i = 0; i < slots.length && n < MAX_SPOT_SHADOWS; i++) {
    const slot = slots[i]!
    const weight = slot.weight * slot.reach
    if (slot.id === null || !slot.light || weight <= 0) continue
    const index = frameIndexOf(slot.id)
    if (index < 0) continue
    const l = slot.light
    const half = Math.min(Math.acos(Math.max(-1, Math.min(1, l.cosOuter))), 1.45)
    const o = 4 + n * SLOT_FLOATS
    const near = l.near ?? SPOT_NEAR
    out.set(spotViewProj(l.pos, l.axis, half, near, l.range), o)
    out.set([l.pos[0], l.pos[1], l.pos[2], near], o + 16)
    out.set([index, weight, (2 * Math.tan(half)) / s.size, s.bias], o + 20)
    out.set([l.range, i, 0, 0], o + 24)
    n++
  }
  out[0] = n
  out[1] = s.size
  return out
}

/** Scene-shader declarations: `spotShadowVis(lightIndex, world, n) -> f32` (1 = lit, also for lights without a map). */
export const spotShadowWgsl = /* wgsl */ `
struct SpotShadowSlot { viewProj: mat4x4f, light: vec4f, params: vec4f, far: vec4f }
struct SpotShadows { head: vec4f, slots: array<SpotShadowSlot, ${MAX_SPOT_SHADOWS}> }
@group(0) @binding(${SPOT_SHADOW_BINDINGS.map}) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(${SPOT_SHADOW_BINDINGS.sampler}) var spotShadowSamp: sampler_comparison;
@group(0) @binding(${SPOT_SHADOW_BINDINGS.uniform}) var<uniform> SPOTS: SpotShadows;

fn spotShadowVis(light: u32, world: vec3f, n: vec3f) -> f32 {
  let count = u32(SPOTS.head.x);
  for (var s = 0u; s < count; s++) {
    let slot = SPOTS.slots[s];
    if (u32(slot.params.x) != light) { continue; }
    let toL = slot.light.xyz - world;
    let d = max(length(toL), 0.05);
    // Slope- and distance-scaled bias: one texel's world size grows with distance, times tan of the incidence angle.
    let c = clamp(abs(dot(n, toL / d)), 0.08, 1.0);
    let tanT = min(sqrt(max(1.0 - c * c, 0.0)) / c, 10.0);
    let texel = d * slot.params.z;
    let clip = slot.viewProj * vec4f(world + n * texel * 0.6, 1.0);
    if (clip.w <= 1e-4) { return 1.0; }
    let ndc = clip.xyz / clip.w;
    if (any(abs(ndc.xy) >= vec2f(1.0)) || ndc.z >= 1.0) { return 1.0; }
    let near = slot.light.w;
    let far = slot.far.x;
    let slack = texel * (tanT * 1.2 + 0.6) * slot.params.w;
    let z = ndc.z - slack * near * far / ((far - near) * d * d);
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let t = 1.0 / SPOTS.head.y;
    let layer = i32(slot.far.y);
    var sum = 0.0;
    for (var oy = -1; oy <= 1; oy++) {
      for (var ox = -1; ox <= 1; ox++) {
        sum += textureSampleCompareLevel(spotShadowMap, spotShadowSamp, clamp(uv + vec2f(f32(ox), f32(oy)) * t, vec2f(t), vec2f(1.0 - t)), layer, z);
      }
    }
    return mix(1.0, sum / 9.0, slot.params.y);
  }
  return 1.0;
}
`

/**
 * Volume-shader declarations (`VolumeLightShader.spotShadows`, bindings 23–25): `spotShadowAir(lightIndex, p) -> f32`,
 * one hardware-filtered comparison at a point in the air (1 = lit, also outside the map and for lights without one), so
 * a fog march can cut a lamp's light behind what blocks it.
 */
export const spotShadowVolumeWgsl = /* wgsl */ `
struct SpotShadowSlot { viewProj: mat4x4f, light: vec4f, params: vec4f, far: vec4f }
struct SpotShadows { head: vec4f, slots: array<SpotShadowSlot, ${MAX_SPOT_SHADOWS}> }
@group(0) @binding(23) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(24) var spotShadowSamp: sampler_comparison;
@group(0) @binding(25) var<uniform> SPOTS: SpotShadows;
fn spotShadowAir(light: u32, p: vec3f) -> f32 {
  let count = u32(SPOTS.head.x);
  for (var s = 0u; s < count; s++) {
    let slot = SPOTS.slots[s];
    if (u32(slot.params.x) != light) { continue; }
    let clip = slot.viewProj * vec4f(p, 1.0);
    if (clip.w <= 1e-4) { return 1.0; }
    let ndc = clip.xyz / clip.w;
    if (any(abs(ndc.xy) >= vec2f(1.0)) || ndc.z >= 1.0 || ndc.z <= 0.0) { return 1.0; }
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    return mix(1.0, textureSampleCompareLevel(spotShadowMap, spotShadowSamp, uv, i32(slot.far.y), ndc.z), slot.params.y);
  }
  return 1.0;
}
`

/** WGSL after \`spotShadowWgsl\`: \`spotShadowVisArea\`, for scenes with lens emitters (\`lights/street.ts\`). */
export const spotShadowAreaWgsl = /* wgsl */ `
/**
 * Contact-hardening visibility from an emitter of radius \`lens\` (m), PCSS-style: the mean blocker depth over the
 * lens's footprint gives the penumbra w = lens · (d − d_blocker) / d_blocker; eight comparisons on a Vogel disc of
 * that width, rotated by \`noise\` (0..1, per pixel and frame, resolved by TAA). Falls back to \`spotShadowVis\`'s sharp
 * result where nothing blocks. Costs nine depth loads more than \`spotShadowVis\`.
 */
fn spotShadowVisArea(light: u32, world: vec3f, n: vec3f, lens: f32, noise: f32) -> f32 {
  let count = u32(SPOTS.head.x);
  for (var s = 0u; s < count; s++) {
    let slot = SPOTS.slots[s];
    if (u32(slot.params.x) != light) { continue; }
    let toL = slot.light.xyz - world;
    let d = max(length(toL), 0.05);
    let c = clamp(abs(dot(n, toL / d)), 0.08, 1.0);
    let tanT = min(sqrt(max(1.0 - c * c, 0.0)) / c, 10.0);
    let texel = d * slot.params.z;
    let clip = slot.viewProj * vec4f(world + n * texel * 0.6, 1.0);
    if (clip.w <= 1e-4) { return 1.0; }
    let ndc = clip.xyz / clip.w;
    if (any(abs(ndc.xy) >= vec2f(1.0)) || ndc.z >= 1.0) { return 1.0; }
    let near = slot.light.w;
    let far = slot.far.x;
    let slack = texel * (tanT * 1.2 + 0.6) * slot.params.w;
    let z = ndc.z - slack * near * far / ((far - near) * d * d);
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let size = SPOTS.head.y;
    let t = 1.0 / size;
    let layer = i32(slot.far.y);
    let rot = noise * 6.2831853;
    // Blocker search over the lens's footprint on the map (in texels at the receiver), capped to keep loads coherent.
    let search = clamp(lens / max(slot.params.z, 1e-5) * (d - near) / d, 1.0, 24.0);
    var bsum = 0.0;
    var bn = 0.0;
    for (var k = 0; k < 9; k++) {
      let a = f32(k) * 2.3999632 + rot;
      let r = sqrt((f32(k) + 0.5) / 9.0) * search;
      let p = clamp(vec2i((uv + vec2f(cos(a), sin(a)) * r * t) * size), vec2i(0), vec2i(i32(size) - 1));
      let zb = textureLoad(spotShadowMap, p, layer, 0);
      if (zb < z) { bsum += far * near / (far - zb * (far - near)); bn += 1.0; }
    }
    if (bn < 0.5) { return 1.0; }
    let db = bsum / bn;
    let pen = clamp(lens * (d - db) / max(db, 0.05) / max(texel, 1e-5), 1.0, 24.0);
    var sum = 0.0;
    for (var k = 0; k < 8; k++) {
      let a = f32(k) * 2.3999632 + rot + 1.1;
      let r = sqrt((f32(k) + 0.5) / 8.0) * pen;
      sum += textureSampleCompareLevel(spotShadowMap, spotShadowSamp, clamp(uv + vec2f(cos(a), sin(a)) * r * t, vec2f(t), vec2f(1.0 - t)), layer, z);
    }
    return mix(1.0, sum / 8.0, slot.params.y);
  }
  return 1.0;
}
`

/**
 * Depth shaders for the shadow pass: position-only (any vertex layout with float32x3 position at offset 0), cut-out
 * (the kit's 32-byte textured layout, alpha-tested), and both again instanced by `SpotShadowInstances`.
 */
/**
 * Default instance transform: (x, y, z, yaw), (scale xz, scale y, …): scale, yaw about +y, then move. A renderer
 * whose instances pack more (the forest's trunk scale) passes its own through \`SpotShadows\`'s \`instanceWgsl\`, the
 * same signature; \`mat\` and \`color\` are the vertex's material and colour (32-byte textured casters only, else 0).
 */
export const SPOT_SHADOW_INSTANCE_WGSL = /* wgsl */ `
fn instanced(p: vec3f, a: vec4f, b: vec4f, mat: f32, color: vec4f) -> vec3f {
  let q = vec3f(p.x * b.x, p.y * b.y, p.z * b.x);
  let c = cos(a.w);
  let s = sin(a.w);
  return vec3f(q.x * c - q.z * s, q.y, q.x * s + q.z * c) + a.xyz;
}
`

export const spotShadowDepthWgsl = (instanceWgsl = SPOT_SHADOW_INSTANCE_WGSL) => /* wgsl */ `
struct Cam { viewProj: mat4x4f }
@group(0) @binding(0) var<uniform> C: Cam;
${instanceWgsl}
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f { return C.viewProj * vec4f(p, 1.0); }
@vertex fn vsInst(@location(0) p: vec3f, @location(3) a: vec4f, @location(4) b: vec4f) -> @builtin(position) vec4f { return C.viewProj * vec4f(instanced(p, a, b, 0.0, vec4f(0.0)), 1.0); }
@vertex fn vsInstTextured(@location(0) p: vec3f, @location(1) matAux: vec2f, @location(5) color: vec4f, @location(3) a: vec4f, @location(4) b: vec4f) -> @builtin(position) vec4f { return C.viewProj * vec4f(instanced(p, a, b, matAux.x, color), 1.0); }

struct MaskOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) layer: i32 }
@group(1) @binding(0) var maskTex: texture_2d_array<f32>;
@group(1) @binding(1) var maskSamp: sampler;
@group(1) @binding(2) var<uniform> maskCut: vec4f;
fn maskOut(world: vec3f, matAux: vec2f, uv: vec2f) -> MaskOut {
  var o: MaskOut;
  o.pos = C.viewProj * vec4f(world, 1.0);
  o.uv = uv;
  o.layer = select(i32(maskCut.y), i32(floor(matAux.y + 0.001)), maskCut.z > 0.5);
  return o;
}
@vertex fn vsMask(@location(0) p: vec3f, @location(1) matAux: vec2f, @location(2) uv: vec2f) -> MaskOut { return maskOut(p, matAux, uv); }
@vertex fn vsMaskInst(@location(0) p: vec3f, @location(1) matAux: vec2f, @location(2) uv: vec2f, @location(5) color: vec4f, @location(3) a: vec4f, @location(4) b: vec4f) -> MaskOut { return maskOut(instanced(p, a, b, matAux.x, color), matAux, uv); }
@fragment fn fsMask(o: MaskOut) {
  if (textureSampleLevel(maskTex, maskSamp, o.uv, o.layer, maskCut.w).a < maskCut.x) { discard; }
}
`

/**
 * Cut-out casters (foliage cards, ferns): alpha-tested against `view` (a 2D-array view; a plain texture's view with
 * `dimension: "2d-array"` works) at `cutoff`, read at mip `lod` so a far card keeps its coverage. The layer is `layer`,
 * or the vertex's aux (`matAux.y`, floored) with `layerFromAux`. Needs the kit's 32-byte textured layout.
 */
export type SpotShadowMask = { view: GPUTextureView; cutoff: number; layer?: number; layerFromAux?: boolean; lod?: number }

/** Instances of a caster: 8 floats each, (x, y, z, yaw) and (scale xz, scale y, unused, unused). */
export type SpotShadowInstances = { buffer: GPUBuffer; count: number; first?: number }

/** Geometry to draw into the maps: a vertex buffer with float32x3 position at offset 0, optionally cut-out or instanced. */
export type SpotShadowCaster = { buffer: GPUBuffer; count: number; stride: number; firstVertex?: number; mask?: SpotShadowMask; instances?: SpotShadowInstances }

const INSTANCE_LAYOUT: GPUVertexBufferLayout = { arrayStride: 32, stepMode: "instance", attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }, { shaderLocation: 4, offset: 16, format: "float32x4" }] }

/**
 * GPU side: a depth32float 2D array (one layer per slot), the `SpotShadows` uniform, and a depth-only pass that
 * re-renders dirty layers. `bindings()` feeds `Renderer.setSpotShadows`.
 */
export class SpotShadows {
  readonly settings: SpotShadowSettings
  readonly picker: SpotShadowPicker
  readonly uniform: GPUBuffer
  readonly sampler: GPUSampler
  private texture: GPUTexture | null = null
  private view: GPUTextureView | null = null
  private layers: GPUTextureView[] = []
  private readonly data = new Float32Array(SPOT_SHADOW_UNIFORM_FLOATS)
  private readonly camBuf: GPUBuffer
  private readonly camGroup: GPUBindGroup
  private readonly camGroupLayout: GPUBindGroupLayout
  private readonly pipelines = new Map<number, GPURenderPipeline>()
  private readonly layout: GPUPipelineLayout
  private readonly module: GPUShaderModule
  private maskLayout: GPUBindGroupLayout | null = null
  private maskPipelines: GPURenderPipeline[] = []
  private maskSampler: GPUSampler | null = null
  private readonly maskGroups = new WeakMap<SpotShadowMask, GPUBindGroup>()
  /** Layers rendered last frame (telemetry: 0 on most frames once settled). */
  rendered = 0

  /** \`instanceWgsl\`: the casters' instance transform (\`SPOT_SHADOW_INSTANCE_WGSL\` by default). */
  constructor(private readonly device: GPUDevice, settings: Partial<SpotShadowSettings> = {}, instanceWgsl?: string) {
    this.settings = { ...SPOT_SHADOW_DEFAULTS, ...settings }
    this.picker = new SpotShadowPicker(this.settings.count)
    this.uniform = device.createBuffer({ size: SPOT_SHADOW_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sampler = device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.camBuf = device.createBuffer({ size: 256 * MAX_SPOT_SHADOWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const camLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 64 } }] })
    this.camGroupLayout = camLayout
    this.camGroup = device.createBindGroup({ layout: camLayout, entries: [{ binding: 0, resource: { buffer: this.camBuf, size: 64 } }] })
    this.layout = device.createPipelineLayout({ bindGroupLayouts: [camLayout] })
    this.module = device.createShaderModule({ code: spotShadowDepthWgsl(instanceWgsl), label: "spot shadow depth" })
    this.ensureTexture()
  }

  private ensureTexture(): void {
    const size = this.settings.size
    if (this.texture && this.texture.width === size) return
    this.texture?.destroy()
    this.texture = this.device.createTexture({ size: [size, size, MAX_SPOT_SHADOWS], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: "spot shadows" })
    this.view = this.texture.createView({ dimension: "2d-array" })
    this.layers = Array.from({ length: MAX_SPOT_SHADOWS }, (_, i) => this.texture!.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 }))
    this.picker.invalidate()
  }

  /** Re-renders every slot next update: something the static-world picker cannot see moved (a walking person). */
  invalidate(): void {
    this.picker.invalidate()
  }

  private pipeline(stride: number, instanced = false): GPURenderPipeline {
    const key = stride * 2 + Number(instanced)
    let p = this.pipelines.get(key)
    if (!p) {
      const textured = instanced && stride === 32
      const vertex: GPUVertexBufferLayout = { arrayStride: stride, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, ...(textured ? [{ shaderLocation: 1, offset: 20, format: "float16x2" as const }, { shaderLocation: 5, offset: 16, format: "unorm8x4" as const }] : [])] }
      p = this.device.createRenderPipeline({
        layout: this.layout,
        vertex: { module: this.module, entryPoint: textured ? "vsInstTextured" : instanced ? "vsInst" : "vs", buffers: instanced ? [vertex, INSTANCE_LAYOUT] : [vertex] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 },
      })
      this.pipelines.set(key, p)
    }
    return p
  }

  private masked(mask: SpotShadowMask, instanced: boolean): { pipeline: GPURenderPipeline; group: GPUBindGroup } {
    const d = this.device
    if (!this.maskLayout) {
      this.maskLayout = d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      ] })
      this.maskSampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" })
    }
    const k = Number(instanced)
    if (!this.maskPipelines[k]) {
      const vertex: GPUVertexBufferLayout = { arrayStride: 32, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 20, format: "float16x2" }, { shaderLocation: 2, offset: 24, format: "float32x2" },
        ...(instanced ? [{ shaderLocation: 5, offset: 16, format: "unorm8x4" as const }] : []),
      ] }
      this.maskPipelines[k] = d.createRenderPipeline({
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.camGroupLayout, this.maskLayout] }),
        vertex: { module: this.module, entryPoint: instanced ? "vsMaskInst" : "vsMask", buffers: instanced ? [vertex, INSTANCE_LAYOUT] : [vertex] },
        fragment: { module: this.module, entryPoint: "fsMask", targets: [] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 },
      })
    }
    let group = this.maskGroups.get(mask)
    if (!group) {
      const uniform = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(uniform, 0, new Float32Array([mask.cutoff, mask.layer ?? 0, mask.layerFromAux ? 1 : 0, mask.lod ?? 2]))
      group = d.createBindGroup({ layout: this.maskLayout, entries: [{ binding: 0, resource: mask.view }, { binding: 1, resource: this.maskSampler! }, { binding: 2, resource: { buffer: uniform } }] })
      this.maskGroups.set(mask, group)
    }
    return { pipeline: this.maskPipelines[k]!, group }
  }

  /** The texture view, sampler and uniform buffer for `Renderer.setSpotShadows`. Changes when the size changes. */
  bindings(): { view: GPUTextureView; sampler: GPUSampler; uniform: GPUBuffer } {
    this.ensureTexture()
    return { view: this.view!, sampler: this.sampler, uniform: this.uniform }
  }

  /**
   * Picks slots, packs the uniform and re-renders dirty layers into `enc`. `frameIndexOf` maps a candidate id to its
   * index in this frame's light buffer (−1 if it isn't there). Returns whether `bindings()` changed (rebind).
   */
  update(enc: GPUCommandEncoder, candidates: readonly SpotCandidate[], eye: Vec3, dt: number, frameIndexOf: (id: number) => number, casters: readonly SpotShadowCaster[]): boolean {
    const before = this.view
    this.ensureTexture()
    this.picker.resize(this.settings.count)
    const slots = this.picker.update(candidates, eye, dt)
    packSpotShadows(this.data, slots, frameIndexOf, this.settings)
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    this.rendered = 0
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!
      if (!s.dirty || !s.light) continue
      const half = Math.min(Math.acos(Math.max(-1, Math.min(1, s.light.cosOuter))), 1.45)
      this.device.queue.writeBuffer(this.camBuf, i * 256, spotViewProj(s.light.pos, s.light.axis, half, s.light.near ?? SPOT_NEAR, s.light.range))
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.layers[i]!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } })
      pass.setBindGroup(0, this.camGroup, [i * 256])
      for (const c of casters) {
        const inst = c.instances
        if (inst && !inst.count) continue
        if (c.mask) {
          const m = this.masked(c.mask, !!inst)
          pass.setPipeline(m.pipeline)
          pass.setBindGroup(1, m.group)
        } else pass.setPipeline(this.pipeline(c.stride, !!inst))
        pass.setVertexBuffer(0, c.buffer)
        if (inst) pass.setVertexBuffer(1, inst.buffer)
        pass.draw(c.count, inst ? inst.count : 1, c.firstVertex ?? 0, inst?.first ?? 0)
      }
      pass.end()
      this.rendered++
    }
    return before !== this.view
  }

  destroy(): void {
    this.texture?.destroy()
    this.uniform.destroy()
    this.camBuf.destroy()
  }
}
