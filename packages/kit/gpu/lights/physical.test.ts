import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { LIGHT_FLOATS } from "../../limits"
import { SceneLights } from "../scene-frame"
import { makeSceneShader } from "../shaders"
import {
  PHYSICAL_LIGHT_DEFAULTS,
  envBRDF,
  envBRDFReference,
  falloff,
  ggxD,
  packPhysicalLightKnobs,
  physicalCone,
  physicalLightControls,
  physicalLightHooks,
  withPhysicalLights,
} from "./physical"

describe("BRDF", () => {
  test("GGX D is normalised: ∫ D(h) n·h dω = 1", () => {
    for (const a of [0.05, 0.2, 0.5, 1]) {
      const a2 = a * a
      let sum = 0
      const n = 20000
      for (let i = 0; i < n; i++) {
        // Integrate over cosθ with dω = 2π d(cosθ); stratify densely near cosθ = 1 for sharp lobes.
        const u = (i + 0.5) / n
        const c = 1 - u * u
        const dc = (2 * u) / n
        sum += ggxD(c, a2) * c * 2 * Math.PI * dc
      }
      expect(sum).toBeCloseTo(1, 2)
    }
  })

  test("the fitted environment BRDF tracks the importance-sampled split sum", () => {
    let worst = 0
    for (const f0 of [0.04, 0.5, 1]) {
      for (const rough of [0.1, 0.25, 0.5, 0.75, 1]) {
        for (const nv of [0.05, 0.2, 0.5, 0.8, 1]) {
          const ref = envBRDFReference(f0, rough, Math.min(nv, 0.999), 2048)
          worst = Math.max(worst, Math.abs(envBRDF(f0, rough, nv) - ref))
        }
      }
    }
    // Fit worst 0.06 over its grid; Karis' mobile fit misses metals by up to 0.4.
    expect(worst).toBeLessThan(0.08)
  })
})

describe("light shape", () => {
  test("windowed inverse square: 1/d² near, zero at range, finite at the fixture", () => {
    expect(falloff(1, 40, 0.1) * 1).toBeCloseTo(1, 3)
    expect(falloff(4, 40, 0.1) * 16).toBeGreaterThan(0.99)
    expect(falloff(40, 40, 0.1)).toBe(0)
    expect(falloff(41, 40, 0.1)).toBe(0)
    expect(falloff(0, 40, 0.3)).toBeCloseTo(1 / 0.09, 3)
    let prev = Infinity
    for (let d = 0.5; d < 40; d += 0.5) {
      const v = falloff(d, 40, 0.3)
      expect(v).toBeLessThanOrEqual(prev)
      prev = v
    }
  })

  test("spot cones pack into Light.cone and the scene frame", () => {
    expect(physicalCone([0, -1, 0], 0.45, 0.88)).toEqual([0, 0, 0.45, 3.88])
    expect(() => physicalCone([0, 1, 0], 0.45, 0.88)).toThrow()
    expect(() => physicalCone([0, -1, 0], 0.9, 0.5)).toThrow()
    const lights = new SceneLights()
    lights.update([{ x: 1, y: 2, h: 6, r: 40, color: [1, 0.5, 0.2], power: 3, spot: { axis: [0, -2, 0], cosOuter: 0.45, cosInner: 0.88 } }], [])
    expect(Array.from(lights.lights.subarray(8, 12)).map((v) => +v.toFixed(4))).toEqual([0, 0, 0.45, 3.88])
    expect(lights.lights[LIGHT_FLOATS + 11]).toBe(0)
  })
})

describe("settings", () => {
  test("Today is the first row and the default", () => {
    const rows = physicalLightControls()
    expect(rows[0]).toMatchObject({ key: "model", type: "select" })
    expect(PHYSICAL_LIGHT_DEFAULTS.model).toBe("today")
    for (const r of rows) if ("min" in r) expect(r.min).toBeLessThanOrEqual(PHYSICAL_LIGHT_DEFAULTS[r.key as "spill"] as number)
    expect(physicalLightControls("Light", "light.")[1]).toMatchObject({ key: "light.envSpecular", field: "envSpecular" })
    expect(Array.from(packPhysicalLightKnobs({ ...PHYSICAL_LIGHT_DEFAULTS, spill: 0.02 }))).toEqual([1, 1, 1, Math.fround(0.02)])
  })
})

describe("WGSL validates with naga", () => {
  const lotLike = {
    lampGrid: false,
    declarations: "struct Night { fog: vec4f, look: vec4f, light: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;",
    bounce: "vec3f(0.0)",
    directional: "vec3f(0.0)",
    material: "if (mat == 20) { pbrRough = 0.3; pbrMetal = 0.0; }",
  }
  const sources: Record<string, string> = {
    "kit scene, physical": makeSceneShader({ ...physicalLightHooks(), lampGrid: true }, true),
    "kit scene, physical, motion": makeSceneShader({ ...physicalLightHooks({ settings: { spill: 0.05 } }), lampGrid: true }, true, true),
    "lot-like, composed": makeSceneShader(withPhysicalLights(lotLike, { knobs: "N.light", env: "mix(vec3f(0.01, 0.04, 0.04), ambientAt(n), rough * rough)" })),
    "lot-like, beam uniform and spot shadows": makeSceneShader(withPhysicalLights(lotLike, { knobs: "N.light", beam: { a: "N.fog", b: "N.look" }, spotShadows: true })),
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      validateWgsl(code)
    })
  }
})
