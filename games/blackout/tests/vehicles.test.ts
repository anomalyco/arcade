import { describe, expect, test } from "bun:test"
import { DT, GUNS, HEALTH } from "../shared/config"
import { Builder } from "../shared/maps/builder"
import { generateOffice } from "../shared/maps/office"
import type { MapDef } from "../shared/maps"
import { decodeClient } from "../shared/protocol"
import { type Drive, VEHICLES, boxOf, distToBox, driveOf, driveStep, halfOf, pushOutBox, rayBox, speedOf, forwardSpeed } from "../shared/sim/vehicle"
import { VEH, type Vehicle } from "../shared/sim/vehicle-rules"
import { lotMap } from "../shared/sim/vehicle-lot"
import { buildSnapshot } from "../shared/sim/view"
import { type Intent, NO_INTENT, type SimEvent, World } from "../shared/sim/world"
import type { ModeId } from "../shared/sim/modes"
import { place, run } from "./helpers"

/** An open 70 x 40 m yard with a wall across x = 50, a jeep, a van and a scooter parked facing east. */
function yard(): MapDef {
  const b = new Builder()
  b.floor("concrete", 0, 0, 70, 40)
  b.wall(0, 0, 70, 0.3)
  b.wall(0, 39.7, 70, 40)
  b.wall(0, 0, 0.3, 40)
  b.wall(69.7, 0, 70, 40)
  b.wall(50, 0.3, 50.4, 39.7)
  b.spawns.push({ x: 3, y: 3 }, { x: 3, y: 37 }, { x: 45, y: 3 }, { x: 45, y: 37 })
  return {
    ...b.build({ id: "yard", seed: 0, name: "Yard", size: [70, 40] }),
    vehicles: [
      { kind: "jeep", x: 10, y: 10, heading: 0 },
      { kind: "van", x: 10, y: 22, heading: 0 },
      { kind: "scooter", x: 10, y: 32, heading: 0 },
    ],
  }
}

function yardWorld(names: string[] = ["a", "b"], mode: ModeId = "ffa"): World {
  const w = new World(5, yard(), mode)
  for (const n of names) w.addHuman(n, n)
  for (const p of [...w.players.values()]) if (!p.human) w.remove(p.id)
  w.step()
  w.takeEvents()
  return w
}

const jeep = (w: World) => w.vehicles.find((v) => v.kind === "jeep")!
const van = (w: World) => w.vehicles.find((v) => v.kind === "van")!
const press = (w: World, intents: Record<string, Partial<Intent>>) => run(w, DT, (id) => intents[id] ?? {})
const events = (w: World) => w.takeEvents()
const far = (w: World, ...ids: string[]) => ids.forEach((id, i) => place(w, id, 40, 5 + i * 3))

