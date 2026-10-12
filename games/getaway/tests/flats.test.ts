import { describe, expect, test } from "bun:test"
import { DT, FLAT_SPEED, REPAIR_SECONDS, SHOP_COOLDOWN, VEHICLE_BY_ID } from "../shared/config"
import { driveToward } from "../shared/sim/bots"
import { BAY_DEPTH, type Shop } from "../shared/sim/city"
import { NO_INPUT, flatCount, newBody, speedOf, stepBody } from "../shared/sim/vehicle"
import type { World } from "../shared/sim/world"
import { ROAD_X, ROAD_Z, drive, humanWorld, place, steps, toChase } from "./sim-helpers"

/** Chase on, both cops parked far away so nobody sees or busts the driver. */
function chase() {
  const w = humanWorld(["c1", "c2"])
  toChase(w)
  place(w, "c1", ROAD_X - 300, ROAD_Z + 200)
  place(w, "c2", ROAD_X + 300, ROAD_Z - 200)
  return w
}

/** c1 lays a strip on the avenue, then drives off. */
function lay(w: World) {
  place(w, "c1", ROAD_X, ROAD_Z, 0)
  w.setInput("c1", { ...NO_INPUT, gadget: 0 })
  steps(w, 0.1)
  w.setInput("c1", NO_INPUT)
  place(w, "c1", ROAD_X - 300, ROAD_Z + 200)
  w.drainEvents()
  return w.props.find((p) => p.kind === "spike")!
}

const wheels = (w: World) => w.carOf("r")!.body.wheels ?? 0

/** The road in front of a shop's bay, `side` meters along the street from it. */
function approach(s: Shop, side = 0) {
  const ox = Math.sin(s.h)
  const oz = Math.cos(s.h)
  const d = BAY_DEPTH / 2 + 5 + 5
  return { x: s.x + ox * d + oz * side, z: s.z + oz * d - ox * side }
}

/** Parks the driver stopped in the middle of a shop's bay, facing in. */
function parkIn(w: World, s: Shop) {
  place(w, "r", s.x, s.z, s.h + Math.PI)
}

describe("spike strips pop one tire at a time", () => {
  test("each pass pops exactly one tire, the first intact one to go over; four passes put the car on its rims", () => {
    const w = chase()
    const strip = lay(w)
    const texts: string[] = []
    for (let pass = 1; pass <= 4; pass++) {
      const north = pass % 2 === 1
      place(w, "r", strip.x, strip.z + (north ? -15 : 15), north ? 0 : Math.PI, 14)
      steps(w, 2, () => w.setInput("r", drive(0.6)))
      const flats = w.drainEvents().filter((e) => e.kind === "flat")
      expect(flats.length).toBe(1)
      texts.push(flats[0]!.text)
      expect(flatCount(wheels(w))).toBe(pass)
      // No stun: the driver keeps control.
      expect(w.carOf("r")!.body.stun).toBe(0)
    }
    // Front left first (square to the strip, left before right), then the next intact tire in crossing order: the other
    // front, then the rears (whichever reaches the strip first; the flats wobble the car a little).
    expect(texts.slice(0, 2)).toEqual(["1|FL", "2|FR"])
    expect(texts.slice(2).map((t) => t.split("|")[1]).sort()).toEqual(["RL", "RR"])
    expect(texts.map((t) => t.split("|")[0])).toEqual(["1", "2", "3", "4"])
    expect(wheels(w)).toBe(15)
    // A fifth pass has nothing left to pop.
    place(w, "r", strip.x, strip.z - 15, 0, 14)
    steps(w, 2, () => w.setInput("r", drive(0.6)))
    expect(w.drainEvents().filter((e) => e.kind === "flat").length).toBe(0)
  })

  test("a car crossing at the strip's end only loses a tire that goes over it", () => {
    const w = chase()
    const strip = lay(w)
    // Left tires over the strip's right end, right tires past it.
    const spec = w.carOf("r")!.vehicle
    place(w, "r", strip.x + strip.r + spec.width * 0.4 - 0.2, strip.z - 15, 0, 14)
    steps(w, 2, () => w.setInput("r", drive(0.6)))
    expect(wheels(w)).toBe(1)
  })

  test("a hit marks the last known position", () => {
    const w = chase()
    const strip = lay(w)
    place(w, "r", strip.x, strip.z - 15, 0, 14)
    steps(w, 2, () => w.setInput("r", drive(0.6)))
    expect(Math.hypot(w.lastSeen!.x - strip.x, w.lastSeen!.z - strip.z)).toBeLessThan(6)
  })
})

