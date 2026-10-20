import { describe, expect, test } from "bun:test"
import { inBuildingFootprint } from "../shared/map"
import { LocalSession } from "../shared/session"
import { Casings, CASINGS_MAX, domeLevel, doorPose, laundryPoses, LINE_HALF, openDoorOf, placeLaundry, type Pose } from "../src/details/leftovers"
import { DetailsPresenter } from "../src/details/presenter"
import { DETAIL_MODELS, type DetailModel } from "../src/details/placement"
import { DEFAULT_DETAIL_SETTINGS } from "../src/details/settings"
import { jetAngle, placeSprinklers, SPRINKLER_OFF, SPRINKLER_ON, sprinklerReach, writeSprinklers, type Sprinkler } from "../src/details/sprinkler"
import { DEFAULT_NIGHT_LIGHT_SETTINGS } from "../src/night-lights/settings"
import { housePlan } from "../src/audio/soundscape/houses"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"

const session = () => {
  const s = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
  s.view.player.x = 44
  s.view.player.y = 150
  s.rebuildCollision()
  return s
}

const all = { ...DEFAULT_DETAIL_SETTINGS, lfLaundry: 1, lfOpenDoors: 1 }

describe("washing on the line", () => {
  test("lines go in yards clear of the houses, the same every time; none when off", () => {
    const t = session().view.town
    const lines = t.buildings.map((b) => placeLaundry(t, b, all)).filter((l) => l !== null)
    expect(lines.length).toBeGreaterThan(0)
    expect(t.buildings.map((b) => placeLaundry(t, b, all))).toEqual(t.buildings.map((b) => placeLaundry(t, b, all)))
    for (const l of lines) {
      for (const u of [-LINE_HALF, 0, LINE_HALF]) {
        const x = l.x + Math.cos(l.yaw) * u
        const z = l.z + Math.sin(l.yaw) * u
        for (const b of t.buildings) expect(inBuildingFootprint(b, x, z)).toBe(false)
      }
      expect(l.items.length).toBeGreaterThan(0)
      for (const it of l.items) expect(Math.abs(it.at)).toBeLessThan(LINE_HALF)
    }
    for (const b of t.buildings) {
      expect(placeLaundry(t, b, { ...all, lfLaundry: 0 })).toBeNull()
      expect(placeLaundry(t, b, { ...all, lifeTouches: false })).toBeNull()
    }
  })

  test("the washing swings in the wind about the cord, within reason", () => {
    const t = session().view.town
    const line = t.buildings.map((b) => placeLaundry(t, b, all)).find((l) => l !== null)!
    const rolls: number[][] = []
    for (let time = 0; time < 20; time += 0.5) {
      const r: number[] = []
      laundryPoses(line, time, 0, (model, _x, _y, _z, _yaw, _p, roll) => {
        if (model !== "linePosts") r.push(roll)
      })
      rolls.push(r)
    }
    expect(rolls[0]!.length).toBe(line.items.length)
    const first = rolls.map((r) => r[0]!)
    expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(0.05)
    for (const r of rolls) for (const v of r) expect(Math.abs(v)).toBeLessThan(1.1)
  })
})

type V = Parameters<typeof openDoorOf>[1]
const car = (over: Partial<V> = {}): V => ({ id: 1, kind: "sedan", x: 10, y: 20, h: 0.3, spawnX: 10, spawnY: 20, wreck: false, seats: ["", "", "", ""], spec: { length: 4, width: 1.8 }, ...over })

describe("cars left with a door open", () => {
  test("a share of parked cars, keyed on where they were left; shut once moved, occupied or wrecked", () => {
    const t = session().view.town
    expect(openDoorOf(t, car(), all)).not.toBeNull()
    expect(openDoorOf(t, car(), all)).toEqual(openDoorOf(t, car(), all))
    expect(openDoorOf(t, car(), { ...all, lfOpenDoors: 0 })).toBeNull()
    expect(openDoorOf(t, car({ x: 12 }), all)).toBeNull()
    expect(openDoorOf(t, car({ seats: ["bob", "", "", ""] }), all)).toBeNull()
    expect(openDoorOf(t, car({ wreck: true }), all)).toBeNull()
  })

  test("the door hangs off the car's side and the dome light sits inside the cabin", () => {
    const t = session().view.town
    const v = car()
    const d = openDoorOf(t, v, all)!
    const pose: Pose = { model: "chair", x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }
    const light = { x: 0, y: 0, z: 0 }
    doorPose(v, d, t, pose, light)
    expect(pose.model).toBe("carDoorSedan")
    expect(Math.hypot(pose.x - v.x, pose.z - v.y)).toBeGreaterThan(0.7)
    expect(Math.hypot(pose.x - v.x, pose.z - v.y)).toBeLessThan(1.4)
    expect(Math.hypot(light.x - v.x, light.z - v.y)).toBeLessThan(0.5)
    expect(light.y).toBeGreaterThan(pose.y + 0.8)
  })

  test("the dome light runs the battery down: full, dipping, sputtering, dead", () => {
    const over = (night: number, decay = true) => Array.from({ length: 600 }, (_, i) => domeLevel(night, i * 0.1, 0.3, decay))
    expect(over(1).every((v) => v === 1)).toBe(true)
    expect(Math.max(...over(2))).toBeLessThanOrEqual(0.55)
    expect(Math.min(...over(2))).toBeLessThan(0.3)
    expect(Math.max(...over(3))).toBeLessThanOrEqual(0.22)
    expect(over(3).filter((v) => v === 0).length).toBeGreaterThan(300)
    expect(over(4).every((v) => v === 0)).toBe(true)
    expect(over(5, false).every((v) => v === 1)).toBe(true)
  })
})

