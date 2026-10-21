import { expect, test } from "bun:test"
import { SceneLights } from "../scene-frame"
import { beamCone } from "./beam"

test("beam packing accepts upward axes and rejects invalid inputs", () => {
  expect(() => beamCone([0, 0, 0], 0.36)).toThrow()
  expect(() => beamCone([0, -1, 0], 1.6)).toThrow()
  const lights = new SceneLights()
  lights.update([{ x: 0, y: 0, h: 1.3, r: 9, color: [1, 1, 1], power: 1, beam: { axis: [0, 0.6, 0.8], halfAngle: 0.36 } }], [])
  expect(Array.from(lights.lights.subarray(8, 12))).toEqual(beamCone([0, 0.6, 0.8], 0.36).map(Math.fround))
})
