import { describe, expect, test } from "bun:test"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { CREATURE_IDS } from "../shared/creatures"
import { DEFAULT_REWARD, Episode, evaluate, policyShape } from "../shared/episode"
import { cos, exp, sin, tanh, wrapAngle } from "../shared/fmath"
import { jointAngle, makeBox, makeJoint, makeStatics, World, worldHash } from "../shared/physics"
import { initParams, Policy } from "../shared/policy"
import { envFor, TASK_IDS } from "../shared/tasks"

describe("fmath", () => {
  test("matches Math closely", () => {
    for (let x = -40; x <= 40; x += 0.37) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-12)
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-12)
      expect(Math.abs(wrapAngle(x) - Math.atan2(Math.sin(x), Math.cos(x)))).toBeLessThan(1e-9)
    }
    for (let x = -10; x <= 10; x += 0.13) {
      expect(Math.abs(exp(x) - Math.exp(x)) / Math.exp(x)).toBeLessThan(1e-12)
      expect(Math.abs(tanh(x) - Math.tanh(x))).toBeLessThan(1e-12)
    }
  })
})

describe("sim", () => {
  test("is deterministic: the same policy gives the same bits", () => {
    for (const id of CREATURE_IDS) {
      const shape = policyShape(id, 12)
      const params = initParams(shape, mulberry32(3))
      const run = () => {
        const ep = new Episode(id, id === "biped" ? "course" : "heist", new Policy(shape, params))
        for (let i = 0; i < 240 && !ep.done; i++) ep.step()
        return `${worldHash(ep.world.bodies)} ${ep.fitness}`
      }
      expect(run()).toBe(run())
    }
  })

  test("a creature standing still stays put on flat ground", () => {
    for (const id of CREATURE_IDS) {
      const ep = new Episode(id, "room", null, { ...DEFAULT_REWARD, seconds: 4 })
      const y0 = ep.torso.y
      while (!ep.done) ep.step()
      expect(ep.fell).toBe(false)
      expect(Math.abs(ep.distance)).toBeLessThan(0.01)
      expect(Math.abs(ep.torso.y - y0)).toBeLessThan(0.03)
    }
  })

  test("joint limits hold under full torque", () => {
    for (const id of CREATURE_IDS) {
      for (const sign of [1, -1]) {
        const ep = new Episode(id, "room", null, { ...DEFAULT_REWARD, seconds: 3, fall: 0 })
        const u = new Float64Array(ep.motors.length).fill(sign)
        let worst = 0
        for (let i = 0; i < 180; i++) {
          ep.step(u)
          ep.done = false
          ep.world.joints.forEach((j) => {
            const a = jointAngle(ep.world.bodies, j)
            worst = Math.max(worst, j.lower - a, a - j.upper)
          })
        }
        // Speculative limits allow a little give under the largest torques, never a broken joint.
        expect(worst).toBeLessThan(0.15)
        for (const b of ep.world.bodies) expect(Number.isFinite(b.x + b.y + b.a)).toBe(true)
      }
    }
  })

  test("joints stay attached", () => {
    const shape = policyShape("quadruped", 16)
    const ep = new Episode("quadruped", "rough", new Policy(shape, initParams(shape, mulberry32(9))), { ...DEFAULT_REWARD, fall: 0 })
    let worst = 0
    for (let i = 0; i < 400; i++) {
      ep.step()
      ep.done = false
      for (const j of ep.world.joints) {
        if (j.b < 0) continue
        const A = ep.world.bodies[j.a]!, B = ep.world.bodies[j.b]!
        const ax = A.x + A.c * j.lax - A.s * j.lay, ay = A.y + A.s * j.lax + A.c * j.lay
        const bx = B.x + B.c * j.lbx - B.s * j.lby, by = B.y + B.s * j.lbx + B.c * j.lby
        worst = Math.max(worst, Math.hypot(ax - bx, ay - by))
      }
    }
    expect(worst).toBeLessThan(0.03)
  })

  test("every task builds and runs", () => {
    for (const task of TASK_IDS) {
      const shape = policyShape("quadruped", 8)
      const r = evaluate("quadruped", task, shape, initParams(shape, mulberry32(1)))
      expect(Number.isFinite(r.fitness)).toBe(true)
    }
  })
})

