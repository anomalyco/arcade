import { describe, expect, test } from "bun:test"
import { GridNav, type NavPortal } from "./sim/ai"
import { FLOW_UNREACHED, FlowFieldCache } from "./sim/flow-field"
import type { Rect } from "./sim/geom"

// A 32 m square with a wall down the middle (x = 15..17): a 4 m gap at the north end (y < 4) and a doorway at y 20..22.
const wall: Rect[] = [
  [15, 4, 17, 20],
  [15, 22, 17, 28],
]
const door: NavPortal = { id: "d", kind: "door", rect: [15.2, 20, 16.8, 22], open: false }

function flatNav(portals: NavPortal[] = []): GridNav {
  const nav = new GridNav(32, 32, 0.5)
  nav.rebuild(wall, portals)
  return nav
}

/** The same world cut into 64×64 chunk tiles (one 32 m chunk), as the streaming world feeds GridNav. */
function tiledNav(portals: NavPortal[] = []): GridNav {
  const flat = flatNav(portals)
  const nav = new GridNav(96, 96, 0.5)
  nav.chunkTiles.set("0,0", flat.grid.slice())
  nav.invalidateTileCache()
  return nav
}

describe("FlowFieldCache", () => {
  test("open ground costs are octile distance in tenths of a cell", () => {
    const nav = new GridNav(32, 32, 0.5)
    nav.rebuild([], [])
    const flow = new FlowFieldCache(nav, { radiusCells: 40 })
    flow.beginTick()
    const f = flow.field(8.25, 8.25)!
    const gx = f.seedGx
    const gy = f.seedGy
    expect(f.costAtCell(gx, gy)).toBe(0)
    expect(f.costAtCell(gx + 6, gy)).toBe(60)
    expect(f.costAtCell(gx + 4, gy + 4)).toBe(56)
    expect(f.costAtCell(gx + 6, gy + 2)).toBe(40 + 28)
  })

  test("routes around a wall through the gap, and the waypoint heads for it", () => {
    const nav = flatNav()
    const flow = new FlowFieldCache(nav, { radiusCells: 64 })
    flow.beginTick()
    const f = flow.field(24, 12)!
    // Straight across the wall is 16 m; around through the doorway (y 20..22) is longer.
    const behind = f.costAt(8, 12)
    expect(behind).not.toBe(FLOW_UNREACHED)
    expect(behind).toBeGreaterThan(16 * 2 * 10 + 60)
    const wp = { x: 0, y: 0 }
    expect(f.waypoint(8, 12, 12, (tx, ty) => nav.straightFree({ x: 8, y: 12 }, { x: tx, y: ty }), wp)).toBe(true)
    // Heads south toward the doorway, not east into the wall.
    expect(wp.y).toBeGreaterThan(12.5)
  })

  test("a closed door is a cost, not a wall, and opening it makes the door the short way", () => {
    const closed = new FlowFieldCache(flatNav([door]), { radiusCells: 64 })
    const open = new FlowFieldCache(flatNav([{ ...door, open: true }]), { radiusCells: 64 })
    closed.beginTick()
    open.beginTick()
    const a = closed.field(24, 21)!.costAt(8, 21)
    const b = open.field(24, 21)!.costAt(8, 21)
    expect(a).not.toBe(FLOW_UNREACHED)
    expect(a - b).toBeGreaterThanOrEqual(55)
    const barricaded = new FlowFieldCache(flatNav([{ ...door, barricadePlanks: 2 }]), { radiusCells: 64 })
    barricaded.beginTick()
    // Planks cost more than a closed door, so the field prefers the long way round through the north gap.
    expect(barricaded.field(24, 21)!.costAt(8, 21)).toBeGreaterThanOrEqual(a)
    expect(barricaded.field(24, 21)!.waypoint(8, 21, 4, () => true, { x: 0, y: 0 })).toBe(true)
  })

  test("chunk tiles and the flat grid give the same field", () => {
    const flat = new FlowFieldCache(flatNav([door]), { radiusCells: 48 })
    const tiled = new FlowFieldCache(tiledNav([door]), { radiusCells: 48 })
    flat.beginTick()
    tiled.beginTick()
    const a = flat.field(24, 12)!
    const b = tiled.field(24, 12)!
    for (let gy = 0; gy < 64; gy++) {
      for (let gx = 0; gx < 64; gx++) expect(b.costAtCell(gx, gy)).toBe(a.costAtCell(gx, gy))
    }
  })

  test("a cached field equals a fresh build, and grid changes invalidate it", () => {
    const nav = flatNav([door])
    const flow = new FlowFieldCache(nav, { radiusCells: 48 })
    flow.beginTick()
    const first = Array.from(flow.field(24, 12)!.cost)
    flow.beginTick()
    expect(Array.from(flow.field(24, 12)!.cost)).toEqual(first)
    expect(flow.hits).toBe(1)
    const fresh = new FlowFieldCache(nav, { radiusCells: 48 })
    fresh.beginTick()
    expect(Array.from(fresh.field(24, 12)!.cost)).toEqual(first)
    nav.rebuild(wall, [{ ...door, open: true }])
    flow.beginTick()
    flow.field(24, 12)
    expect(flow.builds).toBe(2)
  })

  test("goals share a field within a quantum and the per-tick goal budget defers extra goals", () => {
    const flow = new FlowFieldCache(flatNav(), { radiusCells: 32, quantumCells: 2, maxGoalsPerTick: 2 })
    flow.beginTick()
    const a = flow.field(24.1, 12.1)
    expect(flow.field(24.4, 12.4)).toBe(a)
    expect(flow.field(4, 4)).not.toBeNull()
    expect(flow.field(28, 28)).toBeNull()
    expect(flow.deferred).toBe(1)
    flow.beginTick()
    expect(flow.field(28, 28)).not.toBeNull()
  })
})
