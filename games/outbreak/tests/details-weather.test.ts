import { describe, expect, test } from "bun:test"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { inBuildingFootprint, type Town } from "../shared/map"
import { LocalSession } from "../shared/session"
import { dripLevel, placeDrips, RING_SIZE, writeDrips } from "../src/details/drips"
import { BootPrints, DRY_OUT, groundKind, STRIDE, type PrintWeather } from "../src/details/prints"
import { setWindowPower, windowsLit } from "../src/look/lit-windows"

const town = () => {
  const s = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
  s.view.player.x = 44
  s.view.player.y = 150
  s.rebuildCollision()
  return s.view.town
}
const sprites = () => new Float32Array(512 * SPRITE_FLOATS)

describe("drips after rain", () => {
  test("eaves and trees drip once the ground is soaked, hardest as the rain eases, not at all when dry", () => {
    expect(dripLevel(0, 0)).toBe(0)
    expect(dripLevel(0.9, 0)).toBe(1)
    expect(dripLevel(0.9, 1)).toBeLessThan(dripLevel(0.9, 0))
    expect(dripLevel(0.9, 1)).toBeGreaterThan(0)
  })

  test("drip points run along the front eaves and under the trees, outside the houses, the same every time", () => {
    const t = town()
    const a = placeDrips(t, 1)
    expect(a).toEqual(placeDrips(t, 1))
    expect(a.length).toBeGreaterThan(10)
    for (const p of a) for (const b of t.buildings) expect(inBuildingFootprint(b, p.x, p.z)).toBe(false)
    expect(placeDrips(t, 0)).toEqual([])
  })

  test("each landing drop rings the ground, in light only, up to the cap", () => {
    const t = town()
    const pts = placeDrips(t, 2)
    const view = [-1e4, -1e4, 1e4, 1e4] as const
    expect(writeDrips(pts, 0, 3, () => 1, view, sprites(), 0, 48)).toBe(0)
    expect(writeDrips(pts, 1, 3, () => 0, view, sprites(), 0, 48)).toBe(0)
    let most = 0
    for (let time = 0; time < 4; time += 0.1) {
      const buf = sprites()
      const n = writeDrips(pts, 1, time, () => 1, view, buf, 0, 48)
      most = Math.max(most, n)
      for (let i = 0; i < n; i++) {
        const o = i * SPRITE_FLOATS
        expect(buf[o + 3]!).toBeLessThanOrEqual(0.03 + RING_SIZE * 1.2 + 1e-6)
        expect([0, 2]).toContain(buf[o + 8]!)
      }
    }
    expect(most).toBeGreaterThan(0)
    expect(most).toBeLessThanOrEqual(96)
  })
})

