import { MAX_LIGHTS, MAX_WALLS, POLAR_RAYS } from "../../shared/config"
import type { Rect } from "../../shared/geom"
import { polarShader, sceneShader } from "./shaders"

/** Instance layout: four vec4s per quad (centre+half, rot/mode/lit, colour, params). */
const INST_FLOATS = 16
const MAX_INST = 4096
const FRAME_FLOATS = 16
const LIGHT_FLOATS = 8
const SLOTS = MAX_LIGHTS + 1

export const MODE = { wall: 0, actor: 1, ring: 2, glow: 3, line: 4, dot: 5 } as const

export type Rgba = readonly [number, number, number, number]

/** Builds the instance data for one frame. Groups are drawn in order; additive groups blend with One/One. */
export class Instances {
  readonly data = new Float32Array(MAX_INST * INST_FLOATS)
  readonly groups: { add: boolean; start: number; count: number }[] = []
  n = 0

  begin(add: boolean): void {
    this.groups.push({ add, start: this.n, count: 0 })
  }

  reset(): void {
    this.n = 0
    this.groups.length = 0
  }

  /** Appends one quad. (cx, cy) centre, (hx, hy) half extents, rot in radians, mode is one of MODE, prm is per-mode. */
  quad(cx: number, cy: number, hx: number, hy: number, rot: number, mode: number, lit: boolean, col: Rgba, prm: readonly [number, number, number, number] = [0, 0, 0, 0]): void {
    if (this.n >= MAX_INST) return
    const g = this.groups[this.groups.length - 1]
    if (!g) return
    const o = this.n * INST_FLOATS
    const d = this.data
    d[o] = cx
    d[o + 1] = cy
    d[o + 2] = Math.max(0.001, hx)
    d[o + 3] = Math.max(0.001, hy)
    d[o + 4] = rot
    d[o + 5] = mode
    d[o + 6] = lit ? 1 : 0
    d[o + 7] = 0
    d[o + 8] = col[0]
    d[o + 9] = col[1]
    d[o + 10] = col[2]
    d[o + 11] = col[3]
    d[o + 12] = prm[0]
    d[o + 13] = prm[1]
    d[o + 14] = prm[2]
    d[o + 15] = prm[3]
    this.n++
    g.count++
  }

  /** A rectangle from its corners. */
  rect(r: Rect, mode: number, lit: boolean, col: Rgba): void {
    this.quad((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[2] - r[0]) / 2, (r[3] - r[1]) / 2, 0, mode, lit, col)
  }

  /** A line from a to b with a thickness, drawn as a tracer. prm[0] is the alpha. */
  line(ax: number, ay: number, bx: number, by: number, thick: number, col: Rgba, alpha: number): void {
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-4) return
    this.quad((ax + bx) / 2, (ay + by) / 2, len / 2, thick, Math.atan2(by - ay, bx - ax), MODE.line, false, col, [alpha, 0, 0, 0])
  }
}

export type LightIn = { x: number; y: number; r: number; power: number; color: readonly [number, number, number] }

/** Everything the renderer needs for one frame. */
export type RenderFrame = {
  cam: { x: number; y: number }
  ppm: number
  time: number
  ambient: number
  lights: readonly LightIn[]
  walls: readonly Rect[]
  /** The local player's line of sight, or null to see all lit space (spectators). */
  eye: { x: number; y: number } | null
  inst: Instances
}

/**
 * WebGPU scene renderer. Passes per frame: (1) a compute pass casts polar shadow rays per light and for the eye;
 * (2) the scene pass draws a lit floor, lit walls, glows, tracers, actors and ripples into an HDR texture;
 * (3) a composite pass applies vignette, grain and a tone curve onto the canvas.
 */
