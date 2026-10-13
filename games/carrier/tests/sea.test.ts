import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeSea,
  packSea,
  SEA_MAX_WAVES,
  SEA_ORIGIN_GRID,
  SEA_UNIFORM_FLOATS,
  SEA_UNIFORM_LAYOUT,
  seaDisplace,
  seaFoam,
  seaHeight,
  seaNormal,
  seaRest,
  seaSlope,
  snapSeaOrigin,
  type Sea,
} from "../shared/sea"
import { SEA_WGSL } from "../shared/sea.wgsl"

const SEEDS = [1, 2, 3, 42, 1234, 99991, 0xdeadbeef, 2 ** 31 + 17, 7, 31337]

// ---------------------------------------------------------------------------------------------------------------
// float32 emulation of SEA_WGSL, one Math.fround per WGSL operation, in the same order as the shader.
// ---------------------------------------------------------------------------------------------------------------
const f = Math.fround
const TAU32 = f(6.283185307179586)

/** WGSL round(): to nearest, ties to even. */
function roundEven(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

function phase32(u: Float32Array, i: number, px: number, py: number): number {
  const o = SEA_UNIFORM_LAYOUT.waves + i * 4
  const dot = f(f(u[o]! * px) + f(u[o + 1]! * py))
  const th = f(f(u[o + 2]! * dot) + u[o + 3]!)
  return f(th - f(TAU32 * roundEven(f(th / TAU32))))
}

function displace32(u: Float32Array, px: number, py: number): [number, number, number] {
  let dx = 0
  let dy = 0
  let dz = 0
  const n = u[SEA_UNIFORM_LAYOUT.origin + 2]!
  for (let i = 0; i < n; i++) {
    const w = SEA_UNIFORM_LAYOUT.waves + i * 4
    const s = SEA_UNIFORM_LAYOUT.shape + i * 4
    const th = phase32(u, i, px, py)
    const c = f(Math.cos(th))
    dx = f(dx + f(f(u[w]! * u[s + 1]!) * c))
    dy = f(dy + f(u[s]! * f(Math.sin(th))))
    dz = f(dz + f(f(u[w + 1]! * u[s + 1]!) * c))
  }
  return [dx, dy, dz]
}

function smoothstep32(lo: number, hi: number, x: number): number {
  const t = f(Math.min(1, Math.max(0, f(f(x - lo) / f(hi - lo)))))
  return f(f(t * t) * f(3 - f(2 * t)))
}

function slope32(u: Float32Array, px: number, py: number): [number, number, number, number] {
  let jxx = 0
  let jxz = 0
  let jzz = 0
  let gx = 0
  let gz = 0
  let y = 0
  const n = u[SEA_UNIFORM_LAYOUT.origin + 2]!
  for (let i = 0; i < n; i++) {
    const w = SEA_UNIFORM_LAYOUT.waves + i * 4
    const s = SEA_UNIFORM_LAYOUT.shape + i * 4
    const th = phase32(u, i, px, py)
    const c = f(Math.cos(th))
    const sn = f(Math.sin(th))
    const wx = u[w]!
    const wy = u[w + 1]!
    const j = f(u[s + 2]! * sn)
    jxx = f(jxx - f(f(j * wx) * wx))
    jxz = f(jxz - f(f(j * wx) * wy))
    jzz = f(jzz - f(f(j * wy) * wy))
    const g = f(u[s + 3]! * c)
    gx = f(gx + f(g * wx))
    gz = f(gz + f(g * wy))
    y = f(y + f(u[s]! * sn))
  }
  const xx = f(1 + jxx)
  const zz = f(1 + jzz)
  const det = f(f(xx * zz) - f(jxz * jxz))
  const hx = f(f(f(zz * gx) - f(jxz * gz)) / det)
  const hz = f(f(f(xx * gz) - f(jxz * gx)) / det)
  const fo = SEA_UNIFORM_LAYOUT.foam
  const foam = smoothstep32(u[fo]!, u[fo + 1]!, f(f(f(1 - det)) + f(u[fo + 2]! * y)))
  return [hx, hz, foam, 0]
}

function steepness(sea: Sea): number {
  return sea.waves.reduce((sum, w) => sum + w.steep * w.k * w.amp, 0)
}

// ---------------------------------------------------------------------------------------------------------------

describe("makeSea", () => {
  test("is deterministic per seed and differs between seeds", () => {
    for (const seed of SEEDS) expect(makeSea(seed)).toEqual(makeSea(seed))
    const a = makeSea(1)
    const b = makeSea(2)
    expect(a.waves).not.toEqual(b.waves)
    const pa = seaDisplace(a, 123, 456, 789)
    const pb = seaDisplace(b, 123, 456, 789)
    expect(Math.abs(pa[1]! - pb[1]!) + Math.abs(pa[0]! - pb[0]!)).toBeGreaterThan(1e-3)
    expect(seaDisplace(makeSea(1), 123, 456, 789)).toEqual(pa)
  })

  test("follows the recipe: a few long paired swells, weak shape swells, faint chop; capped steepness; dispersion", () => {
    for (let seed = 0; seed < 200; seed++) {
      const sea = makeSea(seed)
      expect(sea.waves.length).toBeGreaterThanOrEqual(10)
      expect(sea.waves.length).toBeLessThanOrEqual(SEA_MAX_WAVES)
      expect(steepness(sea)).toBeLessThan(0.86)
      expect(Math.hypot(...sea.wind)).toBeCloseTo(1, 12)
      const lambdas = sea.waves.map((w) => (2 * Math.PI) / w.k)
      const along = (i: number) => sea.waves[i]!.dirX * sea.swell[0] + sea.waves[i]!.dirZ * sea.swell[1]
      // The primary swell: long (170-490 m), within 14 degrees of the swell direction, and carrying the energy.
      const primary = sea.waves.filter((_, i) => lambdas[i]! >= 160 && along(i) > Math.cos((14.01 * Math.PI) / 180))
      expect(primary.length).toBe(4)
      const dominant = sea.waves.reduce((m, w) => (w.amp > m.amp ? w : m))
      expect((2 * Math.PI) / dominant.k).toBeGreaterThan(245)
      expect((2 * Math.PI) / dominant.k).toBeLessThan(400)
      // Two close-wavelength pairs, so the swell arrives in sets.
      const pl = primary.map((w) => (2 * Math.PI) / w.k).sort((x, y) => x - y)
      let pairs = 0
      for (let i = 0; i < pl.length; i++) for (let j = i + 1; j < pl.length; j++) if (pl[j]! / pl[i]! >= 1.099 && pl[j]! / pl[i]! <= 1.161) pairs++
      expect(pairs).toBeGreaterThanOrEqual(2)
      // Nothing between 40 m and the primary swell competes with it: at most a fifth of its amplitude.
      for (let i = 0; i < sea.waves.length; i++)
        if (lambdas[i]! > 40 && !primary.includes(sea.waves[i]!)) expect(sea.waves[i]!.amp).toBeLessThan(dominant.amp * 0.33)
      // Sharp primary crests take most of the steepness budget; chop is texture.
      const primarySteep = primary.reduce((sum, w) => sum + w.steep * w.k * w.amp, 0)
      expect(primarySteep).toBeGreaterThan(0.59)
      expect(primarySteep).toBeGreaterThan(steepness(sea) * 0.75)
      const chop = sea.waves.filter((_, i) => lambdas[i]! <= 40)
      expect(chop.length).toBe(5)
      for (const w of chop) {
        expect(w.dirX * sea.wind[0] + w.dirZ * sea.wind[1]).toBeGreaterThan(0.49)
        expect(w.k * w.amp).toBeLessThan(0.014)
        expect(w.steep).toBeLessThanOrEqual(1)
      }
      for (const w of sea.waves) {
        expect(w.omega).toBeCloseTo(Math.sqrt(9.81 * w.k), 12)
        expect(Math.hypot(w.dirX, w.dirZ)).toBeCloseTo(1, 12)
        expect(w.steep).toBeGreaterThan(0)
        // A single wave loops past Q k A = 1; Q itself may exceed 1 (sharp crests).
        expect(w.steep * w.k * w.amp).toBeLessThan(0.5)
      }
      // No two waves share a wavelength, so the pattern does not tile.
      const sorted = [...lambdas].sort((x, y) => x - y)
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]! / sorted[i - 1]!).toBeGreaterThan(1.0001)
    }
  })

  test("crest-to-trough swell heights are big: 6-8 m typical, up to ~10-13 m in sets", () => {
    const d = new Float64Array(3)
    const means: number[] = []
    for (const seed of SEEDS) {
      const sea = makeSea(seed)
      const heights: number[] = []
      for (let line = 0; line < 6; line++) {
        const ox = -sea.swell[1] * line * 500
        const oz = sea.swell[0] * line * 500
        let hi = -Infinity
        let lo = Infinity
        for (let s = 0; s < 8000; s += 2) {
          seaDisplace(sea, ox + sea.swell[0] * s, oz + sea.swell[1] * s, 1000 + line * 17, d)
          hi = Math.max(hi, d[1]!)
          lo = Math.min(lo, d[1]!)
          if (s % 400 === 398) {
            heights.push(hi - lo)
            hi = -Infinity
            lo = Infinity
          }
        }
      }
      const mean = heights.reduce((a, b) => a + b) / heights.length
      means.push(mean)
      expect(mean).toBeGreaterThan(5.5)
      expect(mean).toBeLessThan(9)
      expect(Math.max(...heights)).toBeLessThan(14)
    }
    // Seeds vary the sea state.
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(0.6)
  })
})

