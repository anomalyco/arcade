import { expect, test } from "bun:test"
import { validateWgsl } from "@arcade/kit/gpu/test-naga"
import { propLookHooks, sceneHooksFor, texturedSceneShader } from "@arcade/kit/gpu/textured-mesh"
import { outbreakTexturedSceneHooks } from "../src/shaders"

test("textured props compose with Outbreak's lighting in every scene variant the renderer draws", () => {
  const hooks = outbreakTexturedSceneHooks()
  for (const variant of ["plain", "noir", "generic", "painterly"] as const) {
    const code = texturedSceneShader(propLookHooks(sceneHooksFor(hooks, variant)))
    // The level's post-light material (vTone, interiors, practical irradiance) and the furniture tint both apply.
    expect(code).toContain("outbreakAlbedo = albedo;")
    expect(code).toContain("o.color *= inst.tint.rgb;")
    validateWgsl(code)
  }
})
