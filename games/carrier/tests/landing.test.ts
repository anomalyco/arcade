import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { BOW_Z, CENTERLINE_X, DECK_Y, ISLAND, STERN_Z } from "../shared/carrier-spec"
import { playerOf, shipOf } from "../shared/crew"
import { FLEET, makeHull } from "../shared/fleet"
import { LANDING, type LandingShip, approachTime, landTarget, landingStep, startLanding } from "../shared/landing"
import type { ShipLike } from "../shared/launch"
import { PLANE, type Plane, makePlane, quatAxis, setPlaneQuat, worldToShip } from "../shared/plane"
import { type ClientMsg, type ServerMsg, decodeServer, encode } from "../shared/protocol"
import { slotReady } from "../shared/ops"
import { makeSea } from "../shared/sea"
import { makeShip, shipStep } from "../shared/ship"
import { type VehicleKind, landingVehicle } from "../shared/vehicles"

const DT = PLANE.tick
const HORNET = landingVehicle("hornet")

/** A carrier pitching ±6°, heaving ±3 m, rolling ±5° and turning at 2°/s at 16 m/s (far harder than the sea does). */
function stormShip(t: number): ShipLike & { t: number } {
  const w = (2 * Math.PI) / 6.5
  return { t, x: 16 * Math.sin(0.4) * t, z: -16 * Math.cos(0.4) * t, heave: 3 * Math.sin(w * t), heading: 0.4 + t * 0.035, pitch: 0.105 * Math.sin(w * t + 1), roll: 0.087 * Math.sin(0.5 * w * t), u: 16, v: 0, r: 0.035 }
}

/** A jet `dist` m from the ship at relative bearing `bearing` (rad, 0 = ahead of the bow), `height` m above the deck,
 *  heading `off` rad away from the bearing back to the ship, at `speed` m/s. */
function nearShip(ship: ShipLike & { t: number }, dist: number, bearing: number, height: number, speed = 140, off = 0): Plane {
  const p = makePlane(ship.t)
  const a = ship.heading + bearing
  p.x = ship.x + Math.sin(a) * dist
  p.z = ship.z - Math.cos(a) * dist
  p.y = DECK_Y + ship.heave + height
  const h = Math.atan2(ship.x - p.x, -(ship.z - p.z)) + off
  setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI - h))
  p.vx = Math.sin(h) * speed
  p.vz = -Math.cos(h) * speed
  p.throttle = PLANE.cruise
  return p
}

const carrier = (id: number, team: number, x = 0, z = 0): LandingShip => Object.assign(makeShip(x, z, 0.3, 10), { id, team })

describe("the R LAND prompt", () => {
  const own = carrier(1, 0)
  /** A jet at (x, z), its nose `off` degrees (yaw) off the line to the ship. */
  const at = (x: number, z: number, off = 0, y = DECK_Y + 300, speed = 140): Plane => {
    const p = makePlane(10)
    Object.assign(p, { x, y, z })
    const yaw = Math.atan2(own.x - x, own.z - z) + off * (Math.PI / 180)
    setPlaneQuat(p, quatAxis(0, 1, 0, yaw))
    p.vx = Math.sin(yaw) * speed
    p.vz = Math.cos(yaw) * speed
    return p
  }

  test("offers your own carrier when close, under the ceiling, pointing at it, above stall, after the lockout", () => {
    expect(landTarget(at(0, 1000), 10, own, undefined, 10, HORNET)).toBe(own)
    expect(landTarget(at(600, -600, 20), 10, own, undefined, 10, HORNET)).toBe(own)
    expect(landTarget(at(0, 1000), 10, undefined, undefined, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, LANDING.range + 50), 10, own, undefined, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, 1000, 0, DECK_Y + LANDING.ceiling + 20), 10, own, undefined, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, 1000), LANDING.cooldown - 0.1, own, undefined, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, 1000, 0, DECK_Y + 300, PLANE.stallSpeed - 5), 10, own, undefined, 10, HORNET)).toBeNull()
    const crashed = at(0, 1000)
    crashed.crashed = "sea"
    expect(landTarget(crashed, 10, own, undefined, 10, HORNET)).toBeNull()
  })

  test("only while looking at it", () => {
    expect(landTarget(at(0, 1000, 45), 10, own, undefined, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, 1000, 180), 10, own, undefined, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, 1000, 90), 10, own, undefined, 10, HORNET)).toBeNull()
  })

  test("no prompt while its deck burns or it sinks", () => {
    const fire = Object.assign(makeHull(1, 0), { deckFire: 10 + FLEET.deckFire })
    expect(landTarget(at(0, 1000), 10, own, fire, 10, HORNET)).toBeNull()
    expect(landTarget(at(0, 1000), 10, own, fire, 10 + FLEET.deckFire + 1, HORNET)).toBe(own)
    expect(landTarget(at(0, 1000), 10, own, Object.assign(makeHull(1, 0), { sinkAt: 5 }), 10, HORNET)).toBeNull()
  })
})

