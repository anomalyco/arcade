import type { LabControl } from "../../lab-panel"

/**
 * Perspective shadow maps for a small pool of spot lights, after Aiden's Ashwood rig (`render/lighting.ts`): the most
 * important shadow-casting spots near the camera get a slot (score = intensity / max(d − 0.3·range, 1)², with 1.6×
 * hysteresis for holders and a deterministic tiebreak), slots cross-fade over 0.35 s, and a slot's map is re-rendered
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
}

export type SpotSlot = { id: number | null; weight: number; dirty: boolean; light: SpotCandidate | null }

const HYSTERESIS = 1.6
const FADE_S = 0.35

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
    while (this.slots.length < n) this.slots.push({ id: null, weight: 0, dirty: true, light: null })
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
    const near = candidates.filter((c) => Math.hypot(c.pos[0] - eye[0], c.pos[1] - eye[1], c.pos[2] - eye[2]) < c.range + 15)
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
        if (s.weight === 0 || !c) Object.assign(s, { id: null, weight: 0, light: null })
        continue
      }
      s.weight = Math.min(1, s.weight + step)
      const moved = !s.light || c.pos.some((v, i) => v !== s.light!.pos[i]) || c.axis.some((v, i) => v !== s.light!.axis[i]) || c.cosOuter !== s.light.cosOuter || c.range !== s.light.range
      s.light = c
      if (moved || this.worldDirty) s.dirty = true
    }
    for (const id of ranked) {
      if (this.slots.some((s) => s.id === id)) continue
      const free = this.slots.find((s) => s.id === null)
      if (!free) break
      Object.assign(free, { id, weight: jump ? 1 : 0, light: byId.get(id)!, dirty: true })
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
    if (slot.id === null || !slot.light || slot.weight <= 0) continue
    const index = frameIndexOf(slot.id)
    if (index < 0) continue
    const l = slot.light
    const half = Math.min(Math.acos(Math.max(-1, Math.min(1, l.cosOuter))), 1.45)
    const o = 4 + n * SLOT_FLOATS
    out.set(spotViewProj(l.pos, l.axis, half, SPOT_NEAR, l.range), o)
    out.set([l.pos[0], l.pos[1], l.pos[2], SPOT_NEAR], o + 16)
    out.set([index, slot.weight, (2 * Math.tan(half)) / s.size, s.bias], o + 20)
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

/** Position-only depth shader for the shadow pass (any vertex layout with float32x3 position at offset 0). */
const depthShader = /* wgsl */ `
struct Cam { viewProj: mat4x4f }
@group(0) @binding(0) var<uniform> C: Cam;
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f { return C.viewProj * vec4f(p, 1.0); }
`

/** Static geometry to draw into the maps: a vertex buffer with float32x3 position at offset 0. */
export type SpotShadowCaster = { buffer: GPUBuffer; count: number; stride: number; firstVertex?: number }

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
  private readonly pipelines = new Map<number, GPURenderPipeline>()
  private readonly layout: GPUPipelineLayout
  private readonly module: GPUShaderModule
  /** Layers rendered last frame (telemetry: 0 on most frames once settled). */
  rendered = 0

  constructor(private readonly device: GPUDevice, settings: Partial<SpotShadowSettings> = {}) {
    this.settings = { ...SPOT_SHADOW_DEFAULTS, ...settings }
    this.picker = new SpotShadowPicker(this.settings.count)
    this.uniform = device.createBuffer({ size: SPOT_SHADOW_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sampler = device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.camBuf = device.createBuffer({ size: 256 * MAX_SPOT_SHADOWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const camLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 64 } }] })
    this.camGroup = device.createBindGroup({ layout: camLayout, entries: [{ binding: 0, resource: { buffer: this.camBuf, size: 64 } }] })
    this.layout = device.createPipelineLayout({ bindGroupLayouts: [camLayout] })
    this.module = device.createShaderModule({ code: depthShader, label: "spot shadow depth" })
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

  private pipeline(stride: number): GPURenderPipeline {
    let p = this.pipelines.get(stride)
    if (!p) {
      p = this.device.createRenderPipeline({
        layout: this.layout,
        vertex: { module: this.module, entryPoint: "vs", buffers: [{ arrayStride: stride, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 },
      })
      this.pipelines.set(stride, p)
    }
    return p
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
      this.device.queue.writeBuffer(this.camBuf, i * 256, spotViewProj(s.light.pos, s.light.axis, half, SPOT_NEAR, s.light.range))
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.layers[i]!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } })
      pass.setBindGroup(0, this.camGroup, [i * 256])
      for (const c of casters) {
        pass.setPipeline(this.pipeline(c.stride))
        pass.setVertexBuffer(0, c.buffer)
        pass.draw(c.count, 1, c.firstVertex ?? 0)
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
