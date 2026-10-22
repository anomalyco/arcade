import { describe, expect, test } from "bun:test"
import { DEG, J2000, airMass, equatorialToWorld, extinction, julianDate, magnitudeLux, moonPhaseGain, precess, siderealTime, starPixelEnergy, temperatureRgb } from "./astronomy"
import { decodeCatalogue, packCatalogue } from "./catalogue"

describe("astronomical reference values", () => {
  test("J2000 Greenwich noon and sidereal day", () => {
    expect(julianDate(Date.UTC(2000, 0, 1, 12))).toBe(J2000)
    expect(siderealTime(J2000, 0) / DEG).toBeCloseTo(280.46061837, 7)
    const a = siderealTime(J2000, 0), b = siderealTime(J2000 + 86164.0905 / 86400, 0)
    expect(Math.abs(a - b)).toBeLessThan(1e-7)
  })
  test("zenith, north pole and rising east keep the world-axis convention", () => {
    expect(equatorialToWorld(1, 40 * DEG, 40, 1)[1]).toBeCloseTo(1, 12)
    const pole = equatorialToWorld(0, Math.PI / 2, 40, 0)
    expect(pole[1]).toBeCloseTo(Math.sin(40 * DEG), 12)
    expect(pole[2]).toBeLessThan(0)
    expect(equatorialToWorld(Math.PI / 2, 0, 0, 0)[0]).toBeCloseTo(1, 12)
    const p = precess(1, 0.5, J2000)
    expect(p[0]).toBeCloseTo(1, 12); expect(p[1]).toBeCloseTo(0.5, 12)
  })
  test("extinction and lunar phase are physical ratios", () => {
    expect(magnitudeLux(0) / magnitudeLux(5)).toBeCloseTo(100, 10)
    expect(airMass(0)).toBeCloseTo(37.92, 1)
    expect(airMass(Math.PI / 2)).toBeCloseTo(1, 3)
    expect(extinction(0, 0.15)).toBe(0)
    expect(extinction(5 * DEG, 0.15)).toBeLessThan(extinction(45 * DEG, 0.15))
    expect(moonPhaseGain(0)).toBe(1)
    expect(moonPhaseGain(Math.PI / 2)).toBeGreaterThan(0.08)
    expect(moonPhaseGain(Math.PI / 2)).toBeLessThan(0.1)
  })
  test("temperature colour keeps magnitude's luminance", () => {
    for (const k of [2500, 4000, 5778, 10000, 30000]) {
      const c = temperatureRgb(k)
      expect(c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722).toBeCloseTo(1, 12)
    }
    expect(temperatureRgb(3000)[0]).toBeGreaterThan(temperatureRgb(3000)[2])
    expect(temperatureRgb(20000)[2]).toBeGreaterThan(temperatureRgb(20000)[0])
  })
})

test("subpixel star flux stays constant across 128 phases and PSF widths", () => {
  for (const width of [0.55, 0.8, 1, 1.7]) for (let phase = 0; phase < 128; phase++) {
    let sum = 0
    for (let pixel = -8; pixel <= 8; pixel++) sum += starPixelEnergy(pixel - phase / 128, width)
    expect(sum).toBeCloseTo(1, 11)
  }
})

test("real catalogue contains Sirius, Polaris and plausible dark-sky hemisphere counts", async () => {
  const stars = decodeCatalogue(await Bun.file(new URL("./assets/stars.bin", import.meta.url)).arrayBuffer())
  expect(stars).toHaveLength(9096)
  expect(stars.find(s => s.id === 2491)!.magnitude).toBeCloseTo(-1.46, 2)
  expect(stars.find(s => s.id === 424)!.dec / DEG).toBeGreaterThan(89)
  const data = packCatalogue(stars, J2000, 45, 0)
  let visible = 0
  for (let i = 0; i < stars.length; i++) if (data[i * 8 + 1]! > 0 && data[i * 8 + 3]! <= 6.5) visible++
  expect(visible).toBeGreaterThan(2500); expect(visible).toBeLessThan(4600)
})
