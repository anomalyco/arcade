import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { REACTIVE_COVERAGE_WGSL } from "../reactive"
import { SceneLights } from "../scene-frame"
import { panelCone, panelIrradiance, type PanelEmitter } from "../lights/panel"
import { physicalLightHooks } from "../lights/physical"
import { makeSceneShader } from "../shaders"
import { SCREEN_QUAD_WGSL } from "./display"
import { halfToFloat, screenBounceSource, ScreenLightProbe, screenSceneLight, type ScreenEmitter } from "./light"
import { applyScreenPreset, coverFit, createScreenDisplaySettings, degaussEnvelope, DISPLAY_UNIFORM_FLOATS, packDisplayUniform, persistenceDecay, screenDisplayControls, ScreenPower, SCREEN_DISPLAY_DEFAULTS, SCREEN_PRESETS } from "./settings"
import { BLIT_WGSL, FULLSCREEN_WGSL, MIP_WGSL, SIGNAL_WGSL } from "./wgsl"

describe("screen shaders", () => {
  test("signal, mip, VHS input, full screen and the kit quad validate", () => {
    for (const code of [SIGNAL_WGSL, MIP_WGSL, BLIT_WGSL, FULLSCREEN_WGSL, SCREEN_QUAD_WGSL, `${SCREEN_QUAD_WGSL}\n${REACTIVE_COVERAGE_WGSL.replace("fn fs(", "fn fsReactive(")}`]) validateWgsl(code)
  })

  test("the kit scene shader compiles upright panels beside downward ones", () => {
    validateWgsl(makeSceneShader({ ...physicalLightHooks({ panel: true, rect: true, spotShadows: true }), lampGrid: false }, false))
    validateWgsl(makeSceneShader({ ...physicalLightHooks({ panel: true }), lampGrid: false }, false))
  })
})

type Vec3 = readonly [number, number, number]
/** Midpoint quadrature over the panel's area, with both cosines. */
function reference(center: Vec3, p: PanelEmitter, at: Vec3, n: Vec3) {
  const size = 160, nz: Vec3 = [Math.cos(p.yaw), 0, Math.sin(p.yaw)], u: Vec3 = [-nz[2], 0, nz[0]]
  let sum = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = ((x + 0.5) / size * 2 - 1) * p.halfWidth, b = ((y + 0.5) / size * 2 - 1) * p.halfHeight
    const d = [center[0] + u[0] * a - at[0], center[1] + b - at[1], center[2] + u[2] * a - at[2]]
    const d2 = d.reduce((s, v) => s + v * v, 0)
    const cosE = Math.max(-(d[0]! * nz[0] + d[2]! * nz[2]), 0)
    sum += cosE * Math.max(d[0]! * n[0] + d[1]! * n[1] + d[2]! * n[2], 0) / (d2 * d2)
  }
  return sum / (size * size)
}

describe("upright panel light", () => {
  test("diffuse agrees with area integration in front, off-axis and clipped by the horizon", () => {
    const center: Vec3 = [0, 1.2, 0], panel = { halfWidth: 0.2, halfHeight: 0.15, yaw: 0.3 }
    const cases: [Vec3, Vec3][] = [[[2, 0, 0.6], [0, 1, 0]], [[1.5, 1.2, 0.4], [-1, 0, 0]], [[0.6, 0.3, -0.9], [0, 0, 1]], [[0.3, 1.25, 0.05], [0, 1, 0]], [[3, 2.8, 1], [0, -1, 0]]]
    for (const [p, n] of cases) {
      const exact = panelIrradiance(center, panel, p, n), numeric = reference(center, panel, p, n)
      expect(Math.abs(exact - numeric)).toBeLessThan(Math.max(1e-5, numeric * 0.002))
    }
    // Behind the screen: nothing. Far on-axis: cos·cos/d² per unit intensity.
    expect(panelIrradiance(center, panel, [-1, 1, 0], [1, 0, 0])).toBe(0)
    const far = 80
    expect(panelIrradiance(center, panel, [Math.cos(0.3) * far, 1.2, Math.sin(0.3) * far], [-Math.cos(0.3), 0, -Math.sin(0.3)]) * far * far).toBeCloseTo(1, 3)
  })

  test("packs its own cone tag and rejects bad sizes", () => {
    const lights = new SceneLights()
    lights.update([{ id: 9, x: 0, y: 0, h: 1.2, r: 6, color: [1, 1, 1], power: 1, panel: { halfWidth: 0.2, halfHeight: 0.15, yaw: 1 } }], [])
    expect(Array.from(lights.lights.subarray(8, 12))).toEqual([Math.fround(0.2), Math.fround(0.15), 1, -4])
    for (const x of [0, -1, NaN]) expect(() => panelCone({ halfWidth: x, halfHeight: 0.1, yaw: 0 })).toThrow()
  })

  test("hooks without panels are unchanged", () => {
    expect(physicalLightHooks({ rect: true }).diffuseTerm).not.toContain("panel")
    expect(physicalLightHooks().declarations).not.toContain("panelIrradiance")
  })
})

