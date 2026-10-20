import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { mat4 } from "wgpu-matrix"
import {
  FOG_DEFAULTS,
  FOG_LAMP_FLOATS,
  FogLampPicker,
  FogScatter,
  SODIUM_CONE,
  airlightEquiangular,
  airlightReference,
  createFogSettings,
  fogAmbientCoefficients,
  fogAmbientNumeric,
  fogColor,
  fogCone,
  fogControls,
  fogEnvRadiance,
  fogOpticalDepth,
  fogSceneWgsl,
  fogScatterVolume,
  fogSkyRadiance,
  upsampleWeights,
  type FogLamp,
  type ScatterLampShape,
  type Vec3,
} from "./fog-scatter"
import { makeSceneShader, postShader, spriteShader } from "./shaders"
import { volumeAccumulateShader, volumeBilinearShader, volumeUpsampleShader } from "./volume-pass"

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
    expect(frame.lamps[FOG_LAMP_FLOATS - 1]).toBeCloseTo(sigma, 6)
    expect(frame.uniforms[3]).toBe(1)
    expect(frame.uniforms[27]).toBe(1)
    fog.settings.mode = "today"
    const off = fog.update({ eye, viewProj: vp, lamps: [lamp(0, 20)] })
    expect(off.uniforms[3]).toBe(0)
    expect(off.lampCount).toBe(0)
    expect(fog.volumeInput()).toBeNull()
  })
})

describe("depth-aware upsample", () => {
  test("is bilinear on one surface", () => {
    const w = upsampleWeights(0.25, 0.75, [10, 10, 10, 10], 10)
    const bil = [0.75 * 0.25, 0.25 * 0.25, 0.75 * 0.75, 0.25 * 0.75]
    w.forEach((v, i) => expect(v).toBeCloseTo(bil[i]!, 3))
  })

  test("rejects taps on another surface and always sums to one", () => {
    const w = upsampleWeights(0.5, 0.5, [4, 4, 40, 40], 4)
    expect(w[2] + w[3]).toBeLessThan(1e-3)
    expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 6)
    const sky = upsampleWeights(0.5, 0.5, [3000, 3000, 3000, 6], 6)
    expect(sky[3]).toBeGreaterThan(0.99)
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
  const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find(
    (p): p is string => !!p && existsSync(p),
  )
  const sources: Record<string, string> = {
    "fog volume": fogScatterVolume().code,
    "fog volume hooks": fogScatterVolume({
      declarations: "struct Night { look: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;",
      wet: "select(0.0, N.look.x, p.y < 0.2)",
      roughness: "0.6",
      normal: "vec3f(0.0, 1.0, 0.0)",
    }).code,
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
      if (!naga) {
        console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
        return
      }
      const dir = mkdtempSync(join(tmpdir(), "fog-wgsl-"))
      try {
        const file = join(dir, "shader.wgsl")
        writeFileSync(file, code)
        const run = Bun.spawnSync([naga, file])
        const out = run.stderr.toString() + run.stdout.toString()
        if (run.exitCode !== 0) console.log(out)
        expect(run.exitCode).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
