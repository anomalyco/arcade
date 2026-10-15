import { describe, expect, test } from "bun:test"
import { lifeRamp, Particles, PARTICLE_STRIDE, type ParticleSpec } from "./fx/particles"
import { effectSpecs, lifeRampDefaults, lifeRampFor } from "./lab/effects"
import { curveText, gradientText } from "./ramps"

const spark: ParticleSpec = effectSpecs.sparks!

function run(spec: ParticleSpec, steps = 30) {
  const pool = new Particles()
  for (let i = 0; i < 8; i++) pool.spawn(spec, i * 0.1, 1, 0, 1, 2, 0.5, i)
  for (let i = 0; i < steps; i++) pool.update(1 / 60)
  pool.prepare()
  return pool
}

describe("particle life ramps", () => {
  test("default over-life settings add no ramp, so particles draw exactly as before", () => {
    expect(lifeRampFor(lifeRampDefaults)).toBe(0)
    // Defaults that went through knobs (stops rewritten as arrays) still read as the identity.
    expect(lifeRampFor({ ...lifeRampDefaults, sizeOverLife: JSON.parse(lifeRampDefaults.sizeOverLife) })).toBe(0)
    const before = run(spark), after = run({ ...spark, ramp: lifeRampFor(lifeRampDefaults) })
    expect(after.instances).toEqual(before.instances)
  })
  test("the ramp slot travels with a particle when the pool compacts", () => {
    const pool = new Particles()
    const id = lifeRamp("test:compact", () => ({ tint: null, size: null, opacity: new Float32Array([0.5, 0.5]) }))
    pool.spawn({ ...spark, life: 0.01 }, 0, 1, 0)
    pool.spawn({ ...spark, ramp: id }, 0, 1, 0)
    pool.update(1 / 30)
    expect(pool.count).toBe(1)
    expect(pool.data[26]).toBe(id)
    expect(PARTICLE_STRIDE).toBeGreaterThan(26)
  })
  test("tint, size and opacity scale what the kind draws at that point of its life", () => {
    const settings = {
      tintOverLife: gradientText([{ at: 0, color: "#000000" }, { at: 1, color: "#000000" }]),
      sizeOverLife: curveText([{ x: 0, y: 2 }, { x: 1, y: 2 }], { range: [0, 3] }),
      opacityOverLife: curveText([{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]),
    }
    const id = lifeRampFor(settings)
    expect(id).toBeGreaterThan(0)
    expect(lifeRampFor(settings)).toBe(id)
    const base = run(spark), ramped = run({ ...spark, ramp: id })
    for (let n = 0; n < base.count; n++) {
      const k = n * 16
      expect(ramped.instances[k + 3]).toBeCloseTo(base.instances[k + 3]! * 2, 4)
      expect(ramped.instances[k + 4]).toBeCloseTo(0, 5)
      expect(ramped.instances[k + 7]).toBeCloseTo(base.instances[k + 7]! * 0.5, 5)
    }
  })
})