describe("power", () => {
  test("a CRT opens from a line and collapses to a cooling dot; nothing jumps when interrupted", () => {
    const p = new ScreenPower(false)
    p.set(true, 0)
    const early = p.sample(0.1)
    expect(early.rasterY).toBeLessThan(0.5)
    expect(early.rasterX).toBeGreaterThan(early.rasterY)
    const on = p.sample(3)
    expect(on.rasterX).toBeCloseTo(1, 3)
    expect(on.rasterY).toBeCloseTo(1, 3)
    expect(on.level).toBeGreaterThan(0.98)
    p.set(false, 3)
    expect(p.sample(3.1).rasterY).toBeLessThan(0.05)
    const dot = p.sample(3.25)
    expect(dot.rasterX).toBeLessThan(0.05)
    expect(dot.dot).toBeGreaterThan(0.5)
    // Cools, never cuts: the dot fades over the next second.
    expect(p.sample(3.6).dot).toBeGreaterThan(0.1)
    expect(p.sample(5).dot).toBeLessThan(0.02)
    // Switch back on mid-collapse: continuous at the switch.
    const before = p.sample(3.12)
    p.set(true, 3.12)
    const after = p.sample(3.12)
    expect(Math.abs(after.rasterY - before.rasterY)).toBeLessThan(1e-6)
    expect(Math.abs(after.level - before.level)).toBeLessThan(1e-6)
  })

  test("LCD and reduced motion fade without a collapse", () => {
    const p = new ScreenPower(true)
    p.set(false, 0, "lcd")
    const mid = p.sample(0.1, "lcd")
    expect(mid.rasterY).toBe(1)
    expect(mid.level).toBeGreaterThan(0)
    expect(mid.level).toBeLessThan(1)
    expect(p.sample(0.3, "lcd").level).toBe(0)
    expect(degaussEnvelope(0.1, true).wobble).toBe(0)
    expect(degaussEnvelope(0.1, true).purity).toBeGreaterThan(0)
    expect(degaussEnvelope(5).purity).toBe(0)
  })

  test("afterglow decays per channel, red slowest; off at zero", () => {
    const [r, g, b] = persistenceDecay(0.5, 1 / 60)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(persistenceDecay(0, 1 / 60)).toEqual([0, 0, 0])
  })
})

