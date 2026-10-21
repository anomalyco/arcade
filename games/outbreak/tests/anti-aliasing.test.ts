import { describe, expect, test } from "bun:test"
import {
  AA_MSAA,
  AA_TAA,
  AA_TAA_UPSCALE,
  DEFAULT_ANTI_ALIASING_SETTINGS,
  temporalSettings,
} from "../src/anti-aliasing/settings"

/** Anything: every property is another stub, calling one returns a stub, assignments are kept. */
function stub(): any {
  const fn = () => {}
  return new Proxy(fn, {
    get: (t, k) => (k in t ? (t as any)[k] : ((t as any)[k] = stub())),
    apply: () => stub(),
  })
}

describe("anti-aliasing settings (AR-72)", () => {
  test("MSAA (today) is one setting away and maps to the renderer's off state", () => {
    expect(temporalSettings({ ...DEFAULT_ANTI_ALIASING_SETTINGS, aaMode: AA_MSAA })).toBeNull()
    expect(temporalSettings({ ...DEFAULT_ANTI_ALIASING_SETTINGS, aaMode: AA_TAA })?.mode).toBe("taa")
    const up = temporalSettings({ ...DEFAULT_ANTI_ALIASING_SETTINGS, aaMode: AA_TAA_UPSCALE, aaRenderScale: 0.6 })
    expect(up).toEqual({ mode: "taau", renderScale: 0.6, sharpen: DEFAULT_ANTI_ALIASING_SETTINGS.aaSharpen, history: DEFAULT_ANTI_ALIASING_SETTINGS.aaHistory })
  })

  test("Restart, New town and regenerate drop the TAA history (no blend into the last town)", async () => {
    const { OutbreakFrameRenderer } = await import("../src/scene/frame-renderer")
    let resets = 0
    const self = stub()
    self.renderer = { resetTemporalHistory: () => resets++ }
    self.host.session = () => ({ view: { player: { x: 1, y: 2 } } })
    OutbreakFrameRenderer.prototype.resetForSession.call(self, 7)
    expect(resets).toBe(1)
    OutbreakFrameRenderer.prototype.resetForRegenerate.call(self)
    expect(resets).toBe(2)
  })

  test("beam dust motes redraw into the reactive mask", async () => {
    const { DustPass } = await import("../src/air/dust")
    Object.assign(globalThis, {
      GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 },
      GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    })
    const descs: GPURenderPipelineDescriptor[] = []
    const device = {
      createBuffer: () => ({}),
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createShaderModule: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: (d: GPURenderPipelineDescriptor) => (descs.push(d), { d }),
      queue: { writeBuffer() {} },
    } as unknown as GPUDevice
    const dust = new DustPass({ device, frameLayout: {} as GPUBindGroupLayout, color: "rgba16float", depth: "depth24plus", samples: 4 })
    const draws: { d: GPURenderPipelineDescriptor; n: number }[] = []
    let current: GPURenderPipelineDescriptor | null = null
    const pass = {
      setPipeline: (p: { d: GPURenderPipelineDescriptor }) => (current = p.d),
      setBindGroup() {},
      draw: (_v: number, n: number) => draws.push({ d: current!, n }),
    } as unknown as GPURenderPassEncoder
    dust.frame(3, "high", true)
    dust.drawReactive(pass)
    expect(draws.length).toBe(1)
    expect(draws[0]!.n).toBeGreaterThan(0)
    expect(draws[0]!.d.depthStencil).toBeUndefined()
    expect([...draws[0]!.d.fragment!.targets][0]!.format).toBe("rgba8unorm")
  })
})
