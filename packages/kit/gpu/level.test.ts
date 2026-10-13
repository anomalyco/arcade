import { expect, test } from "bun:test"
import { directionalMask } from "./level"

test("legacy indoor sky coverage survives the separate directional texture layout", () => {
  const floor = { data: new Uint8Array([180, 32, 0, 255]), w: 2, h: 1 }
  expect(directionalMask(floor)).toEqual({ data: new Uint8Array([32, 255]), w: 2, h: 1 })
  expect([...floor.data]).toEqual([180, 32, 0, 255])
})

test("Blackout's finer window mask wins over the packed floor channel", () => {
  const moon = { data: new Uint8Array([0, 64, 192, 255]), w: 4, h: 1 }
  const floor = { data: new Uint8Array([180, 255, 0, 255]), w: 2, h: 1, moon }
  expect(directionalMask(floor)).toBe(moon)
})
