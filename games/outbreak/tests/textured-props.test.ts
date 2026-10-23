import { test } from "bun:test"
import { validateWgsl } from "@arcade/kit/gpu/test-naga"
import { texturedSceneShader } from "@arcade/kit/gpu/textured-mesh"
import { outbreakTexturedSceneHooks } from "../src/shaders"

test("textured props compose with Outbreak's beam, shroud and look shaders", () => {
  for (const variant of ["noir", "generic", "painterly"] as const) {
    validateWgsl(texturedSceneShader(outbreakTexturedSceneHooks(variant)))
  }
})
