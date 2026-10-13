import { describe, expect, test } from "bun:test"
import { Chassis, chassisSettings, contactHeight, springStep, wheelRotation } from "../src/game/chassis"
import { VEHICLE_BY_ID, CELL, ROAD_HALF } from "../shared/config"
import { generateCity, rampSurface } from "../shared/sim/city"
import { World } from "../shared/sim/world"
import { human } from "./sim-helpers"
import { buildCar, wheelParts } from "../src/render/car-mesh"
import { splitChassis } from "../src/render/chassis-mesh"
import { KERB_H } from "../src/render/city/streets"
import { NO_INPUT } from "../shared/sim/vehicle"

const city = generateCity(7)
const spec = VEHICLE_BY_ID.get("muscle")!
const car = () => new World(7, [human("r")]).view().cars[0]!
const axles = splitChassis(buildCar(spec)).wheels

describe("presentation chassis", () => {
  test("a spinning banked wheel keeps its axle fixed", () => {
    const out = { yaw: 0, roll: 0, pitch: 0 }, axes = []
    for (let spin = 0; spin < 7; spin += 0.1) {
      wheelRotation(out, 0.7, -0.3, 0.15, 0.4, spin)
      const x = Math.cos(out.roll), y = Math.sin(out.roll) * Math.cos(out.pitch), z = Math.sin(out.roll) * Math.sin(out.pitch)
      axes.push([x * Math.cos(out.yaw) + z * Math.sin(out.yaw), y, -x * Math.sin(out.yaw) + z * Math.cos(out.yaw)])
    }
    for (const axis of axes) axis.forEach((v, i) => expect(v).toBeCloseTo(axes[0][i], 8))
  })
  test("spring settles with modest overshoot and is invariant to dt partition", () => {
    const s = { x: 0, v: 0 }
    let peak = 0
    for (let i = 0; i < 240; i++) { springStep(s, 1, 1 / 60); peak = Math.max(peak, s.x) }
    expect(peak).toBeGreaterThan(1.1)
    expect(peak).toBeLessThan(1.2)
    expect(s.x).toBeCloseTo(1, 8)
    expect(s.v).toBeCloseTo(0, 8)
    const a = { x: 0.4, v: -3 }, b = { ...a }
    springStep(a, 0, 0.7)
    for (let i = 0; i < 70; i++) springStep(b, 0, 0.01)
    expect(a.x).toBeCloseTo(b.x, 10)
    expect(a.v).toBeCloseTo(b.v, 10)
  })
  test("large dt is stable; velocity impulse compresses, rebounds, and settles", () => {
    const s = { x: 0, v: -2.8 }
    springStep(s, 0, 0.07)
    expect(s.x).toBeLessThan(-0.1)
    springStep(s, 0, 0.3)
    expect(s.x).toBeGreaterThan(0)
    springStep(s, 0, 60)
    expect(Number.isFinite(s.x)).toBe(true)
    expect(Math.abs(s.x)).toBeLessThan(1e-10)
  })
  test("road, rounded sidewalk, alley, and both ramp slopes match their profiles", () => {
    expect(contactHeight(city, CELL, CELL + 20)).toBe(0)
    expect(contactHeight(city, ROAD_HALF + 0.5, 25)).toBe(KERB_H)
    expect(contactHeight(city, ROAD_HALF + 0.1, ROAD_HALF + 0.1)).toBe(0)
    for (const alley of city.alleys) {
      const x = (alley.x0 + alley.x1) / 2, z = (alley.z0 + alley.z1) / 2
      const ramp = Math.max(0, ...city.ramps.map(r => rampSurface(r, x, z)?.y ?? 0))
      expect(contactHeight(city, x, z)).toBe(ramp)
    }
    for (const r of city.ramps) for (const t of [0.25, r.peak, 0.9]) {
      const x = r.x + Math.sin(r.h) * (t - 0.5) * r.length, z = r.z + Math.cos(r.h) * (t - 0.5) * r.length
      expect(contactHeight(city, x, z)).toBeCloseTo(rampSurface(r, x, z)!.y, 8)
    }
  })
  test("four wheels tilt a stationary car on a kerb; in flight they follow altitude", () => {
    const c = { ...car(), x: ROAD_HALF, z: 25, h: 0, y: 0, vx: 0, vz: 0, speed: 0 }
    const ch = new Chassis(c, axles)
    for (let i = 0; i < 120; i++) ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
    expect(ch.contacts.filter(p => p.y > axles[0].y + 0.05).length).toBe(2)
    expect(ch.roll.x).toBeGreaterThan(0.04)
    expect(ch.lift.x).toBeCloseTo(KERB_H / 2, 5)
    c.y = 3
    ch.update({ ...c, airborne: true }, spec, city, 1 / 60, chassisSettings(), null)
    for (const p of ch.contacts) expect(p.y).toBeCloseTo(3 + axles[0].y)
  })
  test("ramp contacts pitch the body without adding centre-ramp height twice", () => {
    const r = city.ramps.find(r => r.kind === "plate" && r.h !== 0)!
    const c = { ...car(), x: r.x - Math.sin(r.h) * r.length * 0.2, z: r.z - Math.cos(r.h) * r.length * 0.2, h: r.h, vx: 0, vz: 0, speed: 0 }
    const surface = rampSurface(r, c.x, c.z)!
    c.y = surface.y
    const ch = new Chassis(c, axles)
    for (let i = 0; i < 120; i++) ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
    expect(ch.pitch.x).toBeCloseTo(-Math.atan(surface.slope), 5)
    expect(ch.roll.x).toBeCloseTo(0, 5)
    // The muscle car's axles are slightly asymmetric (1.48 / -1.45 m).
    expect(Math.abs(ch.lift.x)).toBeLessThan(0.005)
  })
  test("mesh split preserves every original vertex and rotates about real wheel hubs", () => {
    for (const id of ["muscle", "compact", "van", "swat", "bike"]) {
      const mesh = buildCar(VEHICLE_BY_ID.get(id)!), parts = splitChassis(mesh)
      expect(parts.body.v.length + parts.wheels.reduce((n, p) => n + p.mesh.v.length - 3 * 6 * 12, 0)).toBe(mesh.v.length)
      expect(parts.wheels.length).toBe(id === "bike" ? 2 : 4)
      parts.wheels.forEach((p, i) => {
        const original = wheelParts.get(mesh)![i]
        expect(p.mesh.v[0] + p.x).toBeCloseTo(mesh.v[original.start], 9)
        expect(p.mesh.v[1] + p.y).toBeCloseTo(mesh.v[original.start + 1], 9)
      })
    }
  })
  test("braking locks, burnout spins faster, local countersteer beats inferred yaw", () => {
    const c = { ...car(), x: CELL, z: 25, vx: 0, vz: 8, speed: 8, h: 0 }
    const ch = new Chassis(c, axles)
    ch.update(c, spec, city, 1 / 60, chassisSettings(), { ...NO_INPUT, throttle: 1, steer: -1 })
    expect(ch.contacts.find((_, i) => axles[i].z < 0)!.spin).toBeGreaterThan(ch.contacts.find((_, i) => axles[i].z > 0)!.spin)
    expect(ch.steer).toBeLessThan(0)
    const spins = ch.contacts.map(p => p.spin)
    ch.update(c, spec, city, 1 / 60, chassisSettings(), { ...NO_INPUT, brake: 1 })
    expect(ch.contacts.map(p => p.spin)).toEqual(spins)
  })
  test("landing counter gives one impulse, not one impulse per duplicated snapshot", () => {
    const c = { ...car(), x: CELL, z: 25, vx: 0, vz: 0, h: 0, landings: 0 }
    const ch = new Chassis(c, axles)
    c.landings = 1; c.landing = 10
    ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
    expect(ch.lift.v).toBeLessThan(-1)
    for (let i = 0; i < 120; i++) ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
    expect(ch.lift.x).toBeCloseTo(0, 5)
  })
  test("an impact kicks spring velocity once on its rising edge", () => {
    const c = { ...car(), x: CELL, z: 25, vx: 0, vz: 20, speed: 20, h: 0, impact: 0 }
    const ch = new Chassis(c, axles)
    c.impact = 10
    ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
    expect(ch.pitch.v).toBeLessThan(-0.5)
    for (let i = 0; i < 120; i++) ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
    expect(ch.pitch.v).toBeCloseTo(0, 5)
  })
  test("heavy vehicles sway more; bikes lean into the same turn", () => {
    const roll = (id: string, feel: boolean) => {
      const spec = VEHICLE_BY_ID.get(id)!
      const c = { ...car(), x: CELL, z: 25, vx: 0, vz: 20, h: 0, vehicle: id }
      const ch = new Chassis(c, splitChassis(buildCar(spec)).wheels)
      for (let i = 0; i < 45; i++) {
        c.h += 0.012; c.vx = Math.sin(c.h) * 20; c.vz = Math.cos(c.h) * 20
        ch.update(c, spec, city, 1 / 60, { ...chassisSettings(), wheelContact: false, vehicleFeel: feel }, null)
      }
      return ch.roll.x
    }
    expect(roll("van", true)).toBeGreaterThan(roll("compact", true) * 1.5)
    expect(roll("swat", true)).toBeGreaterThan(roll("van", true))
    expect(roll("bike", true)).toBeLessThan(0)
    expect(roll("bike", false)).toBeGreaterThan(0)
    expect(roll("compact", false)).toBeCloseTo(roll("van", false), 8)
  })
  test("duplicated 10 Hz snapshots stay close to smooth acceleration, then settle", () => {
    const run = (stride: number) => {
      const c = { ...car(), x: CELL, z: 25, vx: 0, vz: 0, speed: 0, h: 0 }
      const ch = new Chassis(c, axles)
      const values = []
      for (let i = 0; i < 180; i++) {
        c.vz = Math.min(20, Math.floor(i / stride) * stride / 60 * 20)
        c.speed = c.vz
        ch.update(c, spec, city, 1 / 60, chassisSettings(), null)
        values.push(ch.pitch.x)
      }
      return values
    }
    const smooth = run(1), snapshots = run(6)
    expect(Math.max(...snapshots.map((x, i) => Math.abs(x - smooth[i])))).toBeLessThan(0.03)
    expect(Math.abs(snapshots.at(-1)!)).toBeLessThan(0.001)
  })
})
