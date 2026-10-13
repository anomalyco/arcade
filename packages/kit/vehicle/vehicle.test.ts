import { expect, test } from "bun:test"
import { Chassis, chassisSettings, springStep } from "./chassis"
import { VehicleEmissions, EmissionState } from "./emissions"
import { Fx } from "./fx"
import type { Controls, VehicleSpec, VehicleView } from "./types"

const spec: VehicleSpec = { id: "test", width: 2, length: 4, mass: 1.2, accel: 20, grip: 9, boost: 1 }
const car = (): VehicleView => ({ id: 1, vehicle: "test", x: 0, z: 0, h: 0, vx: 0, vz: 20, speed: 20, drift: 0, stun: 0, boost: 1, impact: 0 })
const input: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }
const wheels = [{ x: -0.8, y: 0.3, z: 1.4 }, { x: 0.8, y: 0.3, z: 1.4 }, { x: -0.8, y: 0.3, z: -1.4 }, { x: 0.8, y: 0.3, z: -1.4 }]

test("spring impulse rebounds, settles, and is invariant to time partition", () => {
  const a = { x: 0.4, v: -3 }, b = { ...a }
  springStep(a, 0, 0.7)
  for (let i = 0; i < 70; i++) springStep(b, 0, 0.01)
  expect(a.x).toBeCloseTo(b.x, 10); expect(a.v).toBeCloseTo(b.v, 10)
  springStep(a, 0, 60)
  expect(Math.abs(a.x)).toBeLessThan(1e-10)
})

test("four contacts tilt on a kerb, retract in flight, and reset on teleport", () => {
  const c = car(), ch = new Chassis(c, wheels, (ground: (x: number, z: number) => number, x, z) => ground(x, z))
  const ground = (x: number) => x > 0 ? 0.16 : 0
  for (let i = 0; i < 120; i++) ch.update(c, spec, ground, 1/60, chassisSettings(), null)
  expect(ch.contacts.filter(p => p.y > 0.4).length).toBe(2)
  expect(ch.roll.x).toBeCloseTo(Math.atan2(0.16, 1.6), 5)
  expect(ch.lift.x).toBeCloseTo(0.08, 5)
  ch.update({ ...c, airborne: true, y: 3 }, spec, ground, 1/60, chassisSettings(), null)
  for (const p of ch.contacts) expect(p.y).toBe(3.3)
  ch.update({ ...c, x: 100 }, spec, () => 0, 1/60, chassisSettings(), null)
  expect(ch.roll.x).toBe(0); expect(ch.lift.x).toBe(0)
})

test("slip heats driven tyres into smoke and skids; braking alone makes neither", () => {
  const e = new VehicleEmissions(), state = new EmissionState(), c = car(), skids = new Fx()
  e.skids = skids
  for (let i = 0; i < 60; i++) {
    c.z += 1/3; e.update(1/60)
    e.car(c, spec, state, { ...input, brake: 1 }, 1/60, 0, true, true)
  }
  expect(e.trail.count).toBe(0); expect(skids.skidCount).toBe(0)
  c.drift = 8
  for (let i = 0; i < 60; i++) {
    c.z += 1/3; e.update(1/60); e.car(c, spec, state, input, 1/60, 0, true, true)
  }
  expect(state.wheels[2]!.heat).toBeGreaterThan(0.8)
  expect(state.wheels[0]!.heat).toBe(0)
  expect(e.trail.count).toBeGreaterThan(50); expect(skids.skidCount).toBeGreaterThan(50)
  c.airborne = true
  e.car(c, spec, state, input, 1/60, 0, true, true)
  expect(state.emittingWheels).toBe(0)
  e.update(6); expect(e.trail.count).toBe(0)
})

test("grass, popped tyres and resets cannot bridge a skid trail", () => {
  const e = new VehicleEmissions<null>((_, x) => x < 10 ? 1 : 0), s = new EmissionState(), c = car(), fx = new Fx()
  e.skids = fx; c.drift = 8; c.wheels = 12
  for (let i = 0; i < 60; i++) { e.update(1/60); e.car(c, spec, s, input, 1/60, 0, true, true) }
  expect(e.trail.count).toBe(0)
  c.wheels = 0; c.x = 20
  e.car(c, spec, s, input, 1/60, 0, true, true)
  expect(e.trail.count).toBe(0)
  c.x = 0
  e.car(c, spec, s, input, 1/60, 0, true, true)
  expect(fx.skidCount).toBe(0)
})
