// The lumberjack's chainsaw: the scanned 50cc saw (`public/saw/saw.glb`, built by `scripts/saw/build-saw.ts`) in his
// gloved hands in first person, drawn as the renderer's overlay pass with its own lens and depth so it never clips a
// trunk or the ground, lit by the frame's own lights; and its low LOD as a kit mesh for everyone else's saw.
import { imageTexture, readGltfRaw, type GltfRawPrimitive } from "@arcade/kit/gpu/gltf"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { compileShaderModuleWithLog, type PassContext } from "@arcade/kit/gpu/pass-graph"
import type { OverlayPass } from "@arcade/kit/gpu/renderer"
import { mat4, type Mat4 } from "wgpu-matrix"
import type { LookConfig } from "./look"
import { type ChainPath, type SawCord, VM_COMPOSITE, VM_FLOATS, VM_MAT, VM_PART, VM_VERTEX_FLOATS, vmShader } from "./viewmodel-shader"

type V3 = [number, number, number]

/** Points on the saw (glTF metres: x to the muffler side, y up, -z down the bar), from the asset's `extras.saw`. */
export type SawMarks = {
  nose: V3
  barUnder: V3
  muffler: V3
  grip: V3
  cordExit: V3
  handL: V3
  handR: V3
  rearGrip: V3
  chain: ChainPath & { loop: number; links: number }
}

/** The cord's stub at rest (glTF), from where it leaves the starter to the T-grip's eye, as `build-saw.py` makes it. */
const SAW_CORD: SawCord = { exit: [-0.113, 0.15, 0.05], end: [-0.118, 0.149, 0.052] }

export type SawAsset = { prims: GltfRawPrimitive[]; marks: SawMarks }

export async function loadSawAsset(url: string): Promise<SawAsset> {
  const { primitives, extras } = await readGltfRaw(url)
  const marks = (extras as { saw?: SawMarks }).saw
  if (!marks) throw new Error(`${url}: no saw landmarks`)
  return { prims: primitives, marks }
}

/**
 * The saw for third person: the low LOD (vertex coloured) in the kit's frame for held props, x forward along the bar,
 * y up, z right, the rear handle's grip at the origin.
 */
export function sawWorldMesh(asset: SawAsset): Mesh {
  const m = new Mesh()
  const o = asset.marks.rearGrip
  for (const p of asset.prims) {
    if (p.lod !== 1) continue
    for (const i of p.indices) {
      const x = p.position[i * 3]! - o[0], y = p.position[i * 3 + 1]! - o[1], z = p.position[i * 3 + 2]! - o[2]
      const nx = p.normal[i * 3]!, ny = p.normal[i * 3 + 1]!, nz = p.normal[i * 3 + 2]!
      const c = p.color ? [p.color[i * 4]!, p.color[i * 4 + 1]!, p.color[i * 4 + 2]!] as const : [0.2, 0.1, 0.06] as const
      m.vert([-z, y, x], [-nz, ny, nx], [c[0], c[1], c[2]], MAT.lit)
    }
  }
  return m
}

const PART_OF = (node: string): number => (/gloveL|sleeveL/.test(node) ? VM_PART.left : /grip/.test(node) ? VM_PART.grip : VM_PART.saw)
const MAT_OF = (name: string): number => {
  const k = (Object.keys(VM_MAT) as (keyof typeof VM_MAT)[]).find((key) => name.toLowerCase().startsWith(key))
  if (k === undefined) throw new Error(`saw material ${name}`)
  return VM_MAT[k]
}

type Box = { min: V3; max: V3 }

/**
 * The overlay pass, cropped to the saw's box on screen: there, its own 4× MSAA colour and depth, resolved and copied
 * over the scene (`msaa` 4), or drawn straight onto the scene with a depth of its own (`msaa` 1).
 */
