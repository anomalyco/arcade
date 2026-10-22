import { compileShaderModuleWithLog, type PassContext, type ScenePass } from "../gpu/pass-graph"
import { magnitudeLux, moonPhaseGain, temperatureRgb } from "./astronomy"
import type { SkyAssets } from "./assets"
import { equatorialBasis, moonLight, sunDirection } from "./model"
import type { SkySettings } from "./settings"
import { skyShader } from "./shaders"

export type SkyFrame = {
  /** Monotonic simulation seconds. Only scintillation uses this; the astronomical clock is in settings. */
  time: number
  /** Explicit host calibration, linear scene radiance per cd/m². Never includes current exposure. */
  sceneUnitsPerCdM2: number
  skyFlashRadiance?: readonly [number, number, number]
}

/** One camera-relative HDR background, then energy-normalized catalogue stars. Clouds compose after this pass. */
export class SkyPass implements ScenePass {
  private readonly uniform: GPUBuffer
  private readonly instances: GPUBuffer
  private readonly bind: GPUBindGroup
  private readonly dome: GPURenderPipeline
  private readonly stars: GPURenderPipeline
  private readonly data = new Float32Array(44)
  private enabled = false
  private clock = ""
  private readonly count: number
  constructor(private readonly ctx: PassContext, assets: SkyAssets, readonly settings: SkySettings) {
    const d = ctx.device
    this.uniform = d.createBuffer({ label: "Sky radiometry", size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const packed = new Float32Array(assets.stars.length * 8)
    const colours = new Map<number, readonly [number, number, number]>()
    assets.stars.forEach((s, i) => {
      let rgb = colours.get(s.temperature)
      if (!rgb) { rgb = temperatureRgb(s.temperature); colours.set(s.temperature, rgb) }
      const e = magnitudeLux(s.magnitude)
      packed.set([Math.cos(s.dec)*Math.cos(s.ra), Math.cos(s.dec)*Math.sin(s.ra), Math.sin(s.dec), s.magnitude, rgb[0]*e, rgb[1]*e, rgb[2]*e, s.id], i*8)
    })
    this.count = assets.stars.length
    this.instances = d.createBuffer({ label: "Yale stars", size: packed.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.instances, 0, packed)
    const layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] })
    this.bind = d.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: assets.moon.createView() },
      { binding: 2, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat" }) },
    ] })
    const module = compileShaderModuleWithLog(d, skyShader, "Shared night sky")
    const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] })
    const base = { layout: pipelineLayout, primitive: { topology: "triangle-list" as const }, multisample: { count: ctx.samples }, depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "always" as const } }
    this.dome = d.createRenderPipeline({ ...base, label: "Sky atmosphere and moon", vertex: { module, entryPoint: "domeVertex" }, fragment: { module, entryPoint: "domeFragment", targets: [{ format: ctx.color }] } })
    this.stars = d.createRenderPipeline({ ...base, label: "Catalogue stars", vertex: { module, entryPoint: "starVertex", buffers: [{ arrayStride: 32, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32" }, { shaderLocation: 2, offset: 16, format: "float32x3" }, { shaderLocation: 3, offset: 28, format: "float32" }] }] }, fragment: { module, entryPoint: "starFragment", targets: [{ format: ctx.color, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE, blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } } }] } })
  }
  update(frame: SkyFrame): void {
    const s = this.settings, u = this.data
    this.enabled = s.skyMode === "physical"
    if (!this.enabled) return
    if (!Number.isFinite(frame.sceneUnitsPerCdM2) || frame.sceneUnitsPerCdM2 <= 0) throw new Error("Sky requires a positive sceneUnitsPerCdM2 calibration")
    const clock = [s.skyYear,s.skyDay,s.skyHour,s.skyLatitude,s.skyLongitude].join(":")
    if (clock !== this.clock) {
      equatorialBasis(s).forEach((axis, i) => u.set(axis, i*4))
      u.set(sunDirection(s),24)
      this.clock = clock
    }
    u[3] = s.skyStars
    const moon = moonLight(s), [x,y,z] = moon.direction
    const r = Math.hypot(x,z)
    const right: [number,number,number] = r > 1e-8 ? [-z/r,0,x/r] : [1,0,0]
    const up = [y*right[2],z*right[0]-x*right[2],-y*right[0]]
    u.set(moon.direction,12); u[15] = moon.illuminanceLux
    u.set(right,16); u.set(up,20)
    u.set([frame.sceneUnitsPerCdM2,s.skyExtinction,frame.time,s.skyScintillation],28)
    u.set([s.skyMilkyWay,s.skyAirglow,s.skyZodiacal,s.skyHaze],32)
    // NASA's contrast-adjusted map is not measured albedo (mean linear RGB 0.319).
    const phase = moon.phaseAngle
    const norm = phaseNormalization(phase)
    const solidAngle = 2*Math.PI*(1-Math.cos(moon.angularRadius))
    u.set([phase,s.skyMoonLux*norm/(solidAngle*0.319),s.skyMoonEarthshine,s.skyMoon === "none" ? 0 : 1],36)
    u.set(frame.skyFlashRadiance ?? [0,0,0],40); u[43] = this.ctx.depthClearValue ?? 1
    this.ctx.device.queue.writeBuffer(this.uniform,0,u)
  }
  draw(pass: GPURenderPassEncoder): void {
    if (!this.enabled) return
    pass.setBindGroup(1,this.bind)
    pass.setPipeline(this.dome); pass.draw(3)
    if (this.settings.skyStars > 0) { pass.setPipeline(this.stars); pass.setVertexBuffer(0,this.instances); pass.draw(6,this.count) }
  }
  dispose(): void { this.uniform.destroy(); this.instances.destroy() }
}

// Integral of the Lommel–Seeliger disk divided by the full-disk value, calibrated to the phase-magnitude law.
const phaseCache = new Map<number,number>()
function phaseNormalization(phase: number): number {
  const cached = phaseCache.get(phase)
  if (cached !== undefined) return cached
  let sum = 0, count = 0
  for (let y = -63; y < 64; y += 2) for (let x = -63; x < 64; x += 2) {
    const a = x/64, b = y/64, z2 = 1-a*a-b*b
    if (z2 <= 0) continue
    const z = Math.sqrt(z2), lit = Math.max(0,a*Math.sin(phase)+z*Math.cos(phase))
    sum += lit/(lit+z); count++
  }
  const result = moonPhaseGain(phase)/(sum/count)
  phaseCache.set(phase,result)
  return result
}
