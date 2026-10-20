import { afterEach, describe, expect, test } from "bun:test"
import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { makeTown, propShape, type Building } from "../shared/map"
import { groundHeight, styledFlats, supportHeight } from "../shared/terrain"
import { roomInner } from "../shared/houses/geometry"
import { HOUSE_CONDITIONS, HOUSE_FORMS } from "../shared/houses/style"
import { DEFAULT_HOUSE_VARIETY, houseVarietyKey, resetHouseVariety, setHouseVariety } from "../shared/houses/variety"
import { buildChunkNavTile, generateWorldChunk, StreamingWorld, type WorldChunk } from "../shared/world"

afterEach(() => resetHouseVariety())

const TODAY = { ...DEFAULT_HOUSE_VARIETY, enabled: false }

/** Chunks around the origin and every styled home in them. */
function sample(r = 12, seed = 7): { chunk: WorldChunk; b: Building }[] {
  const out: { chunk: WorldChunk; b: Building }[] = []
  for (let cy = -r; cy <= r; cy++) {
    for (let cx = -r; cx <= r; cx++) {
      const chunk = generateWorldChunk(seed, seed, cx, cy, "streaming")
      for (const b of chunk.buildings) if (b.style) out.push({ chunk, b })
    }
  }
  return out
}

const homes = [...sample(12, 7), ...sample(8, 21), ...sample(6, 1234)]