describe("wet and muddy boot prints", () => {
  const slot = (x: number, y: number, vehicleId: number | null = null) => [{ id: "a", survivor: { x, y, vehicleId } }]
  /** Walks from (x0, y) to (x1, y) in small steps. */
  const walk = (p: BootPrints, t: Town, x0: number, x1: number, y: number, time: number, weather: PrintWeather) => {
    const dir = Math.sign(x1 - x0)
    for (let x = x0; dir * (x1 - x) > 0; x += dir * 0.1) p.step((time += 0.05), t, weather, slot(x, y))
    return time
  }

  test("through a puddle and onto dry hard ground: a short trail of prints that fades with each step and dries off", () => {
    const t = town()
    const road = { x: 20, y: 44 + 96 }
    expect(groundKind(t, road.x, road.y)).toBe("hard")
    const p = new BootPrints()
    const weather = { wetness: 0, puddles: 1, puddleAt: (x: number) => (x < road.x + 1 ? 1 : 0) }
    const time = walk(p, t, road.x, road.x + 14, road.y, 0, weather)
    expect(p.count).toBeGreaterThan(4)
    expect(p.count).toBeLessThan(16)
    const buf = sprites()
    const view = [-1e4, -1e4, 1e4, 1e4] as const
    const n = p.write(time, view, buf, 0)
    expect(n).toBe(p.count * 2)
    // Strength falls along the trail.
    expect(buf[7]!).toBeGreaterThan(buf[(n - 2) * SPRITE_FLOATS + 7]!)
    expect(p.write(time + DRY_OUT + 1, view, sprites(), 0)).toBe(0)
    // Prints are about a stride apart.
    expect(Math.hypot(buf[0]! - buf[2 * SPRITE_FLOATS]!, buf[2]! - buf[2 * SPRITE_FLOATS + 2]!)).toBeGreaterThan(STRIDE * 0.7)
  })

  test("mud from a soaked lawn dries pale but stays; nothing prints on the lawn itself, in a car, or across a jump", () => {
    const t = town()
    const yard = { x: 20, y: 150 }
    let yardX = yard.x
    while (groundKind(t, yardX, yard.y) !== "yard") yardX += 0.5
    const p = new BootPrints()
    const soaked = { wetness: 0.8, puddles: 1, puddleAt: () => 0 }
    walk(p, t, yardX, yardX + 3, yard.y, 0, soaked)
    expect(p.count).toBe(0)
    // Out of the yard and along the road: muddy prints, which dry pale and are still there much later.
    const road = { x: 20, y: 44 + 96 }
    p.step(10, t, soaked, slot(road.x, road.y))
    const time = walk(p, t, road.x, road.x + 8, road.y, 10, soaked)
    expect(p.count).toBeGreaterThan(3)
    const view = [-1e4, -1e4, 1e4, 1e4] as const
    const fresh = sprites()
    p.write(time, view, fresh, 0)
    const old = sprites()
    expect(p.write(time + 5000, view, old, 0)).toBe(p.count * 2)
    expect(old[7]!).toBeLessThan(fresh[7]!)
    expect(old[4]!).toBeGreaterThan(0)
    const car = new BootPrints()
    for (let k = 0; k < 40; k++) car.step(k, t, { wetness: 0, puddles: 1, puddleAt: () => 1 }, slot(20 + k * 0.3, 140, 3))
    expect(car.count).toBe(0)
    const jump = new BootPrints()
    jump.step(0, t, { wetness: 0, puddles: 1, puddleAt: () => 1 }, slot(20, 140))
    jump.step(1, t, { wetness: 0, puddles: 1, puddleAt: () => 1 }, slot(60, 140))
    expect(jump.count).toBe(0)
  })
})

describe("prints of the dead", () => {
  test("a shuffling trail out of a puddle, one foot dragged into a smear, only for the dead near the view", () => {
    const t = town()
    const dead = new BootPrints(96, true)
    const weather = { wetness: 0, puddles: 1, puddleAt: (x: number) => (x < 21 ? 1 : 0) }
    const view = [0, 120, 60, 160] as const
    let time = 0
    for (let x = 20; x < 30; x += 0.1) {
      dead.stepDead((time += 0.05), t, weather, [{ id: 3, x, y: 140, state: "chase" }, { id: 4, x, y: 300, state: "chase" }, { id: 5, x, y: 141, state: "dead" }], view)
    }
    expect(dead.count).toBeGreaterThan(6)
    const buf = sprites()
    const n = dead.write(time, [-1e4, -1e4, 1e4, 1e4], buf, 0)
    // Every other step is a single long smear instead of a sole and heel.
    expect(n).toBeLessThan(dead.count * 2)
    expect(n).toBeGreaterThan(dead.count)
  })
})

describe("the lights go out house by house", () => {
  test("a lit window stays lit only while its house has power, and every house is powered without a power source", () => {
    const ids = Array.from({ length: 400 }, (_, i) => ({ id: `b${i}` }))
    const lit = () => new Set(ids.filter((b) => windowsLit(b, 0.2)).map((b) => b.id))
    const all = lit()
    expect(all.size).toBeGreaterThan(50)
    setWindowPower((id) => Number(id.slice(1)) % 3 === 0)
    const some = lit()
    setWindowPower(null)
    expect(some.size).toBeLessThan(all.size)
    for (const id of some) expect(all.has(id) && Number(id.slice(1)) % 3 === 0).toBe(true)
    expect(lit()).toEqual(all)
  })
})
