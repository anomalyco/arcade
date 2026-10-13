import { describe, expect, test } from "bun:test"
import { BOW_Z, CENTERLINE_X, DECK_Y, STERN_Z } from "../shared/carrier-spec"
import { LANDING, captureMiss, landingStep, startLanding } from "../shared/landing"
import { DECK_CENTRE_Y, LAUNCH, LAUNCH_SPEED, catapult, launchPose, launchStep, startLaunch } from "../shared/launch"
import { LOADOUTS } from "../shared/weapons"
import { PLANE, type Plane, type PlaneControls, type PlaneTuning, makePlane, planeSpeed, planeStep, quatAxis, setPlaneQuat, worldToShip } from "../shared/plane"
import { makeSea } from "../shared/sea"
import { makeShip, shipStep } from "../shared/ship"
import { VEHICLES, VEHICLE_KINDS, deckCentreY, landingVehicle } from "../shared/vehicles"

const DT = PLANE.tick
const HANDS_OFF: PlaneControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false }
const F35 = VEHICLES.f35.flight

/** Level flight north at `speed` with the throttle at cruise. */
function flying(speed: number, cruise: number, y = 1500): Plane {
  const p = makePlane()
  Object.assign(p, { y, vz: -speed, throttle: cruise })
  setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI))
  return p
}

const run = (p: Plane, c: PlaneControls, s: number, P: PlaneTuning = PLANE) => {
  for (let i = 0; i < s / DT; i++) planeStep(p, c, DT, { sea: null, arch: null }, P)
}

describe("vehicle table", () => {
  test("the Hornet is unchanged; every type has a loadout, probes and gear", () => {
    expect(VEHICLES.hornet.flight).toBe(PLANE)
    expect(VEHICLES.hornet.gear).toBe(LAUNCH.gear)
    expect(deckCentreY("hornet")).toBe(DECK_CENTRE_Y)
    expect(catapult("hornet").speed).toBe(LAUNCH_SPEED)
    for (const k of VEHICLE_KINDS) {
      expect(LOADOUTS[k]).toBeDefined()
      expect(VEHICLES[k].probes).toHaveLength(7)
      expect(VEHICLES[k].bombs.length).toBeGreaterThanOrEqual(LOADOUTS[k].bombs)
      expect(VEHICLES[k].rails.length).toBeGreaterThanOrEqual(LOADOUTS[k].missiles)
    }
    expect(VEHICLES.f35.engines).toBe(1)
    expect(VEHICLES.hornet.engines).toBe(2)
    expect(LOADOUTS.f35.weapons.includes("gun")).toBe(false)
  })

  test("the F-35C: a similar top speed, a lower blue zone, slower to turn, roll and accelerate", () => {
    expect(Math.abs(F35.topSpeed - PLANE.topSpeed)).toBeLessThan(8)
    expect(F35.optimalSpeed).toBeLessThan(PLANE.optimalSpeed)
    expect(F35.pitchRate).toBeLessThan(PLANE.pitchRate)
    expect(F35.rollRate).toBeLessThan(PLANE.rollRate)
    expect(F35.rollRate).toBeGreaterThan(PLANE.rollRate * 0.8)
    expect(F35.thrust).toBeLessThan(PLANE.thrust)
    // Cruise settles on its own optimal speed, full military throttle on its top speed.
    const p = flying(F35.optimalSpeed, F35.cruise)
    run(p, HANDS_OFF, 20, F35)
    expect(Math.abs(planeSpeed(p) - F35.optimalSpeed)).toBeLessThan(8)
    run(p, { ...HANDS_OFF, throttle: 1 }, 60, F35)
    expect(Math.abs(planeSpeed(p) - F35.topSpeed)).toBeLessThan(10)
    // A full pull for 2 s at each type's own best speed: the Hornet turns further.
    const turn = (P: PlaneTuning) => {
      const q = flying(P.optimalSpeed, P.cruise)
      run(q, { ...HANDS_OFF, pitch: 1 }, 2, P)
      return Math.atan2(q.vy, -q.vz)
    }
    expect(turn(F35)).toBeLessThan(turn(PLANE) - 0.1)
  })
})

