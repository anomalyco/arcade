import { describe, expect, test } from "bun:test"
import {
  APRON,
  BOUNDS,
  BOW_Z,
  DECK_WIDTH,
  DECK_X0,
  DECK_X1,
  DECK_Y,
  deckHeightAt,
  ELEVATOR,
  inRect,
  ISLAND,
  LENGTH,
  NUMBER_DIGIT_W,
  NUMBER_GAP,
  NUMBER_Z0,
  NUMBER_Z1,
  CENTERLINE_X,
  PARKING,
  type Rect,
  RUNWAY,
  STERN_Z,
  WEAPON_MOUNTS,
} from "../shared/carrier-spec"
import { buildCarrier, buildVehicle } from "../src/render/carrier-mesh"
import { FLOATS_PER_VERT, Mesh } from "../src/render/mesh"
import { buildShipWeapons, poseWeapon, shipWeaponsRestVerts } from "../src/render/ship-weapons"

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1
const insideDeck = (r: Rect) => r.x0 >= DECK_X0 && r.x1 <= DECK_X1 && r.z0 >= STERN_Z && r.z1 <= BOW_Z

describe("carrier spec", () => {
  test("overall dimensions", () => {
    expect(LENGTH).toBe(BOW_Z - STERN_Z)
    expect(DECK_WIDTH).toBe(DECK_X1 - DECK_X0)
    expect(LENGTH).toBeGreaterThan(300)
    expect(DECK_Y).toBeGreaterThan(15)
  })

  test("runway and apron lie on the deck and do not overlap", () => {
    expect(insideDeck(RUNWAY)).toBe(true)
    expect(insideDeck(APRON)).toBe(true)
    expect(overlaps(RUNWAY, APRON)).toBe(false)
    // Layout A: runway toward port (+X), apron along starboard (−X, about a third of the width).
    expect(RUNWAY.x1).toBeGreaterThan(0)
    expect((RUNWAY.x0 + RUNWAY.x1) / 2).toBeGreaterThan(0)
    expect(CENTERLINE_X).toBeGreaterThan(0)
    expect(APRON.x1).toBeLessThan(0)
    expect(APRON.x0).toBeLessThan(DECK_X0 + 1)
    expect(APRON.x1 - APRON.x0).toBeGreaterThan(DECK_WIDTH * 0.25)
  })

  test("07 sits on the runway at the bow end", () => {
    const left = CENTERLINE_X - (2 * NUMBER_DIGIT_W + NUMBER_GAP) / 2
    expect(inRect(RUNWAY, left, NUMBER_Z0)).toBe(true)
    expect(inRect(RUNWAY, left + 2 * NUMBER_DIGIT_W + NUMBER_GAP, NUMBER_Z1)).toBe(true)
    expect(NUMBER_Z1).toBeGreaterThan(BOW_Z - 30)
  })

  test("island on the starboard edge (−X), outside the runway", () => {
    expect(ISLAND.x0).toBeLessThan(DECK_X0 + 1)
    expect(ISLAND.x0).toBeGreaterThanOrEqual(DECK_X0 - 1)
    expect(ISLAND.x1).toBeLessThan(0)
    expect(overlaps(ISLAND, RUNWAY)).toBe(false)
    expect(overlaps(ISLAND, APRON)).toBe(true)
  })

  test("elevator on the port edge (+X), outside the deck", () => {
    expect(ELEVATOR.x0).toBeGreaterThanOrEqual(DECK_X1 - 2)
    expect(ELEVATOR.x1).toBeGreaterThan(DECK_X1)
  })

  test("parking spots: on the starboard apron, clear of the runway, island and each other", () => {
    for (const p of PARKING) {
      expect(p.x - p.radius).toBeGreaterThanOrEqual(APRON.x0 - 0.01)
      expect(p.x + p.radius).toBeLessThanOrEqual(APRON.x1 + 0.01)
      expect(p.z - p.radius).toBeGreaterThanOrEqual(APRON.z0)
      expect(p.z + p.radius).toBeLessThanOrEqual(APRON.z1)
      expect(p.x + p.radius).toBeLessThan(RUNWAY.x0)
      const box = { x0: p.x - p.radius, x1: p.x + p.radius, z0: p.z - p.radius, z1: p.z + p.radius }
      expect(overlaps(box, ISLAND)).toBe(false)
      expect(deckHeightAt(p.x, p.z)).toBe(DECK_Y)
    }
    for (let i = 0; i < PARKING.length; i++)
      for (let j = i + 1; j < PARKING.length; j++) {
        const a = PARKING[i]!
        const b = PARKING[j]!
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.radius + b.radius)
      }
  })

  test("deckHeightAt", () => {
    expect(deckHeightAt(0, 0)).toBe(DECK_Y)
    expect(deckHeightAt(DECK_X0 + 0.1, STERN_Z + 0.1)).toBe(DECK_Y)
    expect(deckHeightAt(DECK_X1 - 0.1, BOW_Z - 5)).toBe(DECK_Y)
    expect(deckHeightAt(RUNWAY.x0 + 1, NUMBER_Z0)).toBe(DECK_Y)
    expect(deckHeightAt((ELEVATOR.x0 + ELEVATOR.x1) / 2, (ELEVATOR.z0 + ELEVATOR.z1) / 2)).toBe(DECK_Y)
    expect(deckHeightAt((ISLAND.x0 + ISLAND.x1) / 2, (ISLAND.z0 + ISLAND.z1) / 2)).toBeNull()
    expect(deckHeightAt(0, BOW_Z + 1)).toBeNull()
    expect(deckHeightAt(0, STERN_Z - 1)).toBeNull()
    expect(deckHeightAt(DECK_X1 + 1, 0)).toBeNull()
    expect(deckHeightAt(DECK_X0 - 1, -100)).toBeNull()
    expect(deckHeightAt(DECK_X0 + 0.2, BOW_Z - 0.2)).toBeNull()
  })
})

