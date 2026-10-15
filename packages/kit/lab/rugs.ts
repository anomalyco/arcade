import type { LabControl, LabSettings } from "../lab-panel"
import { mulberry32 } from "../sim/rng"
import { createRugWorker, type RugWorkerRequest, type RugWorkerResponse } from "../textures/rug-baker"
import { DEFAULT_RUG_SPEC, PERSIAN_FIELDS, RUG_PALETTE_IDS, RUG_PALETTES, RUG_STYLE_LABELS, RUG_STYLES, rugSpecKey, type PersianField, type RugPaletteId, type RugSpec, type RugStyle } from "../textures/rug"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection } from "./types"

/**
 * Rugs: the production rug generator (`textures/rug.ts`), baked by the same Worker Outbreak uses, on a plain floor.
 * The texture, mips and pile height are exactly what the game samples; the lighting here is a simple raking key
 * light so the pile relief reads, not Outbreak's lighting (see the Outbreak "Rugs & interiors" station for that).
 */

const STYLE_PALETTE: Record<RugStyle, RugPaletteId> = { persian: "madder", turkmen: "tekke", kilim: "kilim", deco: "deco", braided: "braid", shag: "shag70s" }
const GALLERY_SPACING = 2.7
const VERT_FLOATS = 6

const rugShader = frameShader + /* wgsl */ `
struct RugStage { light: vec4f, cfg: vec4f }
@group(0) @binding(1) var<uniform> U: RugStage;
@group(0) @binding(2) var rugTex: texture_2d_array<f32>;
@group(0) @binding(3) var rugSamp: sampler;

struct VIn { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) layer: f32 }
struct VOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) uv: vec2f, @location(2) @interpolate(flat) layer: f32 }

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = F.vp * vec4f(v.pos, 1.0);
  o.uv = v.uv;
  o.layer = v.layer;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let bias = exp2(U.cfg.y);
  let gx = dpdx(o.uv) * bias;
  let gy = dpdy(o.uv) * bias;
  let L = normalize(U.light.xyz);
  let ambient = U.cfg.w;
  if (o.layer < 0.0) {
    // Dark walnut boards so rug edges and fringes read against a believable floor.
    let board = floor(o.world.x * 6.0);
    let tone = 0.85 + 0.15 * fract(sin(board * 91.7) * 4375.5);
    let seam = smoothstep(0.0, 0.04, fract(o.world.x * 6.0)) * 0.25 + 0.75;
    let albedo = vec3f(0.11, 0.065, 0.04) * tone * seam;
    return vec4f(albedo * (ambient + max(L.y, 0.0) * U.light.w), 1.0);
  }
  let li = i32(round(o.layer));
  let t = textureSampleGrad(rugTex, rugSamp, o.uv, li, gx, gy);
  if (t.a < 0.035) { discard; }
  let mode = i32(round(U.cfg.z));
  if (mode == 1) { return vec4f(t.rgb, 1.0); }
  if (mode == 2) { return vec4f(vec3f(t.a), 1.0); }
  // Same pile relief as Outbreak's rug material: height differences across one texel of the sampled mip.
  let du = max(length(gx), 1.0 / 2048.0);
  let dv = max(length(gy), 1.0 / 2048.0);
  let hu = textureSampleGrad(rugTex, rugSamp, o.uv + vec2f(du, 0.0), li, gx, gy).a - t.a;
  let hv = textureSampleGrad(rugTex, rugSamp, o.uv + vec2f(0.0, dv), li, gx, gy).a - t.a;
  let slope = vec2f(hu / du, hv / dv) * 0.012 * U.cfg.x;
  let n = normalize(vec3f(-slope.x * 0.35, 1.0, -slope.y * 0.35));
  let pile = mix(0.62, 1.0, smoothstep(0.1, 0.8, t.a));
  return vec4f(t.rgb * pile * (ambient + max(dot(n, L), 0.0) * U.light.w), 1.0);
}
`

type RugSlot = { spec: RugSpec; x: number; z: number }