describe("surface", () => {
  test("never loops: Jacobian determinant stays positive over a grid and a full swell period", () => {
    const s = new Float64Array(4)
    for (const seed of SEEDS.slice(0, 5)) {
      const sea = makeSea(seed)
      let min = Infinity
      for (let t = 0; t < 16; t += 1.3)
        for (let i = 0; i < 60; i++)
          for (let j = 0; j < 60; j++) min = Math.min(min, seaSlope(sea, i * 2.7 + 5000, j * 2.9 - 3000, t, s)[3]!)
      expect(min).toBeGreaterThan(1 - 0.9)
    }
  })

  test("seaHeight inverts the horizontal displacement to < 1 mm", () => {
    const d = new Float64Array(3)
    const rest = new Float64Array(2)
    for (const seed of SEEDS) {
      const sea = makeSea(seed)
      for (let i = 0; i < 300; i++) {
        const x = Math.sin(i * 12.9898 + seed) * 20000
        const z = Math.cos(i * 78.233 + seed) * 20000
        const t = i * 123.4567
        seaRest(sea, x, z, t, rest)
        seaDisplace(sea, rest[0]!, rest[1]!, t, d)
        expect(Math.hypot(rest[0]! + d[0]! - x, rest[1]! + d[2]! - z)).toBeLessThan(1e-3)
        expect(Math.abs(seaHeight(sea, x, z, t) - d[1]!)).toBeLessThan(1e-9)
      }
    }
  })

  test("seaNormal matches finite differences of seaHeight", () => {
    const n = new Float64Array(3)
    for (const seed of SEEDS.slice(0, 4)) {
      const sea = makeSea(seed)
      for (let i = 0; i < 50; i++) {
        const x = i * 37.1 - 900
        const z = i * -21.3 + 400
        const t = 50 + i
        const e = 0.01
        const gx = (seaHeight(sea, x + e, z, t) - seaHeight(sea, x - e, z, t)) / (2 * e)
        const gz = (seaHeight(sea, x, z + e, t) - seaHeight(sea, x, z - e, t)) / (2 * e)
        seaNormal(sea, x, z, t, n)
        expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 12)
        expect(-n[0]! / n[1]!).toBeCloseTo(gx, 4)
        expect(-n[2]! / n[1]!).toBeCloseTo(gz, 4)
      }
    }
  })

  test("foam covers a few percent of the sea and sits on the crests", () => {
    const d = new Float64Array(3)
    for (const seed of SEEDS) {
      const sea = makeSea(seed)
      let foamy = 0
      let n = 0
      let ySum = 0
      let yFoam = 0
      // Over 2.7 km: the swell arrives in sets, so a small patch may sit in a lull.
      for (let i = 0; i < 160; i++)
        for (let j = 0; j < 160; j++) {
          const x = i * 17.3
          const z = j * 16.1
          const y = seaDisplace(sea, x, z, 30, d)[1]!
          n++
          ySum += y
          if (seaFoam(sea, x, z, 30) > 0.5) {
            foamy++
            yFoam += y
          }
        }
      expect(foamy / n).toBeGreaterThan(0.01)
      expect(foamy / n).toBeLessThan(0.08)
      expect(yFoam / foamy - ySum / n).toBeGreaterThan(1)
    }
  })
})

