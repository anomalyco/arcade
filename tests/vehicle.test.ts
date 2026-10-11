import { describe, expect, test } from "bun:test"
import { DT, ROADBLOCK_THICK, VEHICLE_BY_ID, VEHICLES } from "../shared/config"
import type { Box } from "../shared/sim/city"
import { mulberry32 } from "../shared/sim/rng"
import { boxShape, carHalf, carShape, shapeGap } from "../shared/sim/collide"
import { DRIVE, type Body, type Input, NO_INPUT, collideBoxes, collideCars, lateralSpeed, newBody, speedOf, stepAndCollide, stepBody } from "../shared/sim/vehicle"

const muscle = VEHICLE_BY_ID.get("muscle")!
const bike = VEHICLE_BY_ID.get("bike")!
const input = (p: Partial<Input>): Input => ({ ...NO_INPUT, ...p })

/** Signed slip angle: the angle between heading and velocity, in radians. */
function slipAngle(b: Body) {
  const fx = Math.sin(b.h)
  const fz = Math.cos(b.h)
  return Math.atan2(b.vx * fz - b.vz * fx, b.vx * fx + b.vz * fz)
}

function run(b: Body, inp: Input | ((i: number) => Input), seconds: number, spec = muscle, each?: (i: number) => void, boxes?: Box[]) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    if (boxes) stepAndCollide(b, typeof inp === "function" ? inp(i) : inp, spec, DT, boxes)
    else stepBody(b, typeof inp === "function" ? inp(i) : inp, spec, DT)
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
  const [hl, hw] = carHalf(muscle)
  const wall = () => box(10, 20, -50, 50)
  const sd = (xs: number[]) => {
    const m = xs.reduce((a, x) => a + x, 0) / xs.length
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length)
  }

  test("a head-on wall hit stops the car at its bumper with a small bounce, without spinning it", () => {
    const b = newBody(0, 0, Math.PI / 2)
    b.vx = 30
    let maxX = -Infinity
    let impact = 0
    for (let i = 0; i < 30; i++) {
      impact = Math.max(impact, stepAndCollide(b, NO_INPUT, muscle, DT, [wall()]))
      maxX = Math.max(maxX, b.x)
    }
    expect(impact).toBeGreaterThan(25)
    // The nose touches the wall (the box is the car's length, slightly inset), no farther.
    expect(maxX).toBeLessThan(10 - hl + 0.01)
    expect(maxX).toBeGreaterThan(10 - hl - 0.05)
    expect(b.vx).toBeLessThan(0)
    expect(-b.vx).toBeLessThan(10)
    expect(Math.abs(b.h - Math.PI / 2)).toBeLessThan(0.02)
  })

  test("a glancing wall hit keeps most of the speed and slides along the wall", () => {
    const b = newBody(10 - hw - 0.3, 0, 0.15)
    b.vx = 30 * Math.sin(0.15)
    b.vz = 30 * Math.cos(0.15)
    let impact = 0
    for (let i = 0; i < 30; i++) impact = Math.max(impact, stepAndCollide(b, NO_INPUT, muscle, DT, [wall()]))
    expect(impact).toBeGreaterThan(1)
    expect(speedOf(b)).toBeGreaterThan(24)
    expect(b.vz).toBeGreaterThan(24)
    // Turned to run along the wall rather than bouncing off it.
    expect(Math.abs(b.h)).toBeLessThan(0.1)
    expect(b.x).toBeLessThan(10)
  })

  test("a car whose center ends up inside a box is pushed fully outside", () => {
    const b = newBody(10.5, 0, 0)
    collideBoxes(b, muscle, [wall()])
    expect(b.x).toBeLessThanOrEqual(10 - hw + 0.01)
  })

  test("a car held against a wall on full throttle rests there without vibrating", () => {
    for (const h of [Math.PI / 2, Math.PI / 2 - 0.3, 0.02]) {
      const b = newBody(h > 1 ? 5 : 10 - hw - 0.2, 0, h)
      const xs: number[] = []
      const hs: number[] = []
      run(
        b,
        input({ throttle: 1, steer: h === 0.02 ? 0.4 : 0 }),
        3,
        muscle,
        (i) => {
          if (i >= 30) {
            xs.push(b.x)
            hs.push(b.h)
          }
        },
        [wall()],
      )
      expect(Math.max(...xs)).toBeLessThan(10)
      // Pivoting flush or sliding along the wall is smooth motion; jitter into and out of it is not.
      const jerk = (v: number[]) => sd(v.slice(2).map((x, i) => x - 2 * v[i + 1]! + v[i]!))
      expect(jerk(xs)).toBeLessThan(0.002)
      expect(jerk(hs)).toBeLessThan(0.002)
      if (h === Math.PI / 2) {
        expect(sd(xs)).toBeLessThan(1e-4)
        expect(sd(hs)).toBeLessThan(1e-4)
      }
    }
  })

  test("no tunneling through a thin roadblock at max boost speed", () => {
    const thin = box(30 - ROADBLOCK_THICK / 2, 30 + ROADBLOCK_THICK / 2, -20, 20)
    for (const spec of [bike, muscle, VEHICLE_BY_ID.get("interceptor")!]) {
      const b = newBody(0, 0, Math.PI / 2)
      b.vx = spec.maxSpeed * DRIVE.boostSpeed
      let maxX = -Infinity
      for (let i = 0; i < 60; i++) {
        stepAndCollide(b, input({ throttle: 1, boost: true }), spec, DT, [thin])
        maxX = Math.max(maxX, b.x)
      }
      expect(maxX).toBeLessThan(thin.x0)
      expect(shapeGap(boxShape(thin), carShape(b, spec))).toBeGreaterThan(-0.05)
    }
  })

  test("no tunneling through a building corner at speed from any angle, spinning or not", () => {
    const building = box(20, 40, 20, 40)
    for (const spin of [0, 8])
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const b = newBody(30 + Math.sin(a) * 40, 30 + Math.cos(a) * 40, a + Math.PI)
        b.vx = -Math.sin(a) * 60
        b.vz = -Math.cos(a) * 60
        b.yaw = spin
        b.slip = spin ? 2 : 0
        for (let i = 0; i < 45; i++) {
          stepAndCollide(b, input({ throttle: 1, boost: true }), bike, DT, [building])
          expect(shapeGap(boxShape(building), carShape(b, bike))).toBeGreaterThan(-0.1)
        }
      }
  })
})

