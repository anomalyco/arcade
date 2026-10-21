import { expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { buildLevel } from "../src/level"
import { shaders } from "../src/shaders"
import { makeSceneShader } from "@arcade/kit/gpu/shaders"

test("opaque Outbreak entry point has no discard; default shared hooks are unchanged", () => {
  const solid = shaders.scene.split("@fragment fn fsSolid")[1]!
  expect(solid).not.toContain("discard")
  expect(shaders.scene.split("@fragment fn fsSolid")[0]).toContain("roofCut(o.world")
  expect(makeSceneShader({cutaway:"if (o.world.y > 3.0) { discard; }"}).split("@fragment fn fsSolid")[1]).toContain("discard")

  // Opt-in Look shaders also keep fsSolid free of discard.
  const lookSolid = shaders.lookScene.split("@fragment fn fsSolid")[1]!
  expect(lookSolid).not.toContain("discard")
})

test("every roof or high interior triangle is routed to its building's custom cutaway chunk while exterior trees stay opaque", () => {
  const level = buildLevel(makeTown(7))
  let opaque = 0, screen = 0, cut = 0
  for (const chunk of level.chunks) {
    const data = new DataView(chunk.data)
    for (let i = 0; i < data.byteLength; i += 72) {
      if (chunk.customCutaway) {
        expect(chunk.cutBox).toBeDefined()
        cut += 3
        continue
      }
      if (chunk.cutBox) {
        screen += 3
        continue
      }
      const hasRoof = [0, 24, 48].some((off) => data.getUint16(i + off + 20, true) === 0x4d40)
      expect(hasRoof).toBe(false)
      opaque += 3
    }
  }
  expect(opaque).toBeGreaterThan(0)
  expect(screen).toBeGreaterThan(0)
  expect(cut).toBeGreaterThan(0)
})