export class Renderer {
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private wallBuf: GPUBuffer
  private polarBuf: GPUBuffer
  private instBuf: GPUBuffer
  private scene: GPUTexture | null = null
  private sceneView: GPUTextureView | null = null
  private compBind: GPUBindGroup | null = null
  private polarPipe: GPUComputePipeline
  private floorPipe: GPURenderPipeline
  private alphaPipe: GPURenderPipeline
  private addPipe: GPURenderPipeline
  private compPipe: GPURenderPipeline
  private bgCompute: GPUBindGroup
  private bgScene: GPUBindGroup
  private bgFrame: GPUBindGroup
  private frameData = new Float32Array(FRAME_FLOATS)
  private lightData = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  private wallData = new Float32Array(MAX_WALLS * 4)
  readonly hdr: GPUTextureFormat = "rgba16float"

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    private format: GPUTextureFormat,
  ) {
    const d = device
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.lightBuf = d.createBuffer({ size: MAX_LIGHTS * LIGHT_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.wallBuf = d.createBuffer({ size: MAX_WALLS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.polarBuf = d.createBuffer({ size: SLOTS * POLAR_RAYS * 4, usage: GPUBufferUsage.STORAGE })
    this.instBuf = d.createBuffer({ size: MAX_INST * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })

    const compute = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    })
    const scene = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    })
    const frameOnly = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    const sceneTex = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }] })

    const polarMod = d.createShaderModule({ code: polarShader })
    const sceneMod = d.createShaderModule({ code: sceneShader })

    this.polarPipe = d.createComputePipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [compute] }), compute: { module: polarMod, entryPoint: "polarMain" } })

    const sceneLayout = d.createPipelineLayout({ bindGroupLayouts: [scene] })
    const hdrTarget: GPUColorTargetState = { format: this.hdr }
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } }
    const additive: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } }
    this.floorPipe = d.createRenderPipeline({
      layout: sceneLayout,
      vertex: { module: sceneMod, entryPoint: "floorVs" },
      fragment: { module: sceneMod, entryPoint: "floorFs", targets: [hdrTarget] },
      primitive: { topology: "triangle-list" },
    })
    const instVertex: GPUVertexState = {
      module: sceneMod,
      entryPoint: "instVs",
      buffers: [
        {
          arrayStride: INST_FLOATS * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32x4" },
            { shaderLocation: 3, offset: 48, format: "float32x4" },
          ],
        },
      ],
    }
    this.alphaPipe = d.createRenderPipeline({ layout: sceneLayout, vertex: instVertex, fragment: { module: sceneMod, entryPoint: "instFs", targets: [{ ...hdrTarget, blend: premul }] }, primitive: { topology: "triangle-list" } })
    this.addPipe = d.createRenderPipeline({ layout: sceneLayout, vertex: instVertex, fragment: { module: sceneMod, entryPoint: "instFs", targets: [{ ...hdrTarget, blend: additive }] }, primitive: { topology: "triangle-list" } })

    this.compPipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [frameOnly, sceneTex] }),
      vertex: { module: sceneMod, entryPoint: "compVs" },
      fragment: { module: sceneMod, entryPoint: "compFs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    })

    this.bgCompute = d.createBindGroup({
      layout: compute,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 2, resource: { buffer: this.wallBuf } },
        { binding: 3, resource: { buffer: this.polarBuf } },
      ],
    })
    this.bgScene = d.createBindGroup({
      layout: scene,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 2, resource: { buffer: this.polarBuf } },
      ],
    })
    this.bgFrame = d.createBindGroup({ layout: frameOnly, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] })
    this.resize()
  }

  /** Sizes the HDR scene texture to the canvas. Call after the canvas size changes. */
  resize(): void {
    const canvas = this.context.canvas as HTMLCanvasElement
    const w = Math.max(1, canvas.width)
    const h = Math.max(1, canvas.height)
    if (this.scene && this.scene.width === w && this.scene.height === h) return
    this.scene?.destroy()
    this.scene = this.device.createTexture({ size: [w, h], format: this.hdr, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.sceneView = this.scene.createView()
    this.compBind = this.device.createBindGroup({ layout: this.compPipe.getBindGroupLayout(1), entries: [{ binding: 0, resource: this.sceneView }] })
  }

  render(f: RenderFrame): void {
    const canvas = this.context.canvas as HTMLCanvasElement
    this.resize()
    const w = canvas.width
    const h = canvas.height
    const fd = this.frameData
    fd[0] = f.cam.x
    fd[1] = f.cam.y
    fd[2] = (2 * f.ppm) / w
    fd[3] = (-2 * f.ppm) / h
    fd[4] = w
    fd[5] = h
    fd[6] = f.eye?.x ?? 0
    fd[7] = f.eye?.y ?? 0
    fd[8] = f.eye ? 1 : 0
    fd[9] = f.time
    fd[10] = Math.min(MAX_LIGHTS, f.lights.length)
    fd[11] = Math.min(MAX_WALLS, f.walls.length)
    fd[12] = f.ambient
    this.device.queue.writeBuffer(this.frameBuf, 0, fd)

    const ld = this.lightData
    ld.fill(0)
    for (let i = 0; i < Math.min(MAX_LIGHTS, f.lights.length); i++) {
      const l = f.lights[i]!
      const o = i * LIGHT_FLOATS
      ld[o] = l.x
      ld[o + 1] = l.y
      ld[o + 2] = l.r
      ld[o + 3] = l.power
      ld[o + 4] = l.color[0]
      ld[o + 5] = l.color[1]
      ld[o + 6] = l.color[2]
    }
    this.device.queue.writeBuffer(this.lightBuf, 0, ld)

    const wd = this.wallData
    const nw = Math.min(MAX_WALLS, f.walls.length)
    for (let i = 0; i < nw; i++) {
      const r = f.walls[i]!
      wd[i * 4] = r[0]
      wd[i * 4 + 1] = r[1]
      wd[i * 4 + 2] = r[2]
      wd[i * 4 + 3] = r[3]
    }
    this.device.queue.writeBuffer(this.wallBuf, 0, wd, 0, nw * 4)

    const inst = f.inst
    if (inst.n > 0) this.device.queue.writeBuffer(this.instBuf, 0, inst.data.buffer, 0, inst.n * INST_FLOATS * 4)

    const enc = this.device.createCommandEncoder()
    const cp = enc.beginComputePass()
    cp.setPipeline(this.polarPipe)
    cp.setBindGroup(0, this.bgCompute)
    cp.dispatchWorkgroups(Math.ceil((SLOTS * POLAR_RAYS) / 64))
    cp.end()

    const sp = enc.beginRenderPass({
      colorAttachments: [{ view: this.sceneView!, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    })
    sp.setBindGroup(0, this.bgScene)
    sp.setPipeline(this.floorPipe)
    sp.draw(3)
    sp.setVertexBuffer(0, this.instBuf)
    for (const g of inst.groups) {
      if (g.count === 0) continue
      sp.setPipeline(g.add ? this.addPipe : this.alphaPipe)
      sp.setBindGroup(0, this.bgScene)
      sp.draw(6, g.count, 0, g.start)
    }
    sp.end()

    const cpass = enc.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    })
    cpass.setPipeline(this.compPipe)
    cpass.setBindGroup(0, this.bgFrame)
    cpass.setBindGroup(1, this.compBind!)
    cpass.draw(3)
    cpass.end()
    this.device.queue.submit([enc.finish()])
  }
}
