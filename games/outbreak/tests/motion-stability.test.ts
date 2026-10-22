import { describe, expect, test } from "bun:test"
import { DEFAULT_ANTI_ALIASING_SETTINGS } from "../src/anti-aliasing/settings"
import { stepLampReach } from "../src/scene/frame-lighting"

describe("lamp reach fade", () => {
  test("a lamp crossing its reach fades over lampReachFade seconds instead of popping", () => {
    const step = 1 / 60 / DEFAULT_ANTI_ALIASING_SETTINGS.lampReachFade
    let reach = 1
    const seen: number[] = []
    for (let i = 0; i < 40; i++) seen.push((reach = stepLampReach(reach, 0, step)))
    expect(seen[0]).toBeCloseTo(1 - step, 6)
    expect(seen.every((v, i) => i === 0 || seen[i - 1]! - v <= step + 1e-9)).toBe(true)
    expect(reach).toBe(0)
    expect(stepLampReach(0.2, 1, step)).toBeCloseTo(0.2 + step, 6)
  })

  test("still, new or after a jump it is exactly in or out, as Today", () => {
    expect(stepLampReach(1, 1, 0)).toBe(1)
    expect(stepLampReach(0, 0, 0.5)).toBe(0)
    expect(stepLampReach(undefined, 1, 0.01)).toBe(1)
    expect(stepLampReach(undefined, 0, 0.01)).toBe(0)
    expect(stepLampReach(0.5, 1, 1)).toBe(1)
  })
})
