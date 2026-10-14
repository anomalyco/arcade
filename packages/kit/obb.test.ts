import { describe, expect, test } from "bun:test"
import { MinHeap } from "./sim/geom"
import {
  STATIC,
  WALL,
  boxMass,
  collideShapesXY,
  collideShapesXZ,
  orientedShapeXY,
  rectShapeXY,
  resolveXY,
  resolveXZ,
  separateXY,
  separateXZ,
  shapeGapXZ,
} from "./sim/obb"
import { Rng, hash2, hash3, mulberry32, seedOf } from "./sim/rng"

describe("MinHeap", () => {
  test("pops IDs in ascending key order and supports peekKey/clear", () => {
    const h = new MinHeap()
    h.push(10, 5.5)
    h.push(20, 1.2)
    h.push(30, 8.0)
    h.push(40, 0.4)
    h.push(50, 3.1)
    expect(h.size).toBe(5)
    expect(h.peekKey()).toBe(0.4)
    expect(h.pop()).toBe(40)
    expect(h.pop()).toBe(20)
    expect(h.pop()).toBe(50)
    expect(h.pop()).toBe(10)
    expect(h.pop()).toBe(30)
    expect(h.size).toBe(0)
    h.push(99, 2)
    h.clear()
    expect(h.size).toBe(0)
  })
})

describe("Rng & mulberry32", () => {
  test("mulberry32 and Rng.next produce identical sequences for the same seed", () => {
    const fn = mulberry32(42)
    const cls = new Rng(42)
    for (let i = 0; i < 32; i++) {
      expect(fn()).toBe(cls.next())
    }
    expect(cls.seed()).toBeGreaterThanOrEqual(0)
    expect(seedOf("ABCD")).toBe(seedOf("ABCD"))
    expect(hash2(3, 7)).toBeGreaterThanOrEqual(0)
    expect(hash3(3, 7, 11)).toBeGreaterThanOrEqual(0)
  })
})

describe("2D OBB contacts and block impulse solver", () => {
  test("collideShapesXY and resolveXY/separateXY settle a flush wall impact without spin", () => {
    const wall = rectShapeXY([10, 0, 11, 10])
    const car = orientedShapeXY(8.2, 5, 0, 2.0, 1.0)
    const c = collideShapesXY(wall, car)
    expect(c).not.toBeNull()
    expect(c!.points.length).toBe(2)
    const body = { x: 8.2, y: 5, h: 0, vx: 10, vy: 0, w: 0 }
    const m = boxMass(1500, 4, 2)
    const flipped = { ...c!, nx: -c!.nx, ny: -c!.ny }
    const hit = resolveXY(body, m, null, STATIC, flipped, WALL)
    expect(hit.impact).toBeCloseTo(10, 5)
    expect(body.vx).toBeLessThan(0)
    expect(Math.abs(body.w)).toBeLessThan(1e-6)
    separateXY(body, m, null, STATIC, flipped, 0.002)
    expect(body.x).toBeLessThan(8.2)
  })

  test("collideShapesXZ, shapeGapXZ, and resolveXZ/separateXZ match ground-plane convention", () => {
    const a = { x: 0, z: 0, ax: 0, az: 1, ea: 2, eb: 1 }
    const b = { x: 0, z: 3.5, ax: 0, az: 1, ea: 2, eb: 1 }
    expect(shapeGapXZ(a, b)).toBeCloseTo(-0.5, 5)
    const c = collideShapesXZ(a, b)
    expect(c).not.toBeNull()
    const bodyA = { x: 0, z: 0, h: 0, vx: 0, vz: 12, yaw: 0 }
    const bodyB = { x: 0, z: 3.5, h: 0, vx: 0, vz: 0, yaw: 0 }
    const m = boxMass(1.5, 4, 2)
    const hit = resolveXZ(bodyA, m, bodyB, m, c!, WALL)
    expect(hit.impact).toBeCloseTo(12, 5)
    expect(hit.dvA).toBeGreaterThan(0)
    expect(hit.dvB).toBeGreaterThan(0)
    separateXZ(bodyA, m, bodyB, m, c!, 0.01)
    expect(bodyB.z - bodyA.z).toBeCloseTo(3.99, 5)
  })
})
