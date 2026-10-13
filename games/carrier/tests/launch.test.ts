import { describe, expect, test } from "bun:test"
import { BOW_Z, CENTERLINE_X, DECK_Y, RUNWAY } from "../shared/carrier-spec"
import { DECK_CENTRE_Y, LAUNCH, LAUNCH_SPEED, STROKE, catapult, catapultTime, launchStep, startLaunch, type ShipLike } from "../shared/launch"
import { VEHICLES, deckCentreY } from "../shared/vehicles"
import { CREW, makeCrew, joinCrew, joinShip, playerOf, runOp, recover, shipOf, type Crew } from "../shared/crew"
import { PLANE, planeSpeed, planeStep, shipToWorld, worldToShip, planeAttitude, type PlaneControls } from "../shared/plane"
import { makeSea } from "../shared/sea"
import { makeShip, shipStep } from "../shared/ship"

const DT = PLANE.tick
const HANDS_OFF: PlaneControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false }

/** A synthetic carrier pitching and heaving far harder than the sea ever makes it (±6°, ±3 m, 6.5 s), rolling ±5°,
 *  turning at 2°/s while steaming at 16 m/s. */
function stormShip(t: number, phase: number): ShipLike {
  const w = (2 * Math.PI) / 6.5
  const heading = 0.4 + t * 0.035
  return {
    x: 16 * Math.sin(0.4) * t,
    z: -16 * Math.cos(0.4) * t,
    heave: 3 * Math.sin(w * t + phase),
    heading,
    pitch: 0.105 * Math.sin(w * t + phase + 1),
    roll: 0.087 * Math.sin(0.5 * w * t + phase),
    u: 16,
    v: 0,
    r: 0.035,
  }
}

