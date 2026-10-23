import type { LabControl } from "@arcade/kit/lab-panel"
import type { PassContext } from "@arcade/kit/gpu/pass-graph"
import { compileShaderModuleWithLog } from "@arcade/kit/gpu/pass-graph"
import type { OverlayPass, Renderer } from "@arcade/kit/gpu/renderer"
import type { SpotShadowCaster } from "@arcade/kit/gpu/shadows/spot-shadows"
import type { MapKnowledge, WoodsState } from "../../shared/sim"
import type { WoodsWorld } from "../../shared/world"
import { COMPASS } from "./compass-face"
import { VERTEX_FLOATS, v3, type V3 } from "./mesh"
import { MipGen, mippedTexture } from "./mips"
import { PencilLayer } from "./pencil"
import type { PrintReply, PrintRequest } from "./print-jobs"
import { buildCompass, buildSheet, buildTorch, CAPSULE, COMPASS_ON_SHEET, compassRest, leftThumb, type PaperShape } from "./props"
import { heldShader, HELD_FLOATS } from "./shader"
import { scaleOf, SHEET } from "./sheet"

/**
 * The held survey map and compass (hold G): first-person props in the world, lit by your own torch, friends' torches
 * and the camp lights through the forest renderer's own light list. They draw after temporal AA onto the resolved
 * image (the renderer's overlay pass) with their own projection (the viewmodel FOV, a 2 cm near plane), depth and 4×
 * MSAA, so TAA never jitters, blurs or ghosts them. The sheet also blocks your beam (a spot-shadow caster with its
 * own near plane), so the woods beyond it go dark while you read.
 *
 * The printed layer is drawn once per world from the shared terrain (`print.ts`) in a worker, the compass markings
 * and fibre normals there once; mips are built on the GPU. The pencil layer appends what your map learns
 * (`pencil.ts`) and updates only the changed area. Generated images supply only paper material (`public/map/`,
 * credited in `public/CREDITS.md`).
 */

export type MapStyle = "today" | "held"

export type HeldMapSettings = {
  mapStyle: MapStyle
  printRes: "auto" | "2048" | "3072" | "4096"
  vmFov: number
  distance: number
  drop: number
  side: number
  tilt: number
  turn: number
  roll: number
  fold: number
  curl: number
  sag: number
  wave: number
  corners: number
  pinch: number
  creases: number
  fibre: number
  sheen: number
  translucency: number
  pencilSheen: number
  sharpness: number
  sway: number
  lag: number
  raiseSpring: number
  needleHz: number
  needleDamping: number
  declination: number
  bezel: number
  luminous: number
  readingLevel: number
  beamSoftness: number
  beamNear: number
  aimU: number
  aimV: number
  torchX: number
  torchY: number
  torchZ: number
  ambient: number
  gloveTone: number
  gloveWear: number
  gloveSheen: number
}

export const HELD_DEFAULTS: HeldMapSettings = {
  mapStyle: "held", printRes: "auto", vmFov: 58, distance: 0.3, drop: 0.0, side: 0.005, tilt: 38, turn: 3, roll: -2,
  fold: 0.012, curl: 0.016, sag: 0.008, wave: 0.0012, corners: 0.007, pinch: 0.004, creases: 0.8, fibre: 0.12,
  sheen: 0.6, translucency: 0.35, pencilSheen: 1, sharpness: -0.5, sway: 1, lag: 0.12, raiseSpring: 9, needleHz: 0.9,
  needleDamping: 0.28, declination: 2, bezel: 0, luminous: 0.02, readingLevel: 0.003, beamSoftness: 0.45, beamNear: 0.24, aimU: 0.55,
  aimV: 0.42, torchX: 0.15, torchY: -0.07, torchZ: -0.2, ambient: 1, gloveTone: 0.15, gloveWear: 0.55, gloveSheen: 0.35,
}

