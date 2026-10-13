import { describe, expect, test } from "bun:test"
import { DT, VEHICLE_BY_ID } from "../shared/config"
import { generateCity, type Ramp } from "../shared/sim/city"
import { driveToward } from "../shared/sim/bots"
import { NO_INPUT, newBody, stepAndCollide, collideCars } from "../shared/sim/vehicle"
import { World } from "../shared/sim/world"
import { decodeServer, encodeServer } from "../shared/protocol"
import { lerpView } from "../src/game/interp"
import { human } from "./sim-helpers"
import { NetClient } from "../src/game/netcode"
import type { ServerMsg } from "../shared/protocol"

const spec = VEHICLE_BY_ID.get("muscle")!
const ramp: Ramp = { x: 0, z: 0, h: 0, width: 5, length: 12, height: 1.8, peak: 0.72, kind: "plate" }
const input = { ...NO_INPUT, throttle: 1 }

describe("car jumps", () => {
  test("ramp gives airtime, preserves horizontal momentum in flight, then lands with short grip loss", () => {
    const b = newBody(0, -20, 0)
    b.vz = 32
    let airtime = 0, maxY = 0, impact = 0
    for (let i = 0; i < 100; i++) {
      const wasAirborne = b.airborne, vx = b.vx, vz = b.vz
      stepAndCollide(b, wasAirborne ? { ...input, brake: 1, steer: 1, boost: true } : input, spec, DT, [], undefined, [ramp])
      if (wasAirborne && b.airborne) { expect(b.vx).toBe(vx); expect(b.vz).toBe(vz) }
      if (b.airborne) airtime += DT
      if (b.landing > 0) { impact = b.landing; expect(b.landGrip).toBeGreaterThan(0) }
      maxY = Math.max(maxY, b.y)
    }
    expect(airtime).toBeGreaterThan(0.6)
    expect(maxY).toBeGreaterThan(ramp.height + 0.8)
    expect(impact).toBeGreaterThan(5)
    expect(b.y).toBe(0)
    expect(b.vy).toBe(0)
    expect(b.airborne).toBe(false)
    expect(b.landings).toBe(1)
    expect(b.landGrip).toBe(0)
  })

  test("seeded city ramps and two full world runs agree tick for tick", () => {
    const city = generateCity(7)
    expect(city.ramps.length).toBeGreaterThanOrEqual(8)
    expect(city.ramps).toEqual(generateCity(7).ramps)
    expect(city.ramps).not.toEqual(generateCity(8).ramps)
    const worlds = [new World(7, [human("r")]), new World(7, [human("r")])]
    const r = city.ramps.find(r => r.kind === "plate")!
    for (const w of worlds) {
      w.phase = "waiting"
      Object.assign(w.carOf("r")!.body, newBody(r.x - Math.sin(r.h) * 22, r.z - Math.cos(r.h) * 22, r.h), { vx: Math.sin(r.h) * 32, vz: Math.cos(r.h) * 32 })
      w.setInput("r", input)
    }
    let landed = false
    for (let i = 0; i < 90; i++) {
      for (const w of worlds) w.step(DT)
      expect(worlds[0]!.view()).toEqual(worlds[1]!.view())
      const events = worlds.map(w => w.drainEvents())
      expect(events[0]).toEqual(events[1])
      landed ||= events[0]!.some(e => e.kind === "landing" && e.impact! > 0)
    }
    expect(landed).toBe(true)
  })

  test("bot steering crosses a ramp in either direction without getting stuck", () => {
    for (const dir of [1, -1]) {
      const w = new World(7, [human("r")])
      const car = w.carOf("r")!
      Object.assign(car.body, newBody(0, -22 * dir, dir === 1 ? 0 : Math.PI), { vz: 26 * dir })
      let airborne = false
      for (let i = 0; i < 100; i++) {
        const control = driveToward(car, 0, 120 * dir, 32)
        stepAndCollide(car.body, control, car.vehicle, DT, [], undefined, [ramp])
        airborne ||= car.body.airborne
      }
      expect(airborne).toBe(true)
      expect(car.body.z * dir).toBeGreaterThan(40)
      expect(car.body.airborne).toBe(false)
    }
  })

  test("slow cars roll over; airborne cars clear lower cars but hit tall walls", () => {
    const b = newBody(0, -6, 0)
    b.vz = 2
    for (let i = 0; i < 300; i++) { b.vz = 2; stepAndCollide(b, NO_INPUT, spec, DT, [], undefined, [ramp]) }
    expect(b.landings).toBe(0)
    expect(b.y).toBe(0)
    const high = { ...newBody(0, 0, 0), y: 3, airborne: true }
    expect(collideCars(high, spec, newBody(0, 0, 0), spec, DT)).toBeNull()
  })

  test("height interpolates and roundtrips through the snapshot protocol", () => {
    const w = new World(7, [human("r")])
    const a = w.view(), b = w.view()
    b.cars[0]!.y = 4; b.cars[0]!.vy = -3; b.cars[0]!.airborne = true
    const blend = lerpView(a, b, 0.5)
    expect(blend.cars[0]!.y).toBe(2)
    const msg = decodeServer(encodeServer({ type: "snapshot", tick: 1, ack: 1, view: b, you: w.cars[0]!.body }))
    expect(msg?.type === "snapshot" && msg.view.cars[0]!.y).toBe(4)
  })

  test("prediction and delayed reconciliation keep the same launch and landing as the server", () => {
    const w = new World(7, [human("r")])
    w.phase = "waiting"
    const ramp = w.city.ramps.find(r => r.kind === "plate")!
    const body = w.carOf("r")!.body
    Object.assign(body, newBody(ramp.x - Math.sin(ramp.h) * 22, ramp.z - Math.cos(ramp.h) * 22, ramp.h), { vx: Math.sin(ramp.h) * 32, vz: Math.cos(ramp.h) * 32 })
    const client = new NetClient(w.city, "r", () => {})
    const snapshot = (tick: number, ack: number): ServerMsg => ({ type: "snapshot", tick, ack, view: w.view("r"), you: { ...body } })
    client.receive(snapshot(1, 0))
    const delayed: ServerMsg[] = []
    let jumped = false
    for (let i = 0; i < 90; i++) {
      client.update(DT, input)
      w.setInput("r", input); w.step(DT)
      delayed.push(snapshot(i + 2, i + 1))
      if (delayed.length > 2) client.receive(delayed.shift()!)
      expect(client.body!.y).toBeCloseTo(body.y, 9)
      expect(client.body!.vy).toBeCloseTo(body.vy, 9)
      expect(client.body!.landings).toBe(body.landings)
      jumped ||= body.airborne
    }
    expect(jumped).toBe(true)
    expect(body.landings).toBe(1)
  })

  test("brake and boost state follow controls, including steady ticks at rest", () => {
    const b = newBody(0, 0, 0)
    for (let i = 0; i < 10; i++) {
      stepAndCollide(b, { ...NO_INPUT, brake: 1 }, spec, DT, [])
      expect(b.braking).toBe(true)
    }
    stepAndCollide(b, input, spec, DT, [])
    expect(b.braking).toBe(false)
    stepAndCollide(b, { ...input, boost: true }, spec, DT, [])
    expect(b.boosting).toBe(true)
  })
})
