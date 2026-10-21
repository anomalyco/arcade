import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fogScatterVolume } from "../fog-scatter"
import { makeSceneShader } from "../shaders"
import { VOLUME_PARAM_FLOATS } from "../volume-pass"
import { SSR_DEFAULTS, Ssr, createSsrSettings, ssrControls, ssrVolume } from "./ssr"
import { decodeSurfaceRoughness, encodeSurfaceAlpha, reflectiveSurfaceReturn } from "./surface"
import { WET_ASPHALT, WET_DEFAULTS, wetNoise, wetSurface, wetSurfaceWgsl } from "./wet"

describe("wet surface", () => {
  test("equalised noise is close to uniform (deciles within 0.03)", () => {
    const v: number[] = []
    for (let i = 0; i < 240; i++) for (let j = 0; j < 240; j++) v.push(wetNoise(i * 0.173 + 0.05, j * 0.191 + 0.07, 13))
    v.sort((a, b) => a - b)
    for (let k = 1; k < 10; k++) expect(Math.abs(v[Math.floor((v.length * k) / 10)]! - k / 10)).toBeLessThan(0.03)
  })

  const coverage = (puddles: number, ao = 1) => {
    let sum = 0, n = 0
    for (let i = 0; i < 160; i++) for (let j = 0; j < 160; j++) {
      sum += wetSurface(i * 0.7, j * 0.7, 1, 0.8, ao, 0.002, { ...WET_DEFAULTS, puddles }, WET_ASPHALT).puddle
      n++
    }
    return sum / n
  }

  test("puddle coverage grows with the setting and with cavities", () => {
    const none = coverage(0), some = coverage(0.32), more = coverage(0.65)
    expect(none).toBe(0)
    expect(some).toBeGreaterThan(0.005)
    expect(more).toBeGreaterThan(some * 2)
    expect(coverage(0.32, 0.6)).toBeGreaterThan(some)
  })

  test("standing water is a flat near-mirror with darker albedo; dry ground is unchanged", () => {
    const soaked = wetSurface(3, 4, 1, 0.8, 1, 0.002, { ...WET_DEFAULTS, puddles: 2 }, WET_ASPHALT)
    expect(soaked.puddle).toBeCloseTo(1, 5)
    expect(soaked.roughness).toBeCloseTo(0.035, 5)
    expect(soaked.flat).toBeCloseTo(1, 5)
    expect(soaked.albedo).toBeLessThan(0.55 * (1 - 0.6 * 0.8) + 1e-6)
    const dry = wetSurface(3, 4, 1, 0.8, 1, 0.002, { ...WET_DEFAULTS, wetness: 0, puddles: 2 }, WET_ASPHALT)
    expect(dry.roughness).toBeCloseTo(0.8, 6)
    expect(dry.albedo).toBeCloseTo(1, 6)
    expect(dry.flat).toBeCloseTo(0, 6)
  })

  test("the film is glossier than the dry material but never rougher", () => {
    for (let i = 0; i < 50; i++) {
      const s = wetSurface(i * 1.3, i * 0.7, 1, 0.8, 1, 0.002, { ...WET_DEFAULTS, puddles: 0 }, WET_ASPHALT)
      expect(s.roughness).toBeLessThanOrEqual(0.8)
      expect(s.roughness).toBeLessThan(0.45)
    }
  })

  test("walls hold no water", () => {
    expect(wetSurface(3, 4, 0, 0.8, 1, 0.002, { ...WET_DEFAULTS, puddles: 2 }, WET_ASPHALT).puddle).toBe(0)
  })
})

describe("surface tag", () => {
  test("round trip through the HDR alpha; untagged alpha never reflects", () => {
    for (const r of [0, 0.035, 0.3, 0.85, 1]) expect(decodeSurfaceRoughness(encodeSurfaceAlpha(r))).toBeCloseTo(r, 6)
    expect(decodeSurfaceRoughness(1)).toBe(1)
    expect(decodeSurfaceRoughness(0.35)).toBe(1)
  })
})

describe("Ssr settings", () => {
  test("Today is one setting away and turns the pass off", () => {
    const rows = ssrControls()
    const mode = rows[0]!
    if (mode.type !== "select") throw new Error("mode is not a select")
    expect(mode.options[0]).toEqual({ value: "today", label: "Today" })
    const ssr = new Ssr(createSsrSettings({ mode: "today" }))
    expect(ssr.volumeInput()).toBeNull()
  })

  test("outdoor and indoor tiers keep Ashwood's scale, steps and streaks", () => {
    const ssr = new Ssr()
    const out = ssr.volumeInput()!
    expect(out.downscale).toBeCloseTo(4, 6)
    expect(out.params!.length).toBe(VOLUME_PARAM_FLOATS)
    expect(out.params![3]).toBeCloseTo(SSR_DEFAULTS.streak, 6)
    expect(out.params![7]).toBeCloseTo(SSR_DEFAULTS.steps, 6)
    expect(out.params![10]).toBe(64)
    const inside = ssr.volumeInput({ indoor: true })!
    expect(inside.downscale).toBeCloseTo(1 / 0.85, 6)
    expect(inside.params![3]).toBeCloseTo(SSR_DEFAULTS.streakIndoor, 6)
    expect(inside.params![7]).toBeCloseTo(SSR_DEFAULTS.stepsIndoor, 6)
    expect(inside.params![10]).toBe(512)
    expect(Array.from(inside.params!.subarray(12, 16))).toEqual([WET_DEFAULTS.wetness, WET_DEFAULTS.puddles, WET_DEFAULTS.puddleScale, WET_DEFAULTS.ripple].map(Math.fround))
    ssr.settings.maxStepsIndoor=2000
    expect(ssr.volumeInput({indoor:true})!.params![10]).toBe(1024)
    expect(ssr.volumeInput()!.params![10]).toBe(64)
  })
})

describe("WGSL validates with naga", () => {
  const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find(
    (p): p is string => !!p && existsSync(p),
  )
  const ssr = ssrVolume()
  const sources: Record<string, string> = {
    "ssr march": ssr.code,
    "ssr streak": ssr.filter!,
    "fog surface + ripple": fogScatterVolume({ surface: true, wetSettings: "vec4f(1.0, 0.32, 1.0, 0.5)", reflectionSamples: 4 }).code,
    "scene with wet term and surface tag": makeSceneShader({
      lampGrid: false,
      declarations: wetSurfaceWgsl,
      material: "{ let w = wetSurface(o.world, n.y, 0.8, 1.0, 0.01, vec4f(1.0, 0.32, 1.0, 0.5), vec4f(0.6, 0.13, 1.0, 0.0)); albedo *= w.albedo; }",
      fragmentReturn: reflectiveSurfaceReturn("0.5"),
    }),
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      if (!naga) {
        console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
        return
      }
      const dir = mkdtempSync(join(tmpdir(), "ssr-wgsl-"))
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
