import { expect, test } from "bun:test"
import { DT, GRID, CELL, VEHICLE_BY_ID } from "../shared/config"
import { decodeServer, encodeServer, type ServerMsg } from "../shared/protocol"
import { followRoute } from "../shared/sim/bots"
import { generateCity, NODE_COUNT, nodeIndex, routeNodes } from "../shared/sim/city"
import { crossTunnel, inTunnel, TUNNEL } from "../shared/sim/tunnel"
import { newBody, NO_INPUT, stepAndCollide, speedOf } from "../shared/sim/vehicle"
import { World } from "../shared/sim/world"
import { lerpView } from "../src/game/interp"
import { NetClient } from "../src/game/netcode"
import { Camera } from "../src/game/camera"
import { human, bot } from "./sim-helpers"

const input = { ...NO_INPUT, throttle: 1 }
const spec = VEHICLE_BY_ID.get("muscle")!

test("both tunnel directions mirror exit pose, preserve speed and retain overshoot", () => {
  for (const dir of [1, -1]) {
    const edge = dir > 0 ? TUNNEL.east : TUNNEL.west
    const b = { ...newBody(edge + dir * 0.2, TUNNEL.z + 2, dir * 1.4), vx: 30 * dir, vz: 3, yaw: 0.2 }
    const speed = speedOf(b)
    expect(crossTunnel(b)).toBe(true)
    expect(b.x).toBeCloseTo((dir > 0 ? TUNNEL.west : TUNNEL.east) + dir * 0.2, 10)
    expect(b.z).toBe(TUNNEL.z - 2)
    expect(b.h).toBe(Math.PI - dir * 1.4)
    expect(b.vz).toBe(-3)
    expect(b.yaw).toBe(-0.2)
    expect(speedOf(b)).toBe(speed)
    expect(b.tunnels).toBe(1)
    expect(crossTunnel(b)).toBe(false)
  }
  const outside = { ...newBody(TUNNEL.east + 1, TUNNEL.z + 9, 1.5), vx: 30 }
  expect(crossTunnel(outside)).toBe(false)
})

test("the mouths are drivable and the rest of the perimeter stays solid", () => {
  const city = generateCity(7)
  for (const dir of [1, -1]) {
    const b = { ...newBody(dir > 0 ? GRID * CELL - 10 : 10, TUNNEL.z, dir * Math.PI / 2), vx: dir * 30 }
    for (let i = 0; i < 75; i++) stepAndCollide(b, input, spec, DT, city.boxes, undefined, city.ramps)
    expect(b.tunnels).toBe(1)
    expect(b.vx * dir).toBeGreaterThan(25)
  }
  const b = { ...newBody(GRID * CELL, TUNNEL.z + 20, Math.PI / 2), vx: 30 }
  for (let i = 0; i < 50; i++) stepAndCollide(b, input, spec, DT, city.boxes)
  expect(b.tunnels).toBe(0)
  expect(b.x).toBeLessThan(TUNNEL.eastMouth)
})

test("two worlds and delayed predicted snapshots cross on the same tick without visual travel across the map", () => {
  const worlds = [new World(7, [human("r")]), new World(7, [human("r")])]
  for (const w of worlds) {
    w.phase = "waiting"
    Object.assign(w.carOf("r")!.body, newBody(TUNNEL.east - 8, TUNNEL.z + 1, Math.PI / 2), { vx: 30 })
  }
  const w = worlds[0]!, body = w.carOf("r")!.body
  const client = new NetClient(w.city, "r", () => {})
  const snapshot = (tick: number, ack: number): ServerMsg => ({ type: "snapshot", tick, ack, view: w.view("r"), you: { ...body } })
  client.receive(snapshot(1, 0))
  const delayed: ServerMsg[] = []
  for (let i = 0; i < 45; i++) {
    const v = client.update(DT, input)!
    for (const world of worlds) { world.setInput("r", input); world.step(DT) }
    expect(worlds[0]!.view()).toEqual(worlds[1]!.view())
    delayed.push(decodeServer(encodeServer(snapshot(i + 2, i + 1)))!)
    if (delayed.length > 2) client.receive(delayed.shift()!)
    expect(client.body!.x).toBeCloseTo(body.x, 9)
    expect(client.body!.tunnels).toBe(body.tunnels)
    const drawn = v.cars.find(c => c.ownerId === "r")!
    expect(drawn.x < 70 || drawn.x > TUNNEL.eastMouth - 20).toBe(true)
  }
  expect(body.tunnels).toBe(1)
})

