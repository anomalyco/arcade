import { describe, expect, test } from "bun:test"
import {
  AIRBASES, CEILING, DECK_LAYOUT, FLEET_CLEARANCE, LAUNCH_LANE_HALF, LAUNCH_LANE_LENGTH, MESH_CELL, WATER_LEVEL, WORLD_HALF, WORLD_SIZE, bakeWorld, groundHeight,
  heightBound, inSafeZone, isWater, onRunway, segmentHitsGround, shipAt, spawnPoint, surfaceType, terrainHeight,
  terrainMeshHeight, worldMesh, worldQuery,
} from "../src/sim/geography"
import { AA_RANGE, FLEET, SHIP_SPECS, shipToWorld } from "../src/sim/fleet"
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
    expect(centralMax).toBeGreaterThan(380)
    expect(max).toBeLessThan(1000)
    expect(land / 60_000).toBeGreaterThan(0.05)
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
    // Every rendered (non-skirt) LOD0 triangle of the central cluster must lie on the physics surface.
    const data = generateCluster(1, 1, 0)
    const r = rng(4)
    const pos = data.positions, idx = data.index
    const tris = idx.length / 3
    let maxErr = 0, checked = 0
    for (let k = 0; k < 8000; k++) {
      const t = Math.floor(r() * tris) * 3
      const v = [idx[t], idx[t + 1], idx[t + 2]]
      const xs = v.map(i => pos[i * 3]), ys = v.map(i => pos[i * 3 + 1]), zs = v.map(i => pos[i * 3 + 2])
      const area = (xs[1] - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (zs[1] - zs[0])
      if (Math.abs(area) < 1) continue // skirt
      let u = r(), w2 = r()
      if (u + w2 > 1) { u = 1 - u; w2 = 1 - w2 }
      const w = 1 - u - w2
      const lx = xs[0] * w + xs[1] * u + xs[2] * w2, ly = ys[0] * w + ys[1] * u + ys[2] * w2, lz = zs[0] * w + zs[1] * u + zs[2] * w2
      maxErr = Math.max(maxErr, Math.abs(terrainMeshHeight(lx, lz) - ly))
      checked++
    }
    expect(checked).toBeGreaterThan(4000)
    expect(maxErr).toBeLessThan(0.01)
    expect(data.maxY).toBeGreaterThan(150)
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

describe("strike groups", () => {
  test("open water around every ship and along each carrier's launch path", () => {
    for (const sh of FLEET) {
      for (let r = 0; r <= FLEET_CLEARANCE; r += 50) for (let a = 0; a < 64; a++) {
        const ang = (a / 64) * Math.PI * 2
        expect(terrainMeshHeight(sh.position[0] + Math.cos(ang) * r, sh.position[2] + Math.sin(ang) * r)).toBeLessThan(0)
      }
      if (sh.kind === "carrier") {
        for (let d = 0; d <= LAUNCH_LANE_LENGTH; d += 25) for (const c of [-LAUNCH_LANE_HALF, 0, LAUNCH_LANE_HALF]) {
          const p = shipToWorld(sh, [c, 0, -d])
          expect(terrainMeshHeight(p[0], p[2])).toBeLessThan(0)
        }
      }
    }
  })

  test("AIRBASES are derived from the carriers", () => {
    for (const base of AIRBASES) {
      const c = FLEET.find(s => s.team === base.team && s.kind === "carrier")!
      expect(base.center[0]).toBeCloseTo(c.position[0])
      expect(base.center[2]).toBeCloseTo(c.position[2])
      expect(base.center[1]).toBe(SHIP_SPECS.carrier.deckHeight)
      expect(base.heading).toBe(c.heading)
      expect(base.safeRadius).toBe(AA_RANGE)
      // Bow points at the map centre.
      const fx = -Math.sin(base.heading), fz = -Math.cos(base.heading)
      const d = Math.hypot(base.center[0], base.center[2])
      expect(fx * -base.center[0] / d + fz * -base.center[2] / d).toBeCloseTo(1, 6)
    }
  })

  test("decks are solid ground; the carrier flight deck is a runway", () => {
    for (const sh of FLEET) {
      const sp = SHIP_SPECS[sh.kind]
      const I = sp.island
      for (let z = -sp.halfLength + 1; z <= sp.halfLength - 1; z += 13) for (let x = -sp.halfWidth + 1; x <= sp.halfWidth - 1; x += 5) {
        const p = shipToWorld(sh, [x, 0, z])
        const inIsland = Math.abs(x - I.center[0]) <= I.half[0] && Math.abs(z - I.center[2]) <= I.half[2]
        expect(shipAt(p[0], p[2])).toBe(sh)
        expect(groundHeight(p[0], p[2])).toBe(inIsland ? I.center[1] + I.half[1] : sp.deckHeight)
        expect(isWater(p[0], p[2])).toBe(false)
        expect(onRunway(p[0], p[2])).toBe(sh.kind === "carrier" && !inIsland)
        expect(surfaceType(p[0], p[2])).toBe("paved")
      }
      // Just outside the hull is open water.
      const out = shipToWorld(sh, [sp.halfWidth + 3, 0, 0])
      expect(groundHeight(out[0], out[2])).toBe(WATER_LEVEL)
      expect(isWater(out[0], out[2])).toBe(true)
      expect(onRunway(out[0], out[2])).toBe(false)
    }
    expect(onRunway(0, 0)).toBe(false)
  })

  test("spawns sit on the carrier deck, facing the bow, without overlap", () => {
    for (const team of TEAMS) {
      const c = FLEET.find(s => s.team === team && s.kind === "carrier")!
      const used: Vec3[] = []
      for (let i = 0; i < DECK_LAYOUT.catapults.length; i++) {
        const s = spawnPoint(team, "fighter", i)
        expect(s.onGround).toBe(true)
        expect(s.yaw).toBe(c.heading)
        expect(shipAt(s.position[0], s.position[2])).toBe(c)
        expect(onRunway(s.position[0], s.position[2])).toBe(true)
        expect(s.position[1] - groundHeight(s.position[0], s.position[2])).toBeCloseTo(2.2, 6)
        expect(inSafeZone(team, s.position)).toBe(true)
        for (const u of used) expect(Math.hypot(u[0] - s.position[0], u[2] - s.position[2])).toBeGreaterThan(15)
        used.push(s.position)
        // At least ~160 m of clear deck ahead of every catapult slot.
        const ahead = shipToWorld(c, [DECK_LAYOUT.catapults[i][0], 0, DECK_LAYOUT.catapults[i][1] - 160])
        expect(onRunway(ahead[0], ahead[2])).toBe(true)
      }
      for (let i = 0; i < DECK_LAYOUT.heloSpots.length; i++) {
        const s = spawnPoint(team, "apache", i)
        expect(onRunway(s.position[0], s.position[2])).toBe(true)
        expect(s.position[1] - groundHeight(s.position[0], s.position[2])).toBeCloseTo(1.9, 6)
        for (const u of used) expect(Math.hypot(u[0] - s.position[0], u[2] - s.position[2])).toBeGreaterThan(14)
        used.push(s.position)
      }
    }
  })

  test("inSafeZone = within AA_RANGE of an own ship", () => {
    for (const sh of FLEET) {
      expect(inSafeZone(sh.team, [sh.position[0] + AA_RANGE - 50, 300, sh.position[2]])).toBe(true)
      const other = ((sh.team + 1) % 4) as TeamId
      expect(inSafeZone(other, [sh.position[0], 300, sh.position[2]])).toBe(false)
    }
    expect(inSafeZone(0, [0, 300, 0])).toBe(false)
  })

  test("segments hit ship hulls and superstructure", () => {
    for (const sh of FLEET) {
      const sp = SHIP_SPECS[sh.kind]
      // Horizontal shot through the hull side at half deck height.
      const a = shipToWorld(sh, [-sp.halfWidth - 50, sp.deckHeight / 2, 0]), b = shipToWorld(sh, [sp.halfWidth + 50, sp.deckHeight / 2, 0])
      const t = segmentHitsGround(a, b)
      expect(t).not.toBeNull()
      expect(t!).toBeCloseTo(50 / (2 * sp.halfWidth + 100), 3)
      // Shot through the island above deck level.
      const I = sp.island
      const c = shipToWorld(sh, [I.center[0] + 40, I.center[1], I.center[2]]), d = shipToWorld(sh, [I.center[0] - 40, I.center[1], I.center[2]])
      const t2 = segmentHitsGround(c, d)
      expect(t2).not.toBeNull()
      expect(t2!).toBeCloseTo((40 - I.half[0]) / 80, 3)
      // Just above the deck, clear of the island: no hit.
      const e = shipToWorld(sh, [-sp.halfWidth + 1, sp.deckHeight + 3, -sp.halfLength + 5]), f = shipToWorld(sh, [-sp.halfWidth + 1, sp.deckHeight + 3, sp.halfLength - 5])
      expect(segmentHitsGround(e, f)).toBeNull()
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
