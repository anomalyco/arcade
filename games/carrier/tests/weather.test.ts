import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { RAIN_WGSL } from "../src/render/rain"
import { makeSea, packSea, SEA_MAX_WAVES, SEA_UNIFORM_FLOATS, SEA_UNIFORM_LAYOUT, seaDisplace, seaHeight, seaRest, seaSlope, snapSeaOrigin, type Sea } from "../shared/sea"
import {
  classifyWaves,
  LIGHTNING_PER_MIN,
  lightningAt,
  makeWeather,
  makeWeatherSea,
  overrideTo,
  RoomWeather,
  packOverride,
  packWeather,
  seaScales,
  slotAt,
  slotFade,
  slotKind,
  slotStart,
  slotUniform,
  STORM_SEA,
  stormWaves,
  strikeFlash,
  strikesBetween,
  unpackOverride,
  unpackWeather,
  WaveClass,
  WEATHER_CALM_SLOTS,
  WEATHER_FADE,
  WEATHER_JITTER,
  WEATHER_SLOT,
  WEATHER_KEYS,
  WEATHER_KINDS,
  WEATHER_PRESETS,
  WEATHER_P_DOWN,
  WEATHER_P_UP,
  WEATHER_RANGE,
  weatherAt,
  weatherNow,
  weatherSchedule,
  weatherStep,
  type Weather,
} from "../shared/weather"

const SEEDS = [1, 2, 3, 42, 1234, 99991, 0xdeadbeef, 7, 31337]

const maxFieldDiff = (a: Weather, b: Weather) => Math.max(...WEATHER_KEYS.map((k) => Math.abs(a[k] - b[k]) / (WEATHER_RANGE[k][1] - WEATHER_RANGE[k][0])))

