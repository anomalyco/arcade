import { expect, test } from "bun:test"
import { adaptForestExposure, forestExposureTarget, stepForestExposure } from "./exposure"
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

test("no meter follows every fallback target immediately, as smoke did before the hold", () => {
  const s = createForestLookSettings()
  const state = { stops: 0, pending: true, wait: 0 }
  for (const fallback of [0.0005, 0.3, 0.004, 0.001]) {
    const target = forestExposureTarget(null, fallback, s)
    stepForestExposure(state, "off", target, 1 / 60, s)
    expect(state.stops).toBe(target)
    expect(state.pending).toBe(false)
  }
})

test("a reading that never arrives releases the hold at half a second and keeps adapting", () => {
  const s = createForestLookSettings()
  const state = { stops: 0, pending: true, wait: 0 }
  for (let i = 0; i < 3; i++) stepForestExposure(state, "pending", -1, 0.125, s)
  expect(state.stops).toBe(0)
  expect(state.pending).toBe(true)
  stepForestExposure(state, "pending", -1, 0.125, s)
  expect(state.pending).toBe(false)
  expect(state.stops).toBeLessThan(0)
  expect(state.stops).toBeGreaterThan(-1)
  const released = state.stops
  stepForestExposure(state, "pending", -1, 0.125, s)
  expect(state.stops).toBeLessThan(released)
  stepForestExposure(state, "ready", 1, 1 / 60, s)
  expect(state.stops).toBeLessThan(0) // Late recovery adapts, never snaps.
})

test("readback failure releases the hold immediately and recovery does not snap", () => {
  const s = createForestLookSettings()
  const state = { stops: 0, pending: true, wait: 0 }
  stepForestExposure(state, "failed", -1, 1 / 60, s)
  expect(state.pending).toBe(false)
  expect(state.stops).toBeLessThan(0)
  stepForestExposure(state, "ready", 1, 1 / 60, s)
  expect(state.stops).toBeLessThan(0.1)
})

test("a timely first reading snaps once, then adapts", () => {
  const s = createForestLookSettings()
  const state = { stops: 0, pending: true, wait: 0 }
  stepForestExposure(state, "pending", 1, 1 / 60, s)
  expect(state.stops).toBe(0)
  stepForestExposure(state, "ready", -1, 1 / 60, s)
  expect(state.stops).toBe(-1)
  expect(state.pending).toBe(false)
  stepForestExposure(state, "ready", 1, 1 / 60, s)
  expect(state.stops).toBeLessThan(0)
})
