import { describe, expect, test } from "bun:test"
import { makeArchipelago, terrainHeight } from "../shared/islands"
import {
  authority,
  makePlane,
  PLANE,
  planeAttitude,
  planeSpeed,
  planeStep,
  quatAxis,
  quatMul,
  setPlaneQuat,
  type Plane,
  type PlaneControls,
} from "../shared/plane"
import { makeSea } from "../shared/sea"

const DT = PLANE.tick
const NONE: PlaneControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false }

/** Level flight heading north (nose toward −z) at speed v and height y. */
function flying(v: number, y = 1500, heading = 0): Plane {
  const p = makePlane(0)
  p.y = y
  setPlaneQuat(p, quatAxis(0, 1, 0, Math.PI - heading))
  p.vx = v * Math.sin(heading)
  p.vz = -v * Math.cos(heading)
  p.throttle = PLANE.cruise
  return p
}

const run = (p: Plane, c: PlaneControls, seconds: number, world = { sea: null, arch: null }) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) planeStep(p, c, DT, world)
}

describe("plane", () => {
  test("hands-off cruise settles on the optimal speed in level flight", () => {
    const p = flying(100)
    run(p, NONE, 40)
    expect(Math.abs(planeSpeed(p) - PLANE.optimalSpeed)).toBeLessThan(8)
    expect(Math.abs(planeAttitude(p).pitch)).toBeLessThan(0.1)
    expect(p.crashed).toBe("")
  })

  test("full throttle tops out near top speed; the afterburner goes beyond and runs out", () => {
    const p = flying(150)
    run(p, { ...NONE, throttle: 1 }, 40)
    expect(Math.abs(planeSpeed(p) - PLANE.topSpeed)).toBeLessThan(10)
    const top = planeSpeed(p)
    run(p, { ...NONE, throttle: 1, boost: true }, PLANE.boostTime + 0.5)
    expect(planeSpeed(p)).toBeGreaterThan(top + 15)
    expect(p.boost).toBe(0)
    expect(p.boosting).toBe(0)
    run(p, { ...NONE, throttle: 1 }, 4)
    expect(p.boost).toBeGreaterThan(0.3)
  })

  test("turn rate peaks in the optimal band", () => {
    const rate = (v: number) => {
      const p = flying(v)
      p.throttle = 1
      run(p, { ...NONE, pitch: 1 }, 0.6)
      return Math.abs(p.p)
    }
    const slow = rate(70)
    const best = rate(PLANE.optimalSpeed)
    const fast = rate(230)
    expect(best).toBeGreaterThan(slow * 1.4)
    expect(best).toBeGreaterThan(fast * 1.4)
    expect(authority(PLANE.optimalSpeed)).toBeCloseTo(1, 5)
    expect(authority(PLANE.topSpeed)).toBeLessThan(1)
  })

  test("pulling bleeds speed; diving gains it and climbing loses it", () => {
    const pull = flying(PLANE.optimalSpeed)
    const level = flying(PLANE.optimalSpeed)
    run(pull, { ...NONE, pitch: 1, roll: 0 }, 3)
    run(level, NONE, 3)
    expect(planeSpeed(pull)).toBeLessThan(planeSpeed(level) - 10)

    const dive = flying(PLANE.optimalSpeed)
    setPlaneQuat(dive, quatAxis(1, 0, 0, Math.PI / 4))
    dive.vy = -PLANE.optimalSpeed * Math.SQRT1_2
    dive.vz = -PLANE.optimalSpeed * Math.SQRT1_2
    run(dive, NONE, 4)
    expect(planeSpeed(dive)).toBeGreaterThan(PLANE.optimalSpeed + 10)

    const climb = flying(PLANE.optimalSpeed)
    run(climb, { ...NONE, pitch: 1 }, 1.4)
    run(climb, NONE, 3)
    expect(planeSpeed(climb)).toBeLessThan(PLANE.optimalSpeed - 20)
  })

  test("stalls at low speed: the nose drops, the jet sinks, the controls go soft", () => {
    const p = flying(35)
    p.throttle = 0
    // Heading north (Ry(π)), nose 20° up.
    setPlaneQuat(p, quatMul(quatAxis(0, 1, 0, Math.PI), quatAxis(1, 0, 0, -0.35)))
    expect(planeAttitude(p).pitch).toBeGreaterThan(0.3)
    run(p, { ...NONE, throttle: -1 }, 0.2)
    expect(p.stall).toBeGreaterThan(0.5)
    run(p, { ...NONE, throttle: -1 }, 2.5)
    expect(planeAttitude(p).pitch).toBeLessThan(0)
    expect(p.vy).toBeLessThan(-5)
    // Soft controls: full back stick makes far less rate than at flying speed.
    const slow = flying(30)
    run(slow, { ...NONE, pitch: 1 }, 0.5)
    const fast = flying(PLANE.optimalSpeed)
    run(fast, { ...NONE, pitch: 1 }, 0.5)
    expect(Math.abs(slow.p)).toBeLessThan(Math.abs(fast.p) * 0.3)
  })

  test("rolls fast, yaws slowly, and a bank with back stick turns the heading", () => {
    const p = flying(PLANE.optimalSpeed)
    run(p, { ...NONE, roll: 1 }, 0.35)
    expect(planeAttitude(p).bank).toBeGreaterThan(0.6)
    const h0 = planeAttitude(p).heading
    run(p, { ...NONE, pitch: 1 }, 2)
    const dh = planeAttitude(p).heading - h0
    expect(dh).toBeGreaterThan(0.6) // right bank + pull turns right (heading increases)
    const y = flying(PLANE.optimalSpeed)
    run(y, { ...NONE, yaw: 1 }, 1)
    const yh = planeAttitude(y).heading
    expect(yh).toBeGreaterThan(0.1)
    expect(yh).toBeLessThan(0.6)
  })

  test("crashes into the sea", () => {
    const sea = makeSea(3)
    const p = flying(PLANE.optimalSpeed, 30)
    run(p, { ...NONE, pitch: -1 }, 5, { sea, arch: null } as never)
    expect(p.crashed).toBe("sea")
    const y = p.y
    run(p, { ...NONE, pitch: 1 }, 1, { sea, arch: null } as never)
    expect(p.y).toBe(y)
  })

  test("crashes into an island", () => {
    const arch = makeArchipelago(7)
    const big = arch.islands[0]!
    // Fly level at 60 m toward the centrepiece's peak from 3 km south.
    const p = flying(PLANE.optimalSpeed, 120, 0)
    p.x = big.x
    p.z = big.z + 3000
    let hit = false
    for (let i = 0; i < 60 * 40 && !hit; i++) {
      planeStep(p, NONE, DT, { sea: null, arch })
      hit = p.crashed !== ""
    }
    expect(p.crashed).toBe("land")
    expect(terrainHeight(arch, p.x, p.z)).toBeGreaterThan(50)
  })

  test("is lost after staying outside the edge", () => {
    const p = flying(PLANE.optimalSpeed, 500)
    p.z = -PLANE.edge - 100
    run(p, NONE, PLANE.edgeTime + 0.1)
    expect(p.crashed).toBe("lost")
  })

  test("deterministic stepping", () => {
    const go = () => {
      const p = flying(120, 800)
      const sea = makeSea(9)
      for (let i = 0; i < 1200; i++) planeStep(p, { pitch: Math.sin(i * 0.01), roll: Math.cos(i * 0.013), yaw: 0.2, throttle: i % 300 < 150 ? 1 : 0, boost: i % 500 < 100 }, DT, { sea, arch: null })
      return { ...p }
    }
    expect(go()).toEqual(go())
  })
})
