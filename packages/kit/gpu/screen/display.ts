import { CameraFilter, createCameraFilterSettings, type CameraFilterSettings } from "../post/camcorder"
import type { FinalPass, PassContext, ScenePass } from "../renderer"
import { reactivePipelineDescriptor, REACTIVE_COVERAGE_WGSL } from "../reactive"
import { common } from "../shaders"
import { halfToFloat, ScreenLightProbe, type ScreenEmitter, type ScreenPlacement } from "./light"
import { coverFit, createScreenDisplaySettings, degaussEnvelope, DISPLAY_UNIFORM_FLOATS, packDisplayUniform, ScreenPower, type ScreenDisplaySettings } from "./settings"
import { BLIT_WGSL, FULLSCREEN_WGSL, MIP_WGSL, screenBindingsWgsl, screenRoomWgsl, screenTubeWgsl, SIGNAL_WGSL } from "./wgsl"

export type ScreenImage = HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | ImageBitmap | HTMLImageElement | VideoFrame

/**
 * What the screen shows: a GPU texture the game draws into (a security camera, another scene; `linear` when it holds
 * light rather than video gamma, e.g. an HDR render), or an image source copied up each frame (a canvas, a playing
 * video). `still` uploads an image once.
 */
export type ScreenSource =
  | { texture: GPUTexture; linear?: boolean }
  | { image: ScreenImage; width: number; height: number; still?: boolean }

export type ScreenDisplayOptions = {
  /** Signal size in pixels (default 640×480, 4:3). The tube's own resolution comes from its scanlines and mask. */
  width?: number
  height?: number
  /** A settings object to read every frame (the Lab binds one); default the TV preset. */
  settings?: ScreenDisplaySettings
  label?: string
}

const SIGNAL_FORMAT: GPUTextureFormat = "rgba16float"
const VHS_FORMAT: GPUTextureFormat = "rgba8unorm"
/** Readback slots: the CPU reads whichever finished last and never waits for the newest. */
const READBACK_SLOTS = 3

/**
 * A display: CRT tube or LCD panel showing any source, shared by its 3D quads (`ScreenQuadPass`), a full-screen view
 * (`ScreenFinalPass`) and the room's light (`screenSceneLight`). Call `update(dt)` once a frame, then the passes encode
 * the signal stage (VHS, snow, afterglow, mips and the light readback) the first time one of them draws.
 *
 * Renderer-agnostic: a game with its own renderer calls `encode(encoder)` itself, binds `bindEntries()` and includes
 * `screenBindingsWgsl` + `screenTubeWgsl` (`wgsl.ts`) in its own screen shader.
 */
export class ScreenDisplay implements ScreenEmitter {
  readonly settings: ScreenDisplaySettings
  readonly width: number
  readonly height: number
  readonly light = new ScreenLightProbe()
  readonly power: ScreenPower
  /** Fires on every power switch (the HV click and whine of a CRT, a monitor's relay). */
  onPower?: (on: boolean) => void
  /** Fires when the degauss coil runs (its thunk and hum). */
  onDegauss?: () => void
  /** Keeps power and degauss to short fades and no shake. */
  reduceMotion = false
  /** Seconds of display time (`update` advances it). */
  time = 0
  private degaussAt = -1e9
  private source: ScreenSource | null = null
  private uploaded: ScreenImage | null = null
  private upload: GPUTexture | null = null
  private readonly blank: GPUTexture
  private readonly signal: GPUTexture
  private readonly history: GPUTexture
  private readonly levels: number
  private readonly uniform: GPUBuffer
  private readonly signalUniform: GPUBuffer
  private readonly data = new Float32Array(DISPLAY_UNIFORM_FLOATS)
  private readonly signalData = new Float32Array(DISPLAY_UNIFORM_FLOATS)
  private readonly sampler: GPUSampler
  private readonly pipes: { signal: GPURenderPipeline; mip: GPURenderPipeline; blit: GPURenderPipeline }
  private readonly mipGroups: GPUBindGroup[] = []
  private readonly mipViews: GPUTextureView[] = []
  private readonly fullView: GPUTextureView
  private signalGroups = new Map<GPUTexture, GPUBindGroup>()
  private blitGroups = new Map<GPUTexture, GPUBindGroup>()
  private vhs: { filter: CameraFilter; settings: CameraFilterSettings; out: GPUTexture; frame: Float32Array } | null = null
  private readonly readback: { buffer: GPUBuffer; busy: boolean }[]
  private readonly readLevel: number
  private readonly readSize: [number, number]
  private encoded = true
  private lastPower: boolean
  private emitted: [number, number, number] = [0, 0, 0]
  private disposed = false

