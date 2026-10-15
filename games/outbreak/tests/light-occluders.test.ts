import { describe, expect, test } from "bun:test"
import { OCC_FLOATS } from "@arcade/kit/limits"
import { makeTown, sightRects } from "../shared/map"
import { OPEN_WINDOW_SILL, packLightOccluders, WALL_CASTER_HEIGHT, windowStateKey } from "../src/light-occluders"

describe("light occluders", () => {
  const town = makeTown(7)
  const heightOf = (out: Float32Array, n: number, rect: readonly number[]) => {
    for (let i = 0; i < n; i++) {
      const o = i * OCC_FLOATS
      if ([0, 1, 2, 3].every((k) => Math.abs(out[o + k]! - rect[k]!) < 1e-4)) return out[o + 4]!
    }
    return -1
  }

  test("closed windows stop light at full height; open windows only below the sill", () => {
    const win = town.windows[0]!
    const out = new Float32Array(4096 * OCC_FLOATS)
    win.open = false
    let packed = packLightOccluders(town, sightRects(town), out, 4096)
    expect(heightOf(out, packed.count, win.rect)).toBeCloseTo(WALL_CASTER_HEIGHT, 5)
    expect(packed.walls).toContain(win.rect)
    win.open = true
    packed = packLightOccluders(town, sightRects(town), out, 4096)
    expect(heightOf(out, packed.count, win.rect)).toBeCloseTo(OPEN_WINDOW_SILL, 5)
    expect(packed.walls).not.toContain(win.rect)
    win.open = false
  })

  test("walls and closed doors come first at full height, so the eye light's range stays the sight blockers", () => {
    const blockers = sightRects(town)
    const out = new Float32Array(4096 * OCC_FLOATS)
    const packed = packLightOccluders(town, blockers, out, 4096)
    for (let i = 0; i < blockers.length; i++) {
      expect(out[i * OCC_FLOATS + 4]).toBeCloseTo(WALL_CASTER_HEIGHT, 5)
      expect(out[i * OCC_FLOATS]).toBeCloseTo(blockers[i]![0], 5)
    }
    expect(packed.count).toBeGreaterThan(blockers.length + town.windows.length - 1)
  })

  test("opening or closing a window changes the rebuild key", () => {
    const before = windowStateKey(town)
    town.windows[1]!.open = !town.windows[1]!.open
    expect(windowStateKey(town)).not.toBe(before)
    town.windows[1]!.open = !town.windows[1]!.open
    expect(windowStateKey(town)).toBe(before)
  })
})
