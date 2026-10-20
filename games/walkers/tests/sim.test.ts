import { describe, expect, test } from "bun:test"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { CREATURE_IDS, CREATURES } from "../shared/creatures"
import { DEFAULT_REWARD, Episode, evaluate, policyShape } from "../shared/episode"
import { cos, exp, sin, tanh, wrapAngle } from "../shared/fmath"
import { jointAngle, worldHash } from "../shared/physics"
import { initParams, Policy } from "../shared/policy"
import { TASK_IDS } from "../shared/tasks"

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
        const ep = new Episode(id, "wall", new Policy(shape, params))
        for (let i = 0; i < 240 && !ep.done; i++) ep.step()
        return `${worldHash(ep.world.bodies)} ${ep.fitness}`
      }
      expect(run()).toBe(run())
    }
  })

  test("a creature standing still stays put on flat ground", () => {
    for (const id of ["biped", "worm"] as const) {
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
      const def = CREATURES[id]
      for (const sign of [1, -1]) {
        const ep = new Episode(id, "room", null, { ...DEFAULT_REWARD, seconds: 3, fall: 0 })
        const u = new Float64Array(def.joints.length).fill(sign)
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
      const shape = policyShape("biped", 8)
      const r = evaluate("biped", task, shape, initParams(shape, mulberry32(1)))
      expect(Number.isFinite(r.fitness)).toBe(true)
    }
  })
})
