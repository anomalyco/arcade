import { expect, test } from "bun:test"
import { createSkySettings } from "./settings"
import { equatorialBasis, moonLight, sunDirection } from "./model"

test("Today and Moon none cannot add forest light", () => {
  expect(moonLight(createSkySettings({ skyMoon: "full" })).illuminanceLux).toBe(0)
  expect(moonLight(createSkySettings({ skyMode: "physical" })).illuminanceLux).toBe(0)
})
test("moon presets output plausible normal illuminance, not ambient lifts", () => {
  const s = createSkySettings({ skyMode: "physical", skyMoon: "full", skyMoonAltitude: 90 })
  const full = moonLight(s), half = moonLight({ ...s, skyMoon: "half" }), crescent = moonLight({ ...s, skyMoon: "crescent" })
  expect(full.illuminanceLux).toBeGreaterThan(0.1); expect(full.illuminanceLux).toBeLessThan(0.3)
  expect(half.illuminanceLux / full.illuminanceLux).toBeLessThan(0.1)
  expect(crescent.illuminanceLux).toBeLessThan(half.illuminanceLux)
  expect(moonLight({ ...s, skyMoonAltitude: -1 }).illuminanceLux).toBe(0)
})
test("galactic coordinate basis is orthonormal, sun is below the default night horizon", () => {
  const s = createSkySettings(), basis = equatorialBasis(s)
  for (const a of basis) expect(Math.hypot(...a)).toBeCloseTo(1, 10)
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(basis[i]!.reduce((sum, a, k) => sum + a * basis[j]![k]!, 0)).toBeCloseTo(0, 10)
  expect(sunDirection(s)[1]).toBeLessThan(-0.3)
})
