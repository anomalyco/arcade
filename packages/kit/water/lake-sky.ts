import { mat4 } from "wgpu-matrix"
import type { PassContext } from "../gpu/pass-graph"
import type { SkyPass, SkyFrame } from "../sky/pass"
import type { SkyAssets } from "../sky/assets"
import type { SkySettings } from "../sky/settings"
import { SKY_DEFAULTS } from "../sky/settings"
import { loadSkyResources } from "../sky/resources"

const CUBE_DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as const
const CUBE_UPS = [[0,-1,0],[0,-1,0],[0,0,1],[0,0,-1],[0,-1,0],[0,-1,0]] as const

/**
 * View-projection that renders WebGPU cube face `face` (+X, -X, +Y, -Y, +Z, -Z). WebGPU samples a face at
 * u = (sc/|ma| + 1)/2, v = (tc/|ma| + 1)/2 with v = 0 on the first (top) row, and a render target's first row is clip
 * y = +1. The look-at ups make clip x = sc and clip y = tc, so clip y is flipped to put tc = -1 on the first row.
 */
export function lakeCubeFace(face: number): Float32Array {
  const proj = mat4.scale(mat4.perspective(Math.PI / 2, 1, 0.1, 10), [1, -1, 1])
  return mat4.multiply(proj, mat4.lookAt([0, 0, 0], CUBE_DIRS[face]!, CUBE_UPS[face]!)) as Float32Array
}

/** Same production sky for the background and a cached HDR reflection cube.
 * The lunar disk is omitted from the cube: the lake integrates the moon's lux as its own specular lobe.
 * Allocates nothing until the moonlit lake asks for it; no catalogue load or sky pipeline until Physical is selected.
 */
export class LakeSky {
  private cubeTexture?: GPUTexture
  private cube?: SkyPass
  private assets?: SkyAssets
  private depth?: GPUTexture
  private faces: { group: GPUBindGroup; buffer: GPUBuffer; view: GPUTextureView }[] = []
  private pending?: Promise<void>
  private failure?: unknown
  private key = ""
  private dirty = false
  private frame: SkyFrame = { time: 0, sceneUnitsPerCdM2: 1 }
  private disposed = false
  private cubeSettings: SkySettings
  constructor(private ctx: PassContext, readonly settings: SkySettings) {
    this.cubeSettings = this.cubeSettingsFromHost()
  }
  get allocated() { return !!this.cubeTexture }
  /** The 256² × 6 HDR cube, created the first time the moonlit lake needs it. */
  acquire(): GPUTexture {
    this.cubeTexture ??= this.ctx.device.createTexture({ label: "Lake catalogue sky", size: [256,256,6], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    return this.cubeTexture
  }
  get active() { return !this.disposed && this.settings.skyMode === "physical" && !!this.cube }
  get ready() { return this.pending ?? Promise.resolve() }
  update(frame: SkyFrame, enabled: boolean) {
    this.frame = frame
    if (this.disposed || !enabled || this.settings.skyMode !== "physical") return
    if (!this.cube && !this.pending && !this.failure) {
      this.pending = this.load().catch(e => { this.failure = e; console.error("Lake sky load failed", e); throw e })
      void this.pending.catch(() => {})
    }
    const key = JSON.stringify([this.cubeSettingsFromHost(), Math.round((frame.darkAdaptation ?? 1) * 20)])
    if (key !== this.key) {
      this.key = key
      Object.assign(this.cubeSettings, this.cubeSettingsFromHost())
      this.cube?.update(this.frame)
      this.dirty = true
    }
  }
  private cubeSettingsFromHost(): SkySettings {
    // Select only sky fields: forest controls must not invalidate the six-face cache.
    return { ...Object.fromEntries(Object.keys(SKY_DEFAULTS).map(k => [k, this.settings[k as keyof SkySettings]])) as SkySettings, skyMoon: "none", skyScintillation: 0 }
  }
  private async load() {
    const [{ SkyPass }, assets] = await loadSkyResources(import("../sky/pass"), import("../sky/assets").then(m => m.acquireSkyAssets(this.ctx.device)))
    if (this.disposed) { assets.dispose(); return }
    this.assets = assets
    const d = this.ctx.device
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    this.cube = new SkyPass({ ...this.ctx, frameLayout: layout, samples: 1, depth: "depth24plus", depthClearValue: 1 }, assets, this.cubeSettings)
    this.depth = d.createTexture({ size: [256,256], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT })
    const texture = this.acquire()
    this.faces = CUBE_DIRS.map((_, i) => {
      const data = new Float32Array(52)
      data.set(lakeCubeFace(i))
      data.set([256,256,0,0],20)
      const buffer = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buffer,0,data)
      return { buffer, group: d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] }), view: texture.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 }) }
    })
    this.cube.update(this.frame); this.dirty = true
  }
  prepare(enc: GPUCommandEncoder) {
    if (!this.active || !this.cube || !this.depth || !this.dirty) return
    for (const face of this.faces) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: face.view, loadOp: "clear", storeOp: "store", clearValue: [0,0,0,1] }], depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 1 } })
      pass.setBindGroup(0,face.group); this.cube.draw(pass); pass.end()
    }
    this.dirty = false
  }
  dispose() { this.disposed = true; this.cube?.dispose(); this.assets?.dispose(); this.cubeTexture?.destroy(); this.depth?.destroy(); for (const f of this.faces) f.buffer.destroy() }
}