class SawPass implements OverlayPass {
  visible = false
  /**
   * 1 draws the saw straight onto the scene (the default: ~0.3 ms on the mini, vs ~1.2 ms multisampled, with edges
   * that hardly differ under the vibration); 4 multisamples it in its own small target.
   */
  msaa: 1 | 4 = 1
  private pipelines = new Map<number, GPURenderPipeline>()
  private composite: GPURenderPipeline
  private compositeUniform: GPUBuffer
  private layout: GPUBindGroupLayout
  private module: GPUShaderModule
  private targets: { w: number; h: number; samples: number; msaa: GPUTextureView | null; depth: GPUTextureView; resolve: GPUTextureView | null; group: GPUBindGroup | null; textures: GPUTexture[] } | null = null
  group: GPUBindGroup | null = null
  readonly uniform: GPUBuffer
  mesh: { vertices: GPUBuffer; indices: GPUBuffer; count: number } | null = null
  /** The lens before the crop, each part's box (model) and where it is this frame (model → camera). */
  proj = new Float32Array(16)
  boxes: Box[] = []
  models: Mat4[] = []
  private cropped = new Float32Array(16)
  private rect = new Uint32Array(4)
  private origin = new Float32Array(4)

  get active() { return this.visible && !!this.group && !!this.mesh }

