import { describe, expect, test } from "bun:test"
import { validateWgsl } from "./test-naga"
import { mat4 } from "wgpu-matrix"
import {
  FOG_DEFAULTS,
  FOG_GLOW_SIZE,
  FOG_LAMP_FLOATS,
  FogLampPicker,
  FogScatter,
  SODIUM_CONE,
  airlightEquiangular,
  airlightLensEquiangular,
  airlightLensReference,
  airlightReference,
  atmosphereControls,
  bakeLampGlow,
  createFogSettings,
  fogAmbientCoefficients,
  fogAmbientNumeric,
  fogBankInterval,
  fogBankMeanSigma,
  fogBlurAmount,
  fogColor,
  fogCone,
  fogControls,
  fogEnvRadiance,
  fogGlowRect,
  fogOpticalDepth,
  fogSceneWgsl,
  fogScatterVolume,
  fogSkyRadiance,
  type FogLamp,
  type ScatterLampShape,
  type Vec3,
} from "./fog-scatter"
import { makeSceneShader, postShader, spriteShader } from "./shaders"
import { STREET_LAMP_DEFAULTS } from "./lights/street"
import { volumeAccumulateShader, volumeBilinearShader, volumeUpsampleShader } from "./volume-pass"
import { fogBlurDownWgsl, fogBlurMixWgsl } from "./fog-blur"

const medium = { density: 0.01, falloff: 0.05, base: 0 }

/** σ(y) integrated along a → b by the midpoint rule. */
function numericDepth(a: Vec3, b: Vec3, m = medium, steps = 20000): number {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const y = a[1] + (b[1] - a[1]) * ((i + 0.5) / steps)
    sum += m.density * Math.exp(-m.falloff * (y - m.base))
  }
  return (sum * len) / steps
}

