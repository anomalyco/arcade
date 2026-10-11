import { describe, expect, test } from "bun:test"
import { DT, ROADBLOCK_THICK, VEHICLE_BY_ID, VEHICLES } from "../shared/config"
import type { Box } from "../shared/sim/city"
import { mulberry32 } from "../shared/sim/rng"
import { DRIVE, type Body, type Input, NO_INPUT, collideBoxes, lateralSpeed, newBody, speedOf, stepAndCollide, stepBody } from "../shared/sim/vehicle"

const muscle = VEHICLE_BY_ID.get("muscle")!
const bike = VEHICLE_BY_ID.get("bike")!
const input = (p: Partial<Input>): Input => ({ ...NO_INPUT, ...p })

/** Signed slip angle: the angle between heading and velocity, in radians. */
function slipAngle(b: Body) {
  const fx = Math.sin(b.h)
  const fz = Math.cos(b.h)
  return Math.atan2(b.vx * fz - b.vz * fx, b.vx * fx + b.vz * fz)
}

function run(b: Body, inp: Input | ((i: number) => Input), seconds: number, spec = muscle, each?: (i: number) => void) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    stepBody(b, typeof inp === "function" ? inp(i) : inp, spec, DT)
    each?.(i)
  }
}

const box = (x0: number, x1: number, z0: number, z1: number): Box => ({ x0, x1, z0, z1, h: 10, color: [0, 0, 0], neon: null, kind: "building", label: null })

describe("straight line", () => {
  test("every car reaches 90% of its top speed within 6 s and tops out near maxSpeed", () => {
    for (const spec of VEHICLES) {
      const b = newBody(0, 0, 0)
      let t90 = -1
      run(b, input({ throttle: 1 }), 12, spec, (i) => {
        if (t90 < 0 && speedOf(b) >= 0.9 * spec.maxSpeed) t90 = (i + 1) * DT
      })
      expect(t90).toBeGreaterThan(1.5)
      expect(t90).toBeLessThan(6)
      expect(speedOf(b)).toBeGreaterThan(0.95 * spec.maxSpeed)
      expect(speedOf(b)).toBeLessThanOrEqual(spec.maxSpeed)
    }
  })

  test("nitro lifts top speed above maxSpeed, drains in a few seconds and refills", () => {
    const b = newBody(0, 0, 0)
    run(b, input({ throttle: 1 }), 8)
    run(b, input({ throttle: 1, boost: true }), DRIVE.boostDrain + 0.5)
    expect(speedOf(b)).toBeGreaterThan(muscle.maxSpeed * 1.08)
    expect(b.boostFuel).toBe(0)
    run(b, input({ throttle: 1 }), 3)
    expect(b.boostFuel).toBeGreaterThan(0.2)
  })

  test("reverse: throttle -1 brakes first, then backs up to a capped reverse speed", () => {
    const b = newBody(0, 0, 0)
    b.vz = 20
    run(b, input({ throttle: -1 }), 0.5)
    expect(b.vz).toBeLessThan(12)
    run(b, input({ throttle: -1 }), 6)
    expect(b.vz).toBeLessThan(-8)
    expect(-b.vz).toBeLessThanOrEqual(DRIVE.reverseMax)
    // Steering in reverse swings the nose the opposite way, like a real car.
    const h0 = b.h
    run(b, input({ throttle: -1, steer: 1 }), 0.5)
    expect(b.h).toBeLessThan(h0)
  })

  test("coasting slows down and stops", () => {
    const b = newBody(0, 0, 0)
    b.vz = 30
    run(b, NO_INPUT, 30)
    expect(speedOf(b)).toBe(0)
  })
})

describe("drifting", () => {
  test("a handbrake turn at speed slides sideways and turns 90 degrees in under a second", () => {
    const b = newBody(0, 0, 0)
    b.vz = 30
    let maxLat = 0
    let t90 = -1
    run(b, (i) => input({ throttle: 0.3, steer: 1, handbrake: i < 12 }), 2, muscle, (i) => {
      maxLat = Math.max(maxLat, lateralSpeed(b))
      if (t90 < 0 && b.h >= Math.PI / 2) t90 = (i + 1) * DT
    })
    expect(maxLat).toBeGreaterThan(12)
    expect(t90).toBeGreaterThan(0.3)
    expect(t90).toBeLessThan(1)
  })

  test("after the handbrake, throttle and light counter-steer hold the slide angle", () => {
    const b = newBody(0, 0, 0)
    b.vz = 30
    run(b, input({ throttle: 1, steer: 1, handbrake: true }), 0.3)
    let held = 0
    run(b, input({ throttle: 1, steer: -0.15 }), 2, muscle, () => {
      if (Math.abs(slipAngle(b)) > 0.25) held += DT
    })
    expect(held).toBeGreaterThan(1.2)
    // ...without bleeding much speed.
    expect(speedOf(b)).toBeGreaterThan(24)
  })

  test("letting go of everything recovers grip quickly", () => {
    const b = newBody(0, 0, 0)
    b.vz = 30
    run(b, input({ throttle: 1, steer: 1, handbrake: true }), 0.4)
    expect(Math.abs(slipAngle(b))).toBeGreaterThan(0.3)
    run(b, NO_INPUT, 1)
    expect(Math.abs(slipAngle(b))).toBeLessThan(0.1)
    expect(b.drift).toBe(0)
  })

  test("over-steering into the slide never spins the car past ~70 degrees", () => {
    const b = newBody(0, 0, 0)
    b.vz = 35
    let worst = 0
    run(b, (i) => input({ throttle: 1, steer: 1, handbrake: i < 15 }), 4, muscle, () => {
      if (speedOf(b) > 8) worst = Math.max(worst, Math.abs(slipAngle(b)))
    })
    expect(worst).toBeLessThan(1.25)
  })
})

