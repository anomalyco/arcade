import { describe, expect, test } from "bun:test"
import { Particles, PARTICLE_STRIDE, type ParticleSpec } from "./fx/particles"

const smoke: ParticleSpec = { kind: "smoke", life: 4, size: 0.3, growth: 0.3, gravity: 0, drag: 0.9, bounce: 0, r: 0.5, g: 0.5, b: 0.5, alpha: 0.4, temperature: 0, turbulence: 0 }

describe("smoke particles", () => {
  test("settle onto the wind", () => {
    const pool = new Particles()
    pool.windX = 1.2
    pool.windZ = -0.4
    pool.spawn(smoke, 0, 2, 0)
    for (let i = 0; i < 240; i++) pool.update(1 / 60)
    const vx = pool.data[4]!
    const vz = pool.data[6]!
    expect(vx).toBeGreaterThan(1.0)
    expect(vx).toBeLessThan(1.2)
    expect(vz).toBeLessThan(-0.3)
    expect(pool.data[0]!).toBeGreaterThan(2)
  })

  test("fade in and out smoothly, with no pop at birth or death", () => {
    const pool = new Particles()
    pool.windX = pool.windZ = 0
    pool.spawn(smoke, 0, 2, 0)
    const alpha: number[] = []
    for (let i = 0; i < 239; i++) {
      pool.update(1 / 60)
      pool.prepare()
      alpha.push(pool.instances[7]!)
    }
    expect(alpha[0]!).toBeLessThan(0.02)
    expect(alpha.at(-1)!).toBeLessThan(0.01)
    expect(Math.max(...alpha)).toBeCloseTo(0.4, 2)
    for (let i = 1; i < alpha.length; i++) expect(Math.abs(alpha[i]! - alpha[i - 1]!)).toBeLessThan(0.02)
    // The renderer reads kind 8 and a slowly drifting noise seed.
    expect(pool.instances[11]).toBe(8)
    expect(pool.data.length % PARTICLE_STRIDE).toBe(0)
  })
})