describe("driving on flats", () => {
  const muscle = VEHICLE_BY_ID.get("muscle")!
  const top = (mask: number) => {
    const b = newBody(0, 0, 0)
    b.wheels = mask
    for (let i = 0; i < 30 * 40; i++) stepBody(b, drive(1), muscle, DT)
    return speedOf(b)
  }

  test("top speed drops with every flat; on the rims it's about a fifth, but the car still moves", () => {
    const speeds = [0, 1, 3, 7, 15].map(top)
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]!).toBeLessThan(speeds[i - 1]! - 3)
    speeds.forEach((s, n) => expect(s).toBeLessThan(muscle.maxSpeed * FLAT_SPEED[n]! + 0.5))
    expect(speeds[4]!).toBeGreaterThan(6)
    expect(speeds[4]!).toBeLessThan(9.5)
  })

  test("a flat on one side pulls the car that way; flats on both sides don't", () => {
    const heading = (mask: number) => {
      const b = newBody(0, 0, 0)
      b.wheels = mask
      b.vz = 25
      for (let i = 0; i < 60; i++) stepBody(b, drive(0.7), muscle, DT)
      return b.h
    }
    // Positive heading change turns right.
    expect(heading(2)).toBeGreaterThan(0.15)
    expect(heading(8)).toBeGreaterThan(0.15)
    expect(heading(1)).toBeLessThan(-0.15)
    expect(heading(10)).toBeGreaterThan(heading(2))
    expect(Math.abs(heading(3))).toBeLessThan(0.1)
    expect(heading(0)).toBe(0)
  })

  test("four flats cap the driver at about 20% speed, and they can still limp into a shop and get fixed", () => {
    const w = chase()
    const r = w.carOf("r")!
    const shop = w.city.shops[0]!
    const start = approach(shop, 45)
    const mouth = approach(shop)
    // On the road 45 m down the street from the shop, facing it, rims only.
    place(w, "r", start.x, start.z, Math.atan2(mouth.x - start.x, mouth.z - start.z))
    r.body.wheels = 15
    let fastest = 0
    let leg = 0
    let fixedAt = -1
    for (let i = 0; i < 30 * 40 && fixedAt < 0; i++) {
      const b = r.body
      const target = leg === 0 ? mouth : shop
      if (leg === 0 && Math.hypot(b.x - mouth.x, b.z - mouth.z) < 9) leg = 1
      const inBay = Math.hypot(b.x - shop.x, b.z - shop.z) < 2
      w.setInput("r", inBay ? { ...NO_INPUT, brake: 1 } : driveToward(r, target.x, target.z, 8))
      w.step(DT)
      fastest = Math.max(fastest, speedOf(b))
      if (!b.wheels) fixedAt = i * DT
    }
    expect(fastest).toBeLessThan(r.vehicle.maxSpeed * FLAT_SPEED[4] + 0.5)
    expect(fixedAt).toBeGreaterThan(0)
    expect(fixedAt).toBeLessThan(16)
  })
})