describe("physics v2", () => {
  test("the quadruped stands still for a minute without creeping or jittering", () => {
    const ep = new Episode("quadruped", "room", null, { ...DEFAULT_REWARD, seconds: 60 })
    const y0 = ep.torso.y
    let fastest = 0
    while (!ep.done) {
      ep.step()
      if (ep.time > 2) for (const b of ep.world.bodies) fastest = Math.max(fastest, Math.abs(b.vx), Math.abs(b.vy))
    }
    expect(ep.outcome).toBe("timeout")
    expect(Math.abs(ep.distance)).toBeLessThan(0.005)
    expect(Math.abs(ep.torso.y - y0)).toBeLessThan(0.02)
    expect(fastest).toBeLessThan(0.01)
  })

  test("random flailing for a long run never blows up", () => {
    const shape = policyShape("quadruped", 16)
    for (const seed of [1, 2, 3]) {
      const ep = new Episode("quadruped", envFor("course", { seed }), new Policy(shape, initParams(shape, mulberry32(seed)).map((v) => v * 3)), { ...DEFAULT_REWARD, fall: 0, seconds: 30 })
      let fastest = 0
      while (ep.time < 30) {
        ep.step()
        ep.done = false
        for (const b of ep.world.bodies) fastest = Math.max(fastest, Math.hypot(b.vx, b.vy))
      }
      expect(fastest).toBeLessThan(15)
      for (const b of ep.world.bodies) expect(Number.isFinite(b.x + b.y + b.a)).toBe(true)
    }
  })

  test("a crate rests on the floor and slides when pushed", () => {
    const statics = makeStatics([[-5, 0], [5, 0]])
    const crate = makeBox(0, 0.2, 0, 0.15, 0.15, 3)
    const w = new World([crate], [], statics)
    for (let i = 0; i < 240; i++) w.step(1 / 120)
    expect(Math.abs(crate.y - 0.15 - crate.r)).toBeLessThan(0.006)
    expect(Math.abs(crate.a)).toBeLessThan(1e-6)
    crate.vx = 2
    for (let i = 0; i < 240; i++) w.step(1 / 120)
    expect(crate.x).toBeGreaterThan(0.05)
    expect(Math.abs(crate.vx)).toBeLessThan(1e-3)
  })

  test("crates stack, a seesaw tips, a platform follows its drive", () => {
    const statics = makeStatics([[-5, 0], [5, 0]])
    const a = makeBox(0, 0.16, 0, 0.15, 0.15, 3)
    const b = makeBox(0.02, 0.5, 0, 0.15, 0.15, 3)
    const plank = makeBox(2, 0.3, 0, 0.8, 0.04, 6)
    const weight = makeBox(2.6, 0.5, 0, 0.1, 0.1, 4)
    const platform = makeBox(-3, 0.5, 0, 0.3, 0.05, 0)
    platform.drive = { x0: -3, y0: 0.5, ax: 0.5, ay: 0, period: 2, phase: 0 }
    const bodies = [a, b, plank, weight, platform]
    const joints = [makeJoint(bodies, 2, -1, 2, 0.3, { lower: -0.4, upper: 0.4 })]
    const w = new World(bodies, joints, statics)
    for (let i = 0; i < 360; i++) w.step(1 / 120)
    expect(b.y).toBeGreaterThan(0.43)
    expect(b.y).toBeLessThan(0.5)
    expect(plank.a).toBeLessThan(-0.3)
    expect(Math.abs(platform.x - (-3 + 0.5 * sin((2 * Math.PI * w.time) / 2)))).toBeLessThan(1e-9)
  })

  test("raycasts hit the floor, blocks and boxes", () => {
    const statics = makeStatics([[-5, 0], [5, 0]], [[[1, 1], [2, 1], [2, 2], [1, 2]]])
    const w = new World([makeBox(-2, 0.5, 0, 0.2, 0.2, 0)], [], statics)
    expect(w.raycast(0, 1, 0, -1, 5)).toBeCloseTo(1, 12)
    expect(w.raycast(0, 1.5, 1, 0, 5)).toBeCloseTo(1, 12)
    expect(w.raycast(0, 0.5, -1, 0, 5)).toBeCloseTo(1.8, 12)
    expect(w.raycast(0, 2.5, 1, 0, 5)).toBe(5)
  })
})
