import { expect, test } from "bun:test"
import { VEHICLE_BY_ID } from "../shared/config"
import type { CarView } from "../shared/sim/world"
import { NO_INPUT } from "../shared/sim/vehicle"
import { drivenMask, EmissionState, VehicleEmissions, vehicleEffects } from "../src/game/vehicle-emissions"

const spec = VEHICLE_BY_ID.get("muscle")!
const car = (): CarView => ({ id: 1, ownerId: "test", name: "Driver", role: "robber", vehicle: "muscle", x: 0, z: 0, h: 0, vx: 0, vz: 25, speed: 25, drift: 0, stun: 0, boost: 1, human: true, impact: 0, ghost: false })
test("gripping nitro emits attached flames but no tyre smoke; ordinary braking does not imply lock", () => {
  const e = new VehicleEmissions(), s = new EmissionState(), c = car()
  s.speed = c.speed
  for (let i = 0; i < 120; i++) {
    e.update(1/60); c.z += c.speed/60
    e.car(c, spec, s, { ...NO_INPUT, throttle: 1, boost: true }, 1/60, 0, true, true)
  }
  expect(e.trail.count).toBe(0); expect(e.flameCount).toBe(4)
  e.update(1/60)
  e.car(c,spec,s,{ ...NO_INPUT, brake: 1 },1/60,0,true,true)
  expect(e.trail.count).toBe(0)
})
test("two rear plumes warm over one second, stop on grip, remain in world, and fully dissipate", () => {
  const e = new VehicleEmissions(), s = new EmissionState(), c = car(); c.drift = 8
  let early = 0
  for (let i = 0; i < 60; i++) {
    e.update(1/60); c.z += c.speed/60
    e.car(c,spec,s,{ ...NO_INPUT, throttle: 1 },1/60,0,true,true)
    if (i === 5) early = s.intensity
  }
  expect(s.emittingWheels).toBe(2)
  expect(s.wheels[0]!.heat).toBe(0); expect(s.wheels[2]!.heat).toBeGreaterThan(0.8)
  expect(s.intensity).toBeGreaterThan(early * 3)
  const count = e.trail.count, oldZ = e.trail.particles[2]!
  c.drift = 0; c.z += 30
  e.update(1/60); e.car(c,spec,s,NO_INPUT,1/60,0,true,true)
  expect(s.emittingWheels).toBe(0); expect(e.trail.count).toBe(count)
  expect(Math.abs(e.trail.particles[2]! - oldZ)).toBeLessThan(0.05)
  e.update(3); expect(e.trail.count).toBeGreaterThan(0)
  e.update(3); expect(e.trail.count).toBe(0)
})
test("stationary burnout emits from driven tyres, airborne and popped wheels do not", () => {
  const e = new VehicleEmissions(), s = new EmissionState(), c = car()
  c.speed = c.vz = 0
  const input = { ...NO_INPUT, throttle: 1, brake: 1 }
  for(let i=0;i<90;i++) { e.update(1/60); e.car(c,spec,s,input,1/60,0,true,true) }
  expect(e.trail.count).toBeGreaterThan(30); expect(s.emittingWheels).toBe(2)
  c.airborne = true; e.car(c,spec,s,input,1/60,0,true,true); expect(s.emittingWheels).toBe(0)
  c.airborne = false; c.wheels = 4; e.car(c,spec,s,input,1/60,0,true,true); expect(s.emittingWheels).toBe(1)
  expect(drivenMask({...spec,drivetrain:"fwd"})).toBe(3)
  expect(drivenMask({...spec,drivetrain:"awd"})).toBe(15)
})
test("pops are short, occasional and rate limited; cold wisps can be disabled independently", () => {
  const e = new VehicleEmissions(), s = new EmissionState(), c = car(); s.speed = c.speed
  for(let i=0;i<60;i++) { e.update(1/60); e.car(c,spec,s,{...NO_INPUT,throttle:1},1/60,0,true,true) }
  e.car(c,spec,s,NO_INPUT,1/60,0,true,true)
  expect(e.pops).toBe(1); expect(s.pop).toBe(0.11)
  for(let i=0;i<30;i++) { e.update(1/60); e.car(c,spec,s,{...NO_INPUT,throttle:i%2},1/60,0,true,true) }
  expect(e.pops).toBe(1); expect(s.pop).toBe(0)
  vehicleEffects.coldExhaust = true
  c.speed = c.vz = 0
  for(let i=0;i<60;i++) { e.update(1/60); e.car(c,spec,s,NO_INPUT,1/60,0,true,true) }
  expect(e.wispCount).toBeGreaterThan(0)
  expect(e.trail.count).toBe(0)
  vehicleEffects.coldExhaust = false
  e.update(1); expect(e.wispCount).toBe(0)
})