export function createRugsSection(context: LabContext): LabSection {
  const { device, stage } = context
  const settings: LabSettings = {
    view: "single",
    style: DEFAULT_RUG_SPEC.style,
    palette: DEFAULT_RUG_SPEC.palette,
    field: DEFAULT_RUG_SPEC.field,
    seed: DEFAULT_RUG_SPEC.seed,
    tuningSeed: 11,
    width: DEFAULT_RUG_SPEC.width,
    length: DEFAULT_RUG_SPEC.length,
    wear: DEFAULT_RUG_SPEC.wear,
    fade: DEFAULT_RUG_SPEC.fade,
    abrash: DEFAULT_RUG_SPEC.abrash,
    knotMm: DEFAULT_RUG_SPEC.knotMm,
    medallion: DEFAULT_RUG_SPEC.medallion,
    borderScale: DEFAULT_RUG_SPEC.borderScale,
    fringe: DEFAULT_RUG_SPEC.fringe,
    stains: DEFAULT_RUG_SPEC.stains,
    resolution: 1024,
    shading: 0,
    relief: 1,
    mipBias: -0.5,
    lightAzimuth: 35,
    lightElevation: 28,
    lightIntensity: 1.6,
    ambient: 0.32,
  }

  const baseSpec = (): RugSpec => ({
    style: settings.style as RugStyle,
    palette: settings.palette as RugPaletteId,
    seed: Math.round(Number(settings.seed)),
    width: Number(settings.width),
    length: Number(settings.length),
    wear: Number(settings.wear),
    fade: Number(settings.fade),
    abrash: Number(settings.abrash),
    knotMm: Number(settings.knotMm),
    medallion: Number(settings.medallion),
    borderScale: Number(settings.borderScale),
    field: settings.field as PersianField,
    fringe: Boolean(settings.fringe),
    stains: Number(settings.stains),
  })

  /** One rug, or every style side by side with the shared parameters and each style's own dye palette. */
  const slots = (): RugSlot[] => {
    const spec = baseSpec()
    if (settings.view !== "gallery") return [{ spec, x: 0, z: 0 }]
    return RUG_STYLES.map((style, i) => ({
      spec: { ...spec, style, palette: STYLE_PALETTE[style], width: 2, length: style === "braided" ? 2.6 : 3, fringe: style !== "braided" && style !== "shag" },
      x: (i - (RUG_STYLES.length - 1) / 2) * GALLERY_SPACING,
      z: 0,
    }))
  }

  // GPU resources: one layer per visible rug. The gallery is capped at 1024 px so it stays near the game's pool size.
  let texSize = 0
  let texLayers = 0
  let texture: GPUTexture | null = null
  let view: GPUTextureView | null = null
  let group: GPUBindGroup | null = null
  const layerKeys: string[] = []
  const uniforms = new Float32Array(8)
  const uniformBuf = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const frameBuf = device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", maxAnisotropy: 16 })
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })
  const module = device.createShaderModule({ code: rugShader, label: "Lab rugs" })
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [{ arrayStride: VERT_FLOATS * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x2" },
        { shaderLocation: 2, offset: 20, format: "float32" },
      ] }],
    },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })
  let vertexBuf: GPUBuffer | null = null
  let vertexCount = 0
  let meshKey = ""

  const ensureTexture = (size: number, layers: number) => {
    if (texture && texSize === size && texLayers === layers) return
    texture?.destroy()
    texSize = size
    texLayers = layers
    texture = device.createTexture({
      label: "lab-rugs",
      size: [size, size, layers],
      mipLevelCount: Math.floor(Math.log2(size)) + 1,
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    view = texture.createView({ dimension: "2d-array" })
    group = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: frameBuf } },
      { binding: 1, resource: { buffer: uniformBuf } },
      { binding: 2, resource: view },
      { binding: 3, resource: sampler },
    ] })
    layerKeys.length = 0
  }

  const quad = (out: number[], x0: number, z0: number, x1: number, z1: number, y: number, layer: number) => {
    const v = (x: number, z: number, u: number, w: number) => out.push(x, y, z, u, w, layer)
    v(x0, z0, 0, 0); v(x1, z0, 1, 0); v(x1, z1, 1, 1)
    v(x0, z0, 0, 0); v(x1, z1, 1, 1); v(x0, z1, 0, 1)
  }

  const rebuildMesh = (list: RugSlot[]) => {
    const key = list.map(s => `${s.x},${s.z},${s.spec.width},${s.spec.length}`).join(";")
    if (key === meshKey && vertexBuf) return
    meshKey = key
    const out: number[] = []
    quad(out, -12, -8, 12, 8, 0, -1)
    list.forEach((s, i) => quad(out, s.x - s.spec.width / 2, s.z - s.spec.length / 2, s.x + s.spec.width / 2, s.z + s.spec.length / 2, 0.006, i))
    const data = new Float32Array(out)
    vertexBuf?.destroy()
    vertexBuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vertexBuf, 0, data)
    vertexCount = data.length / VERT_FLOATS
  }

  // Bakes: the production Worker; only the latest request per layer is uploaded.
  let worker: Worker | null = null
  let nextId = 1
  const inflight = new Map<number, { layer: number; key: string; size: number }>()
  const wanted: string[] = []
  const stats = { bakes: 0, lastMs: 0, maxMs: 0, pending: 0 }

  const upload = (layer: number, size: number, mips: ArrayBuffer[]) => {
    if (!texture || size !== texSize || layer >= texLayers) return
    let w = size
    mips.forEach((buf, level) => {
      if (level >= texture!.mipLevelCount) return
      device.queue.writeTexture({ texture: texture!, mipLevel: level, origin: [0, 0, layer] }, buf, { bytesPerRow: w * 4, rowsPerImage: w }, [w, w, 1])
      w = Math.max(1, w >> 1)
    })
  }

  const receive = (res: RugWorkerResponse) => {
    const job = inflight.get(res.id)
    inflight.delete(res.id)
    stats.pending = inflight.size
    if (!job) return
    if (res.error || !res.mips.length) {
      console.warn(`[lab rugs] bake failed: ${res.error ?? "no data"}`)
      return
    }
    stats.bakes++
    stats.lastMs = res.ms
    stats.maxMs = Math.max(stats.maxMs, res.ms)
    if (wanted[job.layer] !== job.key) return
    upload(job.layer, job.size, res.mips)
    layerKeys[job.layer] = job.key
    context.sync()
  }

  const requestBakes = () => {
    const list = slots()
    const size = settings.view === "gallery" ? Math.min(1024, Number(settings.resolution)) : Number(settings.resolution)
    ensureTexture(size, list.length)
    rebuildMesh(list)
    worker ??= createRugWorker()
    if (!worker) return
    worker.onmessage = (ev: MessageEvent<RugWorkerResponse>) => receive(ev.data)
    wanted.length = list.length
    list.forEach((slot, layer) => {
      const key = rugSpecKey(slot.spec, size)
      if (wanted[layer] === key) return
      wanted[layer] = key
      if (layerKeys[layer] === key) return
      const id = nextId++
      inflight.set(id, { layer, key, size })
      worker!.postMessage({ id, kind: "rug", spec: slot.spec, size } satisfies RugWorkerRequest)
    })
    stats.pending = inflight.size
  }

  /** New parameters from `tuningSeed` only; the design seed and size are untouched, so a room can be re-dressed. */
  const randomize = () => {
    const seed = Math.max(1, Math.round(Number(settings.tuningSeed) || 1))
    const rnd = mulberry32((seed * 2654435761) >>> 0)
    const style = RUG_STYLES[Math.floor(rnd() * RUG_STYLES.length)]!
    settings.style = style
    settings.palette = rnd() < 0.6 ? STYLE_PALETTE[style] : RUG_PALETTE_IDS[Math.floor(rnd() * RUG_PALETTE_IDS.length)]!
    settings.field = PERSIAN_FIELDS[Math.floor(rnd() * PERSIAN_FIELDS.length)]!
    settings.wear = Math.round(rnd() * 70) / 100
    settings.fade = Math.round(rnd() * 60) / 100
    settings.abrash = Math.round(rnd() * 80) / 100
    settings.knotMm = Math.round((5 + rnd() * 5) * 2) / 2
    settings.medallion = style === "persian" && rnd() > 0.2 ? Math.round((0.5 + rnd() * 0.55) * 100) / 100 : 0
    settings.borderScale = Math.round((0.75 + rnd() * 0.55) * 100) / 100
    settings.fringe = style !== "braided" && style !== "shag"
    settings.stains = Math.round(rnd() * 35) / 100
    settings.tuningSeed = (seed % 9999) + 1
    requestBakes()
    context.sync()
  }

  const bake = () => requestBakes()
  const design = "Design"
  const condition = "Condition"
  const viewGroup = "View & light"
  const controls: LabControl[] = [
    { key: "view", label: "View", group: viewGroup, type: "select", options: [{ value: "single", label: "One rug" }, { value: "gallery", label: "All six styles" }], change: () => { requestBakes(); frame() } },
    { key: "style", label: "Style", group: design, type: "select", options: RUG_STYLES.map(s => ({ value: s, label: RUG_STYLE_LABELS[s] })), change: bake, visible: s => s.view !== "gallery" },
    { key: "palette", label: "Dye palette", group: design, type: "select", options: RUG_PALETTE_IDS.map(id => ({ value: id, label: RUG_PALETTES[id].label })), change: bake, visible: s => s.view !== "gallery" },
    { key: "field", label: "Persian field", group: design, type: "select", options: PERSIAN_FIELDS.map(f => ({ value: f, label: f[0]!.toUpperCase() + f.slice(1) })), change: bake },
    { key: "seed", label: "Design seed", group: design, type: "range", min: 1, max: 9999, step: 1, unit: "", change: bake },
    { key: "medallion", label: "Medallion size", group: design, type: "range", min: 0, max: 1.2, step: 0.05, unit: "", change: bake },
    { key: "borderScale", label: "Border scale", group: design, type: "range", min: 0.5, max: 1.6, step: 0.05, unit: "×", change: bake },
    { key: "knotMm", label: "Knot pitch", group: design, type: "range", min: 3, max: 14, step: 0.5, unit: "mm", change: bake },
    { key: "width", label: "Width", group: design, type: "range", min: 0.8, max: 4, step: 0.1, unit: "m", change: bake, visible: s => s.view !== "gallery" },
    { key: "length", label: "Length", group: design, type: "range", min: 1.2, max: 6, step: 0.1, unit: "m", change: bake, visible: s => s.view !== "gallery" },
    { key: "fringe", label: "Fringes", group: design, type: "toggle", change: bake },
    { key: "wear", label: "Wear", group: condition, type: "range", min: 0, max: 1, step: 0.05, unit: "", change: bake },
    { key: "fade", label: "Sun fade", group: condition, type: "range", min: 0, max: 1, step: 0.05, unit: "", change: bake },
    { key: "abrash", label: "Abrash (dye lots)", group: condition, type: "range", min: 0, max: 1, step: 0.05, unit: "", change: bake },
    { key: "stains", label: "Stains", group: condition, type: "range", min: 0, max: 1, step: 0.05, unit: "", change: bake },
    { key: "tuningSeed", label: "Tuning seed", group: design, type: "range", min: 1, max: 9999, step: 1, unit: "" },
    { key: "randomize", label: "Randomize parameters", group: design, type: "action", run: randomize },
    { key: "resolution", label: "Texture size", group: viewGroup, type: "select", options: [512, 1024, 2048].map(v => ({ value: v, label: `${v} px${v === 1024 ? " (game)" : ""}` })), change: bake },
    { key: "shading", label: "Shading", group: viewGroup, type: "select", options: [{ value: 0, label: "Lit (pile relief)" }, { value: 1, label: "Albedo only" }, { value: 2, label: "Pile height" }] },
    { key: "relief", label: "Pile relief", group: viewGroup, type: "range", min: 0, max: 3, step: 0.1, unit: "×" },
    { key: "mipBias", label: "Mip bias", group: viewGroup, type: "range", min: -2, max: 1, step: 0.25, unit: "log2" },
    { key: "lightAzimuth", label: "Key light azimuth", group: viewGroup, type: "range", min: 0, max: 360, step: 5, unit: "°" },
    { key: "lightElevation", label: "Key light elevation", group: viewGroup, type: "range", min: 5, max: 90, step: 1, unit: "°" },
    { key: "lightIntensity", label: "Key light intensity", group: viewGroup, type: "range", min: 0, max: 4, step: 0.05, unit: "" },
    { key: "ambient", label: "Ambient", group: viewGroup, type: "range", min: 0, max: 1, step: 0.02, unit: "" },
  ]

  const target = () => settings.view === "gallery" ? { x: 0, y: 0, z: 0.4, dist: 15 } : { x: 0, y: 0, z: 0.3, dist: Math.max(4.5, Number(settings.length) * 1.7) }
  const frame = () => { const t = target(); stage.frameTarget(t.x, t.y, t.z, t.dist) }

  return {
    id: "rugs",
    label: "Rugs",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      requestBakes()
      frame()
    },
    leave() {
      worker?.terminate()
      worker = null
      inflight.clear()
      wanted.length = 0
    },
    reroll() {
      settings.seed = ((Number(settings.seed) * 1664525 + 1013904223) >>> 0) % 9999 + 1
      requestBakes()
      context.sync()
    },
    retrigger: () => requestBakes(),
    frameTarget: target,
    prepare() {
      stage.sceneMode = 5
      requestBakes()
      const az = (Number(settings.lightAzimuth) * Math.PI) / 180
      const el = (Number(settings.lightElevation) * Math.PI) / 180
      uniforms.set([Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az), Number(settings.lightIntensity), Number(settings.relief), Number(settings.mipBias), Number(settings.shading), Number(settings.ambient)])
      device.queue.writeBuffer(uniformBuf, 0, uniforms)
    },
    draw(pass) {
      if (!group || !vertexBuf) return
      const f = (stage as unknown as { frame?: Float32Array }).frame
      if (f) device.queue.writeBuffer(frameBuf, 0, f.buffer, f.byteOffset, Math.min(1024, f.byteLength))
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.setVertexBuffer(0, vertexBuf)
      pass.draw(vertexCount)
    },
    telemetry() {
      const resident = layerKeys.filter((k, i) => k && k === wanted[i]).length
      const mb = (texSize * texSize * 4 * (4 / 3) * texLayers) / 1048576
      return `Rugs · ${settings.view === "gallery" ? "six styles" : RUG_STYLE_LABELS[settings.style as RugStyle]} ${JSON.stringify({ size: texSize, layers: texLayers, resident, pending: stats.pending, lastBakeMs: Math.round(stats.lastMs), maxBakeMs: Math.round(stats.maxMs), gpuMB: Number(mb.toFixed(1)) })}`
    },
  }
}
