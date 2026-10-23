import { expect, test } from "bun:test"
import { createSkySettings } from "./settings"
import { equatorialBasis, moonBasis, moonLight, moonSkyIlluminance, moonSkyLuminance, skyClockSettings, sunDirection } from "./model"

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

test("lunar north remains up at each horizon azimuth", () => {
  for (const az of [0, 45, 90, 180, 270]) {
    const moon = moonLight(createSkySettings({ skyMoonAzimuth: az, skyMoonAltitude: 0 }))
    const { right, up } = moonBasis(moon.direction)
    expect(up[1]).toBeCloseTo(1, 10)
    expect(Math.hypot(...up)).toBeCloseTo(1, 10)
    expect(up.reduce((sum, x, i) => sum + x * right[i]!, 0)).toBeCloseTo(0, 10)
  }
})

test("host noon and midnight drive the solar altitude without changing the manual UTC clock", () => {
  const s = createSkySettings()
  expect(sunDirection(skyClockSettings(s, 13))[1]).toBeGreaterThan(0.3)
  expect(sunDirection(skyClockSettings(s, 0))[1]).toBeLessThan(-0.3)
  expect(s.skyHour).toBe(6)
  const manual = { ...s, skyClock: "utc" as const }
  expect(skyClockSettings(manual, 13)).toBe(manual)
})

test("the moonlit dome follows Krisciunas–Schaefer: a full moon lights the sky about twenty times a dark night's", () => {
  const s = createSkySettings({ skyMode: "physical", skyMoon: "full", skyMoonAltitude: 34 })
  const lux = moonLight(s).illuminanceLux
  // 60° from the moon at 45° altitude: ~19 mag/arcsec² in V, 0.003–0.006 cd/m² (moonless ~0.0002).
  const sky = moonSkyLuminance(lux, 60 * Math.PI / 180, 45 * Math.PI / 180, s.skyExtinction)
  expect(sky).toBeGreaterThan(0.002); expect(sky).toBeLessThan(0.008)
  expect(moonSkyLuminance(lux, 5 * Math.PI / 180, 45 * Math.PI / 180, s.skyExtinction)).toBeGreaterThan(3 * sky)
  // The dome's light on the ground is a few percent of the moon's own.
  const e = moonSkyIlluminance(s)
  expect(e / lux).toBeGreaterThan(0.02); expect(e / lux).toBeLessThan(0.15)
  expect(moonSkyIlluminance({ ...s, skyMoonScatter: 0 })).toBe(0)
  expect(moonSkyIlluminance({ ...s, skyMoon: "none" })).toBe(0)
})

test("a moon faded to zero light adds nothing, whatever its phase", () => {
  const s = createSkySettings({ skyMode: "physical", skyMoon: "full", skyMoonLux: 0 })
  expect(moonLight(s).illuminanceLux).toBe(0)
  expect(moonSkyIlluminance(s)).toBe(0)
})