describe("launch", () => {
  test("leaves the bow above flying speed and above the deck on a calm sea", () => {
    const sea = makeSea(7)
    const ship = makeShip(0, 0, 0.3, 0)
    for (let i = 0; i < 600; i++) shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
    const { launch, plane } = startLaunch(ship)
    let left = false
    let steps = 0
    while (!left && steps < 600) {
      shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
      left = launchStep(launch, plane, ship, DT)
      steps++
    }
    expect(left).toBe(true)
    const total = (LAUNCH.hold + VEHICLES.hornet.strokeTime) / DT
    expect(Math.abs(steps - total)).toBeLessThan(4)
    const airspeed = planeSpeed(plane)
    expect(airspeed).toBeGreaterThan(PLANE.stallSpeed * 1.5)
    expect(LAUNCH_SPEED).toBeGreaterThan(85)
    // Inherits the ship's plan velocity: what is left after the launch run along the bow is the ship's own.
    const fx = Math.sin(ship.heading)
    const fz = -Math.cos(ship.heading)
    const along = plane.vx * fx + plane.vz * fz
    expect(Math.abs(along - (ship.u + LAUNCH_SPEED * Math.cos(LAUNCH.pathUp + Math.max(0, ship.pitch))))).toBeLessThan(0.5)
    expect(ship.u).toBeGreaterThan(5)
    const local = worldToShip(ship, plane.x, plane.y, plane.z)
    expect(local[1]).toBeGreaterThan(DECK_Y + 2)
    expect(local[2]).toBeGreaterThan(BOW_Z - 3)
    // Then it climbs away hands off for 5 s without touching anything.
    for (let i = 0; i < 300; i++) {
      shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
      planeStep(plane, HANDS_OFF, DT, { sea, arch: null, ships: [ship] })
    }
    expect(plane.crashed).toBe("")
    expect(plane.y).toBeGreaterThan(DECK_Y + 10)
  })

  test("stays on the catapult track of a heaving, pitching, rolling, turning deck and still flies off", () => {
    const sea = makeSea(2)
    for (const phase of [0, 1.5, 3, 4.5]) {
      let t = 0
      let ship = stormShip(t, phase)
      const { launch, plane } = startLaunch({ ...ship, t })
      let left = false
      while (!left) {
        t += DT
        ship = stormShip(t, phase)
        left = launchStep(launch, plane, ship, DT)
        if (!left) {
          const l = worldToShip(ship, plane.x, plane.y, plane.z)
          expect(Math.abs(l[0] - CENTERLINE_X)).toBeLessThan(1e-6)
          expect(Math.abs(l[1] - DECK_CENTRE_Y)).toBeLessThan(1e-6)
          expect(l[2]).toBeGreaterThan(RUNWAY.z0)
          expect(l[2]).toBeLessThanOrEqual(LAUNCH.endZ + 1e-6)
        }
      }
      expect(planeSpeed(plane)).toBeGreaterThan(PLANE.stallSpeed * 1.5)
      expect(planeAttitude(plane).pitch).toBeGreaterThan(0)
      const bow = shipToWorld(ship, CENTERLINE_X, DECK_Y, BOW_Z)
      expect(plane.y).toBeGreaterThan(bow[1] + 1.5)
      for (let i = 0; i < 240; i++) {
        t += DT
        planeStep(plane, HANDS_OFF, DT, { sea, arch: null, ships: [stormShip(t, phase)] })
      }
      expect(plane.crashed).toBe("")
      expect(plane.vy).toBeGreaterThan(0)
    }
  })

  test("glued to the deck while the real ship turns at full rudder on a swell", () => {
    const sea = makeSea(5555)
    const ship = makeShip(0, 0, 0, 0)
    for (let i = 0; i < 1800; i++) shipStep(ship, { throttle: 1, rudder: 1 }, sea, null)
    const { launch, plane } = startLaunch(ship)
    let left = false
    let prevLocalZ = -Infinity
    while (!left) {
      shipStep(ship, { throttle: 1, rudder: 1 }, sea, null)
      left = launchStep(launch, plane, ship, DT)
      if (left) break
      const l = worldToShip(ship, plane.x, plane.y, plane.z)
      expect(Math.abs(l[0] - CENTERLINE_X)).toBeLessThan(1e-6)
      expect(Math.abs(l[1] - DECK_CENTRE_Y)).toBeLessThan(1e-6)
      expect(l[2]).toBeGreaterThanOrEqual(prevLocalZ - 1e-9)
      prevLocalZ = l[2]
    }
    expect(Math.abs(ship.r)).toBeGreaterThan(0.01)
    expect(planeSpeed(plane)).toBeGreaterThan(PLANE.stallSpeed * 1.5)
  })

  test("one continuous launch: parked and still at idle, then thrust and motion start together from rest", () => {
    for (const kind of ["hornet", "f35"] as const) {
      const ship = Object.assign(makeShip(0, 0, 0.6, 0), { u: 12 })
      const { launch, plane } = startLaunch(ship, undefined, kind)
      const z0 = worldToShip(ship, plane.x, plane.y, plane.z)[2]
      expect(z0).toBeCloseTo(LAUNCH.startZ, 6)
      let steps = 0
      let left = false
      let startStep = -1
      let prevSpeed = 0
      let prevAccel = 0
      while (!left) {
        const before = launch.phase
        left = launchStep(launch, plane, ship, DT)
        steps++
        const z = worldToShip(ship, plane.x, plane.y, plane.z)[2]
        if (launch.phase === "ready") {
          // No creep before the thrust: not one millimetre, engines at idle.
          expect(z).toBeCloseTo(z0, 9)
          expect(launch.throttle).toBeLessThan(0.3)
          expect(launch.burner).toBe(0)
        }
        if (before === "ready" && launch.phase === "stroke") {
          startStep = steps
          // launchStart: full throttle and afterburner on the same step the motion begins, from (almost) rest.
          expect(launch.throttle).toBe(1)
          expect(launch.burner).toBe(1)
          expect(launch.speed).toBeLessThan(0.5)
        }
        if (launch.phase === "stroke") {
          const accel = (launch.speed - prevSpeed) / DT
          // Smooth in: the acceleration only ever grows, and never by a jolt; then holds near-constant ~3.5 g.
          expect(accel).toBeGreaterThanOrEqual(prevAccel - 1e-6)
          expect(accel - prevAccel).toBeLessThan(4)
          prevAccel = accel
          prevSpeed = launch.speed
        }
      }
      expect(startStep).toBeCloseTo(LAUNCH.hold / DT, -0.5)
      const cat = catapult(kind)
      expect(cat.accel / 9.81).toBeGreaterThan(3)
      expect(cat.accel / 9.81).toBeLessThan(3.7)
      expect(cat.time).toBeGreaterThanOrEqual(3)
      expect(cat.time).toBeLessThanOrEqual(4.5)
      expect(cat.speed).toBeGreaterThan(VEHICLES[kind].flight.stallSpeed * 2)
      expect(planeSpeed(plane)).toBeGreaterThan(VEHICLES[kind].flight.stallSpeed * 2)
    }
  })

  test("uses the runway: from its stern end to the bow, at least 85% of its length", () => {
    expect(STROKE).toBeGreaterThan(0.85 * (RUNWAY.z1 - RUNWAY.z0))
    expect(STROKE).toBeGreaterThan(250)
    expect(STROKE).toBeLessThan(300)
    // The parked jet's tail is on the deck, over the runway.
    expect(LAUNCH.startZ - 9.1).toBeGreaterThan(RUNWAY.z0)
    // On the F-35C's own gear too.
    const ship = makeShip(0, 0, 0, 0)
    const { plane } = startLaunch(ship, undefined, "f35")
    expect(worldToShip(ship, plane.x, plane.y, plane.z)[1]).toBeCloseTo(deckCentreY("f35"), 6)
  })

  test("is deterministic", () => {
    const run = () => {
      const sea = makeSea(42)
      const ship = makeShip(10, 20, 1, 0)
      const { launch, plane } = startLaunch(ship)
      for (let i = 0; i < 600; i++) {
        shipStep(ship, { throttle: 0.5, rudder: 0.3 }, sea, null)
        if (launch.phase !== "airborne") launchStep(launch, plane, ship, DT)
        else planeStep(plane, { pitch: 0.3, roll: 0.1, yaw: 0, throttle: 1, boost: i > 400 }, DT, { sea, arch: null })
      }
      return [plane.x, plane.y, plane.z, plane.qx, plane.qw, plane.vx]
    }
    expect(run()).toEqual(run())
  })
})