describe("fog medium", () => {
  test("closed-form optical depth matches numeric integration", () => {
    const cases: [Vec3, Vec3][] = [
      [[0, 1.7, 0], [300, 1.7, 0]],
      [[0, 1.7, 0], [40, 0, 25]],
      [[0, 1.7, 0], [100, 60, -20]],
      [[5, 8, 5], [5, 0, 5]],
      [[0, 30, 0], [-200, 0.2, 80]],
      [[0, 0.5, 0], [0, 120, 400]],
    ]
    for (const [a, b] of cases) {
      const closed = fogOpticalDepth(a, b, medium)
      const ref = numericDepth(a, b)
      expect(Math.abs(closed - ref) / ref).toBeLessThan(1e-4)
    }
  })

  test("level rays are continuous through the Taylor limit (no horizon seam)", () => {
    const eye: Vec3 = [0, 1.7, 0]
    const flat = fogOpticalDepth(eye, [500, 1.7, 0], medium)
    for (const dy of [1e-5, -1e-5, 1e-3, -1e-3]) {
      const t = fogOpticalDepth(eye, [500, 1.7 + dy, 0], medium)
      expect(Math.abs(t - flat) / flat).toBeLessThan(2e-4)
    }
  })

  test("colour is Aiden's teal at his brightness", () => {
    const c = fogColor(181, 0.75, 0.034)
    expect(c[0]).toBeCloseTo(0.006016, 4)
    expect(c[1]).toBeCloseTo(0.041514, 4)
    expect(c[2]).toBeCloseTo(0.042113, 4)
    expect(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toBeCloseTo(0.034, 6)
  })

  test("the sky is fully fogged at the horizon and continuous across it", () => {
    const color = fogColor(181, 0.75, 0.034)
    const s = { ...medium, color, skyDark: 0.45, horizonGlow: 0.35, ground: 0.12 }
    const eye: Vec3 = [0, 1.7, 0]
    const level = fogSkyRadiance(eye, [1, 0, 0], s)
    for (let i = 0; i < 3; i++) expect(Math.abs(level[i]! - color[i]!) / color[i]!).toBeLessThan(1e-6)
    const above = fogSkyRadiance(eye, [Math.cos(0.002), Math.sin(0.002), 0], s)
    for (let i = 0; i < 3; i++) expect(Math.abs(above[i]! - level[i]!) / level[i]!).toBeLessThan(1e-3)
    const zenith = fogSkyRadiance(eye, [0, 1, 0], s)
    expect(zenith[1]).toBeLessThan(level[1]!)
  })

  test("the analytic skylight matches the cosine-weighted environment", () => {
    const color = fogColor(181, 0.75, 0.034)
    const s = { ...medium, color, skyDark: 0.45, horizonGlow: 0.35, ground: 0.12 }
    const [c0, c1, c2] = fogAmbientCoefficients(s)
    for (const ny of [-1, -0.6, -0.25, 0, 0.3, 0.7, 1]) {
      const numeric = fogAmbientNumeric(ny, s, 64)
      for (let i = 0; i < 3; i++) {
        const fit = c0[i]! + c1[i]! * ny + c2[i]! * ny * ny
        expect(Math.abs(fit - numeric[i]!)).toBeLessThan(0.06 * color[i]!)
      }
    }
    // Shadowed upward faces read as dark teal from the fog sky, not black.
    const up = c0[1]! + c1[1]! + c2[1]!
    expect(up).toBeGreaterThan(0.4 * color[1]!)
    expect(fogEnvRadiance([0, -1, 0], s)[1]).toBeCloseTo(color[1] * 0.12, 6)
  })
})

describe("lamp scattering", () => {
  const cone = fogCone(SODIUM_CONE.angle, SODIUM_CONE.inner)
  const lamp: ScatterLampShape = { pos: [0, 8, 12], range: 40, axis: [0, -1, 0], ...cone, near: 0.225 }
  const shape = { leak: 0.03, coneLength: 4.5, phaseG: 0.6 }
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2])
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  const rays: [string, Vec3, number][] = [
    ["under the head", norm([0, 0.2, 1]), 60],
    ["just under the head", norm([0, 6.0 / 12, 1]), 3000],
    ["past the side", norm([0.4, 0.1, 1]), 3000],
    ["into the pool", norm([0, -1.2, 12]), 14.5],
  ]

  test("four equiangular samples converge on the numeric integral", () => {
    const eye: Vec3 = [0, 1.7, 0]
    for (const [, rd, dist] of rays) {
      const ref = airlightReference(eye, rd, dist, lamp, shape)
      expect(ref).toBeGreaterThan(0)
      let mean = 0
      const n = 4096
      for (let k = 0; k < n; k++) mean += airlightEquiangular(eye, rd, dist, lamp, shape, 4, (k + 0.5) / n)
      mean /= n
      expect(Math.abs(mean - ref) / ref).toBeLessThan(0.01)
    }
  })

  test("one jitter of four samples is already close", () => {
    const eye: Vec3 = [0, 1.7, 0]
    for (const [, rd, dist] of rays) {
      const ref = airlightReference(eye, rd, dist, lamp, shape)
      for (const j of [0.1, 0.5, 0.9]) {
        const v = airlightEquiangular(eye, rd, dist, lamp, shape, 4, j)
        expect(Math.abs(v - ref) / ref).toBeLessThan(0.4)
      }
    }
  })

  test("the side leak draws the halo; the cone dominates under the head", () => {
    const eye: Vec3 = [0, 1.7, 0]
    const above = airlightReference(eye, norm([0, 7.6 / 12, 1]), 3000, lamp, shape)
    const below = airlightReference(eye, norm([0, 4.3 / 12, 1]), 3000, lamp, shape)
    expect(below).toBeGreaterThan(above * 4)
    const noLeak = airlightReference(eye, norm([0, 7.6 / 12, 1]), 3000, lamp, { ...shape, leak: 0 })
    expect(above).toBeGreaterThan(noLeak * 1.5)
  })
})

