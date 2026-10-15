import { expect, test } from "bun:test"
import { EmissionState, TYRE_SURFACE, VehicleEmissions, type WheelContact } from "./vehicle/emissions"
import { kinematicContacts, SLIP_DEFAULTS } from "./vehicle/slip"
import type { Controls, VehicleSpec, VehicleView } from "./vehicle/types"
import { SKID_STRIDE, SkidMarks } from "./fx/skids"

test("the ring buffer reports exactly the slots written since the last upload, across the wrap", () => {
  const m = new SkidMarks(8)
  const lay = (n: number) => { for (let i = 0; i < n; i++) m.segment(i, 0, 0, i + 0.5, 0, 0, 1) }
  lay(3)
  expect(m.takeDirty()).toBe(1); expect(m.dirty[0]).toEqual([0, 3])
  expect(m.takeDirty()).toBe(0)
  lay(7)
  expect(m.takeDirty()).toBe(2); expect(m.dirty[0]).toEqual([3, 8]); expect(m.dirty[1]).toEqual([0, 2])
  lay(20)
  expect(m.takeDirty()).toBe(1); expect(m.dirty[0]).toEqual([0, 8])
  expect(m.count).toBe(8)
})

test("marks hold full strength, fade over their last seconds and expire; surfaces tint and size them", () => {
  const m = new SkidMarks(16, { life: 10, fade: 4, strength: 1 })
  m.segment(0, 0, 0, 1, 0, 0, 1, 0)
  m.segment(0, 0, 2, 1, 0, 2, 1, 1)
  m.segment(0, 0, 4, 1, 0, 4, 1, 2)
  const at = (slot: number, k: number) => m.data[slot * SKID_STRIDE + k]!
  expect(at(1, 3)).toBeGreaterThan(at(0, 3)) // dirt ruts are wider
  expect(at(1, 8)).toBeGreaterThan(at(1, 10)) // and brown
  expect(at(2, 12)).toBeLessThan(at(0, 12)) // wet marks dry off quickly
  m.update(5)
  expect(m.opacity(0)).toBeCloseTo(1, 5)
  m.update(3)
  expect(m.opacity(0)).toBeCloseTo(0.5, 5)
  m.update(2.5)
  expect(m.opacity(0)).toBe(0)
  expect(m.alive()).toBe(0)
})

test("degenerate, teleporting and zero-strength segments are rejected", () => {
  const m = new SkidMarks(4)
  m.segment(0, 0, 0, 0.001, 0, 0, 1)
  m.segment(0, 0, 0, 50, 0, 0, 1)
  m.segment(0, 0, 0, 1, 0, 0, 0)
  expect(m.written).toBe(0)
})

const spec: VehicleSpec = { id: "sedan", width: 1.8, length: 4.4, mass: 1.3, accel: 8, grip: 9, boost: 0, drivetrain: "rwd" }
const view = (o: Partial<VehicleView> = {}): VehicleView => ({ id: 1, vehicle: "sedan", x: 0, z: 0, h: 0, vx: 0, vz: 0, speed: 0, drift: 0, impact: 0, stun: 0, boost: 0, ...o })
const controls = (o: Partial<Controls> = {}): Controls => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...o })
const flat = () => 0.2, road = () => TYRE_SURFACE.road

test("kinematic slip: rolling straight is clean; handbrake locks the rears; a hard stop locks all four", () => {
  const out: WheelContact[] = []
  kinematicContacts(out, view({ vz: 14, speed: 14 }), spec, 0, 0, controls({ throttle: 1 }), flat, road)
  expect(out.map(w => w.slip)).toEqual([0, 0, 0, 0])
  expect(out[0]!.y).toBe(0.2)
  kinematicContacts(out, view({ vz: 14, speed: 14 }), spec, 0, 0, controls({ handbrake: true }), flat, road)
  expect(out[0]!.slip).toBe(0); expect(out[2]!.slip).toBeCloseTo(SLIP_DEFAULTS.handbrake, 5)
  kinematicContacts(out, view({ vz: 16, speed: 16 }), spec, 0, 0, controls({ brake: 1 }), flat, road)
  for (const w of out) expect(w.slip).toBeGreaterThan(0.3)
  kinematicContacts(out, view({ vz: 5, speed: 5 }), spec, 0, 0, controls({ brake: 1 }), flat, road)
  for (const w of out) expect(w.slip).toBe(0)
})

test("kinematic slip: in a drift the tail slides wider than the nose, and a burnout spins only driven wheels", () => {
  const out: WheelContact[] = []
  // Heading +Z, rotating toward +X while the body still travels +Z with a sideways component: oversteer.
  kinematicContacts(out, view({ vx: -3, vz: 12, speed: 12.4 }), spec, 1.2, 0.2, controls({ throttle: 1 }), flat, road)
  expect(out[2]!.slip).toBeGreaterThan(out[0]!.slip)
  expect(out[2]!.slip).toBeGreaterThan(0.3)
  kinematicContacts(out, view({ speed: 0 }), spec, 0, 0, controls({ throttle: 1, handbrake: true }), flat, road)
  expect(out.map(w => w.slip)).toEqual([0, 0, 1, 1])
})

test("per-wheel contacts: road lays rubber smoke and black marks, dirt throws dust, wet marks without smoke", () => {
  const run = (surface: number) => {
    const fx = new VehicleEmissions(), marks = new SkidMarks(64), s = new EmissionState()
    fx.skids = marks
    const wheels: WheelContact[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0.1, z: 0, slip: 0.9, slipSpeed: 14, surface }))
    for (let i = 0; i < 30; i++) {
      for (const w of wheels) w.z = i * 0.2
      fx.contacts(view({ vz: 12, speed: 12 }), s, wheels, 1 / 60)
      fx.update(1 / 60)
    }
    fx.trail.prepare()
    return { fx, marks }
  }
  const asphalt = run(TYRE_SURFACE.road), dirt = run(TYRE_SURFACE.dirt), wet = run(TYRE_SURFACE.wet), none = run(TYRE_SURFACE.none)
  expect(asphalt.marks.written).toBeGreaterThan(80)
  expect(asphalt.fx.trail.count).toBeGreaterThan(0)
  expect(asphalt.fx.trail.instances[5]).toBe(0)
  expect(asphalt.fx.trail.particles[1]).toBeGreaterThan(0.39) // smoke starts above the tyre's own ground
  expect(dirt.fx.trail.instances[5]).toBe(1)
  expect(dirt.marks.data[8]).toBeGreaterThan(asphalt.marks.data[8]!)
  expect(wet.fx.trail.count).toBe(0)
  expect(wet.marks.written).toBeGreaterThan(0)
  expect(none.marks.written + none.fx.trail.count).toBe(0)
  // Consecutive strips share endpoints, so marks are continuous.
  const d = asphalt.marks.data
  expect(d[4 * SKID_STRIDE + 2]).toBeCloseTo(d[6]!, 5)
})
