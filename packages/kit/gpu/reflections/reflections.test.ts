import { expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { fogScatterVolume } from "../fog-scatter"
import { makeSceneShader } from "../shaders"
import { Ssr, createSsrSettings, ssrVolume } from "./ssr"
import { decodeSurfaceRoughness, encodeSurfaceAlpha, reflectiveSurfaceReturn } from "./surface"
import { wetSurfaceWgsl } from "./wet"

test("surface tags round trip; untagged alpha never reflects", () => {
  for (const r of [0, 0.035, 0.3, 0.85, 1]) expect(decodeSurfaceRoughness(encodeSurfaceAlpha(r))).toBeCloseTo(r, 6)
  for (const a of [1, 0.35]) expect(decodeSurfaceRoughness(a)).toBe(1)
})

test("Today skips SSR; indoor budgets do not leak into outdoors", () => {
  expect(new Ssr(createSsrSettings({ mode: "today" })).volumeInput()).toBeNull()
  const ssr = new Ssr()
  const outdoors = structuredClone(ssr.volumeInput()!)
  ssr.settings.maxStepsIndoor = 2000
  expect(ssr.volumeInput({ indoor: true })!.params![10]).toBe(1024)
  expect(ssr.volumeInput()).toEqual(outdoors)
})

const ssr = ssrVolume()
const sources = {
  march: ssr.code, streak: ssr.filter!,
  fogSurface: fogScatterVolume({ surface: true, wetSettings: "vec4f(1.0, 0.32, 1.0, 0.5)", reflectionSamples: 4 }).code,
  wetScene: makeSceneShader({ lampGrid: false, declarations: wetSurfaceWgsl, material: "{ let w = wetSurface(o.world, n.y, 0.8, 1.0, 0.01, vec4f(1.0, 0.32, 1.0, 0.5), vec4f(0.6, 0.13, 1.0, 0.0)); albedo *= w.albedo; }", fragmentReturn: reflectiveSurfaceReturn("0.5") }),
}
for (const [name, code] of Object.entries(sources)) test(`WGSL: ${name}`, () => validateWgsl(code))
