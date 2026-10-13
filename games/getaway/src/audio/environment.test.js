import { expect, test } from "bun:test"
import { blocked } from "./environment"
test("street occlusion handles parallel rays and endpoints", () => {
  const b = { x0: 2, x1: 4, z0: 2, z1: 4 }
  expect(blocked(0, 3, 6, 3, b)).toBe(true)
  expect(blocked(0, 1, 6, 1, b)).toBe(false)
  expect(blocked(3, 0, 3, 6, b)).toBe(true)
  expect(blocked(0, 0, 1, 1, b)).toBe(false)
})
