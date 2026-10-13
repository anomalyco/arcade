import { describe, expect, test } from "bun:test"
import { body, PropPhysics, support } from "../src/game/props/physics"
import { placeProps, placementClear, PROP_KINDS } from "../src/game/props/placement"
import { generateCity } from "../shared/sim/city"
import { PropParticles, PARTICLE_CAP } from "../src/game/props/particles"
import { StreetProps } from "../src/game/props"
import { LocalSession } from "../src/game/session"
import { CELL, GRID, ROAD_HALF } from "../shared/config"
import { SPECS } from "../src/game/props/placement"
import { humanWorld } from "./sim-helpers"

describe("decorative physics", () => {
  test("a thrown box bounces, settles on a face and stops consuming steps", () => {
    const world = new PropPhysics(), b = body(0, 0, .5, 0, .4, .5, .4, 3)
    world.add(b); world.impulse(b, 24, 30, 5)
    let peak = 0, bounced = false, previousVy = 0
    for (let i = 0; i < 1800; i++) {
      world.update(1 / 120)
      peak = Math.max(peak, b.y)
      if (previousVy < -1 && b.vy > 0) bounced = true
      previousVy = b.vy
      expect(Number.isFinite(b.x + b.y + b.z + b.roll)).toBe(true)
      expect(b.y).toBeGreaterThanOrEqual(support(b) - 1e-6)
    }
    expect(peak).toBeGreaterThan(2)
    expect(bounced).toBe(true)
    expect(world.active.size).toBe(0)
    const state = JSON.stringify(b)
    world.update(10)
    expect(JSON.stringify(b)).toBe(state)
  })
  test("contact wakes a sleeping neighbour, not distant bodies", () => {
    const world = new PropPhysics(), a = body(0, 0, .5, 0, .5, .5, .5, 1), b = body(1, 1.4, .5, 0, .5, .5, .5, 1), c = body(2, 60, .5, 0, .5, .5, .5, 1)
    for (const p of [a, b, c]) world.add(p)
    world.impulse(a, 8, 0, 0, 0)
    for (let i = 0; i < 15; i++) world.update(1 / 120)
    expect(b.awake).toBe(true)
    expect(b.vx).toBeGreaterThan(0)
    expect(c.awake).toBe(false)
  })
  test("fixed substeps agree across 30 and 60 Hz and cap a stalled frame", () => {
    const run = (hz: number) => {
      const world = new PropPhysics(), b = body(0, 0, 3, 0, .5, .5, .5, 2)
      world.add(b); world.impulse(b, 8, 0, 5)
      for (let i = 0; i < hz * 2; i++) world.update(1 / hz)
      return [b.x, b.y, b.z, b.roll, b.pitch]
    }
    run(30).forEach((n, i) => expect(n).toBeCloseTo(run(60)[i]!, 8))
    const world = new PropPhysics(), b = body(0, 0, 20, 0, .2, .2, .2, 1)
    world.add(b); world.wake(b); world.update(100)
    expect(b.y).toBeGreaterThan(19)
  })
  test("building walls contain flying pieces", () => {
    const world = new PropPhysics(() => 0, [{ x0: 2, x1: 4, z0: -10, z1: 10, h: 10 }])
    const b = body(0, 0, 2, 0, .3, .3, .3, 1)
    world.add(b); world.impulse(b, 20, 0, 0, 0)
    for (let i = 0; i < 40; i++) world.update(1 / 120)
    expect(b.x).toBeLessThan(2)
  })
})

test("seeded placement keeps complete footprints out of roads, junctions, buildings, ramps and drive-in bays", () => {
  const kinds = new Set<string>()
  for (const seed of [1, 7, 22, 91]) {
    const city = generateCity(seed), props = placeProps(city)
    expect(props.length).toBeGreaterThan(500)
    expect(placeProps(city)).toEqual(props)
    for (const p of props) {
      expect(placementClear(city, p)).toBe(true); kinds.add(p.kind)
      const [w, , d] = SPECS[p.kind].size
      const hx = (Math.abs(Math.cos(p.yaw)) * w + Math.abs(Math.sin(p.yaw)) * d) / 2
      const hz = (Math.abs(Math.sin(p.yaw)) * w + Math.abs(Math.cos(p.yaw)) * d) / 2
      for (let road = 0; road <= GRID; road++) {
        expect(Math.abs(p.x - road * CELL) - hx).toBeGreaterThanOrEqual(ROAD_HALF)
        expect(Math.abs(p.z - road * CELL) - hz).toBeGreaterThanOrEqual(ROAD_HALF)
      }
    }
  }
  expect([...kinds].sort()).toEqual([...PROP_KINDS].sort())
  expect(placeProps(generateCity(1))).not.toEqual(placeProps(generateCity(7)))
})

test("ghosts and airborne cars cannot smash ground clutter; the explosion switch suppresses chains", () => {
  const city = generateCity(7), template = humanWorld([]).view("r").cars[0]!
  const props = new StreetProps(city, { addModel: () => 0 }, () => 0)
  const car = { ...template, x: 314, z: 400, h: 0, y: 0, vx: 0, vz: 20, speed: 20, ghost: true }
  props.fixture(["propane", "fuel"], 314, 400)
  props.update([car], 1 / 30, car, true, () => true)
  expect(props.stats.hits).toBe(0)
  car.ghost = false; car.y = 4
  props.update([car], 1 / 30, car, true, () => true)
  expect(props.stats.hits).toBe(0)
  car.y = 0
  props.update([car], 1 / 30, car, false, () => true)
  for (let i = 0; i < 60; i++) props.update([], 1 / 30, car, false, () => true)
  expect(props.stats.hits).toBeGreaterThan(0)
  expect(props.stats.explosions).toBe(0)
})

test("particle bursts stay bounded and expire", () => {
  const pool = new PropParticles()
  pool.emit(10, 0, 1, 0, 9000)
  expect(pool.count).toBe(PARTICLE_CAP)
  for (let i = 0; i < 240; i++) pool.update(1 / 30, () => 0)
  expect(pool.count).toBe(0)
})

test("car view collisions chain locally, don't mutate cars, and recover only offscreen", () => {
  let model = 0
  const city = generateCity(7), props = new StreetProps(city, { addModel: () => model++ }, () => 0)
  props.fixture(["propane", "fuel", "canister"], 314, 400)
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "?peaceful=1&seed=7" } })
  let local: LocalSession
  try { local = new LocalSession("test", { robber: "muscle", cop: "cruiser" }, 7) }
  finally {
    if (saved) Object.defineProperty(globalThis, "location", saved)
    else Reflect.deleteProperty(globalThis, "location")
  }
  const view = local.update(0, { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, gadget: null, engine: false })
  const car = { ...view.cars[0]!, x: 314, z: 400, y: 0, vx: 0, vz: 20, speed: 20, ghost: false, h: 0 }
  const before = JSON.stringify(car)
  props.update([car], 1 / 30, car, true, () => true)
  for (let i = 0; i < 120; i++) props.update([], 1 / 30, car, true, () => true)
  expect(JSON.stringify(car)).toBe(before)
  expect(props.stats.explosions).toBe(3)
  expect(props.props.every(p => p.broken)).toBe(true)
  for (let i = 0; i < 1100; i++) props.update([], 1 / 30, car, true, () => true)
  expect(props.props.every(p => p.broken)).toBe(true)
  props.update([], 1 / 30, car, true, () => false)
  expect(props.props.every(p => !p.broken && !p.body.awake)).toBe(true)
})