describe("modifiers", () => {
  test("a flat tire lowers top speed", () => {
    const b = newBody(0, 0, 0)
    b.flat = 60
    run(b, input({ throttle: 1 }), 12)
    expect(speedOf(b)).toBeLessThan(muscle.maxSpeed * DRIVE.flatSpeed + 0.5)
  })

  test("oil: almost no grip, the car keeps sliding and spinning", () => {
    const b = newBody(0, 0, 0)
    b.vz = 25
    b.slip = 1.2
    b.yaw = 3
    run(b, input({ throttle: 1, steer: -1 }), 0.6)
    expect(Math.abs(b.h)).toBeGreaterThan(1.2)
    expect(lateralSpeed(b)).toBeGreaterThan(8)
    run(b, input({ throttle: 1 }), 2)
    expect(b.slip).toBe(0)
  })
})

describe("collisions", () => {
  test("hitting a wall pushes the car out and reflects the velocity", () => {
    const wall = box(10, 20, -50, 50)
    const b = newBody(7.5, 0, Math.PI / 2)
    b.vx = 25
    stepBody(b, NO_INPUT, muscle, DT)
    const impact = collideBoxes(b, 2, [wall])
    expect(impact).toBeGreaterThan(20)
    expect(b.x).toBeLessThanOrEqual(8)
    expect(b.vx).toBeLessThan(0)
    expect(-b.vx).toBeLessThan(10)
  })

  test("a glancing scrape keeps most of the speed", () => {
    const wall = box(10, 20, -50, 50)
    const b = newBody(8.3, 0, 0.2)
    b.vx = 4
    b.vz = 30
    collideBoxes(b, 2, [wall])
    expect(b.vz).toBeGreaterThan(25)
    expect(b.vx).toBeLessThanOrEqual(0)
  })

  test("a car whose center ends up inside a box is pushed fully outside", () => {
    const b = newBody(10.5, 0, 0)
    collideBoxes(b, 2, [box(10, 20, -50, 50)])
    expect(b.x).toBeLessThanOrEqual(8)
  })

  test("no tunneling through a thin roadblock at max boost speed", () => {
    const thin = box(30 - ROADBLOCK_THICK / 2, 30 + ROADBLOCK_THICK / 2, -20, 20)
    for (const spec of [bike, muscle, VEHICLE_BY_ID.get("interceptor")!]) {
      const radius = Math.max(1.1, spec.length * 0.42)
      const b = newBody(0, 0, Math.PI / 2)
      b.vx = spec.maxSpeed * DRIVE.boostSpeed
      let maxX = -Infinity
      for (let i = 0; i < 60; i++) {
        stepAndCollide(b, input({ throttle: 1, boost: true }), spec, DT, radius, [thin])
        maxX = Math.max(maxX, b.x)
      }
      expect(maxX).toBeLessThan(thin.x0)
    }
  })

  test("no tunneling through a building corner at speed from any angle", () => {
    const building = box(20, 40, 20, 40)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      const b = newBody(30 + Math.sin(a) * 40, 30 + Math.cos(a) * 40, a + Math.PI)
      b.vx = -Math.sin(a) * 60
      b.vz = -Math.cos(a) * 60
      for (let i = 0; i < 45; i++) {
        stepAndCollide(b, input({ throttle: 1, boost: true }), bike, DT, 1.1, [building])
        const inside = b.x > 20 && b.x < 40 && b.z > 20 && b.z < 40
        expect(inside).toBe(false)
      }
    }
  })
})

test("random inputs and wall hits never produce NaN", () => {
  const rng = mulberry32(42)
  const walls = [box(-60, -50, -60, 60), box(50, 60, -60, 60), box(-60, 60, -60, -50), box(-60, 60, 50, 60), box(-5, 5, -5, 5)]
  for (const spec of VEHICLES) {
    const b = newBody(20, 20, 0)
    let inp = NO_INPUT
    for (let i = 0; i < 1500; i++) {
      if (i % 10 === 0)
        inp = {
          throttle: rng() < 0.2 ? -1 : rng(),
          brake: rng() < 0.1 ? 1 : 0,
          steer: rng() * 2 - 1,
          handbrake: rng() < 0.25,
          boost: rng() < 0.3,
        }
      if (i % 200 === 0) b.slip = 1.2
      if (i % 300 === 0) b.stun = 0.5
      stepAndCollide(b, inp, spec, DT, Math.max(1.1, spec.length * 0.42), walls)
      for (const v of [b.x, b.z, b.h, b.vx, b.vz, b.yaw, b.boostFuel, b.drift ?? 0]) expect(Number.isFinite(v)).toBe(true)
    }
    expect(Math.abs(b.x)).toBeLessThan(60)
    expect(Math.abs(b.z)).toBeLessThan(60)
  }
})
