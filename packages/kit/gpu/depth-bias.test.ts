import { expect, test } from "bun:test"
import { makeSceneShader } from "./shaders"

test("depthBias pulls vsStatic clip depth toward the camera by 24-bit steps, and is absent by default", () => {
  const plain = makeSceneShader({})
  expect(plain).not.toContain("o.pos.z -=")
  const biased = makeSceneShader({ depthBias: "select(0.0, 4.0, v.matAux.x == 3.0)" })
  const line = biased.split("\n").find((l) => l.includes("o.pos.z -="))!
  expect(line).toContain("(select(0.0, 4.0, v.matAux.x == 3.0))")
  expect(Number(line.match(/\* ([0-9.e-]+) \* o\.pos\.w/)![1])).toBeCloseTo(2 ** -24, 12)
})
