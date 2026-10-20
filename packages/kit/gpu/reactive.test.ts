import { describe, expect, test } from "bun:test"
import { ParticleRenderer } from "../fx/particle-renderer"
import { Particles, type ParticleSpec } from "../fx/particles"
import { SmokeTrail } from "../fx/smoke-trail"
import { SplatterRenderer } from "../fx/splatter-renderer"
import { SmokeRenderer } from "../fx/tyre-renderer"
import { WeatherRenderer, computeWeatherLod } from "../weather/renderer"
import { createWeatherSettings } from "../weather/settings"
import { WeatherSimulation } from "../weather/state"
import { PassList, type ScenePass } from "./pass-graph"
import { REACTIVE_FORMAT, REACTIVE_TARGET, reactivePipelineDescriptor } from "./reactive"

Object.assign(globalThis, {
  GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8, VERTEX: 32, STORAGE: 128 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 },
})

/** Records every pipeline descriptor; each pipeline object remembers its own. */
function fakeDevice() {
  const pipelines: GPURenderPipelineDescriptor[] = []
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createShaderModule: () => ({}),
    createPipelineLayout: () => ({}),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => {
      pipelines.push(desc)
      return { desc }
    },
    queue: { writeBuffer() {}, writeTexture() {} },
  } as unknown as GPUDevice
  return { device, pipelines }
}

/** A pass that keeps the pipeline and instance count of every draw. */
function fakePass() {
  let pipeline: GPURenderPipelineDescriptor | null = null
  const draws: { desc: GPURenderPipelineDescriptor; instances: number; first: number }[] = []
  const pass = {
    setPipeline: (p: { desc: GPURenderPipelineDescriptor }) => (pipeline = p.desc),
    setBindGroup() {},
    setVertexBuffer() {},
    draw: (_v: number, instances = 1, _fv = 0, first = 0) => draws.push({ desc: pipeline!, instances, first }),
  } as unknown as GPURenderPassEncoder
  return { pass, draws }
}

const isReactive = (desc: GPURenderPipelineDescriptor) => {
  const targets = [...desc.fragment!.targets]
  return !desc.depthStencil && (desc.multisample?.count ?? 1) === 1 && targets.length === 1 && targets[0]!.format === REACTIVE_FORMAT
}

describe("temporal reactive mask (AR-72)", () => {
  test("a reactive twin keeps the stages and drops depth, MSAA and the HDR targets", () => {
    const module = {} as GPUShaderModule
    const desc: GPURenderPipelineDescriptor = {
      label: "fx",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }, { format: "rgba16float", writeMask: 0 }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
      multisample: { count: 4, alphaToCoverageEnabled: true },
    }
    const twin = reactivePipelineDescriptor(desc)
    expect(isReactive(twin)).toBe(true)
    expect(twin.fragment!.targets).toEqual([REACTIVE_TARGET])
    expect(twin.vertex).toBe(desc.vertex)
    expect(twin.fragment!.entryPoint).toBe("fs")
    expect(twin.primitive).toEqual(desc.primitive)
    expect(reactivePipelineDescriptor(desc, { module, entryPoint: "cover" }).fragment!.entryPoint).toBe("cover")
  })

  test("kit particles (fire, smoke, sparks, debris) redraw into the mask", () => {
    const { device } = fakeDevice()
    const r = new ParticleRenderer(device)
    const p = new Particles()
    const spark: ParticleSpec = { kind: "spark", life: 1, size: 0.1, growth: 0, gravity: 0, drag: 0, bounce: 0, r: 1, g: 0.6, b: 0.2, alpha: 1 }
    for (let i = 0; i < 3; i++) p.spawn(spark, i, 1, 0, 0, 1, 0, i)
    r.upload(p)
    const { pass, draws } = fakePass()
    r.drawReactive(pass)
    expect(draws.length).toBe(1)
    expect(draws[0]!.instances).toBe(p.count)
    expect(isReactive(draws[0]!.desc)).toBe(true)
  })

  test("rain streaks, splashes, drips and mist redraw into the mask", () => {
    const { device } = fakeDevice()
    const r = new WeatherRenderer(device)
    const empty = fakePass()
    r.drawReactive(empty.pass)
    expect(empty.draws.length).toBe(0)
    Object.assign(r, { nearCount: 40, farCount: 20, splashCount: 5, dripCount: 2, mistCount: 3 })
    const { pass, draws } = fakePass()
    r.drawReactive(pass)
    expect(draws.map((d) => d.instances)).toEqual([3, 7, 40, 20])
    expect(draws.every((d) => isReactive(d.desc))).toBe(true)
  })

  test("splatter redraws only the drops in flight, not the decals", () => {
    const { device } = fakeDevice()
    const r = new SplatterRenderer(device)
    Object.assign(r, { count: 9, decalCount: 6 })
    const { pass, draws } = fakePass()
    r.drawReactive(pass)
    expect(draws).toEqual([{ desc: draws[0]!.desc, instances: 3, first: 6 }])
    expect(isReactive(draws[0]!.desc)).toBe(true)
    Object.assign(r, { count: 6 })
    const decalsOnly = fakePass()
    r.drawReactive(decalsOnly.pass)
    expect(decalsOnly.draws.length).toBe(0)
  })

  test("tyre smoke and dust billows redraw into the mask", () => {
    const { device } = fakeDevice()
    const r = new SmokeRenderer(device, {} as GPUBindGroupLayout, "")
    const trail = new SmokeTrail()
    trail.drawn = 4
    r.upload(trail, true)
    const { pass, draws } = fakePass()
    r.drawReactive(pass)
    expect(draws.length).toBe(1)
    expect(draws[0]!.instances).toBe(4)
    expect(isReactive(draws[0]!.desc)).toBe(true)
  })

  test("scene-pass plugins opt in with drawReactive", () => {
    const list = new PassList()
    const drew: string[] = []
    const plain: ScenePass = { draw() {} }
    const motes: ScenePass = { draw() {}, drawReactive: () => drew.push("motes") }
    list.add("alpha", plain)
    list.add("alpha", motes)
    list.add("opaque", { draw() {}, drawReactive: () => drew.push("opaque") })
    list.drawReactiveSlot("alpha", {} as GPURenderPassEncoder)
    expect(drew).toEqual(["motes"])
  })

  test("under TAA rain takes the renderer's jittered camera and internal size; density keeps the canvas width", () => {
    const { device } = fakeDevice()
    const r = new WeatherRenderer(device)
    const settings = createWeatherSettings("rain")
    const state = new WeatherSimulation().state
    const viewProj = Array.from({ length: 16 }, (_, i) => i)
    const input = { settings, state, viewProj, eye: [0, 30, 0], viewportWidth: 3456, viewportHeight: 1894 }
    const u = (r as unknown as { uniformData: Float32Array }).uniformData
    r.prepare(input)
    expect(Array.from(u.subarray(0, 16))).toEqual(viewProj)
    expect(Array.from(u.subarray(24, 26))).toEqual([3456, 1894])
    const today = { near: r.nearCount, intensity: u[63] }
    const jittered = viewProj.map((v) => v + 0.5)
    r.prepare(input, { viewProj: jittered, width: 2316, height: 1269 })
    expect(Array.from(u.subarray(0, 16))).toEqual(jittered)
    expect(Array.from(u.subarray(24, 26))).toEqual([2316, 1269])
    expect(r.nearCount).toBe(computeWeatherLod(settings, 34, false, 3456).nearCount)
    expect({ near: r.nearCount, intensity: u[63] }).toEqual(today)
  })
})