describe("getting in and out", () => {
  test("F next to a vehicle takes the wheel; the next player gets the nearest free seat; F again gets out to the side", () => {
    const w = yardWorld(["a", "b", "c"])
    far(w, "c")
    place(w, "a", 10, 8.5)
    place(w, "b", 9, 11.4)
    press(w, { a: { enter: true } })
    const a = w.players.get("a")!
    const v = jeep(w)
    expect(a.veh).toBe(v.id)
    expect(a.seat).toBe(0)
    expect(v.seats[0]).toBe("a")
    expect(events(w).some((e) => e.k === "veh" && e.what === "enter" && e.by === "a")).toBe(true)
    press(w, { b: { enter: true } })
    const b = w.players.get("b")!
    expect(b.veh).toBe(v.id)
    // b stood by the rear right: the nearest free seat to them.
    expect(b.seat).toBe(3)
    // Riders sit on their seats.
    expect(Math.hypot(a.x - 10, a.y - (10 - 0.42))).toBeLessThan(0.05)
    press(w, { a: { enter: true } })
    expect(a.veh).toBe(0)
    expect(v.seats[0]).toBe("")
    expect(distToBox(a.x, a.y, boxOf(v, v.spec))).toBeGreaterThan(0.3)
    expect(a.y).toBeLessThan(v.y)
  })

  test("too far away, nothing happens; a full vehicle takes nobody else", () => {
    const w = yardWorld(["a", "b", "c"])
    place(w, "a", 10, 5)
    place(w, "b", 10, 30.5)
    place(w, "c", 10, 30.2)
    press(w, { a: { enter: true } })
    expect(w.players.get("a")!.veh).toBe(0)
    press(w, { b: { enter: true } })
    expect(w.players.get("b")!.veh).toBeGreaterThan(0)
    place(w, "a", 10.5, 31.2)
    press(w, { a: { enter: true } })
    press(w, { c: { enter: true } })
    expect(w.players.get("c")!.veh).toBe(0)
  })

  test("walkers can't go through a parked vehicle", () => {
    const w = yardWorld(["a"])
    place(w, "a", 10, 7)
    run(w, 2, () => ({ my: 1 }))
    const a = w.players.get("a")!
    expect(a.y).toBeLessThan(10)
    expect(distToBox(a.x, a.y, boxOf(jeep(w), VEHICLES.jeep))).toBeGreaterThan(0.25)
  })

  test("the infected can't get in", () => {
    const w = yardWorld(["a", "b"], "inf")
    const a = w.players.get("a")!
    a.team = 1
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    expect(a.veh).toBe(0)
  })

  test("office floors have no vehicles, maps with spawns do", () => {
    expect(new World(1, generateOffice(3)).vehicles.length).toBe(0)
    expect(new World(1, lotMap()).vehicles.length).toBe(lotMap().vehicles!.length)
  })
})

describe("driving", () => {
  test("W drives forward, A and D steer, S brakes", () => {
    const w = yardWorld(["a"])
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    const v = jeep(w)
    run(w, 2, () => ({ my: -1 }))
    expect(v.x).toBeGreaterThan(18)
    expect(speedOf(v)).toBeGreaterThan(8)
    expect(Math.abs(v.y - 10)).toBeLessThan(0.1)
    // D turns right: clockwise on the plan, toward +y.
    run(w, 0.5, () => ({ my: -1, mx: 1 }))
    expect(v.h).toBeGreaterThan(0.3)
    run(w, 0.5, () => ({ my: 1 }))
    expect(speedOf(v)).toBeLessThan(8)
    // Held on, S backs up once stopped.
    run(w, 2, () => ({ my: 1 }))
    expect(forwardSpeed(v)).toBeLessThan(-1)
  })

  test("a wall stops a vehicle without letting it through, and a hard crash hurts it", () => {
    const w = yardWorld(["a"])
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    const v = jeep(w)
    run(w, 5, () => ({ my: -1 }))
    const [hl] = halfOf(v.spec)
    expect(v.x).toBeLessThan(50 - hl + 0.05)
    expect(v.x).toBeGreaterThan(40)
    expect(v.hp).toBeLessThan(v.spec.hp)
    expect(w.players.get("a")!.alive).toBe(true)
  })

  test("vehicles bump each other instead of overlapping", () => {
    const w = yardWorld(["a"])
    const vn = van(w)
    vn.x = 22
    vn.y = 10
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    const v = jeep(w)
    run(w, 3, () => ({ my: -1 }))
    const [hl] = halfOf(v.spec)
    const [vl] = halfOf(vn.spec)
    expect(vn.x - v.x).toBeGreaterThan(hl + vl - 0.1)
    expect(vn.x).toBeGreaterThan(22.2)
  })

  test("driving into an enemy fast runs them over; slow or a teammate just gets shoved", () => {
    const w = yardWorld(["a", "b"])
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    place(w, "b", 30, 10)
    run(w, 2.5, (id) => (id === "a" ? { my: -1 } : {}))
    const b = w.players.get("b")!
    expect(b.alive).toBe(false)
    const kill = events(w).find((e): e is Extract<SimEvent, { k: "kill" }> => e.k === "kill")
    expect(kill?.how).toBe("roadkill")
    expect(w.players.get("a")!.kills).toBe(1)

    const t = yardWorld(["a", "b"], "tdm")
    const ta = t.players.get("a")!
    const tb = t.players.get("b")!
    tb.team = ta.team
    place(t, "a", 10, 8.5)
    press(t, { a: { enter: true } })
    place(t, "b", 30, 10)
    run(t, 2.5, (id) => (id === "a" ? { my: -1 } : {}))
    expect(tb.alive).toBe(true)
    expect(distToBox(tb.x, tb.y, boxOf(jeep(t), VEHICLES.jeep))).toBeGreaterThan(0.2)
  })
})

