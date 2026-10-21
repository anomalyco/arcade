import { describe, expect, test } from "bun:test"
import { validateWgsl } from "@arcade/kit/gpu/test-naga"
import { polarShader } from "@arcade/kit/gpu/shaders"
import { noteLyingBody, takeLyingBodies } from "../src/soft-shadows/lying-bodies"
import { flashlightVolumeShader } from "../src/flashlight-beam"
import { shaders } from "../src/shaders"

describe("soft character shadows (AR-113)", () => {
  test("lying bodies are taken once per frame", () => {
    noteLyingBody(1, 0, 2, 0.5)
    noteLyingBody(3, 0, 4, 1)
    const seen: number[][] = []
    takeLyingBodies((x, y, z, yaw) => seen.push([x, y, z, yaw]))
    expect(seen).toEqual([
      [1, 0, 2, 0.5],
      [3, 0, 4, 1],
    ])
    takeLyingBodies(() => seen.push([]))
    expect(seen.length).toBe(2)
  })
})

describe("Outbreak shaders validate with naga", () => {
  const sources: Record<string, string> = {
    scene: shaders.scene,
    lookScene: shaders.lookScene,
    polar: polarShader,
    flashlightVolume: flashlightVolumeShader.code,
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => validateWgsl(code))
  }
})