describe("timeline", () => {
  test("is a pure function of (seed, t): any call order, any client, same answer; seeds differ", () => {
    const ts = Array.from({ length: 400 }, (_, i) => i * 97.3 + 3)
    for (const seed of SEEDS.slice(0, 4)) {
      const fwd = ts.map((t) => packWeather(weatherAt(seed, t)))
      // Interleave other seeds (the kind cache is per seed) and go backwards.
      const back = [...ts].reverse().map((t) => (weatherAt(seed ^ 1, t), packWeather(weatherAt(seed, t)))).reverse()
      expect(back).toEqual(fwd)
    }
    const a = Array.from({ length: 300 }, (_, k) => slotKind(1, k)).join("")
    const b = Array.from({ length: 300 }, (_, k) => slotKind(2, k)).join("")
    expect(a).not.toBe(b)
  })

  test("the chain is exact: every slot follows from the previous one by the monotone update (coupling coalesced)", () => {
    for (let i = 0; i < WEATHER_P_UP.length - 1; i++) expect(WEATHER_P_UP[i]! + WEATHER_P_DOWN[i + 1]!).toBeLessThanOrEqual(1)
    for (const seed of SEEDS) {
      for (let k = WEATHER_CALM_SLOTS; k < 6000; k++) {
        const prev = slotKind(seed, k - 1)
        const kind = slotKind(seed, k)
        expect(kind).toBe(weatherStep(prev, slotUniform(seed, k)))
      }
    }
  })

  test("a room starts clear, rain is common in every kind, and kinds only step to neighbours", () => {
    const counts = [0, 0, 0, 0]
    let n = 0
    for (const seed of SEEDS) {
      for (let t = 0; t < slotStart(seed, WEATHER_CALM_SLOTS) - 60; t += 7) expect(weatherAt(seed, t)).toEqual(makeWeather(WEATHER_PRESETS.clear))
      for (let k = 0; k < 5000; k++) {
        const kind = slotKind(seed, k)
        counts[kind]!++
        n++
        expect(Math.abs(kind - slotKind(seed, k + 1))).toBeLessThanOrEqual(1)
      }
    }
    const share = counts.map((c) => c / n)
    console.log(`kind shares: ${WEATHER_KINDS.map((k, i) => `${k} ${(share[i]! * 100).toFixed(1)}%`).join(", ")}`)
    // Within a round players see the weather turn: no kind dominates, and it rains most of the time.
    for (const x of share) expect(x).toBeGreaterThan(0.15)
    expect(share[0]!).toBeLessThan(0.35)
    expect(share[3]!).toBeLessThan(share[1]!)
  })

  test("is continuous: smooth fades, never a step", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const prev = weatherAt(seed, 0)
      const cur = makeWeather()
      let worst = 0
      const dt = 0.25
      for (let t = dt; t < 6 * 3600; t += dt) {
        weatherAt(seed, t, cur)
        worst = Math.max(worst, maxFieldDiff(prev, cur))
        Object.assign(prev, cur)
      }
      // smootherstep's peak slope is 15/8 per fade; adjacent presets differ by < 0.65.
      expect(worst).toBeLessThan((15 / 8 / WEATHER_FADE[0]) * dt * 0.65 + 1e-9)
    }
  })

  test("transitions sit at slot boundaries and hold presets between them; dwell times are minutes", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      for (let k = WEATHER_CALM_SLOTS; k < 400; k++) {
        const start = slotStart(seed, k)
        const fade = slotFade(seed, k)
        expect(fade).toBeGreaterThanOrEqual(WEATHER_FADE[0])
        expect(fade).toBeLessThanOrEqual(WEATHER_FADE[1])
        expect(slotAt(seed, start + 0.001)).toBe(k)
        expect(slotAt(seed, start - 0.001)).toBe(k - 1)
        const before = WEATHER_PRESETS[WEATHER_KINDS[slotKind(seed, k - 1)]!]
        const after = WEATHER_PRESETS[WEATHER_KINDS[slotKind(seed, k)]!]
        expect(maxFieldDiff(weatherAt(seed, start - fade / 2 - 0.01), before)).toBeLessThan(1e-9)
        expect(maxFieldDiff(weatherAt(seed, start + fade / 2 + 0.01), after)).toBeLessThan(1e-9)
        // Some dwell between this fade and the next.
        expect(slotStart(seed, k + 1) - slotFade(seed, k + 1) / 2 - (start + fade / 2)).toBeGreaterThan(20)
      }
      const spans = weatherSchedule(seed, 3 * 3600, 12)
      expect(spans.length).toBe(12)
      for (let i = 0; i < spans.length; i++) {
        const s = spans[i]!
        expect(s.end - s.start).toBeGreaterThan(WEATHER_SLOT - 2 * WEATHER_JITTER - 1)
        if (i) expect(s.start).toBe(spans[i - 1]!.end)
        expect(WEATHER_KINDS.indexOf(s.kind)).toBe(slotKind(seed, slotAt(seed, (s.start + s.end) / 2)))
      }
    }
  })
})

