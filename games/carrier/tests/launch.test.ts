import { describe, expect, test } from "bun:test"
import { BOW_Z, CENTERLINE_X, DECK_Y, RUNWAY } from "../shared/carrier-spec"
import { DECK_CENTRE_Y, LAUNCH, LAUNCH_SPEED, launchStep, startLaunch, type ShipLike } from "../shared/launch"
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
    const total = (LAUNCH.lineupTime + LAUNCH.spoolTime + LAUNCH.strokeTime) / DT
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