describe("repair shops", () => {
  test("there are a few shops spread over the district, each bay open and reachable from a road", () => {
    for (const seed of [7, 1, 99, 4242]) {
      const w = humanWorld(["c1"], "muscle", "cruiser", seed)
      const shops = w.city.shops
      expect(shops.length).toBeGreaterThanOrEqual(3)
      for (const s of shops) {
        // Nothing solid in the bay or on the apron out to the road.
        const mouth = approach(s)
        for (const b of w.city.boxes) {
          const hit = (x: number, z: number) => x > b.x0 - 0.2 && x < b.x1 + 0.2 && z > b.z0 - 0.2 && z < b.z1 + 0.2
          for (let k = 0; k <= 10; k++) expect(hit(s.x + ((mouth.x - s.x) * k) / 10, s.z + ((mouth.z - s.z) * k) / 10)).toBe(false)
        }
        for (const o of shops) if (o !== s) expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThan(120)
      }
    }
  })

  test("stopping in a bay fixes every tire after REPAIR_SECONDS; driving out resets the progress", () => {
    const w = chase()
    const shop = w.city.shops[0]!
    const r = w.carOf("r")!
    r.body.wheels = 0b0110
    parkIn(w, shop)
    steps(w, REPAIR_SECONDS * 0.6)
    expect(r.body.wheels).toBe(0b0110)
    expect(w.view("r").repair!).toBeGreaterThan(0.5)
    // Out of the bay: progress is gone.
    place(w, "r", approach(shop).x, approach(shop).z)
    steps(w, 0.1)
    expect(w.repair).toBe(0)
    parkIn(w, shop)
    steps(w, REPAIR_SECONDS * 0.6)
    expect(r.body.wheels).toBe(0b0110)
    steps(w, REPAIR_SECONDS * 0.5)
    expect(r.body.wheels).toBe(0)
    const done = w.drainEvents().filter((e) => e.kind === "repair")
    expect(done.length).toBe(1)
  })

  test("rolling through a bay doesn't count", () => {
    const w = chase()
    const shop = w.city.shops[0]!
    const r = w.carOf("r")!
    r.body.wheels = 1
    parkIn(w, shop)
    steps(w, REPAIR_SECONDS + 1, () => {
      r.body.vx = Math.sin(shop.h) * 3
      r.body.vz = Math.cos(shop.h) * 3
      r.body.x = shop.x
      r.body.z = shop.z
    })
    expect(r.body.wheels).toBe(1)
  })

  test("a shop that just did a repair can't do another for SHOP_COOLDOWN seconds; other shops can", () => {
    const w = chase()
    const [a, b] = w.city.shops
    const r = w.carOf("r")!
    r.body.wheels = 15
    parkIn(w, a!)
    steps(w, REPAIR_SECONDS + 0.2)
    expect(r.body.wheels).toBe(0)
    expect(w.view("r").shopCool![0]!).toBeGreaterThan(SHOP_COOLDOWN - 1)
    r.body.wheels = 1
    steps(w, 10)
    expect(r.body.wheels).toBe(1)
    expect(w.view("r").repair).toBe(0)
    parkIn(w, b!)
    steps(w, REPAIR_SECONDS + 0.2)
    expect(r.body.wheels).toBe(0)
    r.body.wheels = 1
    parkIn(w, a!)
    steps(w, SHOP_COOLDOWN - 10)
    expect(r.body.wheels).toBe(0)
  })

  test("cops can't get repairs", () => {
    const w = chase()
    const shop = w.city.shops[0]!
    const cop = w.carOf("c1")!
    cop.body.wheels = 3
    place(w, "c1", shop.x, shop.z, shop.h + Math.PI)
    steps(w, REPAIR_SECONDS * 2)
    expect(cop.body.wheels).toBe(3)
    expect(w.drainEvents().some((e) => e.kind === "repair")).toBe(false)
  })

  test("an unseen driver's repair is private: cops get no event, no progress and no shop timers", () => {
    const w = chase()
    const shop = w.city.shops[0]!
    const r = w.carOf("r")!
    r.body.wheels = 1
    parkIn(w, shop)
    steps(w, REPAIR_SECONDS * 0.5)
    expect(w.seen).toBe(false)
    for (const cop of ["c1", "c2"]) {
      const v = w.view(cop)
      expect(v.repair).toBeUndefined()
      expect(v.shopCool).toBeUndefined()
      const ghost = v.cars.find((c) => c.ownerId === "r")!
      expect(ghost.ghost).toBe(true)
      expect(ghost.wheels).toBe(0)
    }
    steps(w, REPAIR_SECONDS)
    const done = w.drainEvents().filter((e) => e.kind === "repair")
    expect(done.length).toBe(1)
    expect(done[0]!.to).toBe("r")
    expect(done[0]!.text).toBe("")
  })

  test("a seen driver's repair goes out to everyone", () => {
    const w = chase()
    const shop = w.city.shops[0]!
    const r = w.carOf("r")!
    r.body.wheels = 1
    parkIn(w, shop)
    place(w, "c1", shop.x + Math.sin(shop.h) * 20, shop.z + Math.cos(shop.h) * 20)
    steps(w, REPAIR_SECONDS + 0.2)
    expect(w.seen).toBe(true)
    const done = w.drainEvents().filter((e) => e.kind === "repair")
    expect(done.length).toBe(1)
    expect(done[0]!.to).toBeUndefined()
    expect(done[0]!.text).toBe(shop.id)
  })
})