test("a bot uses the short navigation link and drives through in either direction", () => {
  for (const dir of [1, -1]) {
    const w = new World(7, [human("r")]), c = w.carOf("r")!
    const from = nodeIndex(dir > 0 ? GRID : 0, 2), to = nodeIndex(dir > 0 ? 0 : GRID, 2)
    c.route = routeNodes(w.city, from, to)
    expect(c.route.filter(n => n >= NODE_COUNT).length).toBe(2)
    c.routeI = 0
    Object.assign(c.body, newBody(w.city.nodes[from]!.x, TUNNEL.z, dir * Math.PI / 2), { vx: 28 * dir })
    for (let i = 0; i < 100; i++) {
      stepAndCollide(c.body, followRoute(w, c, w.city.nodes[to]!.x, TUNNEL.z, 32), c.vehicle, DT, w.city.boxes, undefined, w.city.ramps)
    }
    expect(c.body.tunnels).toBe(1)
    expect(Math.abs(c.body.x - w.city.nodes[to]!.x)).toBeLessThan(35)
  }
})

test("pursuit loses sight in the bore and the bot cop follows the observed departure", () => {
  const w = new World(7, [human("r"), bot("c")])
  w.phase = "chase"; w.phaseT = 0; w.robberId = "r"
  const r = w.carOf("r")!, c = w.carOf("c")!
  r.role = "robber"; c.role = "cop"
  Object.assign(r.body, newBody(TUNNEL.eastMouth - 7, TUNNEL.z, Math.PI / 2), { vx: 28 })
  Object.assign(c.body, newBody(TUNNEL.eastMouth - 24, TUNNEL.z, Math.PI / 2), { vx: 28 })
  let hidden = false, followed = false
  for (let i = 0; i < 130; i++) {
    w.setInput("r", input); w.step(DT)
    if (inTunnel(r.body)) { hidden = true; expect(w.seen).toBe(false); expect(w.canSee(c, r)).toBe(false) }
    if (c.body.tunnels === 1 && r.body.tunnels === 1) {
      followed = true
      expect(c.body.x).toBeLessThan(r.body.x)
      break
    }
  }
  expect(hidden).toBe(true)
  expect(followed).toBe(true)
})

test("protocol keeps the discontinuity marker; interpolation and camera cut", () => {
  const w = new World(7, [human("r")]), b = w.carOf("r")!.body
  Object.assign(b, newBody(TUNNEL.east + 0.1, TUNNEL.z, Math.PI / 2), { vx: 30, vz: 0.125, yaw: 0.25 })
  const before = w.view()
  crossTunnel(b)
  const msg = decodeServer(encodeServer({ type: "snapshot", tick: 2, ack: 1, view: w.view(), you: b }))!
  expect(msg.type).toBe("snapshot")
  if (msg.type !== "snapshot") throw new Error("snapshot missing")
  expect(msg.you).toEqual(b)
  const after = msg.view
  for (const t of [0, 0.2, 0.5, 0.9]) expect(lerpView(before, after, t).cars[0]).toEqual(after.cars[0])
  const cam = new Camera()
  cam.snap(TUNNEL.east, TUNNEL.z)
  cam.update(b.x, b.z, 30, 0, DT)
  expect(Math.abs(cam.fx - b.x)).toBeLessThan(1)
})

test("a coasting remote proxy snaps on crossing, including its near-car blend", () => {
  const w = new World(7, [human("r"), human("c")])
  w.phase = "waiting"
  const r = w.carOf("r")!, c = w.carOf("c")!
  Object.assign(r.body, newBody(TUNNEL.west + 20, TUNNEL.z, Math.PI / 2))
  Object.assign(c.body, newBody(TUNNEL.east - 0.2, TUNNEL.z, Math.PI / 2), { vx: 30 })
  const client = new NetClient(w.city, "r", () => {})
  client.receive({ type: "snapshot", tick: 1, ack: 0, you: { ...r.body }, view: w.view("r") })
  const view = client.update(DT * 1.5, NO_INPUT)!
  const proxy = view.cars.find(car => car.id === c.id)!
  expect(proxy.tunnels).toBe(1)
  expect(proxy.x).toBeCloseTo(TUNNEL.west + 0.8, 9)
})
