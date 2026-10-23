import { mat4 } from "wgpu-matrix"
import type { PassContext } from "../gpu/pass-graph"
import type { SkyPass, SkyFrame } from "../sky/pass"
import type { SkyAssets } from "../sky/assets"
import type { SkySettings } from "../sky/settings"
import { SKY_DEFAULTS } from "../sky/settings"
import { loadSkyResources } from "../sky/resources"

/** Same production sky for the background and a cached HDR reflection cube.
 * The lunar disk is omitted from the cube: lakeMoon integrates its lux separately.
 * No catalogue load or sky pipeline compilation until Physical is selected.
 */
export class LakeSky {
  readonly texture: GPUTexture
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
    this.texture = ctx.device.createTexture({ label: "Lake catalogue sky", size: [256,256,6], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
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
    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    // WebGPU cube faces: +X, -X, +Y, -Y, +Z, -Z; texture-v points down.
    const ups = [[0,-1,0],[0,-1,0],[0,0,1],[0,0,-1],[0,-1,0],[0,-1,0]]
    this.faces = dirs.map((dir, i) => {
      const data = new Float32Array(52)
      data.set(mat4.multiply(mat4.perspective(Math.PI/2,1,0.1,10), mat4.lookAt([0,0,0],dir,ups[i]!)))
      data.set([256,256,0,0],20)
      const buffer = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buffer,0,data)
      return { buffer, group: d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] }), view: this.texture.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 }) }
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
  dispose() { this.disposed = true; this.cube?.dispose(); this.assets?.dispose(); this.texture.destroy(); this.depth?.destroy(); for (const f of this.faces) f.buffer.destroy() }
}