  constructor(private readonly device: GPUDevice, options: ScreenDisplayOptions = {}) {
    const d = device
    this.settings = options.settings ?? createScreenDisplaySettings()
    this.width = Math.max(16, Math.round(options.width ?? 640))
    this.height = Math.max(16, Math.round(options.height ?? 480))
    this.power = new ScreenPower(this.settings.power)
    this.lastPower = this.settings.power
    const label = options.label ?? "screen"
    this.levels = Math.floor(Math.log2(Math.max(this.width, this.height))) + 1
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    this.signal = d.createTexture({ label: `${label} signal`, size: [this.width, this.height], format: SIGNAL_FORMAT, mipLevelCount: this.levels, usage })
    this.history = d.createTexture({ label: `${label} afterglow`, size: [this.width, this.height], format: SIGNAL_FORMAT, usage })
    this.blank = d.createTexture({ label: `${label} blank`, size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    d.queue.writeTexture({ texture: this.blank }, new Uint8Array([0, 0, 0, 255]), {}, [1, 1])
    this.fullView = this.signal.createView()
    for (let l = 0; l < this.levels; l++) this.mipViews.push(this.signal.createView({ baseMipLevel: l, mipLevelCount: 1 }))
    this.uniform = d.createBuffer({ label: `${label} display`, size: DISPLAY_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.signalUniform = d.createBuffer({ label: `${label} signal uniform`, size: DISPLAY_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    const pipe = (code: string, format: GPUTextureFormat, name: string) => {
      const module = d.createShaderModule({ label: `${label} ${name}`, code })
      return d.createRenderPipeline({ label: `${label} ${name}`, layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } })
    }
    this.pipes = { signal: pipe(SIGNAL_WGSL, SIGNAL_FORMAT, "signal"), mip: pipe(MIP_WGSL, SIGNAL_FORMAT, "mip"), blit: pipe(BLIT_WGSL, VHS_FORMAT, "vhs input") }
    for (let l = 1; l < this.levels; l++) {
      this.mipGroups.push(d.createBindGroup({ layout: this.pipes.mip.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.mipViews[l - 1]! }, { binding: 1, resource: this.sampler }] }))
    }
    // The light reads the first mip at most 8 texels wide.
    let level = 0
    while (level < this.levels - 1 && Math.max(1, this.width >> level) > 8) level++
    this.readLevel = level
    this.readSize = [Math.max(1, this.width >> level), Math.max(1, this.height >> level)]
    this.readback = Array.from({ length: READBACK_SLOTS }, (_, i) => ({
      buffer: d.createBuffer({ label: `${label} light readback ${i}`, size: 256 * this.readSize[1], usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      busy: false,
    }))
  }

  /** Shows a new source, or nothing (a powered tube with no signal shows black; set `snow` for an unplugged aerial). */
  setSource(source: ScreenSource | null): void {
    this.source = source
    this.uploaded = null
  }

  /** Runs the degauss coil now. */
  degauss(): void {
    if (this.settings.kind === "lcd") return
    this.degaussAt = this.time
    this.onDegauss?.()
  }

  /** Average emitted radiance this frame (linear rgb, scene units): the picture × peak white × power. */
  emission(): readonly [number, number, number] {
    return this.emitted
  }

  /** Advances the clock and the power and degauss animations, uploads an image source and writes the uniform. */
  update(dt: number): void {
    const s = this.settings
    const step = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1))
    this.time += step
    if (s.power !== this.lastPower) {
      this.lastPower = s.power
      if (this.power.set(s.power, this.time, s.kind, this.reduceMotion)) {
        this.onPower?.(s.power)
        if (s.power && s.autoDegauss && s.kind === "crt") this.degauss()
      }
    }
    const power = this.power.sample(this.time, s.kind, this.reduceMotion)
    const since = this.time - this.degaussAt
    const degauss = s.kind === "lcd" ? { wobble: 0, purity: 0 } : degaussEnvelope(since, this.reduceMotion)
    let sw = 1, sh = 1, linear = false
    const src = this.source
    if (src && "texture" in src) {
      sw = src.texture.width; sh = src.texture.height; linear = !!src.linear
    } else if (src) {
      sw = src.width; sh = src.height
      this.uploadImage(src)
    }
    const avg = this.light.average
    const k = s.brightness * power.level
    this.emitted = [avg[0] * k, avg[1] * k, avg[2] * k]
    packDisplayUniform(s, {
      time: this.time, dt: step, power, degauss, degaussTime: since,
      signalWidth: this.width, signalHeight: this.height, sourceLinear: linear,
      fit: coverFit(sw, sh, this.width / this.height), aspect: this.width / this.height, light: this.emitted,
    }, this.data)
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    this.signalData.set(this.data)
    if (s.vhs) {
      // The signal pass reads the VHS filter's output: already fitted and in video gamma.
      this.signalData.set([1, 1, 0, 0], 8)
      this.signalData[6] = 0
    }
    this.device.queue.writeBuffer(this.signalUniform, 0, this.signalData)
    this.encoded = false
  }

  /** Encodes the signal stage once per `update`; later calls in the same frame do nothing. */
  encode(encoder: GPUCommandEncoder): void {
    if (this.encoded || this.disposed) return
    this.encoded = true
    const s = this.settings
    const src = this.source
    let input: GPUTexture = src && "texture" in src ? src.texture : this.upload && this.source ? this.upload : this.blank
    if (s.vhs) input = this.encodeVhs(encoder, input)
    else if (this.vhs) { this.vhs.filter.dispose(); this.vhs.out.destroy(); this.vhs = null; this.blitGroups.clear() }
    const pass = (view: GPUTextureView) => encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    const sig = pass(this.mipViews[0]!)
    sig.setPipeline(this.pipes.signal)
    sig.setBindGroup(0, this.signalGroup(input))
    sig.draw(3)
    sig.end()
    encoder.copyTextureToTexture({ texture: this.signal }, { texture: this.history }, [this.width, this.height])
    for (let l = 1; l < this.levels; l++) {
      const mp = pass(this.mipViews[l]!)
      mp.setPipeline(this.pipes.mip)
      mp.setBindGroup(0, this.mipGroups[l - 1]!)
      mp.draw(3)
      mp.end()
    }
    const slot = this.readback.find(r => !r.busy)
    if (slot) {
      slot.busy = true
      encoder.copyTextureToBuffer({ texture: this.signal, mipLevel: this.readLevel }, { buffer: slot.buffer, bytesPerRow: 256 }, [this.readSize[0], this.readSize[1]])
      // The renderer submits right after encoding; map once that has happened.
      queueMicrotask(() => void this.collect(slot))
    }
  }

  /** Group layout entries for the display's bindings at `base`..`base + 2` (uniform, signal with mips, sampler). */
  static layoutEntries(base = 0, visibility: number = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX): GPUBindGroupLayoutEntry[] {
    return [
      { binding: base, visibility, buffer: { type: "uniform" } },
      { binding: base + 1, visibility, texture: { sampleType: "float" } },
      { binding: base + 2, visibility, sampler: { type: "filtering" } },
    ]
  }

  bindEntries(base = 0): GPUBindGroupEntry[] {
    return [
      { binding: base, resource: { buffer: this.uniform } },
      { binding: base + 1, resource: this.fullView },
      { binding: base + 2, resource: this.sampler },
    ]
  }

  dispose(): void {
    this.disposed = true
    this.signal.destroy(); this.history.destroy(); this.blank.destroy(); this.upload?.destroy()
    this.uniform.destroy(); this.signalUniform.destroy()
    this.vhs?.filter.dispose(); this.vhs?.out.destroy()
    for (const r of this.readback) if (!r.busy) r.buffer.destroy()
  }

  private uploadImage(src: Extract<ScreenSource, { image: ScreenImage }>) {
    if (src.still && this.uploaded === src.image) return
    const w = Math.max(1, Math.round(src.width)), h = Math.max(1, Math.round(src.height))
    if (!this.upload || this.upload.width !== w || this.upload.height !== h) {
      this.upload?.destroy()
      this.upload = this.device.createTexture({ label: "screen source", size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
      this.signalGroups.clear()
      this.blitGroups.clear()
    }
    const video = typeof HTMLVideoElement !== "undefined" && src.image instanceof HTMLVideoElement
    if (video && (src.image as HTMLVideoElement).readyState < 2) return
    try {
      this.device.queue.copyExternalImageToTexture({ source: src.image as GPUCopyExternalImageSource }, { texture: this.upload }, [w, h])
      this.uploaded = src.image
    } catch { /* a source that isn't ready yet (decoding video, zero-size canvas) shows the last frame */ }
  }

  private signalGroup(input: GPUTexture): GPUBindGroup {
    let g = this.signalGroups.get(input)
    if (!g) {
      g = this.device.createBindGroup({ layout: this.pipes.signal.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.signalUniform } },
        { binding: 1, resource: input.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 2, resource: this.history.createView() },
        { binding: 3, resource: this.sampler },
      ] })
      if (this.signalGroups.size > 8) this.signalGroups.clear()
      this.signalGroups.set(input, g)
    }
    return g
  }

  private encodeVhs(encoder: GPUCommandEncoder, input: GPUTexture): GPUTexture {
    const s = this.settings
    if (!this.vhs) {
      const settings = createCameraFilterSettings(undefined, { mode: "vhs", overlay: false, vhsYear: 0 })
      const out = this.device.createTexture({ label: "screen vhs", size: [this.width, this.height], format: VHS_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
      this.vhs = { filter: new CameraFilter(this.device, VHS_FORMAT, settings, 1987), settings, out, frame: new Float32Array(20) }
    }
    const vhs = this.vhs
    vhs.settings.strength = s.vhsAmount
    let g = this.blitGroups.get(input)
    if (!g) {
      g = this.device.createBindGroup({ layout: this.pipes.blit.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: input.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 2, resource: this.sampler },
      ] })
      if (this.blitGroups.size > 8) this.blitGroups.clear()
      this.blitGroups.set(input, g)
    }
    const blit = encoder.beginRenderPass({ colorAttachments: [{ view: vhs.filter.source(this.width, this.height), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    blit.setPipeline(this.pipes.blit)
    blit.setBindGroup(0, g)
    blit.draw(3)
    blit.end()
    // The filter reads only the clock from the frame (identity camera: no pan smear).
    vhs.frame.fill(0)
    vhs.frame[0] = vhs.frame[5] = vhs.frame[10] = vhs.frame[15] = 1
    vhs.frame[19] = this.time
    void vhs.filter.active
    vhs.filter.encode(encoder, vhs.out.createView(), vhs.frame)
    return vhs.out
  }

  private async collect(slot: { buffer: GPUBuffer; busy: boolean }) {
    try {
      await slot.buffer.mapAsync(GPUMapMode.READ)
      if (this.disposed) { slot.buffer.destroy(); return }
      const [w, h] = this.readSize
      const raw = new Uint16Array(slot.buffer.getMappedRange())
      const rgb = new Float32Array(w * h * 3)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const at = y * 128 + x * 4
        for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = Math.max(0, halfToFloat(raw[at + c]!) || 0)
      }
      slot.buffer.unmap()
      this.light.push(rgb, w, h)
    } catch {
      /* device lost or buffer destroyed: the light keeps its last value */
    }
    slot.busy = false
  }
}

// ---------------------------------------------------------------- 3D quad in the kit renderer

/** A screen's glass in the world: placement plus the room it reflects (optional). */
export type ScreenQuadOptions = ScreenPlacement & {
  /** The room as an axis-aligned box seen from inside (world metres), reflected faintly in the dark glass. */
  room?: { min: readonly [number, number, number]; max: readonly [number, number, number]; albedo?: number }
}

const QUAD_FLOATS = 7 * 4
const GRID_X = 24, GRID_Y = 18

export const SCREEN_QUAD_WGSL = `${common}
${screenBindingsWgsl(1, 0)}
struct ScreenQuad {
  origin: vec4f, // glass centre xyz, half width
  right: vec4f,  // unit right xyz, half height
  up: vec4f,     // unit up xyz, bulge m
  normal: vec4f, // unit normal xyz, own-light radius
  roomMin: vec4f, // xyz, wall albedo
  roomMax: vec4f, // xyz, room on
  misc: vec4f,   // area, -, -, -
}
@group(1) @binding(3) var<uniform> Q: ScreenQuad;
${screenTubeWgsl}
${screenRoomWgsl}
const GX: u32 = ${GRID_X}u;
const GY: u32 = ${GRID_Y}u;
struct VO { @builtin(position) pos: vec4f, @location(0) face: vec2f, @location(1) world: vec3f, @location(2) n: vec3f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let cell = vi / 6u;
  let corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let face = (vec2f(f32(cell % GX), f32(cell / GX)) + corners[vi % 6u]) / vec2f(f32(GX), f32(GY));
  let s = face * 2.0 - 1.0;
  let hw = Q.origin.w;
  let hh = Q.right.w;
  let b = Q.up.w;
  let bx = 1.0 - s.x * s.x;
  let by = 1.0 - s.y * s.y;
  // The faceplate bulges toward the viewer, flush with the bezel at its edges.
  let world = Q.origin.xyz + Q.right.xyz * (s.x * hw) - Q.up.xyz * (s.y * hh) + Q.normal.xyz * (b * bx * by);
  let dzdx = -2.0 * b * s.x * by / hw;
  let dzdy = 2.0 * b * s.y * bx / hh;
  var o: VO;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.face = face;
  o.world = world;
  o.n = normalize(Q.normal.xyz - Q.right.xyz * dzdx - Q.up.xyz * dzdy);
  return o;
}

fn ggxD(nh: f32, a2: f32) -> f32 {
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

@fragment fn fs(v: VO) -> @location(0) vec4f {
  let fw = fwidth(v.face);
  let V = normalize(F.cam.xyz - v.world);
  let n = normalize(v.n);
  let cosv = dot(n, V);
  let mask = screenFaceMask(v.face, fw);
  var c = vec3f(0.0);
  if (cosv > 0.0 && mask > 0.0) { c = screenTube(v.face, fw, cosv) * mask; }
  // The glass: grey phosphor lit by the room, the lamps mirrored in it, the room lit by the picture.
  let smudge = D.dec.w * noise2(v.face * vec2f(9.0, 7.0) + 3.0);
  let rough = mix(0.035, 0.22, smudge);
  let a2 = rough * rough * rough * rough;
  var irr = F.ambient.rgb;
  var spec = vec3f(0.0);
  let count = u32(F.screen.z);
  for (var i = 0u; i < count; i++) {
    let L = lights[i];
    let to = L.pos.xyz - v.world;
    let d = length(to);
    if (d > L.pos.w || d < 1e-3) { continue; }
    // The screen's own light sits on the glass; it doesn't light or mirror itself.
    if (distance(L.pos.xyz, Q.origin.xyz) < Q.normal.w) { continue; }
    let l = to / d;
    let ndl = dot(n, l);
    if (ndl <= 0.0) { continue; }
    let x = d / L.pos.w;
    let win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    let I = L.color.rgb * L.color.w * GAIN * win * win / max(d * d, 0.01);
    irr += I * ndl;
    let h = normalize(l + V);
    let wide = clamp(rough * rough + L.extra.z / (2.0 * max(d, 0.05)), 0.0, 1.0);
    let w2 = wide * wide;
    let energy = a2 / max(w2, 1e-6);
    spec += I * ggxD(max(dot(n, h), 0.0), w2) * energy * ndl * 0.25 / max(ndl * max(cosv, 1e-3), 0.05);
  }
  let fres = screenFresnel(max(cosv, 0.0));
  var room = F.ambient.rgb * 0.3;
  if (Q.roomMax.w > 0.5) {
    room = screenRoom(v.world, reflect(-V, n), Q.roomMin.xyz, Q.roomMax.xyz, Q.origin.xyz, Q.normal.xyz, Q.misc.x, F.ambient.rgb, Q.roomMin.w);
  }
  let glass = D.g0.y * irr / PI + fres * (room * D.g0.w * (1.0 - smudge * 0.5) + spec);
  return vec4f(c + glass, 1.0);
}
`

/**
 * The screen's glass as a kit `ScenePass` (opaque slot): a bulging faceplate gridded across the visible face, the
 * tube per pixel and the glass lit by the frame's own lights. Several quads can share one display (a wall of
 * monitors showing one feed); each encodes the display at most once a frame. Not for the kit's motion-blur velocity
 * attachment.
 */
export class ScreenQuadPass implements ScenePass {
  visible = true
  private readonly pipe: GPURenderPipeline
  private readonly reactivePipe: GPURenderPipeline
  private readonly uniform: GPUBuffer
  private readonly group: GPUBindGroup
  private readonly data = new Float32Array(QUAD_FLOATS)
  private readonly device: GPUDevice

  constructor(ctx: PassContext, readonly display: ScreenDisplay, placement: ScreenQuadOptions) {
    const d = this.device = ctx.device
    this.uniform = d.createBuffer({ label: "screen quad", size: QUAD_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const layout = d.createBindGroupLayout({ label: "screen quad", entries: [...ScreenDisplay.layoutEntries(0), { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    this.group = d.createBindGroup({ layout, entries: [...display.bindEntries(0), { binding: 3, resource: { buffer: this.uniform } }] })
    const module = d.createShaderModule({ label: "screen quad", code: SCREEN_QUAD_WGSL })
    const desc: GPURenderPipelineDescriptor = {
      label: "screen quad",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: true, depthCompare: ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples },
    }
    this.pipe = d.createRenderPipeline(desc)
    // The picture changes on its own: under temporal AA the resolve trusts the current frame on the glass.
    const coverage = d.createShaderModule({ label: "screen quad reactive", code: `${SCREEN_QUAD_WGSL}\n${REACTIVE_COVERAGE_WGSL.replace("fn fs(", "fn fsReactive(")}` })
    this.reactivePipe = d.createRenderPipeline(reactivePipelineDescriptor({ ...desc, vertex: { module: coverage, entryPoint: "vs" } }, { module: coverage, entryPoint: "fsReactive" }))
    this.place(placement)
  }

  /** Moves the glass (and the room it reflects). */
  place(p: ScreenQuadOptions): void {
    const nx = Math.cos(p.yaw), nz = Math.sin(p.yaw)
    // Right is the viewer's right when facing the glass.
    const right = [-nz, 0, nx]
    const s = this.display.settings
    const room = p.room
    this.data.set([p.center[0], p.center[1], p.center[2], p.width / 2], 0)
    this.data.set([right[0]!, right[1]!, right[2]!, p.height / 2], 4)
    this.data.set([0, 1, 0, s.bulge], 8)
    this.data.set([nx, 0, nz, Math.max(p.width, p.height) * 0.75], 12)
    this.data.set([room?.min[0] ?? 0, room?.min[1] ?? 0, room?.min[2] ?? 0, room?.albedo ?? 0.55], 16)
    this.data.set([room?.max[0] ?? 0, room?.max[1] ?? 0, room?.max[2] ?? 0, room ? 1 : 0], 20)
    this.data.set([p.width * p.height, 0, 0, 0], 24)
  }

  prepare(enc: GPUCommandEncoder): void {
    if (!this.visible) return
    this.data[11] = this.display.settings.bulge
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    this.display.encode(enc)
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.visible) return
    pass.setPipeline(this.pipe)
    pass.setBindGroup(1, this.group)
    pass.draw(GRID_X * GRID_Y * 6)
  }

  drawReactive(pass: GPURenderPassEncoder): void {
    if (!this.visible) return
    pass.setPipeline(this.reactivePipe)
    pass.setBindGroup(1, this.group)
    pass.draw(GRID_X * GRID_Y * 6)
  }

  dispose(): void {
    this.uniform.destroy()
  }
}

// ---------------------------------------------------------------- full screen

/**
 * The display filling the view, as a renderer final pass: the game's finished frame is the source, drawn through the
 * tube inside a dark bezel (a game played on a CRT; a cutscene seen on a monitor). Active while `enabled`. Call
 * `display.update(dt)` each frame as for quads.
 */
export class ScreenFinalPass implements FinalPass {
  enabled = false
  /** Bezel margin each side, as a fraction of the view (0 fills it edge to edge). */
  margin = 0.035
  private target: GPUTexture | null = null
  private readonly pipe: GPURenderPipeline
  private readonly uniform: GPUBuffer
  private group: GPUBindGroup | null = null

  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat, readonly display: ScreenDisplay) {
    const module = device.createShaderModule({ label: "screen full", code: FULLSCREEN_WGSL })
    this.pipe = device.createRenderPipeline({ label: "screen full", layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } })
    this.uniform = device.createBuffer({ label: "screen full", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  get active(): boolean {
    return this.enabled
  }

  source(width: number, height: number): GPUTextureView {
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.destroy()
      this.target = this.device.createTexture({ label: "screen full source", size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
      this.display.setSource({ texture: this.target })
      this.group = null
    }
    return this.target.createView()
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, _frame: Float32Array): void {
    if (!this.target) return
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.margin, this.target.width / this.target.height, this.target.width, this.target.height]))
    this.display.encode(encoder)
    this.group ??= this.device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [...this.display.bindEntries(0), { binding: 3, resource: { buffer: this.uniform } }] })
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    pass.setPipeline(this.pipe)
    pass.setBindGroup(0, this.group)
    pass.draw(3)
    pass.end()
  }

  dispose(): void {
    this.target?.destroy()
    this.uniform.destroy()
  }
}