describe("house variety (AR-79)", () => {
  test("Today is one setting away and generates exactly Today's chunks", () => {
    // Hashes from origin/main before house variety (8404f9ab).
    const expected: [number, number, number][] = [[-4, -4, 3229796152], [5, -4, 2705487771], [-4, 3, 1649913710], [5, 3, 1029186939], [-4, 7, 3998631068], [5, 7, 2811631627]]
    for (const [cx, cy, hash] of expected) expect(generateWorldChunk(7, 7, cx, cy, "streaming", TODAY).hash).toBe(hash)
    setHouseVariety({ enabled: false })
    for (const [cx, cy, hash] of expected) expect(generateWorldChunk(7, 7, cx, cy, "streaming").hash).toBe(hash)
    expect(houseVarietyKey()).toBe("today")
  })

  test("generation is deterministic and the sim's stream sees the same chunks (co-op parity)", () => {
    const world = new StreamingWorld(7, 7, 0.22, "streaming")
    for (const [cx, cy] of [[-4, -4], [5, 3], [-7, 2], [4, -8], [10, 10]] as const) {
      const a = generateWorldChunk(7, 7, cx, cy, "streaming")
      const b = generateWorldChunk(7, 7, cx, cy, "streaming", { ...DEFAULT_HOUSE_VARIETY })
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
      expect(world.getOrGenerateChunk(cx, cy).hash).toBe(a.hash)
    }
    // A Lab change is part of the cache key and goes away with a reset.
    const before = generateWorldChunk(7, 7, -4, -4, "streaming").hash
    const key = houseVarietyKey()
    setHouseVariety({ derelict: 0.9 })
    expect(houseVarietyKey()).not.toBe(key)
    resetHouseVariety()
    expect(generateWorldChunk(7, 7, -4, -4, "streaming").hash).toBe(before)
  })

  test("the town has every form and condition, and no two homes alike", () => {
    const forms = new Set(homes.map((h) => h.b.style!.form))
    for (const f of HOUSE_FORMS) expect(forms.has(f)).toBe(true)
    const conditions = new Set(homes.map((h) => h.b.style!.condition))
    for (const c of HOUSE_CONDITIONS) expect(conditions.has(c)).toBe(true)
    const shapes = new Set(homes.map(({ b }) => b.style!.rooms.map((r) => `${r.type}:${(r.rect[2] - r.rect[0]).toFixed(1)}x${(r.rect[3] - r.rect[1]).toFixed(1)}`).join("|")))
    expect(shapes.size).toBeGreaterThan(homes.length * 0.9)
    const roofs = new Set(homes.map(({ b }) => b.style!.roof))
    expect(roofs.size).toBeGreaterThanOrEqual(5)
    const households = new Set(homes.map(({ b }) => b.style!.household))
    expect(households.size).toBe(6)
  })

  test("every home stays in its chunk with unique ids, a front door and at most six doors", () => {
    expect(homes.length).toBeGreaterThan(150)
    for (const { chunk, b } of homes) {
      const [x0, z0, x1, z1] = chunk.bounds
      for (const w of chunk.barriers) {
        expect(w.rect[0]).toBeGreaterThanOrEqual(x0)
        expect(w.rect[2]).toBeLessThanOrEqual(x1)
        expect(w.rect[1]).toBeGreaterThanOrEqual(z0)
        expect(w.rect[3]).toBeLessThanOrEqual(z1)
      }
      const doors = chunk.doors.filter((d) => d.id.startsWith(b.id))
      expect(doors.some((d) => d.id === `${b.id}-front`)).toBe(true)
      expect(doors.length).toBeLessThanOrEqual(6)
      const ids = [...chunk.doors.map((d) => d.id), ...chunk.windows.map((w) => w.id), ...chunk.containers.map((c) => c.id)]
      expect(new Set(ids).size).toBe(ids.length)
      for (const w of chunk.windows) if (w.boarded) expect(w.openable).toBe(false)
    }
  })

  test("survivors reach every room and every container from the street, doors open", () => {
    const CELL = 0.1, R = 0.3
    for (const { chunk, b } of homes) {
      const [ox, oz] = chunk.bounds
      const n = Math.round(32 / CELL)
      const blocked = new Uint8Array(n * n)
      const solids: Rect[] = [...chunk.barriers.map((w) => w.rect), ...chunk.vehicles]
      for (const p of chunk.props) {
        const s = propShape(p)
        if (s) solids.push(s.rect)
      }
      for (const s of solids) {
        const i0 = Math.max(0, Math.floor((s[0] - R - ox) / CELL)), i1 = Math.min(n - 1, Math.floor((s[2] + R - ox) / CELL))
        const k0 = Math.max(0, Math.floor((s[1] - R - oz) / CELL)), k1 = Math.min(n - 1, Math.floor((s[3] + R - oz) / CELL))
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (distToRect(ox + (i + 0.5) * CELL, oz + (k + 0.5) * CELL, s) < R) blocked[i + k * n] = 1
      }
      const seen = new Uint8Array(n * n)
      const q: number[] = []
      for (let i = 0; i < n; i++) for (const c of [i, i + (n - 1) * n, i * n, i * n + n - 1]) if (!blocked[c] && !seen[c]) { seen[c] = 1; q.push(c) }
      while (q.length) {
        const c = q.pop()!
        const i = c % n, k = (c - i) / n
        for (const [a, e] of [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]]) {
          if (a! < 0 || e! < 0 || a! >= n || e! >= n) continue
          const m = a! + e! * n
          if (!seen[m] && !blocked[m]) { seen[m] = 1; q.push(m) }
        }
      }
      const reach = (r: Rect, pad: number) => {
        for (let z = r[1] - pad; z <= r[3] + pad; z += CELL) for (let x = r[0] - pad; x <= r[2] + pad; x += CELL) {
          const i = Math.floor((x - ox) / CELL), k = Math.floor((z - oz) / CELL)
          if (i >= 0 && k >= 0 && i < n && k < n && seen[i + k * n]) return true
        }
        return false
      }
      const rects = b.style!.rooms.map((r) => r.rect)
      for (const room of b.style!.rooms) {
        const inner = roomInner(room.rect, rects)
        expect({ id: b.id, room: room.type, ok: reach([inner[0] + 0.35, inner[1] + 0.35, inner[2] - 0.35, inner[3] - 0.35], 0) }).toEqual({ id: b.id, room: room.type, ok: true })
      }
      for (const c of chunk.containers) if (c.buildingId === b.id) expect({ id: c.id, ok: reach(c.rect, 0.8) }).toEqual({ id: c.id, ok: true })
    }
  })

  test("zombies' nav tiles connect every room to the street through doors", () => {
    let rooms = 0, cut = 0
    for (const { chunk, b } of homes) {
      const tile = buildChunkNavTile(chunk, () => 0)
      const passable = (c: number) => tile[c] === 0 || tile[c] === 2 || tile[c] === 3
      const seen = new Uint8Array(64 * 64)
      const q: number[] = []
      for (let i = 0; i < 64; i++) for (const c of [i, i + 63 * 64, i * 64, i * 64 + 63]) if (passable(c) && !seen[c]) { seen[c] = 1; q.push(c) }
      while (q.length) {
        const c = q.pop()!
        const i = c % 64, k = (c - i) / 64
        for (const [a, e] of [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]]) {
          if (a! < 0 || e! < 0 || a! >= 64 || e! >= 64) continue
          const m = a! + e! * 64
          if (!seen[m] && passable(m)) { seen[m] = 1; q.push(m) }
        }
      }
      const rects = b.style!.rooms.map((r) => r.rect)
      for (const room of b.style!.rooms) {
        rooms++
        const inner = roomInner(room.rect, rects)
        let ok = false
        for (let z = inner[1]; z <= inner[3] && !ok; z += 0.25) for (let x = inner[0]; x <= inner[2] && !ok; x += 0.25) {
          const i = Math.floor((x - chunk.bounds[0]) / 0.5), k = Math.floor((z - chunk.bounds[1]) / 0.5)
          if (i >= 0 && k >= 0 && i < 64 && k < 64 && seen[i + k * 64]) ok = true
        }
        if (!ok) cut++
      }
    }
    // The 0.5 m nav grid is coarse; nearly every room must still be on it.
    expect(cut / rooms).toBeLessThan(0.02)
  })

  test("garages roll the garage table, burnt and ransacked homes start bare", () => {
    const garage = homes.flatMap(({ chunk, b }) => chunk.containers.filter((c) => c.buildingId === b.id && c.table === "garage"))
    expect(garage.length).toBeGreaterThan(0)
    const burnt = homes.filter(({ b }) => b.style!.condition === "burnt")
    for (const { chunk, b } of burnt) for (const c of chunk.containers) if (c.buildingId === b.id) expect(c.ammo).toBe(0)
  })

  test("front paths and driveways lie on level ground, so their pads never sink into the lawn", () => {
    let samples = 0
    for (const { chunk, b } of homes) {
      const town = { ...makeTown(7), buildings: chunk.buildings, barriers: chunk.barriers, doors: chunk.doors, activeChunkKeys: [chunk.key] }
      const flats = styledFlats(town, b)
      expect(flats.length).toBeGreaterThanOrEqual(2)
      for (const f of flats) {
        for (let z = f[1]; z <= f[3]; z += 0.5) {
          for (let x = f[0]; x <= f[2]; x += 0.5) {
            samples++
            // The pads sit at 3–3.5 cm; walking on them stands on them.
            expect(groundHeight(town, x, z)).toBeLessThan(0.025)
            if (!b.style!.rooms.some((r) => x >= r.rect[0] && x <= r.rect[2] && z >= r.rect[1] && z <= r.rect[3])) expect(supportHeight(town, x, z)).toBeGreaterThanOrEqual(0.014)
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(5000)
  })
})