export function heldMapControls(prefix = "woods.map."): LabControl[] {
  const G = "Map"
  const row = (key: keyof HeldMapSettings, label: string, min: number, max: number, step: number, unit: string, subsection?: string): LabControl => ({ key: prefix + key, field: key, label, group: G, min, max, step, unit, ...(subsection ? { subsection } : {}) })
  return [
    { key: prefix + "mapStyle", field: "mapStyle", label: "Map style", group: G, type: "select", options: [{ value: "today", label: "Today" }, { value: "held", label: "Held" }] },
    row("vmFov", "Held FOV", 40, 80, 1, "°", "Holding"),
    row("distance", "Distance from eye", 0.22, 0.55, 0.005, "m", "Holding"),
    row("drop", "Below eye", 0, 0.35, 0.005, "m", "Holding"),
    row("side", "Right of centre", -0.15, 0.15, 0.005, "m", "Holding"),
    row("tilt", "Tilt back", 0, 85, 1, "°", "Holding"),
    row("turn", "Turn", -30, 30, 0.5, "°", "Holding"),
    row("roll", "Roll", -30, 30, 0.5, "°", "Holding"),
    row("sway", "Hand sway", 0, 2, 0.05, "×", "Holding"),
    row("lag", "Turn lag", 0, 0.4, 0.01, "s", "Holding"),
    row("raiseSpring", "Raise spring", 3, 20, 0.5, "Hz·2π", "Holding"),
    row("fold", "Fold depth", 0, 0.012, 0.0005, "m", "Paper"),
    row("curl", "Curl", 0, 0.08, 0.001, "m", "Paper"),
    row("sag", "Top sag", 0, 0.05, 0.001, "m", "Paper"),
    row("wave", "Waviness", 0, 0.005, 0.0001, "m", "Paper"),
    row("corners", "Corner curl", 0, 0.02, 0.0005, "m", "Paper"),
    row("pinch", "Pinch dent", 0, 0.01, 0.0005, "m", "Paper"),
    row("creases", "Crease ridges", 0, 1, 0.01, "", "Paper"),
    row("fibre", "Fibre relief", 0, 0.5, 0.01, "", "Paper"),
    row("sheen", "Paper sheen", 0, 2, 0.05, "×", "Paper"),
    row("translucency", "Translucency", 0, 1, 0.01, "", "Paper"),
    row("pencilSheen", "Graphite sheen", 0, 2, 0.05, "×", "Paper"),
    row("sharpness", "Print mip bias", -1.5, 0.5, 0.05, "mips", "Paper"),
    { key: prefix + "printRes", field: "printRes", label: "Print texture", group: G, subsection: "Paper", type: "select", options: [{ value: "auto", label: "By quality" }, { value: "2048", label: "2K" }, { value: "3072", label: "3K" }, { value: "4096", label: "4K" }] },
    row("needleHz", "Needle swing", 0.3, 2.5, 0.05, "Hz", "Compass"),
    row("needleDamping", "Needle damping", 0.05, 1.2, 0.01, "ζ", "Compass"),
    row("declination", "Declination west", -15, 15, 0.5, "°", "Compass"),
    row("bezel", "Bezel bearing", 0, 359, 1, "°", "Compass"),
    row("luminous", "Luminous paint", 0, 0.2, 0.002, "", "Compass"),
    row("readingLevel", "Torch low mode while reading", 0.001, 0.1, 0.0005, "×", "Torch"),
    row("beamSoftness", "Reading beam softness (on the props)", 0.2, 1, 0.01, "γ", "Torch"),
    row("beamNear", "Reading beam near limit (on the props)", 0, 0.5, 0.01, "m", "Torch"),
    row("aimU", "Beam aim across", 0, 1, 0.01, "", "Torch"),
    row("aimV", "Beam aim down", 0, 1, 0.01, "", "Torch"),
    row("torchX", "Torch right", -0.1, 0.35, 0.005, "m", "Torch"),
    row("torchY", "Torch up", -0.4, 0, 0.005, "m", "Torch"),
    row("torchZ", "Torch forward", -0.35, 0, 0.005, "m", "Torch"),
    row("ambient", "Night ambient", 0, 4, 0.05, "×", "Torch"),
    row("gloveTone", "Glove tone", 0, 1, 0.01, "", "Holding"),
    row("gloveWear", "Glove wear", 0, 1, 0.01, "", "Holding"),
    row("gloveSheen", "Glove sheen", 0, 1.5, 0.01, "", "Holding"),
  ]
}

// ---------------------------------------------------------------- small column-major 4×4 helpers

type M4 = Float32Array
const m4 = () => new Float32Array(16)
function mul(a: M4, b: M4, out: M4 = m4()): M4 {
  const r = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let rI = 0; rI < 4; rI++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += a[k * 4 + rI]! * b[c * 4 + k]!
    r[c * 4 + rI] = s
  }
  out.set(r)
  return out
}
const basis = (x: V3, y: V3, z: V3, t: V3): M4 => new Float32Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t[0], t[1], t[2], 1])
const translate = (x: number, y: number, z: number) => basis([1, 0, 0], [0, 1, 0], [0, 0, 1], [x, y, z])
const rotX = (a: number) => basis([1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)], [0, 0, 0])
const rotY = (a: number) => basis([Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)], [0, 0, 0])
const rotZ = (a: number) => basis([Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1], [0, 0, 0])
const point = (m: M4, p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!]
const dir = (m: M4, d: V3): V3 => [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]]
function invertRigid(m: M4): M4 {
  const x: V3 = [m[0]!, m[4]!, m[8]!], y: V3 = [m[1]!, m[5]!, m[9]!], z: V3 = [m[2]!, m[6]!, m[10]!]
  const t: V3 = [m[12]!, m[13]!, m[14]!]
  const c0: V3 = [m[0]!, m[1]!, m[2]!], c1: V3 = [m[4]!, m[5]!, m[6]!], c2: V3 = [m[8]!, m[9]!, m[10]!]
  return basis(x, y, z, [-v3.dot(c0, t), -v3.dot(c1, t), -v3.dot(c2, t)])
}
function perspective(fovY: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovY / 2), m = m4()
  m[0] = f / aspect; m[5] = f; m[10] = far / (near - far); m[11] = -1; m[14] = (near * far) / (near - far)
  return m
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const DEG = Math.PI / 180

// ---------------------------------------------------------------- textures

async function loadImage(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await createImageBitmap(await res.blob())
  } catch { return null }
}

// ---------------------------------------------------------------- the pass