describe("car to car", () => {
  const cruiser = VEHICLE_BY_ID.get("cruiser")!
  const tick = (a: Body, b: Body, ia = NO_INPUT, ib = NO_INPUT) => {
    stepAndCollide(a, ia, muscle, DT, [])
    stepAndCollide(b, ib, cruiser, DT, [])
    return collideCars(a, muscle, b, cruiser, DT)
  }

  test("overlapping side by side, cars are pushed apart to touch at about their widths, not a circle's", () => {
    const a = newBody(0, 0, 0)
    const b = newBody(1.2, 0.5, 0)
    expect(collideCars(a, muscle, b, cruiser, DT)).not.toBeNull()
    const gap = b.x - a.x
    expect(gap).toBeGreaterThan((muscle.width + cruiser.width) * 0.48 - 0.05)
    expect(gap).toBeLessThan((muscle.width + cruiser.width) / 2 + 0.05)
    expect(shapeGap(carShape(a, muscle), carShape(b, cruiser))).toBeGreaterThan(-0.02)
  })

  test("a car leaning into another alongside stays pressed against it without bouncing off", () => {
    const a = newBody(0, 0, 0)
    const b = newBody(2.3, 0, -0.08)
    a.vz = b.vz = 20
    const gaps: number[] = []
    for (let i = 0; i < 60; i++) {
      tick(a, b, input({ throttle: 0.6 }), input({ throttle: 0.6, steer: -0.3 }))
      if (i > 20) gaps.push(shapeGap(carShape(a, muscle), carShape(b, cruiser)))
    }
    expect(Math.max(...gaps)).toBeLessThan(0.6)
    expect(Math.min(...gaps)).toBeGreaterThan(-0.15)
  })

  test("a T-bone shoves the struck car sideways; hitting the rear quarter spins it", () => {
    for (const off of [0, -1.6]) {
      const a = newBody(0, off, 0)
      const b = newBody(10, 0, -Math.PI / 2)
      b.vx = -15
      let hit = 0
      for (let i = 0; i < 45; i++) hit = Math.max(hit, tick(a, b)?.impact ?? 0)
      expect(hit).toBeGreaterThan(12)
      expect(a.x).toBeLessThan(-2)
      if (off === 0) expect(Math.abs(a.h)).toBeLessThan(0.05)
      else expect(Math.abs(a.h)).toBeGreaterThan(0.5)
      // Never sunk into each other.
      expect(shapeGap(carShape(a, muscle), carShape(b, cruiser))).toBeGreaterThan(-0.05)
    }
  })

  test("a fast head-on doesn't sink in: the cars meet bumper to bumper", () => {
    const a = newBody(0, 0, 0)
    const b = newBody(0, 30, Math.PI)
    a.vz = 40
    b.vz = -40
    let worst = Infinity
    for (let i = 0; i < 30; i++) {
      tick(a, b)
      worst = Math.min(worst, shapeGap(carShape(a, muscle), carShape(b, cruiser)))
    }
    expect(worst).toBeGreaterThan(-0.05)
    expect(a.vz).toBeLessThan(5)
    expect(b.vz).toBeGreaterThan(-5)
  })

  test("contacts are deterministic", () => {
    const go = () => {
      const a = newBody(0, 0, 0.3)
      const b = newBody(6, 8, -2)
      const out: number[] = []
      for (let i = 0; i < 90; i++) {
        tick(a, b, input({ throttle: 1, steer: 0.3 }), input({ throttle: 1, steer: -0.5, boost: i > 20 }))
        out.push(a.x, a.z, a.h, a.yaw, b.x, b.z, b.h, b.yaw)
      }
      return out
    }
    expect(go()).toEqual(go())
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
      stepAndCollide(b, inp, spec, DT, walls)
      for (const v of [b.x, b.z, b.h, b.vx, b.vz, b.yaw, b.boostFuel, b.drift ?? 0]) expect(Number.isFinite(v)).toBe(true)
    }
    expect(Math.abs(b.x)).toBeLessThan(60)
    expect(Math.abs(b.z)).toBeLessThan(60)
  }
})