describe("lamp picker", () => {
  const eye: Vec3 = [0, 1.7, 0]
  const proj = mat4.perspective(1.1, 16 / 9, 0.15, 1200)
  const view = mat4.lookAt(eye, [0, 1.7, 10], [0, 1, 0])
  const vp = mat4.multiply(proj, view) as Float32Array
  const lamp = (x: number, z: number, intensity = 2000, id?: number): FogLamp => ({ x, y: 8, z, range: 20, color: [1, 0.5, 0.2], intensity, id })

  test("culls lamps whose range sphere is outside the view", () => {
    const picker = new FogLampPicker()
    const chosen = picker.pick([lamp(0, 20), lamp(0, -40), lamp(200, 20)], eye, vp, medium, 16)
    expect(chosen).toEqual([0])
  })

  test("ranks by output over distance and caps the budget at 16", () => {
    const lamps = Array.from({ length: 30 }, (_, i) => lamp(((i % 5) - 2) * 6, 10 + i * 4))
    const picker = new FogLampPicker()
    const chosen = picker.pick(lamps, eye, vp, medium, 24)
    expect(chosen.length).toBe(16)
    const distances = chosen.map((i) => lamps[i]!.z)
    expect(Math.max(...distances)).toBeLessThan(Math.min(...lamps.filter((_, i) => !chosen.includes(i)).map((l) => l.z)) + 1e-6)
    expect(picker.pick(lamps, eye, vp, medium, 3).length).toBe(3)
  })

  test("keeps an incumbent within 1.5x and breaks ties by position", () => {
    const picker = new FogLampPicker()
    const a = lamp(-4, 40, 1000, 1), b = lamp(4, 40, 1000, 2)
    expect(picker.pick([b, a], eye, vp, medium, 1)).toEqual([1])
    const weaker = { ...a, intensity: 1000 / 1.3 }
    expect(picker.pick([b, weaker], eye, vp, medium, 1)).toEqual([1])
    const muchWeaker = { ...a, intensity: 1000 / 1.6 }
    expect(picker.pick([b, muchWeaker], eye, vp, medium, 1)).toEqual([0])
  })

  test("packs sigma and transmittance into the scattered colour", () => {
    const fog = new FogScatter(createFogSettings())
    const frame = fog.update({ eye, viewProj: vp, lamps: [lamp(0, 20)] })
    expect(frame.lampCount).toBe(1)
    const sigma = 0.01 * Math.exp(-0.05 * 8)
    const t = Math.exp(-fogOpticalDepth(eye, [0, 8, 20], medium))
    expect(frame.lamps[4]).toBeCloseTo(2000 * sigma * t * FOG_DEFAULTS.strength, 4)
    expect(frame.lamps[19]).toBeCloseTo(sigma, 6)
    expect(FOG_LAMP_FLOATS).toBe(24)
    expect([...frame.lamps.subarray(20, 24)]).toEqual([0, 0, 0, 0])
    expect(frame.uniforms[3]).toBe(1)
    expect(frame.uniforms[27]).toBe(1)
    fog.settings.mode = "today"
    const off = fog.update({ eye, viewProj: vp, lamps: [lamp(0, 20)] })
    expect(off.uniforms[3]).toBe(0)
    expect(off.lampCount).toBe(0)
    expect(fog.volumeInput()).toBeNull()
  })
})

