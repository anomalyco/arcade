import { expect, test } from "bun:test"
import { adaptForestExposure, forestExposureTarget } from "./exposure"
import { createForestLookSettings } from "./settings"

test("centre-meter reference retains the previous exposure law", () => {
  const s = createForestLookSettings({ exposureModel: "metered", adaptRange: 1.5, adaptLift: 1.5 })
  for (const centre of [0.0001, 0.003, 0.015, 0.06, 1]) {
    const meter = { mean: centre, centre, logMean: centre / 2, p95: centre * 5, age: 2 }
    const previous = Math.max(-1.5, Math.min(1.5, -Math.log2(centre * s.meterGain / 0.09) * 0.55))
    expect(forestExposureTarget(meter, 0, s)).toBe(previous)
  }
})

test("night exposure allows darkness instead of chasing a grey frame", () => {
  const s = createForestLookSettings({ exposureModel: "robust", nightStops: 0, adaptLift: 0.35, adaptRange: 1 })
  expect(forestExposureTarget(null, 0, s)).toBe(0.35)
  expect(forestExposureTarget(null, 1000, s)).toBe(-1)
  expect(forestExposureTarget(null, s.nightKey, s)).toBe(0)
})

test("log metering is insensitive to a highlight that leaves the geometric mean fixed", () => {
  const s = createForestLookSettings({ exposureModel: "robust" })
  const meter = { mean: 0.1, centre: 0.1, logMean: 0.003, p95: 1, age: 2 }
  expect(forestExposureTarget(meter, 0, s)).toBe(forestExposureTarget({ ...meter, centre: 5, p95: 10 }, 0, s))
})

test("adaptation is asymmetric and frame-partition independent", () => {
  const s = createForestLookSettings({ adaptDarken: 0.8, adaptBrighten: 6 })
  let partitioned = 0
  for (let i = 0; i < 240; i++) partitioned = adaptForestExposure(partitioned, -1, 1 / 60, s)
  expect(partitioned).toBeCloseTo(adaptForestExposure(0, -1, 4, s), 12)
  expect(-adaptForestExposure(0, -1, 1, s)).toBeGreaterThan(adaptForestExposure(0, 1, 1, s))
})

test("manual exposure and zero elapsed time do not acquire adaptive gain", () => {
  const s = createForestLookSettings({ autoExposure: false })
  expect(forestExposureTarget(null, 0, s)).toBe(0)
  expect(adaptForestExposure(0.3, -1, 0, s)).toBe(0.3)
})

test("centre response is model-derived for imported and directly assigned settings", () => {
  const s = createForestLookSettings()
  Object.assign(s, { exposureModel: "metered", adaptDarken: 0.8, adaptBrighten: 6 })
  expect(adaptForestExposure(0, -1, 0.35, s)).toBeCloseTo(-1 + Math.exp(-1), 12)
  expect(adaptForestExposure(0, 1, 1.8, s)).toBeCloseTo(1 - Math.exp(-1), 12)
  const query = createForestLookSettings({ exposureModel: "metered" })
  expect(adaptForestExposure(0, 1, 1.8, query)).toBe(adaptForestExposure(0, 1, 1.8, s))
  s.exposureModel = "robust"
  expect(adaptForestExposure(0, 1, 6, s)).toBeCloseTo(1 - Math.exp(-1), 12)
})

test("scene compensation stays inside exposure bounds and respects manual mode", () => {
  const s = createForestLookSettings({ nightStops: 0 })
  expect(forestExposureTarget(null, s.nightKey, s, -0.25)).toBe(-0.25)
  expect(forestExposureTarget(null, 1000, s, -0.25)).toBe(-s.adaptRange)
  s.autoExposure = false
  expect(forestExposureTarget(null, s.nightKey, s, -0.25)).toBe(0)
})