describe("the F-35C on the carrier", () => {
  test("rides the catapult at its own gear height and leaves the bow above flying speed", () => {
    const sea = makeSea(7)
    const ship = makeShip(0, 0, 0.3, 0)
    for (let i = 0; i < 600; i++) shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
    const { launch, plane } = startLaunch(ship, makePlane(ship.t), "f35")
    expect(launch.kind).toBe("f35")
    expect(deckCentreY("f35")).toBeCloseTo(DECK_Y + 1.05 + F35.centre, 6)
    let left = false
    for (let i = 0; i < 600 && !left; i++) {
      shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
      if (launch.phase !== "stroke" || launch.z < LAUNCH.endZ - 5) {
        const l = worldToShip(ship, plane.x, plane.y, plane.z)
        if (launch.phase !== "airborne") expect(Math.abs(l[1] - deckCentreY("f35"))).toBeLessThan(0.05)
      }
      left = launchStep(launch, plane, ship, DT)
    }
    expect(left).toBe(true)
    expect(catapult("f35").speed).toBeLessThan(LAUNCH_SPEED)
    expect(planeSpeed(plane)).toBeGreaterThan(F35.stallSpeed * 1.5)
    const local = worldToShip(ship, plane.x, plane.y, plane.z)
    expect(local[2]).toBeGreaterThan(BOW_Z - 3)
    // Hands off, it climbs away clear of the sea and the ship.
    for (let i = 0; i < 300; i++) {
      shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
      planeStep(plane, HANDS_OFF, DT, { sea, arch: null, ships: [ship] }, F35, VEHICLES.f35.probes)
    }
    expect(plane.crashed).toBe("")
    // Drawn on another client's copy of the hull at its own height.
    const drawn = launchPose(-20, ship, makePlane(), "f35")
    expect(worldToShip(ship, drawn.x, drawn.y, drawn.z)[1]).toBeCloseTo(deckCentreY("f35"), 6)
  })

  test("auto-lands: captured behind the stern, trapped, stopped on the deck on its own gear", () => {
    const sea = makeSea(7)
    const ship = Object.assign(makeShip(0, 0, 0.2, 0), { u: 0 })
    for (let i = 0; i < 600; i++) shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
    const v = landingVehicle("f35")
    expect(v.rest).toBeCloseTo(VEHICLES.f35.gear + F35.centre, 6)
    // 1.2 km behind the stern, 30 m off the centreline, 90 m up, at 120 m/s over the ship.
    const p = makePlane(ship.t)
    const f = [Math.sin(ship.heading), -Math.cos(ship.heading)]
    const left = [-Math.cos(ship.heading), -Math.sin(ship.heading)]
    const z = STERN_Z - 1200
    const x = CENTERLINE_X + 30
    p.x = ship.x + f[0]! * z + left[0]! * x
    p.z = ship.z + f[1]! * z + left[1]! * x
    p.y = DECK_Y + 90
    setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI - ship.heading))
    p.vx = f[0]! * (120 + ship.u)
    p.vz = f[1]! * (120 + ship.u)
    p.throttle = F35.cruise
    expect(captureMiss(p, ship, v)).toBe("")
    const l = startLanding(p, ship, v)
    // Its hook meets the wires where the Hornet's does: the centre touches down ~2 m further aft.
    expect(l.touchZ + VEHICLES.f35.hookZ).toBeCloseTo(LANDING.touchZ + VEHICLES.hornet.hookZ, 6)
    expect(LANDING.touchZ - l.touchZ).toBeGreaterThan(1.5)
    expect(LANDING.touchZ - l.touchZ).toBeLessThan(2.5)
    let done = false
    let touched = Number.NaN
    for (let i = 0; i < 60 / DT && !done; i++) {
      shipStep(ship, { throttle: 0.6, rudder: 0 }, sea, null)
      const before = l.phase
      done = landingStep(l, p, ship, DT)
      if (before === "approach" && l.phase === "trap") touched = l.z
    }
    expect(done).toBe(true)
    expect(Math.abs(touched - l.touchZ)).toBeLessThan(1.5)
    const at = worldToShip(ship, p.x, p.y, p.z)
    expect(Math.abs(at[0] - CENTERLINE_X)).toBeLessThan(0.5)
    expect(at[1]).toBeCloseTo(deckCentreY("f35"), 1)
    expect(at[2]).toBeLessThan(BOW_Z - 30)
    expect(at[2]).toBeGreaterThan(STERN_Z)
  })
})