describe("shooting", () => {
  test("rounds stop on a vehicle and wear it down", () => {
    const w = yardWorld(["a", "b"])
    place(w, "a", 10, 16)
    place(w, "b", 10, 3)
    const v = jeep(w)
    run(w, 0.5, (id) => (id === "a" ? { aim: -Math.PI / 2, fire: true } : {}))
    expect(v.hp).toBeLessThan(v.spec.hp)
    expect(w.players.get("b")!.health).toBe(HEALTH)
  })

  test("a destroyed vehicle explodes: riders die, people close by are hurt, the shooter gets the kills", () => {
    const w = yardWorld(["a", "b", "c", "d"])
    far(w, "d")
    place(w, "b", 10, 8.5)
    press(w, { b: { enter: true } })
    place(w, "c", 10, 12.6)
    w.players.get("c")!.health = HEALTH
    place(w, "a", 3, 10).cooldownUntil = 0
    const v = jeep(w)
    v.hp = 20
    events(w)
    // Aim at the bodywork, away from the rider.
    run(w, 0.3, (id) => (id === "a" ? { aim: 0.05, fire: true } : {}))
    const ev = events(w)
    expect(v.state).toBe("wreck")
    expect(ev.some((e) => e.k === "wreck" && e.id === v.id && e.by === "a")).toBe(true)
    expect(w.players.get("b")!.alive).toBe(false)
    expect(w.players.get("b")!.veh).toBe(0)
    expect(w.players.get("c")!.alive).toBe(false)
    expect(w.players.get("a")!.kills).toBe(2)
    expect(ev.some((e) => e.k === "kill" && e.victim === "b" && e.how === "vehicle")).toBe(true)
  })

  test("riders can be shot, behind armour", () => {
    const w = yardWorld(["a", "b"])
    place(w, "b", 10, 8.5)
    press(w, { b: { enter: true } })
    const b = w.players.get("b")!
    const a = place(w, "a", b.x, b.y - 8)
    a.cooldownUntil = 0
    run(w, DT, (id) => (id === "a" ? { aim: Math.PI / 2, fire: true } : {}))
    expect(b.health).toBeCloseTo(HEALTH - GUNS.rifle.damage * VEHICLES.jeep.seats[0]!.armor, 5)
  })

  test("passengers shoot, the driver can't", () => {
    const w = yardWorld(["a", "b", "c"])
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    place(w, "b", 9, 11.4)
    press(w, { b: { enter: true } })
    place(w, "c", 30, 30)
    events(w)
    run(w, 0.5, (id) => (id === "c" ? {} : { aim: Math.atan2(30 - 10, 30 - 10), fire: true }))
    const shots = events(w).filter((e) => e.k === "shot")
    expect(shots.some((e) => e.k === "shot" && e.by === "b")).toBe(true)
    expect(shots.some((e) => e.k === "shot" && e.by === "a")).toBe(false)
  })

  test("a wreck burns as cover, then the vehicle is back at its spot", () => {
    const w = yardWorld(["a", "b"])
    far(w, "a", "b")
    const v = jeep(w)
    v.x = 20
    v.hp = 1
    w.players.get("a")!.cooldownUntil = 0
    place(w, "a", 20, 3)
    run(w, 0.2, (id) => (id === "a" ? { aim: Math.PI / 2, fire: true } : {}))
    expect(v.state).toBe("wreck")
    far(w, "a", "b")
    run(w, VEH.wreck + 0.5)
    expect(v.state).toBe("gone")
    expect(buildSnapshot(w, "a").vehicles!.some((x) => x.id === v.id)).toBe(false)
    run(w, VEH.respawn - VEH.wreck)
    expect(v.state).toBe("ok")
    expect(v.hp).toBe(v.spec.hp)
    expect([v.x, v.y]).toEqual([10, 10])
  })

  test("a frag next to a vehicle damages it", () => {
    const w = yardWorld(["a", "b"])
    far(w, "b")
    const a = place(w, "a", 10, 16)
    a.cooldownUntil = 0
    const v = jeep(w)
    run(w, DT, (id) => (id === "a" ? { aim: -Math.PI / 2, equip: true, tx: 10, ty: 12 } : {}))
    place(w, "a", 3, 37)
    run(w, 2.5)
    expect(v.hp).toBeLessThan(v.spec.hp)
  })
})