describe("overrides", () => {
  test("fade from the snapshot to the target; null returns to the timeline; chains stay continuous", () => {
    const seed = 42
    const t0 = 5000
    const o = overrideTo(seed, null, t0, "heavy", 90)
    expect(packWeather(weatherNow(seed, t0 - 10, o))).toEqual(packWeather(weatherAt(seed, t0 - 10)))
    expect(maxFieldDiff(weatherNow(seed, t0, o), weatherAt(seed, t0))).toBeLessThan(1e-4)
    expect(weatherNow(seed, t0 + 90, o)).toEqual(makeWeather(WEATHER_PRESETS.heavy))
    expect(weatherNow(seed, t0 + 5000, o)).toEqual(makeWeather(WEATHER_PRESETS.heavy))
    const mid = weatherNow(seed, t0 + 45, o)
    expect(mid.rain).toBeGreaterThan(Math.min(o.from.rain, 1) - 1e-9)

    // Interrupt mid-fade with a new override: continuous at the switch.
    const t1 = t0 + 30
    const o2 = overrideTo(seed, o, t1, "clear", 60)
    const room = new RoomWeather(seed)
    room.set(o)
    room.set(o2)
    expect(room.active(t1 - 0.5)).toBe(o)
    expect(room.active(t1 + 0.5)).toBe(o2)
    expect(maxFieldDiff(room.at(t1 + 1e-6), weatherNow(seed, t1, o))).toBeLessThan(1e-4)
    // Back to the timeline: continuous at the switch, then exactly the timeline.
    const t2 = t1 + 200
    const o3 = overrideTo(seed, o2, t2, null, 60)
    expect(maxFieldDiff(weatherNow(seed, t2 + 1e-6, o3), weatherNow(seed, t2, o2))).toBeLessThan(1e-4)
    for (const t of [t2 + 60.01, t2 + 400, t2 + 3000]) expect(weatherNow(seed, t, o3)).toEqual(weatherAt(seed, t))
    // Continuous through the whole chain, as a client sees it (each override arrives a second before it starts).
    const client = new RoomWeather(seed)
    let worst = 0
    let prev = client.at(t0 - 5)
    for (let t = t0 - 5; t < t2 + 120; t += 0.1) {
      if (t > t0 - 1 && client.cur === null) client.set(o)
      if (t > t1 - 1 && client.cur === o) client.set(o2)
      if (t > t2 - 1 && client.cur === o2) client.set(o3)
      const w = client.at(t)
      worst = Math.max(worst, maxFieldDiff(prev, w))
      prev = w
    }
    expect(worst).toBeLessThan(0.01)
  })

  test("custom targets are clamped; the wire form round-trips exactly what the server holds; junk is rejected", () => {
    const custom = { ...WEATHER_PRESETS.medium, rain: 7, windDir: -400, sea: 0.123456789 }
    const o = overrideTo(9, null, 1234.5, custom, 30)
    expect(o.to!.rain).toBe(1)
    expect(o.to!.windDir).toBe(-180)
    expect(o.to!.sea).toBe(0.1235)
    const wire = JSON.parse(JSON.stringify(packOverride(o)))
    expect(unpackOverride(wire)).toEqual(o)
    const back = overrideTo(9, o, 2000, null)
    expect(unpackOverride(JSON.parse(JSON.stringify(packOverride(back))))).toEqual(back)
    // The server and a client agree on the room's weather after the round trip.
    for (const t of [1000, 1240, 1300, 2050, 9000]) expect(weatherNow(9, t, unpackOverride(wire))).toEqual(weatherNow(9, t, o))
    expect(JSON.stringify(packOverride(o)).length).toBeLessThan(400)
    expect(unpackOverride(null)).toBeNull()
    expect(unpackOverride([1, 2, 3])).toBeNull()
    expect(unpackOverride([1, -5, ...packWeather(o.from)])).toBeNull()
    expect(unpackOverride([1, 5, ...packWeather(o.from).slice(1), "x"])).toBeNull()
    expect(unpackWeather([...packWeather(o.from).slice(1), NaN])).toBeNull()
  })
})