describe("GPU uniform", () => {
  test("SEA_UNIFORM_LAYOUT matches the WGSL struct under uniform address-space rules", () => {
    const body = /struct SeaUniform \{([^}]*)\}/.exec(SEA_WGSL)![1]!
    const members = [...body.matchAll(/^\s*(\w+)\s*:\s*(array<[^>]+>|\w+)\s*,/gm)].map((m) => [m[1]!, m[2]!] as const)
    let offset = 0
    let maxAlign = 0
    const offsets: Record<string, number> = {}
    for (const [name, type] of members) {
      let size: number
      let align: number
      const arr = /^array<vec4f,\s*(\d+)>$/.exec(type)
      if (type === "vec4f") [size, align] = [16, 16]
      else if (arr) [size, align] = [16 * Number(arr[1]), 16]
      else throw new Error(`unexpected member type ${type}`)
      offset = Math.ceil(offset / align) * align
      offsets[name] = offset / 4
      offset += size
      maxAlign = Math.max(maxAlign, align)
    }
    const size = Math.ceil(offset / maxAlign) * maxAlign
    expect(offsets).toEqual({ ...SEA_UNIFORM_LAYOUT })
    expect(size).toBe(SEA_UNIFORM_FLOATS * 4)
    expect(SEA_WGSL).toContain(`array<vec4f, ${SEA_MAX_WAVES}>`)
  })

  test("packSea writes waves, wrapped phases, origin, count and foam where the struct expects them", () => {
    const sea = makeSea(42)
    const u = new Float32Array(SEA_UNIFORM_FLOATS).fill(NaN)
    packSea(sea, 36000.25, u, 20480, -19456)
    expect(u.every(Number.isFinite)).toBe(true)
    const L = SEA_UNIFORM_LAYOUT
    for (let i = 0; i < SEA_MAX_WAVES; i++) {
      const w = sea.waves[i]
      const o = L.waves + i * 4
      const s = L.shape + i * 4
      if (!w) {
        expect([...u.subarray(o, o + 4), ...u.subarray(s, s + 4)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
        continue
      }
      expect(u[o]).toBe(f(w.dirX))
      expect(u[o + 1]).toBe(f(w.dirZ))
      expect(u[o + 2]).toBe(f(w.k))
      expect(u[o + 3]).toBeGreaterThanOrEqual(0)
      expect(u[o + 3]).toBeLessThanOrEqual(f(2 * Math.PI))
      expect(u[s]).toBe(f(w.amp))
      expect(u[s + 1]).toBe(f(w.steep * w.amp))
      expect(u[s + 2]).toBe(f(w.steep * w.amp * w.k))
      expect(u[s + 3]).toBe(f(w.amp * w.k))
    }
    expect([...u.subarray(L.origin, L.origin + 4)]).toEqual([20480, -19456, sea.waves.length, 0])
    expect([...u.subarray(L.foam, L.foam + 4)]).toEqual([...sea.foam.map(f), 0])
  })

  test("snapSeaOrigin snaps to the grid", () => {
    expect(snapSeaOrigin(20123.4)).toBe(20480)
    expect(snapSeaOrigin(-19876.9)).toBe(-19456)
    expect(snapSeaOrigin(100)).toBe(0)
    expect(SEA_ORIGIN_GRID).toBe(1024)
  })

  test("float32 shader math agrees with the float64 CPU far from the origin after hours of sea time", () => {
    const u = new Float32Array(SEA_UNIFORM_FLOATS)
    const d = new Float64Array(3)
    const s = new Float64Array(4)
    let worstD = 0
    let worstG = 0
    let worstFoam = 0
    for (const seed of SEEDS) {
      const sea = makeSea(seed)
      for (const [cx, cz, t] of [
        [20013.7, -19876.2, 36000.37],
        [-23456.1, 21987.6, 10 * 3600 + 1234.567],
        [3.3, 7.7, 86400 - 0.01],
        [150000.5, -98765.4, 3 * 86400 + 0.5],
      ] as const) {
        const ox = snapSeaOrigin(cx)
        const oz = snapSeaOrigin(cz)
        packSea(sea, t, u, ox, oz)
        // Camera-centred samples out to 2 km, plus a ring at the 8 km limit documented in sea.wgsl.ts.
        for (let i = 0; i < 200; i++) {
          const r = i < 160 ? 2000 * Math.sqrt(i / 160) : 8000
          const a = i * 2.39996
          const x = cx + r * Math.cos(a)
          const z = cz + r * Math.sin(a)
          const px = f(x - ox)
          const pz = f(z - oz)
          const g = displace32(u, px, pz)
          seaDisplace(sea, x, z, t, d)
          worstD = Math.max(worstD, Math.hypot(g[0] - d[0]!, g[1] - d[1]!, g[2] - d[2]!))
          const sl = slope32(u, px, pz)
          seaSlope(sea, x, z, t, s)
          worstG = Math.max(worstG, Math.abs(sl[0] - s[0]!), Math.abs(sl[1] - s[1]!))
          worstFoam = Math.max(worstFoam, Math.abs(sl[2] - s[2]!))
        }
      }
    }
    console.log(
      `f32 vs f64: displacement ${(worstD * 1000).toFixed(2)} mm, gradient ${worstG.toExponential(2)}, foam ${worstFoam.toExponential(2)}`,
    )
    expect(worstD).toBeLessThan(0.03)
    expect(worstG).toBeLessThan(2e-3)
    expect(worstFoam).toBeLessThan(0.02)
  })

  test("SEA_WGSL validates with naga when available", () => {
    const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find(
      (p): p is string => !!p && existsSync(p),
    )
    if (!naga) {
      console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
      return
    }
    const dir = mkdtempSync(join(tmpdir(), "sea-wgsl-"))
    try {
      const file = join(dir, "sea.wgsl")
      writeFileSync(
        file,
        `${SEA_WGSL}
@group(1) @binding(0) var<uniform> sea: SeaUniform;
@group(0) @binding(0) var<storage, read_write> outp: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = vec2f(f32(id.x), f32(id.y));
  outp[id.x] = vec4f(seaDisplace(p), 0.0) + seaSlope(p);
}
@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(seaDisplace(p), 1.0); }
@fragment fn fs(@location(0) p: vec2f) -> @location(0) vec4f { return seaSlope(p); }
`,
      )
      const run = Bun.spawnSync([naga, file])
      expect(run.stderr.toString() + run.stdout.toString()).toContain("Validation successful")
      expect(run.exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("weather compatibility (shared/weather.ts, read-only)", () => {
  test("the worst storm across seeds keeps the surface from looping and seaHeight accurate", async () => {
    const { makeWeatherSea, WEATHER_PRESETS } = await import("../shared/weather")
    const worst = [
      WEATHER_PRESETS.heavy,
      { ...WEATHER_PRESETS.heavy, swell: 1 },
      { ...WEATHER_PRESETS.heavy, swell: 0 },
      { ...WEATHER_PRESETS.heavy, swell: 0.5, sea: 1 },
    ]
    const s = new Float64Array(4)
    const d = new Float64Array(3)
    const rest = new Float64Array(2)
    let minDet = Infinity
    let worstErr = 0
    for (let seed = 0; seed < 40; seed++) {
      const view = makeWeatherSea(makeSea(seed))
      for (const w of worst) {
        view.set(w)
        const sea = view.sea
        expect(steepness(sea)).toBeLessThan(0.93)
        for (let t = 0; t < 30; t += 2.3)
          for (let i = 0; i < 40; i++)
            for (let j = 0; j < 40; j++) minDet = Math.min(minDet, seaSlope(sea, i * 3.7 - 70, j * 4.1 + 30, t + seed, s)[3]!)
        for (let i = 0; i < 60; i++) {
          const x = Math.sin(i * 12.9898 + seed) * 5000
          const z = Math.cos(i * 78.233 + seed) * 5000
          const t = i * 61.7
          seaRest(sea, x, z, t, rest)
          seaDisplace(sea, rest[0]!, rest[1]!, t, d)
          worstErr = Math.max(worstErr, Math.hypot(rest[0]! + d[0]! - x, rest[1]! + d[2]! - z))
        }
      }
    }
    console.log(`storm: min det J ${minDet.toFixed(3)}, seaRest error ${(worstErr * 1000).toFixed(3)} mm`)
    expect(minDet).toBeGreaterThan(0)
    expect(worstErr).toBeLessThan(1e-3)
  })
})