/** Flies a landing to the end on `shipAt`, checking every step. Returns the time taken and how often it reported done. */
function land(plane: Plane, shipAt: (t: number) => ShipLike & { t: number }, kind: VehicleKind = "hornet") {
  let t = plane.t
  const lv = landingVehicle(kind)
  const l = startLanding(plane, shipAt(t), lv)
  let done = 0
  let steps = 0
  let ship = shipAt(t)
  let prevZ = -Infinity
  while (steps < 60 * 30) {
    t += DT
    ship = shipAt(t)
    const t0 = plane.t
    if (landingStep(l, plane, ship, DT)) done++
    // The jet's clock always advances (a stalled clock froze the game's step loop).
    expect(plane.t).toBeCloseTo(t0 + DT, 9)
    steps++
    const loc = worldToShip(ship, plane.x, plane.y, plane.z)
    // Never through the hull or the island (after the blend from where R was pressed).
    if (l.since > 0.8) {
      const overHull = loc[2] > STERN_Z && loc[2] < BOW_Z && Math.abs(loc[0]) < 38
      if (overHull) expect(loc[1]).toBeGreaterThan(DECK_Y + lv.rest - 0.05)
      const byIsland = loc[0] > ISLAND.x0 - 6 && loc[0] < ISLAND.x1 + 6 && loc[2] > ISLAND.z0 - 6 && loc[2] < ISLAND.z1 + 6
      if (byIsland) expect(loc[1]).toBeGreaterThan(ISLAND.y1)
      if (l.phase === "approach") expect(plane.y).toBeGreaterThan(10)
    }
    if (l.phase !== "approach") {
      // On the runway centreline, on the deck, never rolling back, stopped short of the bow.
      expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
      expect(Math.abs(loc[1] - (DECK_Y + lv.rest))).toBeLessThan(1e-6)
      expect(loc[2]).toBeGreaterThanOrEqual(prevZ - 1e-6)
      expect(loc[2]).toBeLessThan(BOW_Z - 60)
      prevZ = loc[2]
    }
    if (done && l.time > 2) break
  }
  return { l, done, since: l.since, ship }
}

