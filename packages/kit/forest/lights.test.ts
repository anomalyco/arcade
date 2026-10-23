import { expect, test } from "bun:test"
import { MAX_LIGHTS } from "../limits"
import { SceneLights, type SceneLight } from "../gpu/scene-frame"
import type { CampLight } from "./build"
import { appendForestLights } from "./lights"

const light = (id: number, unshadowed = true): SceneLight => ({ id, x: 0, y: 0, h: 1, r: 8, color: [1, 0.4, 0.1], power: 1, unshadowed })
const camp: CampLight[] = Array.from({ length: MAX_LIGHTS + 10 }, () => ({ x: 0, y: 3, z: 0, axis: [0, -1, 0], color: [1, 0.7, 0.4], power: 0.008, range: 0.9, cosOuter: -1, kind: "bulb", surfaceOnly: true }))

test("saturated camp keeps torches, flares and lanterns through the real light packer", () => {
  const torches = Array.from({ length: 6 }, (_, i) => light(1000 + i))
  // Exercise both packing classes: polar-shadowed lantern and unshadowed flare.
  const game = [light(8000), light(8001, false)]
  const lights = [...torches]
  appendForestLights(lights, game, light(2000), [...camp, { ...camp[0]!, surfaceOnly: false }], { windows: 1, stringLights: 1 })
  const packed = new SceneLights()
  packed.update(lights, [])
  expect(packed.lightCount).toBe(MAX_LIGHTS)
  for (const l of [...torches, ...game, light(2000)]) {
    expect(packed.indexOf(l.id!)).toBeGreaterThanOrEqual(0)
    expect(packed.indexOf(l.id!)).toBeLessThan(packed.indexOf(3000))
  }
  expect(packed.indexOf(3000 + camp.length)).toBe(9) // Ground lighting outranks decorative bulbs, even if supplied last.
  expect(packed.indexOf(3000 + MAX_LIGHTS - 11)).toBe(MAX_LIGHTS - 1)
  expect(packed.indexOf(3000 + MAX_LIGHTS - 10)).toBe(-1)
})

test("a gameplay-filled budget admits no decorative camp bulbs", () => {
  const lights = [light(1000)]
  const game = Array.from({ length: MAX_LIGHTS - 1 }, (_, i) => light(8000 + i))
  appendForestLights(lights, game, light(2000), camp, { windows: 1, stringLights: 1 })
  const packed = new SceneLights()
  packed.update(lights, [])
  expect(packed.lightCount).toBe(MAX_LIGHTS)
  expect(packed.indexOf(game.at(-1)!.id!)).toBe(MAX_LIGHTS - 1)
  expect(packed.indexOf(2000)).toBe(-1)
  expect(packed.indexOf(3000)).toBe(-1)
})