describe("prediction and the wire", () => {
  test("replaying the driver's inputs from a snapshot lands exactly where the server does", () => {
    const w = yardWorld(["a"])
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    run(w, 1, () => ({ my: -1 }))
    const v = jeep(w)
    const snap = buildSnapshot(w, "a").vehicles!.find((x) => x.id === v.id)!
    const body = { x: v.x, y: v.y, h: v.h, vx: v.vx, vy: v.vy, w: v.w }
    expect(snap.x).toBe(v.x)
    const inputs: Partial<Intent>[] = []
    for (let i = 0; i < 60; i++) inputs.push({ my: i < 40 ? -1 : 0.5, mx: i % 20 < 10 ? 1 : -0.4, sprint: i > 50 })
    let k = 0
    run(w, inputs.length * DT, () => inputs[k++]!)
    for (const i of inputs) driveStep(body, driveOf({ ...NO_INTENT, ...i }), VEHICLES.jeep, DT, w.solids)
    expect(body.x).toBe(v.x)
    expect(body.y).toBe(v.y)
    expect(body.h).toBe(v.h)
  })

  test("the snapshot carries vehicles and who rides where", () => {
    const w = yardWorld(["a"])
    place(w, "a", 10, 8.5)
    press(w, { a: { enter: true } })
    const s = buildSnapshot(w, "a")
    const v = s.vehicles!.find((x) => x.kind === "jeep")!
    expect(v.seats[0]).toBe("a")
    expect(s.players.find((p) => p.id === "a")!.veh).toBe(v.id)
    expect(new World(1, generateOffice(2)).vehicles).toEqual([])
    expect("vehicles" in buildSnapshot(new World(1, generateOffice(2)), "x")).toBe(false)
  })

  test("enter and horn are validated presses", () => {
    const m = decodeClient(JSON.stringify({ type: "intent", seq: 3, i: { mx: 4, my: -1, aim: 0, enter: true, horn: "yes" } }))
    expect(m?.type).toBe("intent")
    if (m?.type !== "intent") return
    expect(m.i.enter).toBe(true)
    expect(m.i.horn).toBeUndefined()
    expect(m.i.mx).toBe(1)
    const n = decodeClient(JSON.stringify({ type: "intent", seq: 4, i: { mx: 0, my: 0, aim: 0, enter: 1 } }))
    expect(n?.type === "intent" && n.i.enter).toBeFalsy()
  })
})

describe("geometry", () => {
  test("boxes: distance, push-out and rays respect the heading", () => {
    const k = { x: 0, y: 0, h: Math.PI / 2, hl: 2, hw: 1 }
    expect(distToBox(0, 1.9, k)).toBe(0)
    expect(distToBox(1.5, 0, k)).toBeCloseTo(0.5, 9)
    const p = { x: 0.9, y: 0 }
    expect(pushOutBox(p, 0.3, k)).toBe(true)
    expect(p.x).toBeCloseTo(1.3, 9)
    const hit = rayBox(-5, 0, 1, 0, k, 20)!
    expect(hit[0]).toBeCloseTo(4, 9)
    expect(hit[1]).toBeCloseTo(6, 9)
    expect(rayBox(-5, 3, 1, 0, k, 20)).toBeNull()
  })

  test("an empty vehicle rolls to a stop on its own", () => {
    const b = { x: 0, y: 0, h: 0, vx: 10, vy: 0, w: 0 }
    const parked: Drive = { throttle: 0, steer: 0, handbrake: true }
    for (let i = 0; i < 60; i++) driveStep(b, parked, VEHICLES.van, DT, [])
    expect(speedOf(b)).toBe(0)
    expect(b.x).toBeGreaterThan(2)
  })
})

export type { Vehicle }
