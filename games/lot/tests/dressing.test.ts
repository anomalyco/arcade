import { expect, test } from "bun:test"
import type { SourceScene } from "../src/world"
import { DRESSING_PRESETS, dressingDefaults, dressingRules, groundHeight, placeDressing } from "../src/dressing"

const scene: SourceScene = await Bun.file(new URL("../public/ashwood/scene.json", import.meta.url)).json()

test("Today places nothing; the dressed gate gets every kind, clear of lanes, booth and colliders", () => {
  expect(placeDressing(scene.ground, scene.colliders, { ...dressingDefaults(), ...DRESSING_PRESETS.today })).toEqual([])
  const items = placeDressing(scene.ground, scene.colliders, dressingDefaults())
  expect(new Set(items.map(i => i.item))).toEqual(new Set(["pebble", "leaf", "grass", "salal", "fern", "twigs", "paper", "can"]))
  expect(items.length).toBeGreaterThan(500)
  const { obstacles } = dressingRules(scene.ground, scene.colliders)
  for (const i of items) expect(obstacles.clearance(i.x, i.z)).toBeGreaterThanOrEqual(0)
  expect(placeDressing(scene.ground, scene.colliders, dressingDefaults())).toEqual(items)
})

test("dressing sits on the baked ground and on the booth island's top", () => {
  const apron = groundHeight(scene.ground, 0, 130), island = groundHeight(scene.ground, 8, 125)
  expect(Math.abs(apron)).toBeLessThan(0.3)
  expect(island - groundHeight(scene.ground, 8, 123.5)).toBeCloseTo(0.12, 1)
})