describe("settings", () => {
  test("presets reset the look but keep power and the light; controls bind real defaults", () => {
    const s = createScreenDisplaySettings({ power: false, light: 2 })
    expect(applyScreenPreset(s, "lcd")).toBe(true)
    expect(s.kind).toBe("lcd")
    expect(s.power).toBe(false)
    expect(s.light).toBe(2)
    applyScreenPreset(s, "tv")
    expect(s.kind).toBe("crt")
    expect(applyScreenPreset(s, "nope")).toBe(false)
    for (const id of Object.keys(SCREEN_PRESETS)) for (const k of Object.keys(SCREEN_PRESETS[id]!.values)) expect(k in SCREEN_DISPLAY_DEFAULTS).toBe(true)
    for (const c of screenDisplayControls({ onDegauss: () => {} })) {
      if (c.type === "action") continue
      const field = c.field as keyof typeof SCREEN_DISPLAY_DEFAULTS
      expect(field in SCREEN_DISPLAY_DEFAULTS).toBe(true)
      if ("min" in c) {
        const v = SCREEN_DISPLAY_DEFAULTS[field] as number
        expect(v).toBeGreaterThanOrEqual(c.min)
        expect(v).toBeLessThanOrEqual(c.max)
      }
    }
  })

  test("cover fit crops the long side; the uniform is the declared size", () => {
    expect(coverFit(1920, 1080, 4 / 3)).toEqual([0.75, 1, 0.125, 0])
    const [, ky] = coverFit(480, 640, 4 / 3)
    expect(ky).toBeCloseTo(0.5625, 6)
    const out = packDisplayUniform(createScreenDisplaySettings(), {
      time: 1, dt: 1 / 60, power: { rasterX: 1, rasterY: 1, level: 1, dot: 0 }, degauss: { wobble: 0, purity: 0 }, degaussTime: 9,
      signalWidth: 640, signalHeight: 480, sourceLinear: false, fit: [1, 1, 0, 0], aspect: 4 / 3, light: [0.1, 0.2, 0.3],
    })
    expect(out.length).toBe(DISPLAY_UNIFORM_FLOATS)
    expect(out[3]).toBeCloseTo(SCREEN_DISPLAY_DEFAULTS.brightness, 5)
  })
})

describe("screen light", () => {
  const emitter = (rgb: [number, number, number]): ScreenEmitter => ({ settings: createScreenDisplaySettings(), emission: () => rgb })
  const at = { center: [1, 1.2, 2] as const, yaw: Math.PI / 2, width: 0.4, height: 0.3 }

  test("a panel of radiance L and area A has on-axis intensity L·A; dark screens give no light", () => {
    const l = screenSceneLight(emitter([2, 1, 0.5]), at)!
    expect(l.panel).toEqual({ halfWidth: 0.2, halfHeight: 0.15, yaw: Math.PI / 2 })
    expect(l.color).toEqual([1, 0.5, 0.25])
    expect(l.power * 5).toBeCloseTo(2 * 0.12, 6)
    expect([l.x, l.y, l.h]).toEqual([1, 2, 1.2])
    expect(screenSceneLight(emitter([0, 0, 0]), at)).toBeNull()
    const spot = screenSceneLight(emitter([1, 1, 1]), at, { shape: "spot" })!
    expect(spot.spot?.axis[1]).toBe(0)
    expect(screenSceneLight(emitter([1, 1, 1]), at, { model: "today" })!.cone?.[1]).toBeCloseTo(1, 6)
  })

  test("probe averages the readback and reports its balance; bounce scale follows emission", () => {
    const probe = new ScreenLightProbe()
    let calls = 0
    probe.subscribe(() => calls++)
    probe.push(new Float32Array([1, 1, 1, 0, 0, 0]), 2, 1)
    expect(probe.average).toEqual([0.5, 0.5, 0.5])
    expect(probe.balance()).toBeCloseTo(-1, 6)
    expect(calls).toBe(1)
    const e: [number, number, number] = [1, 1, 1]
    const bounce = screenBounceSource(emitter(e), 4, 2)
    expect(bounce.scale()).toBeCloseTo(0.5, 6)
    e[0] = e[1] = e[2] = 4
    expect(bounce.scale()).toBeCloseTo(2, 6)
  })

  test("a cool picture lights in its own colour at full strength, in direct light and baked bounce alike", () => {
    // The sea show's average: dark navy to steel blue, its luminance a third of its blue.
    const sea: [number, number, number] = [0.011, 0.145, 0.39]
    const direct = screenSceneLight(emitter(sea), at)!
    const bounce = screenBounceSource(emitter(sea), 4, 1)
    for (let c = 0; c < 3; c++) {
      expect(direct.color[c]! * direct.power * 5 / 0.12).toBeCloseTo(sea[c]!, 6)
      expect(bounce.color()[c]! * bounce.scale()).toBeCloseTo(sea[c]!, 6)
    }
  })

  test("half floats decode", () => {
    expect(halfToFloat(0x3c00)).toBe(1)
    expect(halfToFloat(0x3800)).toBe(0.5)
    expect(halfToFloat(0)).toBe(0)
    expect(halfToFloat(0xc000)).toBe(-2)
  })
})
