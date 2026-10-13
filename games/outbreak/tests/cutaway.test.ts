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
})

test("every high or roof triangle is kept in the cutaway pipeline", () => {
  const level = buildLevel(makeTown(7))
  let opaque = 0, cut = 0
  for (const chunk of level.chunks) {
    const data = new DataView(chunk.data)
    for (let i = 0; i < data.byteLength; i += 24) {
      if (chunk.customCutaway) { cut++; continue }
      expect(data.getFloat32(i+4,true)).toBeLessThanOrEqual(Math.fround(2.8))
      // Roof code 21 is exactly representable in binary16 (0x4d40).
      expect(data.getUint16(i+20,true)).not.toBe(0x4d40)
      opaque++
    }
  }
  expect(opaque).toBeGreaterThan(0)
  expect(cut).toBeGreaterThan(0)
  expect(opaque+cut+level.glass.reduce((n,c)=>n+c.data.byteLength/24,0)).toBe(196722)
})