  constructor(private ctx: PassContext, chain: ChainPath, cord: SawCord) {
    const d = ctx.device
    this.module = compileShaderModuleWithLog(d, vmShader(chain, cord), "saw viewmodel")
    const tex = { visibility: GPUShaderStage.FRAGMENT, texture: {} }
    this.layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ...Array.from({ length: 6 }, (_, i) => ({ binding: 2 + i, ...tex })),
    ] })
    // Alpha goes to 0 under the saw: the forest's mark for a rough, non-emissive surface, whose lamp hotspot must not
    // bloom (`forest/post.ts`), as the trunk beside it doesn't.
    const over: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" } }
    const cm = d.createShaderModule({ label: "saw composite", code: VM_COMPOSITE })
    this.composite = d.createRenderPipeline({
      label: "saw composite", layout: "auto",
      vertex: { module: cm, entryPoint: "vs" },
      fragment: { module: cm, entryPoint: "fs", targets: [{ format: ctx.color, blend: over }] },
      primitive: { topology: "triangle-list" },
    })
    this.compositeUniform = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.uniform = d.createBuffer({ size: VM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  private pipeline(samples: number): GPURenderPipeline {
    let p = this.pipelines.get(samples)
    if (p) return p
    const d = this.ctx.device
    // Drawn straight onto the scene, the same alpha mark comes from the blend.
    const direct: GPUBlendState = { color: { srcFactor: "one", dstFactor: "zero" }, alpha: { srcFactor: "zero", dstFactor: "zero" } }
    p = d.createRenderPipeline({
      label: "saw viewmodel",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.ctx.frameLayout, this.layout] }),
      vertex: { module: this.module, entryPoint: "vs", buffers: [{ arrayStride: VM_VERTEX_FLOATS * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32x2" }, { shaderLocation: 3, offset: 32, format: "float32" },
        { shaderLocation: 4, offset: 36, format: "float32" },
      ] }] },
      fragment: { module: this.module, entryPoint: "fs", targets: [{ format: this.ctx.color, ...(samples === 1 ? { blend: direct } : {}) }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: samples },
    })
    this.pipelines.set(samples, p)
    return p
  }

  bind(textures: GPUTexture[]) {
    const d = this.ctx.device
    const samp = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 16 })
    this.group = d.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: samp },
      ...textures.map((t, i) => ({ binding: 2 + i, resource: t.createView() })),
    ] })
  }

  write(u: Float32Array<ArrayBuffer>) { this.ctx.device.queue.writeBuffer(this.uniform, 0, u) }

  setMesh(vertices: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>) {
    const d = this.ctx.device
    const vb = d.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(vb, 0, vertices)
    const ib = d.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(ib, 0, indices)
    this.mesh = { vertices: vb, indices: ib, count: indices.length }
  }

  /** The saw's pixels on a w × h target ([x0, y0, x1, y1], y down), from its parts' boxes; false when it's off screen. */
  private crop(w: number, h: number): boolean {
    const P = this.proj
    let x0 = 1, y0 = 1, x1 = -1, y1 = -1
    for (let k = 0; k < this.boxes.length; k++) {
      const b = this.boxes[k]!, m = this.models[k]!
      for (let c = 0; c < 8; c++) {
        const q = point(m, [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]])
        const cw = P[3]! * q[0] + P[7]! * q[1] + P[11]! * q[2] + P[15]!
        // Behind the lens (a sleeve past the near plane): the whole width and height.
        if (cw < 0.02) { x0 = y0 = -1; x1 = y1 = 1; continue }
        const nx = (P[0]! * q[0] + P[4]! * q[1] + P[8]! * q[2] + P[12]!) / cw
        const ny = (P[1]! * q[0] + P[5]! * q[1] + P[9]! * q[2] + P[13]!) / cw
        x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny)
      }
    }
    const r = this.rect
    r[0] = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * w) - 2)
    r[2] = Math.min(w, Math.ceil((x1 * 0.5 + 0.5) * w) + 2)
    r[1] = Math.max(0, Math.floor((0.5 - y1 * 0.5) * h) - 2)
    r[3] = Math.min(h, Math.ceil((0.5 - y0 * 0.5) * h) + 2)
    return r[2]! > r[0]! && r[3]! > r[1]!
  }

  private ensureTargets(w: number, h: number, samples: number) {
    const t0 = this.targets
    if (t0 && t0.samples === samples && t0.w >= w && t0.h >= h && (samples === 1 ? t0.w === w && t0.h === h : true)) return t0
    for (const t of t0?.textures ?? []) t.destroy()
    const d = this.ctx.device
    // Multisampled, the targets only cover the saw's box; grown in 128 px steps so a moving saw rarely reallocates.
    const tw = samples === 1 ? w : Math.max(t0?.samples === samples ? t0.w : 0, Math.ceil(w / 128) * 128)
    const th = samples === 1 ? h : Math.max(t0?.samples === samples ? t0.h : 0, Math.ceil(h / 128) * 128)
    const depth = d.createTexture({ label: "saw depth", size: [tw, th], format: "depth24plus", sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    if (samples === 1) {
      this.targets = { w: tw, h: th, samples, msaa: null, depth: depth.createView(), resolve: null, group: null, textures: [depth] }
      return this.targets
    }
    const msaa = d.createTexture({ label: "saw msaa", size: [tw, th], format: this.ctx.color, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const resolve = d.createTexture({ label: "saw resolve", size: [tw, th], format: this.ctx.color, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    const group = d.createBindGroup({ layout: this.composite.getBindGroupLayout(0), entries: [
      { binding: 0, resource: resolve.createView() }, { binding: 1, resource: { buffer: this.compositeUniform } },
    ] })
    this.targets = { w: tw, h: th, samples, msaa: msaa.createView(), depth: depth.createView(), resolve: resolve.createView(), group, textures: [msaa, depth, resolve] }
    return this.targets
  }

  encode(enc: GPUCommandEncoder, target: GPUTextureView, w: number, h: number, frame: GPUBindGroup) {
    if (!this.group || !this.mesh || !this.crop(w, h)) return
    const [x0, y0, x1, y1] = this.rect as unknown as [number, number, number, number]
    const cw = x1 - x0, ch = y1 - y0
    const samples = this.msaa
    const t = this.ensureTargets(samples === 1 ? w : cw, samples === 1 ? h : ch, samples)
    const draw = (rp: GPURenderPassEncoder) => {
      rp.setBindGroup(0, frame)
      rp.setBindGroup(1, this.group!)
      rp.setPipeline(this.pipeline(samples))
      rp.setVertexBuffer(0, this.mesh!.vertices)
      rp.setIndexBuffer(this.mesh!.indices, "uint32")
      rp.drawIndexed(this.mesh!.count)
      rp.end()
    }
    if (samples === 1) {
      const rp = enc.beginRenderPass({
        label: "saw viewmodel",
        colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: t.depth, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
      })
      rp.setScissorRect(x0, y0, cw, ch)
      draw(rp)
      return
    }
    // The lens cropped to the box: NDC [a, b] → [-1, 1] on each axis (y up), the box drawn at the target's corner.
    const ax = (x0 / w) * 2 - 1, bx = (x1 / w) * 2 - 1
    const ay = 1 - (y1 / h) * 2, by = 1 - (y0 / h) * 2
    const sx = 2 / (bx - ax), sy = 2 / (by - ay)
    const ox = -sx * (ax + bx) / 2, oy = -sy * (ay + by) / 2
    // Rows of C · P, with C = [sx 0 0 ox; 0 sy 0 oy; 0 0 1 0; 0 0 0 1] on clip coordinates (P column-major).
    const P = this.proj, C = this.cropped
    for (let c = 0; c < 4; c++) {
      const pw = P[c * 4 + 3]!
      C[c * 4] = sx * P[c * 4]! + ox * pw
      C[c * 4 + 1] = sy * P[c * 4 + 1]! + oy * pw
      C[c * 4 + 2] = P[c * 4 + 2]!
      C[c * 4 + 3] = pw
    }
    const d = this.ctx.device
    d.queue.writeBuffer(this.uniform, 0, C)
    this.origin[0] = x0
    this.origin[1] = y0
    d.queue.writeBuffer(this.compositeUniform, 0, this.origin)
    const rp = enc.beginRenderPass({
      label: "saw viewmodel",
      colorAttachments: [{ view: t.msaa!, resolveTarget: t.resolve!, loadOp: "clear", storeOp: "discard", clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: t.depth, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    })
    rp.setViewport(0, 0, cw, ch, 0, 1)
    rp.setScissorRect(0, 0, cw, ch)
    draw(rp)
    const cp = enc.beginRenderPass({ label: "saw composite", colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }] })
    cp.setViewport(x0, y0, cw, ch, 0, 1)
    cp.setPipeline(this.composite)
    cp.setBindGroup(0, t.group!)
    cp.draw(3)
    cp.end()
  }
}

/** What the first-person saw needs each frame. */
export type SawFrame = {
  /** The camera as drawn: eye (world), yaw, pitch (down), roll; the world's vertical field of view (rad). */
  eye: readonly number[]
  yaw: number
  pitch: number
  roll: number
  worldFov: number
  /** The aim before any shake (rad), which the saw lags behind. */
  aimYaw: number
  aimPitch: number
  aspect: number
  dt: number
  t: number
  engine: "off" | "pulling" | "on"
  /** Throttle held, in the wood (0..1), at a sprint (0..1), walking speed (m/s), head bob (m). */
  throttle: boolean
  cut: number
  sprint: number
  speed: number
  bob: number
  /** The trunk being cut (world x, z, kerf radius), so the bar disappears into it. */
  trunk: { x: number; z: number; r: number } | null
  /** Reduced motion: no shake, sway or lag. */
  calm: boolean
}

/** World points for effects, where the view shows them. */
export type SawPoints = { nose: V3; under: V3; muffler: V3; exhaust: V3; forward: V3 }

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** A damped spring towards zero: kicks add velocity. */
class Spring {
  x = 0
  v = 0
  constructor(private hz: number, private damp: number) {}
  step(dt: number) {
    const w = this.hz * Math.PI * 2
    const n = Math.max(1, Math.ceil(dt / 0.004))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      this.v += (-w * w * this.x - 2 * this.damp * w * this.v) * h
      this.x += this.v * h
    }
    return this.x
  }
}

/**
 * The first-person saw: the pass, the asset on the GPU, and how the saw moves in your hands. Engine vibration (fine at
 * idle, harsher revved, a judder in wood as the chain bogs), a twist as the throttle opens, the chain running with the
 * throttle (the clutch lets it stop at idle), pull-cord starts (the left hand leaves the wrap handle, takes the T-grip
 * and yanks; the cord stretches out of the starter), the push into the cut, kickback on a hit, the lunge, a lowered
 * carry at a sprint, breathing sway and lag behind the turn.
 */
export class SawView {
  private pass: SawPass
  private u = new Float32Array(VM_FLOATS)
  private marks: SawMarks | null = null
  ready = false
  /** Automation: off hides the saw (to measure what it costs). */
  enabled = true
  /** Automation: 4 draws the saw multisampled in its own small target, 1 straight onto the scene. */
  get msaa(): 1 | 4 { return this.pass.msaa }
  set msaa(n: 1 | 4) { this.pass.msaa = n }
  /** Back from where your helmet lamp shines on the world to the helmet (world m), so the saw is lit from the helmet. */
  lampBack: V3 = [0, 0, 0]
  /** Undoes the level that made up the moved lamp's shorter throw; 0 while it isn't moved. */
  lampGain = 0
  private chainS = 0
  private chainV = 0
  private throttle = 0
  private wasThrottle = false
  private cut = 0
  private pullK = 0
  private yankT = 9
  private yankLen = 1
  private lungeT = 9
  private lastYaw = 0
  private lastPitch = 0
  private lagYaw = new Spring(2.2, 0.7)
  private lagPitch = new Spring(2.2, 0.7)
  private kickPitch = new Spring(5, 0.35)
  private kickBack = new Spring(4, 0.5)
  private kickRoll = new Spring(7, 0.3)
  private sprint = 0
  private on = 0

  constructor(ctx: PassContext, private look: LookConfig, chain: ChainPath = { x: 0.062, z: 0.088, rear: [0.058, 0.031], nose: [0.578, 0.0205] }) {
    this.pass = new SawPass(ctx, chain, SAW_CORD)
  }

  get overlay(): OverlayPass { return this.pass }

  /** Uploads the near LOD and its maps. */
  async upload(asset: SawAsset, device: GPUDevice): Promise<void> {
    this.marks = asset.marks
    // Gloves and sleeves first: they cover the saw's handles, so the depth test spares the housing behind them.
    const first = (p: GltfRawPrimitive) => (/^(glove|sleeve)/i.test(p.material) ? 0 : 1)
    const lod0 = asset.prims.filter((p) => p.lod === 0).sort((a, b) => first(a) - first(b))
    const vertices = new Float32Array(lod0.reduce((n, p) => n + p.position.length / 3, 0) * VM_VERTEX_FLOATS)
    const indices = new Uint32Array(lod0.reduce((n, p) => n + p.indices.length, 0))
    const boxes: Box[] = [0, 1, 2].map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }))
    let o = 0, base = 0, k = 0
    for (const p of lod0) {
      const part = PART_OF(p.node)
      const id = part * 16 + MAT_OF(p.material)
      const box = boxes[part]!
      const n = p.position.length / 3
      for (let i = 0; i < n; i++, o += VM_VERTEX_FLOATS) {
        for (let c = 0; c < 3; c++) {
          const x = p.position[i * 3 + c]!
          vertices[o + c] = x
          vertices[o + 3 + c] = p.normal[i * 3 + c]!
          if (x < box.min[c]!) box.min[c] = x
          if (x > box.max[c]!) box.max[c] = x
        }
        vertices[o + 6] = p.uv0[i * 2]!
        vertices[o + 7] = p.uv0[i * 2 + 1]!
        vertices[o + 8] = p.uv1[i * 2]!
        vertices[o + 9] = id
      }
      for (const i of p.indices) indices[k++] = base + i
      base += n
    }
    this.pass.boxes = boxes
    const find = (m: string) => lod0.find((p) => p.material.toLowerCase().startsWith(m))
    const tex = (img: { bytes: Uint8Array; mime: string } | null | undefined, srgb: boolean, normal = false) => {
      if (!img) throw new Error("saw texture missing")
      return imageTexture(device, img.bytes, srgb, img.mime, undefined, normal)
    }
    const housing = find("housing"), bar = find("bar")
    const textures = await Promise.all([
      tex(housing?.base, true), tex(housing?.orm, false), tex(housing?.normalMap, false, true),
      tex(bar?.base, true), tex(bar?.orm, false), tex(bar?.normalMap, false, true),
    ])
    this.pass.setMesh(vertices, indices)
    this.pass.bind(textures)
    this.ready = true
  }

  /** The pull cord: the left hand yanks (each pull and every extra yank). */
  yank() { this.yankT = 0; this.yankLen = 0.85 + Math.random() * 0.3 }
  /** A hit throws the bar back and up at you: kickback off a body, a clash of chains. */
  kick(k: number) {
    this.kickPitch.v += 2.6 * k
    this.kickBack.v += 0.7 * k
    this.kickRoll.v += (Math.random() - 0.5) * 2.4 * k
  }
  lunge() { this.lungeT = 0 }
  /** The engine catching or failing to: a shudder through the saw. */
  shudder(k: number) {
    this.kickRoll.v += 1.6 * k
    this.kickPitch.v -= 0.6 * k
  }

  /** Shows the saw this frame (or hides it); returns world points for effects, null while it isn't shown. */
  frame(f: SawFrame | null): SawPoints | null {
    this.pass.visible = !!f && this.ready && this.enabled
    if (!f || !this.ready || !this.marks) return null
    const L = this.look
    const m = this.marks
    const dt = Math.min(0.1, f.dt)
    const calm = f.calm ? 0 : 1
    const shake = L.sawShake * calm
    const sway = L.sawSway * calm
    const ease = (from: number, to: number, rate: number) => from + (to - from) * (1 - Math.exp(-dt * rate))

    // Engine and chain: the throttle opens in a blink and closes slower; the clutch lets the chain stop at idle, and
    // wood drags it down.
    const running = f.engine === "on"
    this.on = ease(this.on, running ? 1 : 0, running ? 10 : 3)
    this.throttle = ease(this.throttle, running && f.throttle ? 1 : 0, f.throttle ? 14 : 5)
    if (running && f.throttle && !this.wasThrottle) { this.kickRoll.v -= 0.9 * shake; this.kickPitch.v -= 0.25 * shake }
    this.wasThrottle = running && f.throttle
    this.cut = ease(this.cut, f.cut, 8)
    const chainTarget = running ? smooth(0.25, 0.9, this.throttle) * L.chainSpeed * (1 - 0.4 * this.cut) : 0
    this.chainV = ease(this.chainV, chainTarget, chainTarget > this.chainV ? 6 : 2.5)
    this.chainS = (this.chainS + this.chainV * dt) % m.chain.loop
    const pitchLen = m.chain.loop / (m.chain.links * 2)
    const blur = Math.max(0, Math.min(1, ((this.chainV * dt) / pitchLen - 0.25) / 0.75))

    // Look lag: the saw trails the turn and springs back.
    let dy = f.aimYaw - this.lastYaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    const dp = f.aimPitch - this.lastPitch
    this.lastYaw = f.aimYaw
    this.lastPitch = f.aimPitch
    if (Math.abs(dy) < 0.5) this.lagYaw.x -= dy * 0.5 * L.sawLag * calm
    if (Math.abs(dp) < 0.5) this.lagPitch.x += dp * 0.5 * L.sawLag * calm
    this.lagYaw.x = Math.max(-0.2, Math.min(0.2, this.lagYaw.x))
    this.lagPitch.x = Math.max(-0.2, Math.min(0.2, this.lagPitch.x))
    const lagY = this.lagYaw.step(dt)
    const lagP = this.lagPitch.step(dt)
    const kp = this.kickPitch.step(dt)
    const kb = this.kickBack.step(dt)
    const kr = this.kickRoll.step(dt)

    // Vibration: high-frequency jitter (the 2-stroke's firing aliased to the frame) and, in wood, a coarse judder.
    const t = f.t
    const amp = shake * this.on * (0.0005 + this.throttle * 0.0011 + this.cut * 0.0022)
    const jit = (a: number, b: number, c: number) => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.3) * 0.4 + Math.sin(t * c + 2.1) * 0.3
    const judder = shake * this.cut * (0.5 + 0.5 * Math.sin(t * 2.3)) * 0.0035
    const vx = jit(311, 197, 433) * amp + Math.sin(t * 13.1) * judder * 0.6
    const vy = jit(287, 233, 389) * amp + Math.sin(t * 9.7 + 0.4) * judder
    const vr = jit(263, 349, 157) * amp * 4 + Math.sin(t * 11.3) * judder * 3

    // Sprint carry, the lunge, the cut, the pull.
    this.sprint = ease(this.sprint, f.sprint, 6)
    const sk = this.sprint
    const pulling = f.engine === "pulling"
    this.pullK = ease(this.pullK, pulling ? 1 : 0, pulling ? 9 : 5)
    const pk = this.pullK
    this.lungeT += dt
    const lunge = this.lungeT < 0.45 ? Math.sin((this.lungeT / 0.45) * Math.PI) : 0
    this.yankT += dt
    const yank = this.yankT < 0.14 ? smooth(0, 0.14, this.yankT) : this.yankT < 0.65 ? 1 - smooth(0.14, 0.65, this.yankT) : 0
    // The trunk's distance sets how far the bar is pushed in: its nose a third of the way into the wood.
    let push = 0
    if (f.trunk) {
      const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw)
      const ahead = (f.trunk.x - f.eye[0]!) * fx + (f.trunk.z - f.eye[2]!) * fz
      push = Math.max(-0.25, Math.min(0.35, ahead - f.trunk.r * 0.6 - (-m.nose[2] + m.rearGrip[2] - L.sawZ)))
    }
    const breathe = Math.sin(t * 1.3) * 0.004 * sway
    const drift = Math.sin(t * 0.61 + 1) * 0.003 * sway
    const stride = Math.sin(t * 8.5) * Math.min(1, f.speed / 4) * sway

    const px = L.sawX + vx + drift + sk * 0.05 - pk * 0.05 + stride * 0.006
    const py = L.sawY + vy + breathe - f.bob * 0.4 * sway - sk * 0.1 + pk * 0.04 + Math.abs(stride) * 0.008 + kp * 0.03
    const pz = L.sawZ - this.cut * push - lunge * 0.17 + kb * 0.12 + sk * 0.06 - pk * 0.02
    const pitch = L.sawPitch + lagP + kp - this.cut * 0.06 - lunge * 0.1 - sk * 0.5 - pk * 0.12 + yank * 0.05
    const yaw = L.sawYaw + lagY - sk * 0.3 + pk * 0.05 + vx * 2
    const roll = L.sawRoll + vr + kr - sk * 0.3 - pk * 0.28 - yank * 0.06 + stride * 0.04
    const pivot = m.rearGrip
    const saw = mat4.translation([px, py, pz])
    mat4.rotateY(saw, yaw, saw)
    mat4.rotateX(saw, pitch, saw)
    mat4.rotateZ(saw, roll, saw)
    mat4.translate(saw, [-pivot[0], -pivot[1], -pivot[2]], saw)

    // The left hand: on the wrap handle, or on the starter's T-grip while pulling, out along the yank.
    const grab = smooth(0.2, 0.75, pk)
    const yankDir: V3 = [-0.35, 0.62, 0.7]
    const yl = 0.42 * yank * this.yankLen
    const gripAt: V3 = [m.grip[0] + yankDir[0] * yl, m.grip[1] + yankDir[1] * yl, m.grip[2] + yankDir[2] * yl]
    const reach = smooth(0, 1, pk)
    const hand: V3 = [(gripAt[0] - m.handL[0]) * reach, (gripAt[1] - m.handL[1]) * reach + Math.sin(reach * Math.PI) * 0.03, (gripAt[2] - m.handL[2]) * reach]
    const leftModel = mat4.translation(hand)
    // The hand turns over as it comes off the handle to take the grip.
    mat4.translate(leftModel, m.handL, leftModel)
    mat4.rotateZ(leftModel, -0.5 * reach, leftModel)
    mat4.rotateX(leftModel, -0.3 * yank, leftModel)
    mat4.translate(leftModel, [-m.handL[0], -m.handL[1], -m.handL[2]], leftModel)
    const left = mat4.multiply(saw, leftModel)
    // The grip sits in the fist once taken, turned across it; otherwise it rests in its pocket.
    let grip: Mat4 = saw
    if (grab > 0) {
      const inHand = mat4.multiply(left, mat4.translation(m.handL))
      mat4.rotateY(inHand, (Math.PI / 2) * grab, inHand)
      mat4.translate(inHand, [-m.grip[0], -m.grip[1], -m.grip[2]], inHand)
      // Blend from its pocket to the fist.
      grip = grab >= 1 ? inHand : lerpM(saw, inHand, grab)
    }

    // Uniforms.
    const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw), sp = Math.sin(f.pitch), cp = Math.cos(f.pitch)
    const eye: V3 = [f.eye[0]!, f.eye[1]!, f.eye[2]!]
    const target: V3 = [eye[0] - sy * cp, eye[1] - sp, eye[2] - cy * cp]
    const up: V3 = [Math.sin(f.roll) * cy, Math.cos(f.roll), -Math.sin(f.roll) * sy]
    const invView = mat4.inverse(mat4.lookAt(eye, target, up))
    const fov = (L.sawFov * Math.PI) / 180
    const squeeze = Math.tan(f.worldFov / 2) / Math.tan(fov / 2)
    const u = this.u
    mat4.perspective(fov, f.aspect, 0.02, 4, this.pass.proj)
    this.pass.models = [saw, left, grip]
    u.set(this.pass.proj, 0)
    u.set(invView, 16)
    u.set(saw, 32)
    u.set(left, 48)
    u.set(grip, 64)
    let o = 80
    const exitCam = point(saw, m.cordExit)
    const endCam = point(grip, SAW_CORD.end)
    u.set([...exitCam, this.chainS], o); o += 4
    u.set([...endCam, blur], o); o += 4
    u.set([eye[0], eye[1], eye[2], t], o); o += 4
    const a = L.sawAmbient
    u.set([0.0016 * a, 0.002 * a, 0.003 * a, L.sawSpill], o); o += 4
    u.set([squeeze, L.sawWear, 0.6, 1], o); o += 4
    u.set(f.trunk && this.cut > 0.05 ? [f.trunk.x, f.trunk.z, f.trunk.r, 1] : [0, 0, 0, 0], o); o += 4
    u.set([this.cut, 0, 0, 0], o); o += 4
    // Lights are held at least this far off (beams, others), so the helmet lamp above the saw doesn't flood it.
    u.set([L.sawLampNear, L.sawLampNear * 0.5, 0, 0], o); o += 4
    u.set([...this.lampBack, this.lampGain], o); o += 4
    this.pass.write(u)

    // Effect points, placed where the view shows them.
    const seen = (q: V3): V3 => {
      const c = point(saw, q)
      return point(invView, [c[0] * squeeze, c[1] * squeeze, c[2]])
    }
    const nose = seen(m.nose)
    const rear = seen(m.rearGrip)
    const fwd = norm([nose[0] - rear[0], nose[1] - rear[1], nose[2] - rear[2]])
    // The muffler blows out forward and to the right, away from the operator.
    const ex = norm(dir(invView, dir(saw, [0.55, 0.1, -0.8])))
    return { nose, under: seen(m.barUnder), muffler: seen(m.muffler), exhaust: ex, forward: fwd }
  }
}

function point(m: Mat4, p: readonly number[]): V3 {
  return [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!]
}
function dir(m: Mat4, p: readonly number[]): V3 {
  return [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]!]
}
function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
function lerpM(a: Mat4, b: Mat4, k: number): Mat4 {
  const out = mat4.create()
  for (let i = 0; i < 16; i++) out[i] = a[i]! + (b[i]! - a[i]!) * k
  return out
}