function checkMesh(m: Mesh, name: string, bounds?: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }) {
  const v = m.v
  expect(v.length % (FLOATS_PER_VERT * 3)).toBe(0)
  for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
    for (let k = 0; k < FLOATS_PER_VERT; k++) if (!Number.isFinite(v[i + k]!)) throw new Error(`${name}: non-finite value at vertex ${i / FLOATS_PER_VERT}`)
    const n = Math.hypot(v[i + 3]!, v[i + 4]!, v[i + 5]!)
    if (Math.abs(n - 1) > 1e-3) throw new Error(`${name}: normal length ${n} at vertex ${i / FLOATS_PER_VERT}`)
    for (let k = 6; k < 9; k++) if (v[i + k]! < 0 || v[i + k]! > 1) throw new Error(`${name}: colour out of range`)
    if (bounds) {
      const [x, y, z] = [v[i]!, v[i + 1]!, v[i + 2]!]
      if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1 || z < bounds.z0 || z > bounds.z1) throw new Error(`${name}: vertex (${x}, ${y}, ${z}) outside bounds`)
    }
  }
}

describe("carrier mesh", () => {
  const c = buildCarrier()

  test("deck ships empty; vehicles stay available as standalone models", () => {
    expect(c.vehicles).toEqual([])
    for (const kind of new Set(PARKING.map((p) => p.kind))) {
      const m = buildVehicle(kind)
      expect(m.count).toBeGreaterThan(0)
      checkMesh(m, kind, { x0: -12, x1: 12, y0: 0, y1: 8, z0: -12, z1: 12 })
    }
  })

  test("triangle budget", () => {
    expect(c.triangles).toBe((c.hull.count + c.radar.count) / 3)
    expect(c.triangles).toBeLessThan(40000)
  })

  test("finite geometry, unit normals, inside the declared bounds", () => {
    checkMesh(c.hull, "hull", BOUNDS)
    // The radar is in its own frame around the pivot; placed, it must stay inside the bounds too.
    const [px, py, pz] = c.radarPivot
    checkMesh(c.radar, "radar", { x0: BOUNDS.x0 - px, x1: BOUNDS.x1 - px, y0: BOUNDS.y0 - py, y1: BOUNDS.y1 - py, z0: BOUNDS.z0 - pz, z1: BOUNDS.z1 - pz })
    // Spinning: the radar's horizontal reach must fit at any angle.
    let r = 0
    for (let i = 0; i < c.radar.v.length; i += FLOATS_PER_VERT) r = Math.max(r, Math.hypot(c.radar.v[i]!, c.radar.v[i + 2]!))
    expect(px + r).toBeLessThanOrEqual(BOUNDS.x1)
    expect(inRect(ISLAND, px, pz)).toBe(true)
  })

  test("every triangle's winding agrees with its normal (nothing inside-out after mirroring)", () => {
    for (const [name, m] of [["hull", c.hull], ["radar", c.radar]] as const) {
      const v = m.v
      const F = FLOATS_PER_VERT
      let bad = 0
      for (let i = 0; i < v.length; i += 3 * F) {
        const ax = v[i]!, ay = v[i + 1]!, az = v[i + 2]!
        const ux = v[i + F]! - ax, uy = v[i + F + 1]! - ay, uz = v[i + F + 2]! - az
        const wx = v[i + 2 * F]! - ax, wy = v[i + 2 * F + 1]! - ay, wz = v[i + 2 * F + 2]! - az
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
        const len = Math.hypot(nx, ny, nz)
        if (len < 1e-9) continue
        if ((nx * v[i + 3]! + ny * v[i + 4]! + nz * v[i + 5]!) / len < 0.5) bad++
      }
      expect(`${name}: ${bad} flipped`).toBe(`${name}: 0 flipped`)
    }
  })

  test("island geometry on starboard (−X), elevator geometry on port (+X)", () => {
    const v = c.hull.v
    let islandX = 0
    let islandN = 0
    let elevator = 0
    for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
      const [x, y, z] = [v[i]!, v[i + 1]!, v[i + 2]!]
      if (y > DECK_Y + 10) {
        islandX += x
        islandN++
      }
      if (x > DECK_X1 + 3 && z > ELEVATOR.z0 && z < ELEVATOR.z1 && y > DECK_Y - 0.5) elevator++
      const onWeaponSponson = WEAPON_MOUNTS.some((w) => x >= w.sponson.x0 - 0.1 && z >= w.sponson.z0 - 0.01 && z <= w.sponson.z1 + 0.01)
      if (x < DECK_X0 - 6 && !onWeaponSponson) throw new Error(`geometry beyond the starboard edge at x = ${x}`)
    }
    expect(islandX / islandN).toBeLessThan(DECK_X0 + 16)
    expect(elevator).toBeGreaterThan(10)
    expect(c.radarPivot[0]).toBeLessThan(0)
  })

  test("deck surface is at DECK_Y and the island rises above it", () => {
    let top = -Infinity
    let deckTris = 0
    const v = c.hull.v
    for (let i = 0; i < v.length; i += FLOATS_PER_VERT * 3) {
      const ys = [v[i + 1]!, v[i + 1 + FLOATS_PER_VERT]!, v[i + 1 + 2 * FLOATS_PER_VERT]!]
      top = Math.max(top, ...ys)
      if (ys.every((y) => y === DECK_Y) && v[i + 4]! > 0.99) deckTris++
    }
    expect(deckTris).toBeGreaterThan(100)
    expect(top).toBeGreaterThan(ISLAND.y0 + 30)
    expect(top).toBeLessThanOrEqual(ISLAND.y1)
  })
})