const COMPOSITE = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(src, vec2i(pos.xy), 0); }
`

/**
 * The props as the renderer's overlay: drawn into their own 4× MSAA colour and depth (cleared to transparent),
 * resolved, then composited premultiplied over the resolved scene. Targets are made on first use at the output size.
 */
class HeldPass implements OverlayPass {
  visible = false
  private opaque: GPURenderPipeline
  private clear: GPURenderPipeline
  private composite: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private targets: { w: number; h: number; msaa: GPUTextureView; depth: GPUTextureView; resolve: GPUTextureView; group: GPUBindGroup; textures: GPUTexture[] } | null = null
  group: GPUBindGroup | null = null
  readonly uniform: GPUBuffer
  meshes: { opaque: { buf: GPUBuffer; count: number }[]; clear: { buf: GPUBuffer; count: number }[] } = { opaque: [], clear: [] }

  get active() { return this.visible && !!this.group }

  constructor(private ctx: PassContext) {
    const d = ctx.device
    const module = compileShaderModuleWithLog(d, heldShader, "held map")
    this.layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ] })
    const layout = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, this.layout] })
    const buffers: GPUVertexBufferLayout[] = [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" },
      { shaderLocation: 2, offset: 24, format: "float32x2" }, { shaderLocation: 3, offset: 32, format: "float32x3" },
      { shaderLocation: 4, offset: 44, format: "float32" },
    ] }]
    const over: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } }
    const desc = (clear: boolean): GPURenderPipelineDescriptor => ({
      label: clear ? "held map clear" : "held map",
      layout,
      vertex: { module, entryPoint: "vs", buffers },
      fragment: { module, entryPoint: clear ? "fsClear" : "fsOpaque", targets: [{ format: ctx.color, ...(clear ? { blend: over } : {}) }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: !clear, depthCompare: "less-equal" },
      multisample: { count: 4 },
    })
    this.opaque = d.createRenderPipeline(desc(false))
    this.clear = d.createRenderPipeline(desc(true))
    const cm = d.createShaderModule({ label: "held composite", code: COMPOSITE })
    this.composite = d.createRenderPipeline({
      label: "held composite", layout: "auto",
      vertex: { module: cm, entryPoint: "vs" },
      fragment: { module: cm, entryPoint: "fs", targets: [{ format: ctx.color, blend: over }] },
      primitive: { topology: "triangle-list" },
    })
    this.uniform = d.createBuffer({ size: HELD_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  bind(print: GPUTexture, pencil: GPUTexture, fibre: GPUTexture, face: GPUTexture) {
    const d = this.ctx.device
    const aniso = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", maxAnisotropy: 16 })
    const wrap = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "mirror-repeat", addressModeV: "mirror-repeat", maxAnisotropy: 16 })
    this.group = d.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: aniso }, { binding: 2, resource: wrap },
      { binding: 3, resource: print.createView() }, { binding: 4, resource: pencil.createView() }, { binding: 5, resource: fibre.createView() }, { binding: 6, resource: face.createView() },
    ] })
  }

  setMesh(kind: "opaque" | "clear", i: number, data: Float32Array<ArrayBuffer>) {
    const list = this.meshes[kind]
    const cur = list[i]
    if (cur && cur.buf.size >= data.byteLength) { this.ctx.device.queue.writeBuffer(cur.buf, 0, data); cur.count = data.length / VERTEX_FLOATS; return }
    cur?.buf.destroy()
    const buf = this.ctx.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.ctx.device.queue.writeBuffer(buf, 0, data)
    list[i] = { buf, count: data.length / VERTEX_FLOATS }
  }

  private ensureTargets(w: number, h: number) {
    if (this.targets && this.targets.w === w && this.targets.h === h) return this.targets
    this.release()
    const d = this.ctx.device
    const msaa = d.createTexture({ label: "held msaa", size: [w, h], format: this.ctx.color, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const depth = d.createTexture({ label: "held depth", size: [w, h], format: "depth24plus", sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const resolve = d.createTexture({ label: "held resolve", size: [w, h], format: this.ctx.color, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    const group = d.createBindGroup({ layout: this.composite.getBindGroupLayout(0), entries: [{ binding: 0, resource: resolve.createView() }] })
    this.targets = { w, h, msaa: msaa.createView(), depth: depth.createView(), resolve: resolve.createView(), group, textures: [msaa, depth, resolve] }
    return this.targets
  }

  /** Frees the overlay targets (Map style: Today). */
  release() {
    for (const t of this.targets?.textures ?? []) t.destroy()
    this.targets = null
  }

  encode(enc: GPUCommandEncoder, target: GPUTextureView, w: number, h: number, frame: GPUBindGroup) {
    if (!this.group) return
    const t = this.ensureTargets(w, h)
    const rp = enc.beginRenderPass({
      label: "held props",
      colorAttachments: [{ view: t.msaa, resolveTarget: t.resolve, loadOp: "clear", storeOp: "discard", clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: t.depth, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    })
    rp.setBindGroup(0, frame)
    rp.setBindGroup(1, this.group)
    rp.setPipeline(this.opaque)
    for (const m of this.meshes.opaque) if (m?.count) { rp.setVertexBuffer(0, m.buf); rp.draw(m.count) }
    rp.setPipeline(this.clear)
    for (const m of this.meshes.clear) if (m?.count) { rp.setVertexBuffer(0, m.buf); rp.draw(m.count) }
    rp.end()
    const cp = enc.beginRenderPass({ label: "held composite", colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }] })
    cp.setPipeline(this.composite)
    cp.setBindGroup(0, t.group)
    cp.draw(3)
    cp.end()
  }
}

// ---------------------------------------------------------------- the held map

export type HeldFrame = {
  state: WoodsState
  me: number
  raise: number
  eye: readonly number[]
  yaw: number
  pitch: number
  roll: number
  aspect: number
  dt: number
  time: number
  walk: { lateral: number; vertical: number }
}

type Job = PrintRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never

export class HeldMap {
  readonly settings: HeldMapSettings
  /** The adaptive quality tier (main keeps it current): the print is 2K below High unless Print texture says otherwise. */
  tier = "high"
  private pass: HeldPass
  private device: GPUDevice
  private mips: MipGen
  private worker: Worker | null = null
  /** The worker died: later jobs run on the main thread. */
  private local = false
  private idleStop: ReturnType<typeof setTimeout> | null = null
  private jobs = new Map<number, (r: PrintReply) => void>()
  private jobId = 0
  private world: WoodsWorld | null = null
  private printTex: GPUTexture | null = null
  private pencilTex: GPUTexture | null = null
  private fibreTex: GPUTexture | null = null
  private faceTex: GPUTexture | null = null
  private pencil = new PencilLayer(2048)
  private pencilAt = 0
  private printKey = ""
  /** The one print in flight (its key); a newer wish waits until it lands, then the latest key is printed. */
  private printing = ""
  private faceScale = 0
  private fibreSrc: ImageBitmap | null = null
  private fibreAsked = false
  private shapeKey = ""
  private thumb: V3[] = []
  private wear: ImageBitmap | null = null
  private imagesReady = false
  private u = new Float32Array(HELD_FLOATS)
  private casterBuf: GPUBuffer
  private casterData = new Float32Array(6 * 8)
  private raise = { x: 0, v: 0 }
  private lagS = { yaw: 0, pitch: 0, vy: 0, vp: 0, lastYaw: NaN, lastPitch: NaN }
  private needle = { phi: 0, v: 0, fluid: 0, last: NaN, ready: false }
  private bubble = { x: 0, y: 0, vx: 0, vy: 0 }
  private torchOut: { origin: [number, number, number]; axis: [number, number, number] } | null = null
  private wasVisible = false
  /** Automation: sweep the beam's aim over the sheet (uv offset) without moving the view. */
  sweep: [number, number] = [0, 0]
  /** Build timings (ms): the worker's print, the main thread's upload and pencil update, for the Lab and proofs. */
  readonly timings: { print: number; upload: number; pencil: number; phases: Record<string, number> } = { print: 0, upload: 0, pencil: 0, phases: {} }

  /** `prefetch`: print the sheet in idle time after each world change (off for the software-GPU smoke). */
  constructor(private renderer: Renderer, base: string, settings?: Partial<HeldMapSettings>, private prefetch = true) {
    this.settings = { ...HELD_DEFAULTS, ...settings }
    this.device = renderer.passContext.device
    this.mips = new MipGen(this.device)
    this.pass = new HeldPass(renderer.passContext)
    renderer.setOverlayPass(this.pass)
    this.casterBuf = this.device.createBuffer({ size: this.casterData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    void Promise.all([loadImage(`${base}map/paper-wear.jpg`), loadImage(`${base}map/paper-fibre.jpg`)]).then(([w, f]) => {
      this.wear = w
      this.fibreSrc = f
      this.imagesReady = true
      if (this.prefetch && this.world) this.prefetchSoon(this.world)
    })
    addEventListener("pagehide", () => this.stopWorker())
  }

  /**
   * One job in the worker (on the main thread once the worker has died). Never rejects: failures come back as
   * `error`, a stopped or crashed worker as `cancelled`. An idle worker is stopped after a few seconds.
   */
  private request(job: Job, transfer: Transferable[] = []): Promise<PrintReply> {
    const id = ++this.jobId
    if (this.idleStop) { clearTimeout(this.idleStop); this.idleStop = null }
    if (this.local) {
      return import("./print-jobs").then((m) => m.runJob({ ...job, id } as PrintRequest)).catch((err: unknown) => ({ id, ms: 0, error: String(err) }))
    }
    if (!this.worker) {
      const w = new Worker(new URL("./print.worker.ts", import.meta.url), { type: "module", name: "held-map print" })
      w.onmessage = (e: MessageEvent<PrintReply>) => {
        if (e.data.error) console.error("held map: print job failed", e.data.error)
        const done = this.jobs.get(e.data.id)
        this.jobs.delete(e.data.id)
        done?.(e.data)
        if (!this.jobs.size && this.worker === w) this.idleStop = setTimeout(() => this.stopWorker(), 5000)
      }
      const died = (why: string) => {
        console.error("held map: print worker died; printing on the main thread from now on", why)
        this.local = true
        this.stopWorker()
      }
      w.onerror = (e) => { e.preventDefault(); died(e.message) }
      w.onmessageerror = () => died("unreadable message")
      this.worker = w
    }
    return new Promise((resolve) => { this.jobs.set(id, resolve); this.worker!.postMessage({ ...job, id }, transfer) })
  }

  /** Stops the worker; jobs still waiting come back cancelled (the next frame asks again). */
  private stopWorker() {
    if (this.idleStop) { clearTimeout(this.idleStop); this.idleStop = null }
    this.worker?.terminate()
    this.worker = null
    const waiting = [...this.jobs]
    this.jobs.clear()
    for (const [id, done] of waiting) done({ id, ms: 0, cancelled: true })
  }

  setWorld(world: WoodsWorld) {
    if (this.world && this.world !== world) this.stopWorker()
    this.world = world
    if (this.prefetch && this.imagesReady) this.prefetchSoon(world)
  }

  /** Prints in idle time after boot or a world change, so the first raise doesn't wait for it. */
  private prefetchSoon(world: WoodsWorld) {
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
    const run = () => { if (this.held && this.world === world) this.ensureTextures() }
    if (idle) idle(run, { timeout: 4000 }); else setTimeout(run, 1500)
  }

  get held() { return this.settings.mapStyle === "held" }

  private printSize() {
    const r = this.settings.printRes
    return r === "auto" ? (this.tier === "high" ? 4096 : 2048) : Number(r)
  }

  private rebind() {
    if (this.printTex && this.pencilTex && this.fibreTex && this.faceTex) this.pass.bind(this.printTex, this.pencilTex, this.fibreTex, this.faceTex)
  }

  /** Uploads an image to level 0 (reusing the texture when it fits) and rebuilds its mips on the GPU. */
  private upload(src: ImageBitmap, format: GPUTextureFormat, old: GPUTexture | null): GPUTexture {
    let tex = old
    if (!tex || tex.width !== src.width || tex.height !== src.height || tex.format !== format || tex.mipLevelCount === 1) {
      old?.destroy()
      tex = mippedTexture(this.device, src.width, src.height, format, "held map")
    }
    this.device.queue.copyExternalImageToTexture({ source: src }, { texture: tex, premultipliedAlpha: false }, [src.width, src.height])
    src.close()
    const enc = this.device.createCommandEncoder()
    this.mips.generate(enc, tex)
    this.device.queue.submit([enc.finish()])
    return tex
  }

  /**
   * Asks the worker for whatever is missing: the compass face once, the print when the world or its size changed (one
   * job at a time; a superseded result is dropped). Waits for the paper images, so an early raise never prints twice.
   */
  private ensureTextures() {
    const world = this.world
    if (!world || !this.imagesReady) return
    const d = this.device
    if (!this.fibreTex) {
      // Flat until the fibre normals arrive (or if the image failed).
      this.fibreTex = d.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      d.queue.writeTexture({ texture: this.fibreTex }, new Uint8Array([128, 128, 255, 255]), { bytesPerRow: 4 }, [1, 1])
    }
    if (!this.pencilTex) this.pencilTex = mippedTexture(d, this.pencil.canvas.width, this.pencil.canvas.height, "rgba8unorm-srgb", "held pencil")
    if (this.fibreSrc && !this.fibreAsked) {
      this.fibreAsked = true
      const src = this.fibreSrc
      void createImageBitmap(src).then((copy) => this.request({ kind: "fibre", image: copy, size: 1024 }, [copy])).then((r) => {
        if (r.cancelled) { this.fibreAsked = false; return }
        if (r.bitmap) { this.fibreTex = this.upload(r.bitmap, "rgba8unorm", this.fibreTex); this.rebind() }
      }, () => { this.fibreAsked = false })
    }
    const scale = scaleOf(world)
    if (this.faceScale !== scale) {
      this.faceScale = scale
      void this.request({ kind: "face", scale }).then((r) => {
        if (r.cancelled) { if (this.faceScale === scale) this.faceScale = 0; return }
        if (r.bitmap) { this.faceTex = this.upload(r.bitmap, "rgba8unorm-srgb", this.faceTex); this.rebind() }
      })
    }
    const key = this.printWish()
    if (!key || key === this.printKey || this.printing) return
    this.printing = key
    const size = this.printSize(), params = world.params, wear = this.wear
    void (wear ? createImageBitmap(wear) : Promise.resolve(null))
      .then((copy) => this.request({ kind: "print", params, longSide: size, wear: copy }, copy ? [copy] : []))
      .then((r) => {
        // Kept only if it is still what we want (A→B→A keeps A's fresh print; B is asked for next frame otherwise).
        if (r.bitmap && key === this.printWish()) {
          this.printKey = key
          this.timings.print = Math.round(r.ms)
          this.timings.phases = r.phases ?? {}
          const t0 = performance.now()
          this.printTex = this.upload(r.bitmap, "rgba8unorm-srgb", this.printTex)
          this.timings.upload = Math.round(performance.now() - t0)
          this.rebind()
        } else {
          r.bitmap?.close()
          // A failed print isn't retried every frame: the wish is marked done until the world or size changes.
          if (r.error && key === this.printWish()) this.printKey = key
        }
      })
      .catch((err: unknown) => console.error("held map: print upload failed", err))
      .finally(() => { if (this.printing === key) this.printing = "" })
  }

  /** The print the current world and size call for. */
  private printWish() {
    const w = this.world
    return w ? `${w.params.seed}:${w.params.half}:${w.params.trunkDensity}:${this.printSize()}` : ""
  }

  /** Appends what the map learned to the pencil layer and copies only the changed area (its mips on the GPU). */
  private ensurePencil(m: MapKnowledge, state: WoodsState, now: number) {
    const world = this.world, tex = this.pencilTex
    if (!world || !tex || now < this.pencilAt) return
    this.pencilAt = now + 250
    const t0 = performance.now()
    const r = this.pencil.update(world, m, state)
    if (!r) return
    this.device.queue.copyExternalImageToTexture({ source: this.pencil.canvas, origin: { x: r.x, y: r.y } }, { texture: tex, origin: { x: r.x, y: r.y }, premultipliedAlpha: false }, [r.w, r.h])
    const enc = this.device.createCommandEncoder()
    this.mips.generate(enc, tex, r)
    this.device.queue.submit([enc.finish()])
    this.timings.pencil = Math.round((performance.now() - t0) * 10) / 10
  }

  private shape(): PaperShape { const s = this.settings; return { fold: s.fold, curl: s.curl, sag: s.sag, wave: s.wave, corners: s.corners, pinch: s.pinch } }

  /** Camera-space shoulders (right, up, back) the sleeves run towards. */
  private static readonly LEFT_SHOULDER: V3 = [-0.2, -0.6, -0.12]
  private static readonly RIGHT_SHOULDER: V3 = [0.24, -0.5, -0.05]

  private sheetPose(e: number, swayX: number, swayY: number, swayRoll: number): M4 {
    const s = this.settings
    const up: V3 = [s.side, -s.drop, -s.distance], down: V3 = [s.side - 0.08, -s.drop - 0.42, -s.distance + 0.14]
    const arc = Math.sin(Math.PI * Math.min(1, Math.max(0, e)))
    const pos: V3 = [lerp(down[0], up[0], e) + swayX, lerp(down[1], up[1], e) + swayY, lerp(down[2], up[2], e) - arc * 0.05]
    const tilt = lerp(80, s.tilt, e) * DEG
    let m = translate(pos[0], pos[1], pos[2])
    m = mul(m, rotY(lerp(18, s.turn, e) * DEG))
    m = mul(m, rotX(-tilt))
    m = mul(m, rotZ((lerp(-12, s.roll, e) + swayRoll) * DEG))
    return m
  }

  private ensureMeshes() {
    const s = this.settings
    const key = `${s.fold}:${s.curl}:${s.sag}:${s.wave}:${s.corners}:${s.pinch}:${s.distance}:${s.drop}:${s.side}:${s.tilt}:${s.turn}:${s.roll}:${s.torchX}:${s.torchY}:${s.torchZ}`
    if (key === this.shapeKey) return
    const first = !this.shapeKey
    this.shapeKey = key
    const inv = invertRigid(this.sheetPose(1, 0, 0, 0))
    const sheet = buildSheet(this.shape(), point(inv, HeldMap.LEFT_SHOULDER))
    this.pass.setMesh("opaque", 0, sheet.opaque)
    this.thumb = leftThumb(this.shape())
    if (first) {
      const c = buildCompass()
      this.pass.setMesh("opaque", 1, c.opaque)
      this.pass.setMesh("clear", 0, c.clear)
    }
    // The torch's sleeve runs towards the right shoulder from its raised pose.
    const t = this.torchPose(1, 0, 0, this.sheetPose(1, 0, 0, 0))
    this.pass.setMesh("opaque", 2, buildTorch(point(invertRigid(t), HeldMap.RIGHT_SHOULDER)))
  }

  private torchPose(e: number, swayX: number, swayY: number, sheet: M4): M4 {
    const s = this.settings
    const up: V3 = [s.torchX, s.torchY, s.torchZ], down: V3 = [s.torchX + 0.08, s.torchY - 0.36, s.torchZ + 0.1]
    let lens: V3 = [lerp(down[0], up[0], e) + swayX * 1.3, lerp(down[1], up[1], e) + swayY * 1.2, lerp(down[2], up[2], e)]
    // The hand keeps the lens on the printed side, at least 9 cm off the paper's plane (the beam rakes across it).
    const ns = v3.norm(dir(sheet, [0, 0, 1])), cs = point(sheet, [0, 0, 0])
    const off = v3.dot(v3.sub(lens, cs), ns)
    if (off < 0.09) lens = v3.add(lens, v3.scale(ns, (0.09 - off) * Math.min(1, e)))
    const au = Math.min(1, Math.max(0, s.aimU + this.sweep[0] + this.lagS.yaw * 0.9)), av = Math.min(1, Math.max(0, s.aimV + this.sweep[1] - this.lagS.pitch * 0.9))
    const target = point(sheet, [(au - 0.5) * SHEET.w / 1000, (0.5 - av) * SHEET.h / 1000, 0])
    // Lowered, the torch points ahead and down; raised, at the sheet.
    const ahead: V3 = v3.add(lens, [0, -0.35, -1])
    const aim = v3.norm(v3.sub(v3.add(v3.scale(ahead, 1 - e), v3.scale(target, e)), lens))
    let x = v3.norm(v3.cross(aim, [0, 1, 0]))
    let z = v3.cross(x, aim)
    const r = -22 * DEG
    const xr = v3.add(v3.scale(x, Math.cos(r)), v3.scale(z, Math.sin(r))), zr = v3.add(v3.scale(z, Math.cos(r)), v3.scale(x, -Math.sin(r)))
    x = xr; z = zr
    return basis(x, aim, z, lens)
  }

  /**
   * Per frame: the raise and the hands, the needle and bubble, uniforms and the sheet's shadow caster. Returns the own
   * torch's lens and axis while the map is up (main lerps the beam onto the sheet), else null.
   */
  frame(f: HeldFrame): void {
    const s = this.settings
    const dt = Math.min(f.dt, 0.05)
    const p = f.state.players.find((x) => x.id === f.me)
    // Raise: a spring after the sim's raise, slightly underdamped so the arms settle.
    const w = s.raiseSpring, z = 0.72
    for (let k = 0; k < 4; k++) {
      const h = dt / 4
      const a = w * w * (f.raise - this.raise.x) - 2 * z * w * this.raise.v
      this.raise.v += a * h; this.raise.x += this.raise.v * h
    }
    const e = Math.min(1.08, Math.max(0, this.raise.x))
    this.pass.visible = this.held && e > 0.002 && !!p
    if (!this.held) this.pass.release()
    if (!this.pass.visible || !p) { this.torchOut = null; this.wasVisible = false; this.dimShare = 0; return }
    if (!this.wasVisible) {
      // Coming up from your side: the needle has been knocking about and the hands start from rest.
      this.wasVisible = true
      this.lagS.lastYaw = NaN
      this.needle.ready = false
    }
    this.ensureTextures()
    this.ensureMeshes()
    this.ensurePencil(p.map, f.state, performance.now())
    if (!this.pass.active) { this.torchOut = null; return }

    // Turn lag: the hands trail the head's turns and swing back.
    const L = this.lagS
    if (Number.isNaN(L.lastYaw)) { L.lastYaw = f.yaw; L.lastPitch = f.pitch }
    let dy = f.yaw - L.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    const dp = f.pitch - L.lastPitch
    L.lastYaw = f.yaw; L.lastPitch = f.pitch
    const lw = 1 / Math.max(s.lag, 0.01) * 2.2
    L.yaw += dy * 0.6; L.pitch += dp * 0.6
    for (const [x, v] of [["yaw", "vy"], ["pitch", "vp"]] as const) {
      const acc = -lw * lw * L[x] - 2 * 0.65 * lw * L[v]
      L[v] += acc * dt; L[x] += L[v] * dt
      L[x] = Math.max(-0.25, Math.min(0.25, L[x]))
    }
    if (s.lag <= 0.01) { L.yaw = 0; L.pitch = 0 }
    const breathe = Math.sin(f.time * 1.25) * 0.0018, drift = Math.sin(f.time * 0.53 + 1) * 0.0012
    const swayX = (-f.walk.lateral * 0.35 + drift) * s.sway, swayY = (f.walk.vertical * 0.5 + breathe) * s.sway
    const swayRoll = (f.walk.lateral * 40 + Math.sin(f.time * 0.7) * 0.25) * s.sway

    let sheet = this.sheetPose(e, swayX, swayY, swayRoll)
    const lagM = mul(rotY(-L.yaw), rotX(-L.pitch))
    sheet = mul(lagM, sheet)
    const torch = mul(lagM, this.torchPose(e, swayX, swayY, sheet))

    // Camera basis (FirstPerson.compose): camera space → world.
    const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw), sp = Math.sin(f.pitch), cp = Math.cos(f.pitch)
    const fwd: V3 = [-sy * cp, sp, -cy * cp]
    const upv: V3 = [sy * sp * Math.cos(f.roll) + cy * Math.sin(f.roll), cp * Math.cos(f.roll), cy * sp * Math.cos(f.roll) - sy * Math.sin(f.roll)]
    const zA = v3.scale(fwd, -1), xA = v3.norm(v3.cross(upv, zA)), yA = v3.cross(zA, xA)
    const eye: V3 = [f.eye[0]!, f.eye[1]!, f.eye[2]!]
    const invView = basis(xA, yA, zA, eye)

    const rest = compassRest(this.shape())
    const compass = mul(sheet, basis(rest.right, rest.front, rest.n, v3.add(rest.centre, v3.scale(rest.n, 0.00015))))
    const B = COMPASS.bezel, mm = 0.001
    const bezel = mul(compass, mul(translate(0, B.y * mm, COMPASS.plate.t * mm), rotZ(-s.bezel * DEG)))

    // Needle in fluid: a damped pendulum towards magnetic north in the capsule's plane, dragged by the liquid when
    // the housing turns, nudged by the hand's sway.
    const toWorld = mul(invView, compass)
    const xw = dir(toWorld, [1, 0, 0]), yw = dir(toWorld, [0, 1, 0]), zw = dir(toWorld, [0, 0, 1])
    const decl = s.declination * DEG
    const mag: V3 = [-Math.sin(decl), 0, -Math.cos(decl)]
    const target = Math.atan2(-v3.dot(mag, xw), v3.dot(mag, yw))
    const N = this.needle
    if (!N.ready) { N.ready = true; N.last = target; N.phi = N.phi === 0 ? 0.9 : 0.55 * Math.sign(Math.sin(f.time * 7.3) || 1); N.v = 0 }
    let dT = target - N.last; dT = Math.atan2(Math.sin(dT), Math.cos(dT))
    N.last = target
    const housing = -dT / Math.max(dt, 1e-3)
    N.fluid += (housing - N.fluid) * (1 - Math.exp(-dt / 0.5))
    const w0 = 2 * Math.PI * s.needleHz
    const kick = (f.walk.lateral * 30 + Math.sin(f.time * 9.1) * 0.02) * s.sway
    for (let k = 0; k < 8; k++) {
      const h = dt / 8
      const a = -w0 * w0 * Math.sin(N.phi) - 2 * s.needleDamping * w0 * (N.v - N.fluid * 0.7) + kick
      N.v += a * h; N.phi += N.v * h
    }
    N.phi = Math.atan2(Math.sin(N.phi), Math.cos(N.phi))
    const theta = N.phi + target
    const needle = mul(compass, mul(translate(0, B.y * mm, COMPASS.plate.t * mm + CAPSULE.needle), rotZ(theta)))
    // Bubble: rises to the capsule's highest point, sloshes with the hand.
    const gl: V3 = [-v3.dot([0, -1, 0], xw), -v3.dot([0, -1, 0], yw), 0]
    const gm = Math.hypot(gl[0], gl[1]) || 1
    const reach = Math.min(1, gm * 4) * 0.0115
    const Bb = this.bubble
    const tx = (gl[0] / gm) * reach, ty = (gl[1] / gm) * reach
    const bw = 7
    Bb.vx += (bw * bw * (tx - Bb.x) - 2 * 0.45 * bw * Bb.vx + kick * 0.0004) * dt
    Bb.vy += (bw * bw * (ty - Bb.y) - 2 * 0.45 * bw * Bb.vy) * dt
    Bb.x += Bb.vx * dt; Bb.y += Bb.vy * dt
    const bubble = mul(compass, translate(Bb.x, B.y * mm + Bb.y, COMPASS.plate.t * mm + CAPSULE.glass - 0.0011))

    // Uniforms.
    const u = this.u
    u.set(perspective(s.vmFov * DEG, f.aspect, 0.02, 4), 0)
    u.set(invView, 16)
    u.set(invertRigid(mul(invView, compass)), 32)
    const objs = [sheet, compass, bezel, needle, bubble, sheet, torch]
    objs.forEach((m, i) => u.set(m, 48 + i * 16))
    let o = 48 + 7 * 16
    u.set([eye[0], eye[1], eye[2], f.time], o); o += 4
    const tone = s.gloveTone
    u.set([0.0016 * s.ambient, 0.002 * s.ambient, 0.003 * s.ambient, 0], o); o += 4
    u.set([SHEET.w / 1000, SHEET.h / 1000, s.translucency, s.sheen], o); o += 4
    u.set([s.creases, s.fibre, s.pencilSheen, s.sharpness], o); o += 4
    // Bezel-local and plate-local (x, y) → sheet uv: (rotate by the bezel turn, offset) → sheet (rest axes) → uv.
    const bt = -s.bezel * DEG, cb = Math.cos(bt), sb = Math.sin(bt)
    const plateToUv = (x: number, y: number): [number, number] => {
      const p3 = v3.add(rest.centre, v3.add(v3.scale(rest.right, x), v3.scale(rest.front, y)))
      return [(p3[0] + SHEET.w / 2000) / (SHEET.w / 1000), (SHEET.h / 2000 - p3[1]) / (SHEET.h / 1000)]
    }
    const bezelToUv = (x: number, y: number) => plateToUv(x * cb - y * sb, x * sb + y * cb + B.y * mm)
    const o0 = bezelToUv(0, 0), ox = bezelToUv(1, 0), oy = bezelToUv(0, 1)
    u.set([ox[0] - o0[0], oy[0] - o0[0], o0[0], 0], o); o += 4
    u.set([ox[1] - o0[1], oy[1] - o0[1], o0[1], (COMPASS.plate.t + 1.1) * mm], o); o += 4
    const invBezel = invertRigid(mul(invView, bezel))
    const be = point(invBezel, eye)
    u.set([be[0], be[1], be[2], s.luminous], o); o += 4
    // Occluders (world): the left thumb along the paper, the torch fist.
    const toW = (m: M4, q: V3) => point(invView, point(m, q))
    const at = (uu: number, vv: number, zz: number): V3 => [uu / 1000 - SHEET.w / 2000, SHEET.h / 2000 - vv / 1000, zz / 1000]
    const th = this.thumb, tp = (k: number) => th[Math.min(th.length - 1, Math.round(k * (th.length - 1)))] ?? [0, 0, 0]
    const occ: [V3, number][] = [[toW(sheet, tp(0.4)), 0.0125], [toW(sheet, tp(0.6)), 0.012], [toW(sheet, tp(0.8)), 0.0112], [toW(sheet, tp(1)), 0.0104], [toW(torch, [0.04, -0.08, 0]), 0.036]]
    for (let k = 0; k < 5; k++) { const q = occ[k]; u.set(q ? [q[0][0], q[0][1], q[0][2], q[1]] : [0, 0, 0, 0], o); o += 4 }
    const bc = toW(bezel, [0, 0, B.h * mm]), bn = v3.norm(dir(mul(invView, bezel), [0, 0, 1]))
    u.set([bc[0], bc[1], bc[2], B.outer * mm], o); o += 4
    u.set([bn[0], bn[1], bn[2], B.inner * mm], o); o += 4
    const leather: V3 = [lerp(0.022, 0.12, tone), lerp(0.011, 0.06, tone), lerp(0.006, 0.028, tone)]
    u.set([leather[0], leather[1], leather[2], 0], o); o += 4
    // Your torch (matched in the light list by its lens): its beam profile flattened on the props while reading.
    const lensW = toW(torch, [0, 0, 0])
    u.set([lensW[0], lensW[1], lensW[2], lerp(1, s.beamSoftness, Math.min(1, e))], o); o += 4
    const p0 = plateToUv(0, 0), px = plateToUv(1, 0), py = plateToUv(0, 1)
    u.set([px[0] - p0[0], py[0] - p0[0], p0[0], 0], o); o += 4
    u.set([px[1] - p0[1], py[1] - p0[1], p0[1], 0], o); o += 4
    u.set([s.gloveSheen, s.gloveWear, lerp(0, s.beamNear, Math.min(1, e)), 0], o); o += 4
    this.device.queue.writeBuffer(this.pass.uniform, 0, u)

    // The sheet blocks the beam: a world-space quad for the torch's spot shadow.
    const corners = [at(0, 0, 0), at(SHEET.w, 0, 0), at(SHEET.w, SHEET.h, 0), at(0, SHEET.h, 0)].map((q) => toW(sheet, q))
    const tri = [0, 1, 2, 0, 2, 3]
    tri.forEach((k, i) => this.casterData.set([...corners[k]!, 0, 0, 0, 0, 0], i * 8))
    this.device.queue.writeBuffer(this.casterBuf, 0, this.casterData)

    const lens = toW(torch, [0, 0, 0]), axis = v3.norm(dir(mul(invView, torch), [0, 1, 0]))
    this.torchOut = { origin: lens, axis }
    this.raiseShare = Math.min(1, e)
    // The torch drops to its low mode as soon as you start raising the map, ahead of the arm.
    this.dimShare = Math.min(1, Math.max(this.dimShare - dt * 3, Math.sqrt(Math.max(0, f.raise))))
  }

  /** How far the torch has gone to its reading level (0..1). */
  dimShare = 0

  /** How far up the props are (0..1, after the arm spring). */
  raiseShare = 0

  /** The own torch while held: lens and beam axis (world), or null when the map is down or not held. */
  torch(): { origin: [number, number, number]; axis: [number, number, number] } | null { return this.torchOut }

  /** The sheet as a torch-shadow caster while it is up. */
  casters(): SpotShadowCaster[] { return this.pass.visible && this.raiseShare > 0.3 ? [{ buffer: this.casterBuf, count: 6, stride: 32 }] : [] }

  /** Automation: the printed sheet, pencil layer and compass atlas as PNG data URLs (printed again in the worker). */
  async layers(): Promise<{ print: string; pencil: string; face: string }> {
    const world = this.world
    if (!world) return { print: "", pencil: "", face: "" }
    const url = (b?: Blob) => new Promise<string>((res) => { if (!b) return res(""); const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(b) })
    const wear = this.wear ? await createImageBitmap(this.wear) : null
    const [p, f] = await Promise.all([this.request({ kind: "print", params: world.params, longSide: this.printSize(), wear, png: true }, wear ? [wear] : []), this.request({ kind: "face", scale: scaleOf(world), png: true })])
    return { print: await url(p.png), pencil: this.pencil.canvas.toDataURL("image/png"), face: await url(f.png) }
  }

  /** Automation readout. */
  get debug() { return { floor: [...this.u.slice(176, 188)].map((x) => +x.toFixed(4)), visible: this.pass.visible, active: this.pass.active, raise: this.raise.x, needle: this.needle.phi, bubble: [this.bubble.x, this.bubble.y], timings: this.timings, printSize: this.printSize(), compassOnSheet: COMPASS_ON_SHEET } }
}
