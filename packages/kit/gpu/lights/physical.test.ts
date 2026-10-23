import { expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { LIGHT_FLOATS } from "../../limits"
import { SceneLights } from "../scene-frame"
import { makeSceneShader } from "../shaders"
import { physicalCone, physicalLightHooks, withPhysicalLights } from "./physical"

test("spot cones pack into the scene frame and reject unsupported axes/cones", () => {
  expect(() => physicalCone([0, 1, 0], 0.45, 0.88)).toThrow()
  expect(() => physicalCone([0, -1, 0], 0.9, 0.5)).toThrow()
  const lights = new SceneLights()
  lights.update([{ x: 1, y: 2, h: 6, r: 40, color: [1, 0.5, 0.2], power: 3, spot: { axis: [0, -2, 0], cosOuter: 0.45, cosInner: 0.88 } }], [])
  expect(Array.from(lights.lights.subarray(8, 12))).toEqual(physicalCone([0, -2, 0], 0.45, 0.88).map(Math.fround))
  expect(lights.lights[LIGHT_FLOATS + 11]).toBe(0)
})

const base = { lampGrid: false, declarations: "struct Night { fog: vec4f, look: vec4f, light: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;", bounce: "vec3f(0.0)", directional: "vec3f(0.0)", material: "if (mat == 20) { pbrRough = 0.3; pbrMetal = 0.0; }" }
const sources = {
  physical: makeSceneShader({ ...physicalLightHooks(), lampGrid: true }, true),
  motion: makeSceneShader({ ...physicalLightHooks({ settings: { spill: 0.05 } }), lampGrid: true }, true, true),
  composed: makeSceneShader(withPhysicalLights(base, { knobs: "N.light", env: "mix(vec3f(0.01, 0.04, 0.04), ambientAt(n), rough * rough)" })),
  shadows: makeSceneShader(withPhysicalLights(base, { knobs: "N.light", beam: { a: "N.fog", b: "N.look" }, spotShadows: true })),
  lensShadows: makeSceneShader(withPhysicalLights(base, { spotShadows: true, spotShadowRadius: "L.extra.z" })),
}
for (const [name, code] of Object.entries(sources)) test(`WGSL: ${name}`, () => validateWgsl(code))