describe("one catapult per ship", () => {
  /** p1 helms a ship with p3 and p5 aboard as pilots on deck; p2 helms the other team's. */
  function crew(): Crew {
    const c = makeCrew(42)
    for (let i = 1; i <= 5; i++) joinCrew(c, i, `p${i}`, 0)
    const ship = playerOf(c, 1)!.ship
    for (const id of [3, 5]) if (playerOf(c, id)!.ship !== ship) joinShip(c, id, ship, 0, "pilot")
    return c
  }

  test("a second launch on the same ship is refused while the first is on the catapult, allowed once it has left", () => {
    const c = crew()
    const ship = playerOf(c, 1)!.ship
    const aboard = c.players.filter((p) => p.ship === ship).map((p) => p.id)
    expect(aboard.length).toBeGreaterThanOrEqual(3)
    const [a, b, d] = aboard as [number, number, number]
    const t0 = 10_000
    expect(runOp(c, a, "hornet", t0).error).toBeUndefined()
    const busy = catapultTime("hornet") * 1000
    // On the catapult (hold + stroke): refused with the reason, and the slot is left alone.
    const slots = JSON.stringify(shipOf(c, ship)!.aircraft)
    expect(runOp(c, b, "hornet", t0 + 1000).error).toBe("catapult-busy")
    expect(runOp(c, d, "f35", t0 + busy - 10).error).toBe("catapult-busy")
    expect(JSON.stringify(shipOf(c, ship)!.aircraft)).toBe(slots)
    expect(playerOf(c, b)!.plane).toBe(-1)
    // It has left the bow: the next jet may go.
    expect(runOp(c, b, "hornet", t0 + busy).error).toBeUndefined()
    // The jet's lifetime doesn't matter: once it has gone, landing or crashing don't hold the catapult.
    recover(c, a, "landed", t0 + busy + 5000)
    expect(runOp(c, d, "f35", t0 + 2 * busy + 1).error).toBeUndefined()
    expect(CREW.aircraft).toBeGreaterThan(1)
  })

  test("another ship's catapult is independent", () => {
    const c = crew()
    const ship = playerOf(c, 1)!.ship
    const other = c.players.find((p) => p.ship !== ship)!
    expect(runOp(c, 1, "hornet", 0).error).toBeUndefined()
    expect(runOp(c, other.id, "hornet", 100).error).toBeUndefined()
  })
})

