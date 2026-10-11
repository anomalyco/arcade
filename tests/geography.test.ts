import { describe, expect, test } from "bun:test"
import {
  AIRBASES, BASE_LAYOUT, CEILING, MESH_CELL, SAFE_ZONE_HEIGHT, WATER_LEVEL, WORLD_HALF, WORLD_SIZE, bakeWorld, baseToWorld,
  groundHeight, heightBound, inSafeZone, onRunway, segmentHitsGround, spawnPoint, surfaceType, terrainHeight, terrainMeshHeight,
  worldMesh, worldQuery,
} from "../src/sim/geography"
import { generateCluster } from "../src/render/world/tile-gen"
import type { TeamId, Vec3 } from "../src/sim/types"

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TEAMS: TeamId[] = [0, 1, 2, 3]

describe("heightfield", () => {
  test("procedural bake is fast and cached", () => {
    const ms = bakeWorld()
    console.log(`heightmap bake: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(400)
    const t = performance.now()
    bakeWorld()
    expect(performance.now() - t).toBeLessThan(5)
    expect(WORLD_SIZE).toBe(16_000)
  })

  test("deterministic and finite", () => {
    const r = rng(1)
    let digest = 0
    for (let i = 0; i < 20_000; i++) {
      const x = (r() * 2 - 1) * WORLD_HALF, z = (r() * 2 - 1) * WORLD_HALF
      const h = terrainHeight(x, z)
      expect(Number.isFinite(h)).toBe(true)
      expect(terrainHeight(x, z)).toBe(h)
      digest = (digest * 31 + Math.round(h * 1000)) % 1_000_000_007
    }
    // Same digest when re-sampled (pure function, cache-independent).
    const r2 = rng(1)
    let digest2 = 0
    for (let i = 0; i < 20_000; i++) {
      const x = (r2() * 2 - 1) * WORLD_HALF, z = (r2() * 2 - 1) * WORLD_HALF
      digest2 = (digest2 * 31 + Math.round(terrainHeight(x, z) * 1000)) % 1_000_000_007
    }
    expect(digest2).toBe(digest)
  })

  test("has tall central peaks, islands and open water", () => {
    let max = -Infinity, land = 0, centralMax = -Infinity
    const r = rng(2)
    for (let i = 0; i < 60_000; i++) {
      const x = (r() * 2 - 1) * WORLD_HALF, z = (r() * 2 - 1) * WORLD_HALF
      const h = terrainHeight(x, z)
      max = Math.max(max, h)
      if (h > 0) land++
      if (Math.hypot(x, z) < 2500) centralMax = Math.max(centralMax, h)
    }
    expect(centralMax).toBeGreaterThan(450)
    expect(max).toBeLessThan(1000)
    expect(land / 60_000).toBeGreaterThan(0.1)
    expect(land / 60_000).toBeLessThan(0.4)
  })

  test("heightBound is a conservative upper bound", () => {
    const r = rng(3)
    for (let i = 0; i < 100_000; i++) {
      const x = (r() * 2 - 1) * WORLD_HALF, z = (r() * 2 - 1) * WORLD_HALF
      expect(groundHeight(x, z)).toBeLessThanOrEqual(heightBound(x, z))
    }
  })

  test("groundHeight matches the rendered LOD0 triangles", () => {
    // Every rendered (non-skirt) LOD0 face of the central cluster must lie on the physics surface.
    const data = generateCluster(1, 1, 0)
    const r = rng(4)
    const pos = data.positions
    const faces = pos.length / 9
    let maxErr = 0, checked = 0
    for (let k = 0; k < 8000; k++) {
      const f = Math.floor(r() * faces) * 9
      const xs = [pos[f], pos[f + 3], pos[f + 6]], ys = [pos[f + 1], pos[f + 4], pos[f + 7]], zs = [pos[f + 2], pos[f + 5], pos[f + 8]]
      const area = (xs[1] - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (zs[1] - zs[0])
      if (Math.abs(area) < 1) continue // skirt
      let u = r(), v = r()
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      const w = 1 - u - v
      const lx = xs[0] * w + xs[1] * u + xs[2] * v, ly = ys[0] * w + ys[1] * u + ys[2] * v, lz = zs[0] * w + zs[1] * u + zs[2] * v
      maxErr = Math.max(maxErr, Math.abs(terrainMeshHeight(lx, lz) - ly))
      checked++
    }
    expect(checked).toBeGreaterThan(4000)
    expect(maxErr).toBeLessThan(0.01)
    expect(data.maxY).toBeGreaterThan(300)
  })

  test("groundHeight never below water and equals vertex heights at mesh vertices", () => {
    const r = rng(5)
    for (let i = 0; i < 20_000; i++) {
      const x = (r() * 2 - 1) * WORLD_HALF, z = (r() * 2 - 1) * WORLD_HALF
      expect(groundHeight(x, z)).toBeGreaterThanOrEqual(WATER_LEVEL)
    }
    const m = worldMesh()
    for (let i = 0; i < 2000; i++) {
      const k = (1 + Math.floor(r() * (m.n - 2))) * m.stride + 1 + Math.floor(r() * (m.n - 2))
      expect(terrainMeshHeight(m.vx[k], m.vz[k])).toBeCloseTo(m.h[k], 3)
    }
    expect(m.cell).toBe(MESH_CELL)
  })

  test("worldQuery contract", () => {
    expect(worldQuery.half).toBe(WORLD_HALF)
    expect(worldQuery.ceiling).toBe(CEILING)
    expect(worldQuery.groundHeight(0, 0)).toBe(groundHeight(0, 0))
  })
})

describe("airbases", () => {
  test("cardinal placement and headings toward the center", () => {
    const expected = [[0, 5500], [0, -5500], [-5500, 0], [5500, 0]]
    for (const base of AIRBASES) {
      expect(base.center[0]).toBeCloseTo(expected[base.team][0])
      expect(base.center[2]).toBeCloseTo(expected[base.team][1])
      const fx = -Math.sin(base.heading), fz = -Math.cos(base.heading)
      const toCenter = Math.hypot(base.center[0], base.center[2])
      expect(fx * -base.center[0] / toCenter + fz * -base.center[2] / toCenter).toBeCloseTo(1, 6)
      expect(base.helipads.length).toBe(BASE_LAYOUT.helipads.length)
    }
  })

  test("runways, aprons and helipads are perfectly flat and onRunway", () => {
    for (const base of AIRBASES) {
      const y = base.center[1]
      const rw = BASE_LAYOUT.runway
      for (let a = rw.a0; a <= rw.a1; a += 7.3) for (let c = rw.c0; c <= rw.c1; c += 3.1) {
        const [x, z] = baseToWorld(base, a, c)
        expect(groundHeight(x, z)).toBe(y)
        expect(onRunway(x, z)).toBe(true)
      }
      for (const r of BASE_LAYOUT.paved) for (let a = r.a0; a <= r.a1; a += 11) for (let c = r.c0; c <= r.c1; c += 5) {
        const [x, z] = baseToWorld(base, a, c)
        expect(groundHeight(x, z)).toBe(y)
        expect(onRunway(x, z)).toBe(true)
      }
      for (const p of base.helipads) {
        expect(groundHeight(p[0], p[2])).toBe(p[1])
        expect(onRunway(p[0], p[2])).toBe(true)
        expect(surfaceType(p[0], p[2])).toBe("paved")
      }
      // Flat margin around the runway (no hills/trees intruding on takeoff).
      const F = BASE_LAYOUT.flat
      const m = MESH_CELL * 1.5 // jittered edge cells blend into the shoulder
      for (let a = F.a0 + m; a <= F.a1 - m; a += 50) for (let c = F.c0 + m; c <= F.c1 - m; c += 40) {
        const [x, z] = baseToWorld(base, a, c)
        expect(groundHeight(x, z)).toBe(y)
      }
      // Grass beside the runway is not "paved".
      const [gx, gz] = baseToWorld(base, 0, -80)
      expect(onRunway(gx, gz)).toBe(false)
      // Departure path toward the center: clear for 400 m past the runway end, then a 15% climb clears terrain.
      for (let d = 0; d < 1500; d += 25) {
        const [x, z] = baseToWorld(base, rw.a1 + d, 0)
        expect(groundHeight(x, z)).toBeLessThan(y + 5 + Math.max(0, d - 400) * 0.15)
      }
    }
    expect(onRunway(0, 0)).toBe(false)
  })

  test("spawn points sit on the surface inside the safe zone, without overlap", () => {
    for (const team of TEAMS) {
      const base = AIRBASES[team]
      const used: Vec3[] = []
      for (let i = 0; i < 12; i++) {
        const s = spawnPoint(team, "fighter", i)
        expect(s.onGround).toBe(true)
        expect(s.yaw).toBe(base.heading)
        const g = groundHeight(s.position[0], s.position[2])
        expect(s.position[1] - g).toBeCloseTo(2.2, 6)
        expect(onRunway(s.position[0], s.position[2])).toBe(true)
        expect(inSafeZone(team, s.position)).toBe(true)
        for (const u of used) expect(Math.hypot(u[0] - s.position[0], u[2] - s.position[2])).toBeGreaterThan(20)
        used.push(s.position)
      }
      for (let i = 0; i < 8; i++) {
        const s = spawnPoint(team, "apache", i)
        const g = groundHeight(s.position[0], s.position[2])
        expect(s.position[1] - g).toBeCloseTo(1.9, 6)
        expect(onRunway(s.position[0], s.position[2])).toBe(true)
        expect(inSafeZone(team, s.position)).toBe(true)
      }
      for (const kind of ["warthog", "blackbird"] as const) {
        const s = spawnPoint(team, kind, 3)
        expect(onRunway(s.position[0], s.position[2])).toBe(true)
      }
    }
  })

  test("safe zone shape", () => {
    for (const base of AIRBASES) {
      const [x, , z] = base.center
      const y0 = base.center[1]
      expect(base.safeRadius).toBe(500)
      expect(inSafeZone(base.team, [x, 30, z])).toBe(true)
      expect(inSafeZone(base.team, [x, y0 + SAFE_ZONE_HEIGHT - 10, z])).toBe(true)
      expect(inSafeZone(base.team, [x, y0 + SAFE_ZONE_HEIGHT + 10, z])).toBe(false)
      // Covers the whole runway length, and safeRadius to the side.
      for (const a of [BASE_LAYOUT.runway.a0, BASE_LAYOUT.runway.a1]) {
        const [rx, rz] = baseToWorld(base, a, 0)
        expect(inSafeZone(base.team, [rx, 25, rz])).toBe(true)
      }
      const [sx, sz] = baseToWorld(base, 0, base.safeRadius - 20), [ox, oz] = baseToWorld(base, 0, base.safeRadius + 20)
      expect(inSafeZone(base.team, [sx, 25, sz])).toBe(true)
      expect(inSafeZone(base.team, [ox, 25, oz])).toBe(false)
      const other = ((base.team + 1) % 4) as TeamId
      expect(inSafeZone(other, [x, 30, z])).toBe(false)
    }
  })
})

describe("segmentHitsGround", () => {
  function brute(a: Vec3, b: Vec3): number | null {
    const n = 20_000
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const y = a[1] + (b[1] - a[1]) * t
      if (y <= groundHeight(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t)) return t
    }
    return null
  }

  test("matches brute force on random segments over terrain", () => {
    const r = rng(7)
    let agree = 0, total = 0, hits = 0
    for (let i = 0; i < 600; i++) {
      // Bias toward the central islands and low altitudes so most segments matter.
      const x = (r() * 2 - 1) * 6000, z = (r() * 2 - 1) * 6000
      const a: Vec3 = [x, 20 + r() * 700, z]
      const len = 50 + r() * 2500
      const yaw = r() * Math.PI * 2, pitch = (r() - 0.6) * 0.8
      const b: Vec3 = [x + Math.cos(yaw) * Math.cos(pitch) * len, a[1] + Math.sin(pitch) * len, z + Math.sin(yaw) * Math.cos(pitch) * len]
      const got = segmentHitsGround(a, b), want = brute(a, b)
      total++
      if (want !== null) hits++
      const len3 = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      if (got === null && want === null) agree++
      else if (got !== null && want !== null && Math.abs(got - want) * len3 < 1.5) agree++
    }
    expect(hits).toBeGreaterThan(50)
    expect(agree / total).toBeGreaterThan(0.99)
  })

  test("edge cases", () => {
    expect(segmentHitsGround([0, 3000, 0], [100, 3000, 100])).toBeNull()
    expect(segmentHitsGround([7900, -5, 7900], [7910, -5, 7900])).toBe(0)
    // Straight down onto open water.
    const t = segmentHitsGround([7900, 100, 7900], [7900, -100, 7900])
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(0.5, 3)
    // Zero-length segment above ground.
    expect(segmentHitsGround([0, 2000, 0], [0, 2000, 0])).toBeNull()
  })
})

describe("performance", () => {
  test("1M groundHeight calls", () => {
    const r = rng(9)
    const xs = new Float64Array(1_000_000), zs = new Float64Array(1_000_000)
    for (let i = 0; i < xs.length; i++) { xs[i] = (r() * 2 - 1) * WORLD_HALF; zs[i] = (r() * 2 - 1) * WORLD_HALF }
    let sum = 0
    const t0 = performance.now()
    for (let i = 0; i < xs.length; i++) sum += groundHeight(xs[i], zs[i])
    const random = performance.now() - t0
    // Coherent queries (aircraft flying a path) mostly hit the vertex cache.
    const t1 = performance.now()
    for (let i = 0; i < 1_000_000; i++) sum += groundHeight(-3000 + i * 0.006, -500 + Math.sin(i * 1e-5) * 400)
    const coherent = performance.now() - t1
    console.log(`1M groundHeight: random ${random.toFixed(0)} ms, coherent ${coherent.toFixed(0)} ms (sum ${sum.toFixed(0)})`)
    expect(random).toBeLessThan(1500)
    expect(coherent).toBeLessThan(400)
  })

  test("100k bullet segments", () => {
    const r = rng(10)
    const segs: [Vec3, Vec3][] = []
    for (let i = 0; i < 100_000; i++) {
      const x = (r() * 2 - 1) * 7000, z = (r() * 2 - 1) * 7000, y = r() * 900
      const vx = (r() - 0.5) * 2, vy = (r() - 0.5) * 0.6, vz = (r() - 0.5) * 2
      const k = 17 / Math.hypot(vx, vy, vz) // ~1000 m/s over one 60 Hz tick
      segs.push([[x, y, z], [x + vx * k, y + vy * k, z + vz * k]])
    }
    let hits = 0
    const t0 = performance.now()
    for (const [a, b] of segs) if (segmentHitsGround(a, b) !== null) hits++
    const ms = performance.now() - t0
    console.log(`100k bullet segments: ${ms.toFixed(0)} ms, ${hits} hits`)
    expect(ms).toBeLessThan(1000)
  })
})
