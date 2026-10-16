import { describe, expect, test } from "bun:test"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { makeTown } from "../shared/map"
import { propLamps } from "../src/props/furnish"
import { propDressingState } from "../src/props/state"
import { TABLE_LAMP_CONE_W, tableLampClip, TableLampLights } from "../src/table-lamps"

describe("live table lamps", () => {
  test("a lamp is clipped to the walls around it", () => {
    const clip = tableLampClip({ x: 5, z: 5, h: 1 }, [[7, 0, 7.2, 10], [0, 3, 10, 3.2]])
    expect(clip).toEqual([2.4, 3.2, 7, 7.6])
  })

  test("the start houses' lamps write warm unshadowed lights, nearest first, up to the cap", () => {
    const was = propDressingState.on
    propDressingState.on = true
    try {
      const town = makeTown(7)
      const lamps = propLamps(town)
      expect(lamps.length).toBeGreaterThan(0)
      const live = new TableLampLights()
      live.setSources(lamps, town)
      const lights = new Float32Array(8 * LIGHT_FLOATS)
      const l = lamps[0]!
      expect(live.write(lights, 1, 8, 1, l.x, l.z, 1, 0, 0.55)).toBe(2)
      const o = LIGHT_FLOATS
      expect(lights[o]).toBeCloseTo(l.x, 4)
      expect(lights[o + 2]).toBeCloseTo(l.z, 4)
      expect(lights[o + 11]).toBe(TABLE_LAMP_CONE_W)
      expect(lights[o + 13]).toBe(-1)
      expect(live.write(lights, 1, 8, 0, l.x, l.z, 1, 0, 0.55)).toBe(1)
    } finally {
      propDressingState.on = was
    }
  })
})
