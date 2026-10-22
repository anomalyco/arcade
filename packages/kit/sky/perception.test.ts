import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { decodeCatalogue } from "./catalogue"
import { magnitudeLux } from "./astronomy"
import { skySensitivity, starVisibilityWeights } from "./perception"

test("faint-star visibility preserves the real catalogue's aggregate illuminance", () => {
  const bytes = readFileSync(new URL("./assets/stars.bin", import.meta.url))
  const stars = decodeCatalogue(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const weights = starVisibilityWeights(stars.map(s => s.magnitude))
  let physical = 0, adapted = 0, faint = 0
  stars.forEach((s, i) => {
    const lux = magnitudeLux(s.magnitude)
    physical += lux; adapted += lux * weights[i]!
    if (s.magnitude > 6 && weights[i]! > 1) faint++
  })
  expect(Math.abs(adapted / physical - 1)).toBeLessThan(1e-6)
  expect(faint).toBeGreaterThan(1000)
})

test("observer sensitivity is bounded and photometric at zero adaptation", () => {
  expect(skySensitivity(-1)).toBe(1)
  expect(skySensitivity(0)).toBe(1)
  expect(skySensitivity(1)).toBe(10)
  expect(skySensitivity(2)).toBe(10)
})
