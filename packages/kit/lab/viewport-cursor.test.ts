import { expect, test } from "bun:test"
import { sampleGroundNormal } from "./viewport-cursor"
import { yardGround } from "./yard"

test("sampleGroundNormal returns unit upward normal on flat ground and tilted normal on yard ramps", () => {
  const flat = sampleGroundNormal(0, 0, yardGround)
  expect(flat.y).toBe(0)
  expect(flat.nx).toBe(0)
  expect(flat.ny).toBe(1)
  expect(flat.nz).toBe(0)
  expect(flat.slopeDeg).toBe(0)

  // Main jump ramp at x=10, z=-3 rises along -Z
  const ramp = sampleGroundNormal(10, -3, yardGround)
  expect(ramp.y).toBeGreaterThan(0.1)
  expect(ramp.ny).toBeLessThan(1)
  expect(ramp.slopeDeg).toBeGreaterThan(5)
  expect(Math.hypot(ramp.nx, ramp.ny, ramp.nz)).toBeCloseTo(1, 3)
})
