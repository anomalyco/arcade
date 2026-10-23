import { expect, test } from "bun:test"
import { ForestStorm, type ForestStormFrame } from "./storm"

const input = { dt: 1 / 60, eye: [0, 1.7, 0], yaw: 0, groundY: 0, forestWind: 1 }
const run = (storm: ForestStorm, seconds: number, each?: (f: ForestStormFrame) => void) => {
  let f!: ForestStormFrame
  for (let i = 0; i < Math.round(seconds * 60); i++) { f = storm.frame(input); each?.(f) }
  return f
}

test("dry and calm by default: no rain, no flash, the eye untouched", () => {
  const f = run(new ForestStorm(), 2)
  expect(f.view.rain).toBeNull()
  expect(f.view.flash).toBe(0)
  expect(f.view.exposure).toBeCloseTo(1, 6)
  expect(f.view.wind).toBeCloseTo(1, 6)
})

test("a near strike flashes, holds the forest meter, then leaves the eye darker for a few seconds", () => {
  const storm = new ForestStorm()
  run(storm, 1)
  storm.strike("near")
  let flash = 0, held = false, thunder = 0
  run(storm, 0.6, (f) => { flash = Math.max(flash, f.view.flash); held ||= f.view.holdExposure; thunder += f.thunder.length })
  expect(flash).toBeGreaterThan(0.3)
  expect(held).toBe(true)
  expect(thunder).toBe(1)
  const after = run(storm, 1)
  expect(after.view.flash).toBeLessThan(1e-3)
  expect(after.view.exposure).toBeLessThan(0.9)
  const later = run(storm, 8)
  expect(later.view.exposure).toBeGreaterThan(after.view.exposure)
  expect(later.view.exposure).toBeGreaterThan(0.9)
  expect(later.view.holdExposure).toBe(false)
})

test("a gust rises, peaks near the gust peak and falls back", () => {
  const storm = new ForestStorm({ stormWind: 1, gustPeak: 2, gustLength: 6 })
  run(storm, 0.5)
  storm.gust()
  let peak = 0
  run(storm, 3, (f) => { peak = Math.max(peak, f.wind) })
  expect(peak).toBeGreaterThan(1.9)
  expect(peak).toBeLessThanOrEqual(2 + 1e-9)
  expect(run(storm, 10).wind).toBeCloseTo(1, 3)
})

test("rain eases in and settle() snaps it with the wet ground", () => {
  const storm = new ForestStorm({ rain: 1, wetness: 1, puddles: 0.8 })
  const first = run(storm, 0.2)
  expect(first.rain).toBeLessThan(0.3)
  expect(first.view.rain).not.toBeNull()
  storm.settle()
  const settled = storm.frame(input)
  expect(settled.rain).toBeCloseTo(1, 3)
  expect(settled.view.wetness).toBeCloseTo(1, 3)
  expect(settled.view.puddles).toBeCloseTo(0.8, 3)
})