describe("the scripted landing", () => {
  test("lands from every direction, height and heading: head-on, beside, behind, directly above; within the timeout", () => {
    let n = 0
    for (const kind of ["hornet", "f35"] as const)
      for (let b = 0; b < 12; b++)
        for (const dist of [60, 700, 1950])
          for (const [height, speed, off] of [
            [20, 90, 0],
            [500, 240, 1.2],
            [980, 160, Math.PI],
          ] as const) {
            const plane = nearShip(stormShip(3), dist, (b / 12) * Math.PI * 2, height, speed, off)
            const r = land(plane, stormShip, kind)
            n++
            expect(r.done).toBe(1)
            expect(r.l.phase).toBe("done")
            // Finished by itself, never by the hard timeout.
            expect(approachTime(r.l) + LANDING.trap + LANDING.hold).toBeLessThan(LANDING.timeout)
          }
    expect(n).toBe(216)
  })

  test("from close behind it is quick; from far ahead it still finishes well inside the timeout", () => {
    const close = startLanding(nearShip(stormShip(3), 900, Math.PI, 80, 120), stormShip(3), HORNET)
    expect(approachTime(close) + LANDING.trap + LANDING.hold).toBeLessThan(10)
    const far = startLanding(nearShip(stormShip(3), 1990, 0, 900, 250), stormShip(3), HORNET)
    expect(approachTime(far) + LANDING.trap + LANDING.hold).toBeLessThan(18)
  })

  test("on a real ship at sea, turning at full rudder", () => {
    const sea = makeSea(5)
    const ship = makeShip(0, 0, 0.3, 0)
    for (let i = 0; i < 1200; i++) shipStep(ship, { throttle: 1, rudder: 1 }, sea, null)
    const plane = nearShip(ship, 1500, Math.PI / 2, 300, 150)
    const l = startLanding(plane, ship, HORNET)
    let done = 0
    for (let i = 0; i < 60 * 25 && l.phase !== "done"; i++) {
      shipStep(ship, { throttle: 1, rudder: 1 }, sea, null)
      if (landingStep(l, plane, ship, DT)) done++
    }
    expect(done).toBe(1)
    const loc = worldToShip(ship, plane.x, plane.y, plane.z)
    expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
    expect(loc[2]).toBeGreaterThan(LANDING.touchZ)
  })

  test("the hard timeout ends it on the deck even if the sequence overruns", () => {
    const plane = nearShip(stormShip(3), 1500, 1, 300)
    const l = startLanding(plane, stormShip(3), HORNET)
    // An approach that never ends by itself.
    for (const s of l.segs) s.T = 1e6
    let done = 0
    let t = 3
    for (let i = 0; i < 60 * (LANDING.timeout + 3); i++) {
      t += DT
      if (landingStep(l, plane, stormShip(t), DT)) done++
    }
    expect(done).toBe(1)
    expect(l.phase).toBe("done")
    const loc = worldToShip(stormShip(t), plane.x, plane.y, plane.z)
    expect(Math.abs(loc[0] - CENTERLINE_X)).toBeLessThan(0.5)
  })

  test("deterministic", () => {
    const go = () => {
      const plane = nearShip(stormShip(3), 1700, 2.1, 400, 200, 0.7)
      land(plane, stormShip)
      return [plane.x, plane.y, plane.z, plane.qx, plane.qw]
    }
    expect(go()).toEqual(go())
  })

  test("a game-style step loop catches up and never spins after the landing is done (the old freeze)", () => {
    const plane = nearShip(stormShip(3), 800, Math.PI, 100, 120)
    const l = startLanding(plane, stormShip(3), HORNET)
    // The host steps while its clock is behind the frame's sea time, for a minute after the landing has ended.
    for (let frame = 1; frame < 60 * 40; frame++) {
      const t = 3 + frame / 60
      let n = 0
      while (plane.t + DT <= t) {
        landingStep(l, plane, stormShip(plane.t + DT), DT)
        expect(++n).toBeLessThan(5)
      }
    }
    expect(l.phase).toBe("done")
  })
})

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  send(data: string) {
    const m = decodeServer(data)
    if (m) this.sent.push(m)
  }
  close() {}
  get id(): number {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: "welcome" }> => m.type === "welcome").at(-1)!.id
  }
}

describe("after landing, back on deck as a pilot with the slot free", () => {
  function room() {
    let now = 1_000_000
    const core = new RoomCore(
      () => now,
      () => 42,
    )
    const join = (name: string) => {
      const c = new FakeConn()
      core.message(c, encode({ type: "hello", build: BUILD, name }))
      return c
    }
    const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
    return { core, join, say, step: (ms: number) => core.step((now += ms)), now: () => now }
  }

  test("on its own carrier: the slot frees at once (no recharge); a repeated recover is harmless", () => {
    const { core, join, say, now } = room()
    const a = join("ada")
    const b = join("bo")
    const c = join("cy")
    const crew = core.crew!
    // cy is on ada's ship (team 0) as a pilot on deck: launch, then land.
    const ship = playerOf(crew, a.id)!.ship
    const pilot = [b, c].find((x) => playerOf(crew, x.id)!.ship === ship)!
    say(pilot, { type: "op", op: "hornet" })
    const p = playerOf(core.crew!, pilot.id)!
    const slot = p.plane
    expect(slot).toBeGreaterThanOrEqual(0)
    say(pilot, { type: "recover", how: "landed" })
    const after = playerOf(core.crew!, pilot.id)!
    expect(after).toMatchObject({ role: "pilot", plane: -1, ship })
    expect(slotReady(shipOf(core.crew!, ship)!.aircraft[slot]!, now())).toBe(true)
    // A late duplicate changes nothing.
    say(pilot, { type: "recover", how: "landed" })
    expect(playerOf(core.crew!, pilot.id)).toMatchObject({ role: "pilot", plane: -1, ship })
  })

  test("on another friendly carrier: aboard it as a pilot, its own slot free at once", () => {
    const { core, join, say, now } = room()
    const a = join("ada")
    join("bo")
    const crew = core.crew!
    const home = playerOf(crew, a.id)!.ship
    const team = playerOf(crew, a.id)!.team
    const other = crew.ships.find((s) => s.team === team && s.id !== home)!
    expect(other).toBeDefined()
    say(a, { type: "op", op: "hornet" })
    const slot = playerOf(core.crew!, a.id)!.plane
    say(a, { type: "recover", how: "landed", ship: other.id })
    expect(playerOf(core.crew!, a.id)).toMatchObject({ role: "pilot", plane: -1, ship: other.id })
    expect(slotReady(shipOf(core.crew!, home)!.aircraft[slot]!, now())).toBe(true)
  })
})