describe("atmosphere", () => {
  const eye: Vec3 = [0, 1.7, 0]
  const vp = mat4.multiply(mat4.perspective(1.2, 16 / 9, 0.1, 1000), mat4.lookAt(eye, [0, 1.7, 10], [0, 1, 0]))
  const sodium = (x: number, z: number, intensity = 1000): FogLamp => ({ x, y: 8, z, range: 30, color: [1, 0.55, 0.18], intensity })
  const bank = { ...FOG_DEFAULTS, base: 0 }

  test("is Today by default: bank, clouds, glow map and blur all off", () => {
    const fog = new FogScatter(createFogSettings())
    const u = fog.update({ eye, viewProj: vp, lamps: [sodium(0, 20)] }).uniforms
    expect(u[32]).toBe(0)
    expect(u[35]).toBe(0)
    expect(u[47]).toBe(0)
    expect(u[54]).toBe(0)
    expect(fog.blurInput()).toBeNull()
    expect(fog.frame.glowVersion).toBe(0)
  })

  test("packs the bank, clouds and glow map when on, and rebakes the glow only when lamps change", () => {
    const fog = new FogScatter(createFogSettings({ bank: "drift", clouds: "lit", blur: "depth" }))
    const lamps = [sodium(0, 20), sodium(10, 60)]
    const u = fog.update({ eye, viewProj: vp, lamps, time: 12 }).uniforms
    expect(u[32]).toBeCloseTo(FOG_DEFAULTS.bankDensity, 6)
    expect(u[35]).toBe(FOG_DEFAULTS.bankSteps)
    expect(u[42]).toBe(12)
    expect(u[47]).toBeCloseTo(FOG_DEFAULTS.cloudOpacity, 6)
    expect(u[54]).toBeGreaterThan(0)
    expect(fog.blurInput()).toEqual({ strength: FOG_DEFAULTS.blurStrength, reach: FOG_DEFAULTS.blurReach })
    expect(fog.frame.glowVersion).toBe(1)
    fog.update({ eye, viewProj: vp, lamps, time: 13 })
    expect(fog.frame.glowVersion).toBe(1)
    fog.update({ eye, viewProj: vp, lamps: [sodium(0, 20, 2000), lamps[1]!], time: 14 })
    expect(fog.frame.glowVersion).toBe(2)
    fog.settings.mode = "today"
    const off = fog.update({ eye, viewProj: vp, lamps })
    expect(off.uniforms[35]).toBe(0)
    expect(off.uniforms[47]).toBe(0)
    expect(fog.blurInput()).toBeNull()
  })

  test("glow map peaks under each lamp and falls off with the spread", () => {
    const lamps = [sodium(0, 0)]
    const rect = fogGlowRect(lamps, 20)!
    expect(rect[0]).toBeLessThan(-70)
    expect(rect[2]).toBeGreaterThan(70)
    const out = new Float32Array(FOG_GLOW_SIZE * FOG_GLOW_SIZE * 4)
    bakeLampGlow(out, lamps, rect, 20)
    const at = (i: number, j: number) => out[(j * FOG_GLOW_SIZE + i) * 4]!
    const mid = FOG_GLOW_SIZE / 2
    const peak = Math.max(at(mid, mid), at(mid - 1, mid - 1))
    expect(peak).toBeGreaterThan(at(0, mid) * 8)
    expect(at(mid - 1, mid)).toBeCloseTo(at(mid, mid - 1), 6)
    expect(out[(mid * FOG_GLOW_SIZE + mid) * 4 + 2]! / at(mid, mid)).toBeCloseTo(0.18, 5)
  })

  test("bank slab clips the ray and the blur grows with fog depth", () => {
    expect(fogBankInterval(1.7, 0, 50, bank)).toEqual([0, 50])
    const [t0, t1] = fogBankInterval(10, -0.5, 1000, bank)
    expect(t0).toBeCloseTo(12, 6)
    expect(t1).toBeCloseTo(20, 6)
    expect(fogBankInterval(10, 0.5, 1000, bank)).toEqual([0, 0])
    expect(fogBankMeanSigma(bank.bankHeight + 1, bank)).toBe(0)
    expect(fogBankMeanSigma(0, bank)).toBeCloseTo(bank.bankDensity * 0.5 * (1 - bank.bankThreshold), 9)
    const near = fogBlurAmount(eye, [0, 0, 5], medium, 1.6), far = fogBlurAmount(eye, [0, 0, 150], medium, 1.6)
    expect(near).toBeLessThan(0.15)
    expect(far).toBeGreaterThan(0.85)
    expect(fogBlurAmount(eye, [0, 0, 20], medium, 1.6, bank)).toBeGreaterThan(fogBlurAmount(eye, [0, 0, 20], medium, 1.6))
  })

  test("every atmosphere row is typed, in range, and each feature leads with its Today select", () => {
    const rows = atmosphereControls()
    for (const k of ["bank", "blur", "clouds"]) {
      const row = rows.find((c) => c.key === k)!
      expect(row).toMatchObject({ type: "select" })
      expect("options" in row && row.options[0]!.value).toBe("today")
    }
    for (const c of rows) {
      if (!("min" in c)) continue
      const v = FOG_DEFAULTS[c.key as keyof typeof FOG_DEFAULTS] as number
      expect(c.min).toBeLessThanOrEqual(v)
      expect((c as { max: number }).max).toBeGreaterThanOrEqual(v)
    }
  })
})

describe("lab controls", () => {
  test("every fog parameter has a typed row and Today comes first", () => {
    const controls = fogControls()
    expect(controls[0]!.key).toBe("mode")
    const keys = new Set(controls.map((c) => c.key))
    for (const k of ["density", "falloff", "hue", "saturation", "brightness", "strength", "leak", "phaseG", "history", "halfRes", "coneLength"]) expect(keys.has(k)).toBe(true)
    for (const c of controls) if ("min" in c) expect(c.min).toBeLessThanOrEqual(FOG_DEFAULTS[c.key as keyof typeof FOG_DEFAULTS] as number)
    expect(fogControls("Fog", "fog.")[1]).toMatchObject({ key: "fog.density", field: "density" })
  })
})

describe("WGSL validates with naga", () => {
  const sources: Record<string, string> = {
    "fog volume": fogScatterVolume().code,
    "fog volume hooks": fogScatterVolume({
      declarations: "struct Night { look: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;",
      wet: "select(0.0, N.look.x, p.y < 0.2)",
      roughness: "0.6",
      normal: "vec3f(0.0, 1.0, 0.0)",
    }).code,
    "fog volume atmosphere": fogScatterVolume({ atmosphere: true, normal: "vec3f(0.0, 1.0, 0.0)", reflectionSamples: 4 }).code,
    "fog blur down": fogBlurDownWgsl,
    "fog blur mix": fogBlurMixWgsl,
    accumulate: volumeAccumulateShader,
    upsample: volumeUpsampleShader,
    bilinear: volumeBilinearShader,
    scene: makeSceneShader({
      lampGrid: false,
      declarations: fogSceneWgsl,
      ambient: "fogAmbient(n)",
      surface: "col = fogApply(col, F.cam.xyz, o.world); if (mat == 3 && o.aux < 0.0) { col = fogSky(F.cam.xyz, normalize(o.world - F.cam.xyz)) + fogEnv(n) * 0.0; }",
    }),
    sprite: spriteShader(),
    "sprite motion": spriteShader(true),
    "post gate": postShader(false, false, { chromatic: 0, bloom: 0.26, grain: 0.01, vignette: 0.45, bloomGate: { cap: 0.02, hot: 4 } }),
    "post gate looks": postShader(true, false, { chromatic: 0, bloom: 0.26, grain: 0.01, vignette: 0.45, bloomGate: { cap: 0.02, hot: 4 } }),
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      validateWgsl(code)
    })
  }
})