describe("brass where it fell", () => {
  const ground = () => 0
  test("each shot drops one casing to the shooter's right that lands and stays", () => {
    const c = new Casings()
    const shot = { id: 1, time: 1, fromX: 0, fromY: 0, aim: 0, seed: 77 }
    c.observe([shot], ground)
    c.observe([shot, { ...shot, id: 2, time: 1.01 }], ground)
    expect(c.count).toBe(1)
    for (let i = 0; i < 120; i++) c.step(1 / 60, ground)
    const at: number[][] = []
    c.poses([-10, -10, 10, 10], (x, y, z) => at.push([x, y, z]))
    expect(at.length).toBe(1)
    const [x, y, z] = at[0]!
    expect(y).toBe(0)
    // Aim along +x: the right is +z.
    expect(z).toBeGreaterThan(0.4)
    expect(Math.hypot(x, z)).toBeLessThan(2.5)
    for (let i = 0; i < 600; i++) c.step(1 / 60, ground)
    const later: number[][] = []
    c.poses([-10, -10, 10, 10], (x2, y2, z2) => later.push([x2, y2, z2]))
    expect(later).toEqual(at)
  })

  test("the same shot seeds the same casing for every client, and old brass makes way for new", () => {
    const a = new Casings()
    const b = new Casings()
    const shot = { id: 9, time: 3, fromX: 5, fromY: 5, aim: 1.2, seed: 4242 }
    for (const c of [a, b]) {
      c.observe([shot], ground)
      for (let i = 0; i < 90; i++) c.step(1 / 60, ground)
    }
    const pa: number[][] = []
    const pb: number[][] = []
    a.poses([-50, -50, 50, 50], (x, y, z) => pa.push([x, y, z]))
    b.poses([-50, -50, 50, 50], (x, y, z) => pb.push([x, y, z]))
    expect(pa).toEqual(pb)
    const many = new Casings()
    for (let i = 0; i < CASINGS_MAX + 40; i++) many.observe([{ id: 100 + i, time: i, fromX: i, fromY: 0, aim: 0, seed: i }], ground)
    expect(many.count).toBe(CASINGS_MAX)
  })
})

describe("sprinkler at first light", () => {
  const s: Sprinkler = { key: "s", x: 0, z: 0, y: 0, facing: Math.PI / 2, seed: 0.3 }
  const view = [-20, -20, 20, 20] as const
  const buf = () => new Float32Array(256 * SPRITE_FLOATS)

  test("sprinklers are seeded from the town and sit on front lawns", () => {
    const t = session().view.town
    expect(placeSprinklers(t, DEFAULT_DETAIL_SETTINGS)).toEqual(placeSprinklers(t, DEFAULT_DETAIL_SETTINGS))
    for (const p of placeSprinklers(t, DEFAULT_DETAIL_SETTINGS)) for (const b of t.buildings) expect(inBuildingFootprint(b, p.x, p.z)).toBe(false)
    expect(placeSprinklers(t, { ...DEFAULT_DETAIL_SETTINGS, lfSprinkler: false })).toEqual([])
  })

  test("it runs only in its window, sweeps its arc, and loses pressure day by day", () => {
    const r = sprinklerReach(1, true)
    expect(writeSprinklers([s], 5, SPRINKLER_ON - 0.1, r, () => 1, view, buf(), 0)).toBe(0)
    expect(writeSprinklers([s], 5, SPRINKLER_OFF + 0.01, r, () => 1, view, buf(), 0)).toBe(0)
    expect(writeSprinklers([s], 5, (SPRINKLER_ON + SPRINKLER_OFF) / 2, r, () => 1, view, buf(), 0)).toBeGreaterThan(8)
    expect(writeSprinklers([s], 5, (SPRINKLER_ON + SPRINKLER_OFF) / 2, r, () => 0, view, buf(), 0)).toBe(0)
    for (let t = 0; t < 30; t += 0.1) expect(Math.abs(jetAngle(t, s.facing, s.seed) - s.facing)).toBeLessThanOrEqual(Math.PI * 0.45 + 1e-9)
    expect(sprinklerReach(2, true)).toBeLessThan(sprinklerReach(1, true))
    expect(sprinklerReach(5, true)).toBe(0)
    expect(sprinklerReach(5, false)).toBe(sprinklerReach(1, true))
  })
})

describe("the town runs down", () => {
  test("televisions die with their house's power, the hour its fridge stops humming, and stay on when the town does not run down", () => {
    const t = session().view.town
    let id = 0
    const p = new DetailsPresenter({ addModel: () => id++ })
    const s = { ...DEFAULT_DETAIL_SETTINGS, dtTvs: 1 }
    const count = (absHour: number, decay = true) => {
      const batches = p.collect(t, [-1e4, -1e4, 1e4, 1e4], { ...s, lfDecay: decay }, DEFAULT_NIGHT_LIGHT_SETTINGS, { dt: 1 / 60, time: 1, threats: [], noises: [], night: 1, absHour })
      const n = (m: DetailModel) => batches.find((b) => b.model === DETAIL_MODELS.indexOf(m))?.count ?? 0
      return { on: n("tv"), off: n("tvOff") }
    }
    const all = count(14, false)
    expect(all.on).toBeGreaterThan(1)
    expect(all.off).toBe(0)
    const first = count(14)
    const later = count(200)
    expect(first.on + first.off).toBe(all.on)
    expect(later.on + later.off).toBe(all.on)
    expect(first.off).toBeLessThanOrEqual(later.off)
    for (const b of t.buildings) expect(p.powered(b.id)).toBe(housePlan(t, b).powerLoss > 200)
    expect(t.buildings.some((b) => !p.powered(b.id))).toBe(true)
    count(200, false)
    expect(t.buildings.every((b) => p.powered(b.id))).toBe(true)
  })
})