describe("ship weapons", () => {
  const c = buildCarrier()
  const weapons = buildShipWeapons()

  test("one weapon per mount, on its sponson, clear of the deck", () => {
    expect(weapons.map((w) => w.kind)).toEqual(WEAPON_MOUNTS.map((m) => m.kind))
    expect(weapons.filter((w) => w.kind === "ciws").length).toBe(2)
    expect(weapons.filter((w) => w.kind === "gun").length).toBe(1)
    for (const m of WEAPON_MOUNTS) {
      const [x, y, z] = m.pos
      expect(inRect(m.sponson, x, z)).toBe(true)
      expect(y).toBe(m.sponson.y1)
      expect(deckHeightAt(x, z)).toBeNull()
      expect(m.side === "port" ? x > DECK_X1 : x < DECK_X0).toBe(true)
      expect(m.restYaw).toBeGreaterThanOrEqual(m.yawArc[0])
      expect(m.restYaw).toBeLessThanOrEqual(m.yawArc[1])
      for (const s of [m.sponson.x0, m.sponson.x1]) expect(s >= BOUNDS.x0 && s <= BOUNDS.x1).toBe(true)
    }
  })

  test("rest pose stays inside the bounds, and the budget holds", () => {
    const v = shipWeaponsRestVerts()
    let bad = 0
    for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
      const [x, y, z] = [v[i]!, v[i + 1]!, v[i + 2]!]
      if (!(x >= BOUNDS.x0 && x <= BOUNDS.x1 && y >= BOUNDS.y0 && y <= BOUNDS.y1 && z >= BOUNDS.z0 && z <= BOUNDS.z1)) bad++
      expect(Math.hypot(v[i + 3]!, v[i + 4]!, v[i + 5]!)).toBeCloseTo(1, 2)
    }
    expect(bad).toBe(0)
    expect(c.triangles + v.length / FLOATS_PER_VERT / 3).toBeLessThan(12000)
  })

  test("posing turns the barrel's bore to (sin yaw, sin pitch, cos yaw)", () => {
    const w = weapons.find((x) => x.kind === "gun")!
    const tip = (yaw: number, pitch: number) => {
      const v = poseWeapon({ ...w, turret: new Mesh() }, yaw, pitch)
      let best: [number, number, number] = [0, 0, 0]
      let far = -Infinity
      for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
        const d = Math.hypot(v[i]! - w.yawPivot[0], v[i + 2]! - w.yawPivot[2])
        if (d > far) [far, best] = [d, [v[i]!, v[i + 1]!, v[i + 2]!]]
      }
      return best
    }
    const a = tip(Math.PI / 2, 0)
    expect(a[0] - w.yawPivot[0]).toBeGreaterThan(10)
    const b = tip(0, 0.6)
    expect(b[2] - w.yawPivot[2]).toBeGreaterThan(8)
    expect(b[1] - w.yawPivot[1]).toBeGreaterThan(6)
  })
})