describe("street lamp airlight (lens emitter)", () => {
  const lamp = { pos: [0, 6.4, 0] as Vec3, range: 30, arm: [1, 0] as const, a: 0.3, b: 0.14 }
  const shape = { leak: 0.03, coneLength: 4.5, phaseG: 0.6 }
  const street = { along: 2.4, street: 1.5, house: 0.7, cutoff: 78, glow: 0.04 }
  // Rays passing 1.5 m or more from the lens; a ray grazing it is checked within 60 % (the profile's direction then
  // differs across the lens, which the representative point ignores).
  const rays: [Vec3, Vec3][] = [
    [[8, 1.7, 6], [-0.7, 0.25, -0.55]],
    [[0, 1.7, 12], [0, 0.4, -0.92]],
    [[3, 1.7, -9], [-0.2, 0.25, 0.95]],
  ]
  test("the representative-point estimator stays within 15 % of the full lens integral", () => {
    for (const [ro, d] of rays) {
      const l = Math.hypot(d[0], d[1], d[2])
      const rd: Vec3 = [d[0] / l, d[1] / l, d[2] / l]
      const ref = airlightLensReference(ro, rd, 60, lamp, shape, street, 6000, 24)
      let est = 0
      const N = 4000
      for (let k = 0; k < N; k++) est += airlightLensEquiangular(ro, rd, 60, lamp, shape, street, 4, (k + 0.5) / N)
      est /= N
      expect(Math.abs(est - ref) / ref).toBeLessThan(0.15)
    }
    const rd: Vec3 = [-0.7 / 0.997, 0.45 / 0.997, -0.55 / 0.997]
    let est = 0
    for (let k = 0; k < 256; k++) est += airlightLensEquiangular([8, 1.7, 6], rd, 60, lamp, shape, street, 4, (k + 0.5) / 256)
    expect(est / 256 / airlightLensReference([8, 1.7, 6], rd, 60, lamp, shape, street, 6000, 24)).toBeLessThan(1.6)
  })
  test("a ray grazing the lens stays bounded (no singular dot under the head)", () => {
    const rd: Vec3 = [0, 0, -1]
    const avg = (f: (j: number) => number) => { let t = 0; for (let k = 0; k < 256; k++) t += f((k + 0.5) / 256); return t / 256 }
    const lens = (h: number) => avg((j) => airlightLensEquiangular([0, 6.4 - h, 5], rd, 60, lamp, shape, street, 4, j))
    const spot = { pos: lamp.pos, range: 30, axis: [0, -1, 0] as Vec3, cosOuter: -1, cosInner: -0.5, near: 0.0001 }
    const point = (h: number) => avg((j) => airlightEquiangular([0, 6.4 - h, 5], rd, 60, spot, shape, 4, j))
    expect(lens(0.005) / lens(0.05)).toBeLessThan(1.2)
    expect(point(0.005) / point(0.05)).toBeGreaterThan(3)
  })
  test("packs the lens and the street profile", () => {
    const fog = new FogScatter(createFogSettings())
    const eye: Vec3 = [0, 1.7, 30]
    const vp = mat4.multiply(mat4.perspective(1.2, 16 / 9, 0.1, 1000), mat4.lookAt(eye, [0, 4, 0], [0, 1, 0]))
    const f = fog.update({ eye, viewProj: vp, lamps: [{ x: 0, y: 6.4, z: 0, range: 30, color: [1, 0.55, 0.18], intensity: 3000, lens: { arm: [0, 2], a: 0.3, b: 0.14 } }] })
    expect([...f.lamps.subarray(20, 24)].map((v) => +v.toFixed(3))).toEqual([0, 1, 0.3, 0.14])
    expect(f.uniforms[60]).toBeCloseTo(STREET_LAMP_DEFAULTS.along, 5)
  })
})