describe("lightning", () => {
  test("only in storms, deterministic, about the configured rate, flashes in [0, 1]", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const clear = overrideTo(seed, null, 0, "clear", 0)
      expect(strikesBetween(seed, 10, 3610, clear).length).toBe(0)
      const heavy = overrideTo(seed, null, 0, "heavy", 0)
      const strikes = strikesBetween(seed, 10, 3610, heavy)
      const perMin = strikes.length / 60
      expect(perMin).toBeGreaterThan(WEATHER_PRESETS.heavy.lightning * LIGHTNING_PER_MIN * 0.75)
      expect(perMin).toBeLessThan(WEATHER_PRESETS.heavy.lightning * LIGHTNING_PER_MIN * 1.25)
      expect(strikesBetween(seed, 10, 3610, heavy)).toEqual(strikes)
      for (const s of strikes.slice(0, 40)) {
        let peak = 0
        for (let dt = -0.1; dt < 1.2; dt += 0.005) {
          const f = lightningAt(seed, s.t + dt, heavy)
          expect(f).toBeGreaterThanOrEqual(0)
          expect(f).toBeLessThanOrEqual(1)
          peak = Math.max(peak, f)
        }
        expect(peak).toBeGreaterThan(0.3)
        expect(strikeFlash(s, -0.01)).toBe(0)
        expect(strikeFlash(s, 0.95)).toBe(0)
        expect(s.dist).toBeGreaterThan(800)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Sea coupling. float32 emulation of SEA_WGSL (same as tests/sea.test.ts), one Math.fround per WGSL operation.
// ---------------------------------------------------------------------------------------------------------------
const f = Math.fround
const TAU32 = f(6.283185307179586)
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
function grad32(u: Float32Array, px: number, py: number): [number, number] {
  let jxx = 0
  let jxz = 0
  let jzz = 0
  let gx = 0
  let gz = 0
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
  }
  const xx = f(1 + jxx)
  const zz = f(1 + jzz)
  const det = f(f(xx * zz) - f(jxz * jxz))
  return [f(f(f(zz * gx) - f(jxz * gz)) / det), f(f(f(xx * gz) - f(jxz * gx)) / det)]
}

const steepness = (sea: Sea) => sea.waves.reduce((sum, w) => sum + w.steep * w.k * w.amp, 0)

/** Crest-to-trough heights in 600 m windows (a long swell's crest and trough) along six 6 km lines down the swell. */
function setHeights(sea: Sea, t: number): number[] {
  const d = new Float64Array(3)
  const out: number[] = []
  for (let line = 0; line < 6; line++) {
    const ox = -sea.swell[1] * line * 430
    const oz = sea.swell[0] * line * 430
    let hi = -Infinity
    let lo = Infinity
    for (let s = 0; s < 6000; s += 3) {
      seaDisplace(sea, ox + sea.swell[0] * s, oz + sea.swell[1] * s, t + line * 17, d)
      hi = Math.max(hi, d[1]!)
      lo = Math.min(lo, d[1]!)
      if (s % 600 === 597) {
        out.push(hi - lo)
        hi = -Infinity
        lo = Infinity
      }
    }
  }
  return out.sort((a, b) => a - b)
}

describe("sea coupling", () => {
  test("clear weather is exactly the seed's sea; the view never touches k, omega, direction or phase", () => {
    for (const seed of SEEDS) {
      const base = makeSea(seed)
      const v = makeWeatherSea(base)
      expect(v.sea.waves.length).toBeLessThanOrEqual(SEA_MAX_WAVES)
      for (let i = 0; i < base.waves.length; i++) expect(v.sea.waves[i]).toEqual(base.waves[i]!)
      for (let i = base.waves.length; i < v.sea.waves.length; i++) expect(v.sea.waves[i]!.amp).toBe(0)
      const d0 = seaDisplace(base, 123, 456, 789)
      expect(seaDisplace(v.sea, 123, 456, 789)).toEqual(d0)
      const before = v.sea.waves.map((w) => [w.k, w.omega, w.dirX, w.dirZ, w.phase])
      v.set(WEATHER_PRESETS.heavy)
      expect(v.sea.waves.map((w) => [w.k, w.omega, w.dirX, w.dirZ, w.phase])).toEqual(before)
      v.set(WEATHER_PRESETS.clear)
      expect(seaDisplace(v.sea, 123, 456, 789)).toEqual(d0)
      // Storm components never share a wavelength with the sea's own.
      for (const s of stormWaves(base)) for (const w of base.waves) expect(Math.abs(s.k / w.k - 1)).toBeGreaterThan(0.002)
    }
  })

  test("the surface moves continuously through a storm's arrival (no phase jumps)", () => {
    const seed = 3
    const v = makeWeatherSea(makeSea(seed))
    const o = overrideTo(seed, null, 100, "heavy", 60)
    const w = makeWeather()
    const d = new Float64Array(3)
    for (const [x, z] of [[0, 0], [5000, -7000], [-20000, 3000]] as const) {
      let prev: number[] | null = null
      let worst = 0
      const dt = 1 / 60
      for (let t = 95; t < 170; t += dt) {
        v.set(weatherNow(seed, t, o, w))
        seaDisplace(v.sea, x, z, t, d)
        if (prev) worst = Math.max(worst, Math.hypot(d[0]! - prev[0]!, d[1]! - prev[1]!, d[2]! - prev[2]!))
        prev = [d[0]!, d[1]!, d[2]!]
      }
      // Fastest particle speed in the storm is Σ A ω (Q + 1) ~ 12 m/s: under 0.25 m per frame.
      expect(worst).toBeLessThan(0.25)
    }
  })

  test("never loops at max storm, for every swell/chop balance; steepness capped", () => {
    const s = new Float64Array(4)
    for (const seed of SEEDS.slice(0, 6)) {
      const v = makeWeatherSea(makeSea(seed))
      for (const swell of [0, 0.5, 1]) {
        v.set({ ...WEATHER_PRESETS.heavy, swell })
        expect(steepness(v.sea)).toBeLessThanOrEqual(STORM_SEA.steepCap + 1e-9)
        let min = Infinity
        for (let t = 0; t < 16; t += 1.3)
          for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) min = Math.min(min, seaSlope(v.sea, i * 2.7 + 5000, j * 2.9 - 3000, t, s)[3]!)
        expect(min).toBeGreaterThan(0.15)
      }
    }
  })

  test("heavy storm: big sets reach 18-26 m crest to trough; medium 10-16 m; light barely above calm", () => {
    const report: string[] = []
    const mean = (a: number[]) => a.reduce((x, y) => x + y) / a.length
    for (const seed of SEEDS) {
      const base = makeSea(seed)
      const v = makeWeatherSea(base)
      const calm = setHeights(base, 1000)
      v.set(WEATHER_PRESETS.heavy)
      const storm = setHeights(v.sea, 1000)
      const big = storm[storm.length - 1]!
      v.set(WEATHER_PRESETS.medium)
      const med = setHeights(v.sea, 1000)
      v.set(WEATHER_PRESETS.light)
      const light = setHeights(v.sea, 1000)
      report.push(`${seed}: ${mean(calm).toFixed(1)}/${calm[calm.length - 1]!.toFixed(1)}, ${mean(light).toFixed(1)}/${light[light.length - 1]!.toFixed(1)}, ${mean(med).toFixed(1)}/${med[med.length - 1]!.toFixed(1)}, ${mean(storm).toFixed(1)}/${big.toFixed(1)} m`)
      expect(big).toBeGreaterThan(18)
      expect(big).toBeLessThan(26)
      expect(mean(storm) / mean(calm)).toBeGreaterThan(1.9)
      expect(med[med.length - 1]!).toBeGreaterThan(10)
      expect(med[med.length - 1]!).toBeLessThan(16)
      expect(mean(med)).toBeGreaterThan(mean(calm) * 1.15)
      expect(mean(light) / mean(calm)).toBeGreaterThan(1.01)
      expect(mean(light) / mean(calm)).toBeLessThan(1.1)
    }
    console.log(`sets (mean/max) clear, light, medium, heavy: ${report.join("; ")}`)
  })

  test("the storm keeps sharp swell crests: the chop gives up Gerstner Q before the swell does", () => {
    for (const seed of SEEDS) {
      const v = makeWeatherSea(makeSea(seed))
      v.set(WEATHER_PRESETS.heavy)
      // The swell's Q only drops once everything else is already at its floor.
      if (v.steep < 1) expect(v.steepOther).toBe(STORM_SEA.otherQFloor)
      // Primary swell crests stay Gerstner-sharp: the biggest swell component keeps Q near 1 or more.
      const classes = classifyWaves(v.base)
      let best = -1
      for (let i = 0; i < classes.length; i++) if (classes[i] === WaveClass.Swell && (best < 0 || v.sea.waves[i]!.amp > v.sea.waves[best]!.amp)) best = i
      expect(v.sea.waves[best]!.steep).toBeGreaterThan(0.7)
    }
  })

  test("chop kicks up with the wind: wind-aligned chop grows most; swell balance shifts the energy", () => {
    const base = makeSea(42)
    const v = makeWeatherSea(base)
    const classes = classifyWaves(base)
    v.set(WEATHER_PRESETS.heavy)
    let alongMax = 0
    let crossMin = Infinity
    for (let i = 0; i < base.waves.length; i++) {
      if (classes[i] !== WaveClass.Chop) continue
      const w = base.waves[i]!
      const a = w.dirX * base.wind[0] + w.dirZ * base.wind[1]
      if (a > 0.95) alongMax = Math.max(alongMax, v.scale[i]!)
      if (a < 0.7) crossMin = Math.min(crossMin, v.scale[i]!)
    }
    expect(alongMax).toBeGreaterThan(crossMin)
    const chopOnly = seaScales({ ...WEATHER_PRESETS.heavy, swell: 0 })
    const swellOnly = seaScales({ ...WEATHER_PRESETS.heavy, swell: 1 })
    expect(chopOnly.swell).toBe(1)
    expect(chopOnly.chopAlong).toBe(STORM_SEA.chopAlong)
    expect(swellOnly.chopAlong).toBe(1)
    expect(swellOnly.swell).toBe(STORM_SEA.swell)
  })

  test("CPU (f64) and GPU (emulated f32) agree on the storm sea far from the origin", () => {
    const u = new Float32Array(SEA_UNIFORM_FLOATS)
    const d = new Float64Array(3)
    const s = new Float64Array(4)
    let worstD = 0
    let worstG = 0
    for (const seed of SEEDS) {
      const v = makeWeatherSea(makeSea(seed))
      for (const [cx, cz, t, w] of [
        [20013.7, -19876.2, 36000.37, WEATHER_PRESETS.heavy],
        [-23456.1, 21987.6, 10 * 3600 + 1234.567, WEATHER_PRESETS.medium],
        [3.3, 7.7, 86400 - 0.01, { ...WEATHER_PRESETS.heavy, swell: 0 }],
      ] as const) {
        v.set(w)
        const ox = snapSeaOrigin(cx)
        const oz = snapSeaOrigin(cz)
        packSea(v.sea, t, u, ox, oz)
        for (let i = 0; i < 160; i++) {
          const r = 2000 * Math.sqrt(i / 160)
          const a = i * 2.39996
          const x = cx + r * Math.cos(a)
          const z = cz + r * Math.sin(a)
          const g = displace32(u, f(x - ox), f(z - oz))
          seaDisplace(v.sea, x, z, t, d)
          worstD = Math.max(worstD, Math.hypot(g[0] - d[0]!, g[1] - d[1]!, g[2] - d[2]!))
          const gr = grad32(u, f(x - ox), f(z - oz))
          seaSlope(v.sea, x, z, t, s)
          worstG = Math.max(worstG, Math.abs(gr[0] - s[0]!), Math.abs(gr[1] - s[1]!))
        }
      }
    }
    console.log(`storm f32 vs f64: displacement ${(worstD * 1000).toFixed(2)} mm, gradient ${worstG.toExponential(2)}`)
    expect(worstD).toBeLessThan(0.03)
    expect(worstG).toBeLessThan(3e-3)
  })

  test("buoyancy works unchanged on the view: seaHeight inverts the storm surface", () => {
    const d = new Float64Array(3)
    const rest = new Float64Array(2)
    for (const seed of SEEDS.slice(0, 5)) {
      const v = makeWeatherSea(makeSea(seed))
      v.set(WEATHER_PRESETS.heavy)
      for (let i = 0; i < 200; i++) {
        const x = Math.sin(i * 12.9898 + seed) * 9000
        const z = Math.cos(i * 78.233 + seed) * 9000
        const t = i * 77.7
        seaRest(v.sea, x, z, t, rest)
        seaDisplace(v.sea, rest[0]!, rest[1]!, t, d)
        expect(Math.hypot(rest[0]! + d[0]! - x, rest[1]! + d[2]! - z)).toBeLessThan(1e-3)
        expect(Math.abs(seaHeight(v.sea, x, z, t) - d[1]!)).toBeLessThan(1e-9)
      }
    }
  })
})

describe("rain shader", () => {
  test("RAIN_WGSL validates with naga when available", () => {
    const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find((p): p is string => !!p && existsSync(p))
    if (!naga) {
      console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
      return
    }
    const dir = mkdtempSync(join(tmpdir(), "rain-wgsl-"))
    try {
      const file = join(dir, "rain.wgsl")
      writeFileSync(file, RAIN_WGSL)
      const run = Bun.spawnSync([naga, file])
      expect(run.stderr.toString() + run.stdout.toString()).toContain("Validation successful")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("room weather (protocol + server)", () => {
  test("a broadcast override reaches everyone, joiners get it, ships float on the room's storm sea", async () => {
    const { RoomCore } = await import("../server/core")
    const { BUILD } = await import("../shared/build.gen")
    const { decodeClient, decodeServer, encode } = await import("../shared/protocol")
    const { seaStorm } = await import("../shared/ship")
    type Msg = NonNullable<ReturnType<typeof decodeServer>>
    const conn = () => {
      const sent: Msg[] = []
      return { sent, send: (d: string) => void sent.push(decodeServer(d)!), close: () => {} }
    }
    let now = 1_000_000
    // Overrides are dev tools: only a dev room takes them (tests/bots.test.ts checks a production room refuses them).
    const core = new RoomCore(
      () => now,
      () => 42,
      { dev: true },
    )
    const a = conn()
    core.message(a, encode({ type: "hello", build: BUILD, name: "ada" }))
    // A joiner always hears the room's weather (null: the seeded timeline).
    expect(a.sent.filter((m) => m.type === "weather").at(-1)).toEqual({ type: "weather", o: null })
    // Validation: junk is dropped, kinds, "auto" and custom weathers decode.
    expect(decodeClient(encode({ type: "weather", to: "tornado" as never, f: 10 }))).toBeNull()
    expect(decodeClient(encode({ type: "weather", to: "heavy", f: 9999 }))).toBeNull()
    expect(decodeClient(encode({ type: "weather", to: packWeather(WEATHER_PRESETS.medium), f: 30 }))).not.toBeNull()
    core.message(a, encode({ type: "weather", to: "heavy", f: 20 }))
    const msg = a.sent.filter((m) => m.type === "weather").at(-1) as Extract<Msg, { type: "weather" }>
    const o = unpackOverride(msg.o)!
    expect(o.to).toEqual(makeWeather(WEATHER_PRESETS.heavy))
    expect(o.fade).toBe(20)
    const b = conn()
    core.message(b, encode({ type: "hello", build: BUILD, name: "bo" }))
    expect(b.sent.filter((m) => m.type === "weather").at(-1)).toEqual(msg)
    // A client holding the override computes the same weather as the room.
    const client = new RoomWeather(core.world!.seed)
    client.set(o)
    for (let i = 0; i < 30 * 20; i++) {
      now += 50
      core.step(now)
    }
    const t = (now - core.world!.epoch) / 1000
    expect(client.at(t)).toEqual(makeWeather(WEATHER_PRESETS.heavy))
    const sea = (core as unknown as { sea: Sea }).sea
    expect(seaStorm(sea)).toBeGreaterThan(0.8)
    for (const s of core.ships.values()) expect(Number.isFinite(s.heave + s.pitch + s.roll)).toBe(true)
    // Back to the timeline.
    core.message(b, encode({ type: "weather", to: "auto", f: 0 }))
    expect(unpackOverride((a.sent.filter((m) => m.type === "weather").at(-1) as Extract<Msg, { type: "weather" }>).o)!.to).toBeNull()
  })
})
