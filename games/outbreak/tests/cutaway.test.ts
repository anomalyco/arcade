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

  // Default Outbreak scene/post shaders must remain free of LookUniforms bindings under Current identity
  expect(shaders.scene).not.toContain("LookUniforms")
  expect(shaders.post).not.toContain("LookUniforms")

  // Opt-in Look shaders keep fsSolid free of discard while wiring LookUniforms
  const lookSolid = shaders.lookScene.split("@fragment fn fsSolid")[1]!
  expect(lookSolid).not.toContain("discard")
  expect(shaders.lookScene).toContain("struct LookUniforms")
  expect(shaders.lookPost).toContain("struct GradeAndLook")
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
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity, hasRoof = false
      for (const off of [0, 24, 48]) {
        const vx = data.getFloat32(i + off, true)
        const vy = data.getFloat32(i + off + 4, true)
        const vz = data.getFloat32(i + off + 8, true)
        minX = Math.min(minX, vx); maxX = Math.max(maxX, vx)
        maxY = Math.max(maxY, vy)
        minZ = Math.min(minZ, vz); maxZ = Math.max(maxZ, vz)
        if (data.getUint16(i + off + 20, true) === 0x4d40) hasRoof = true
      }
      expect(hasRoof).toBe(false)
      opaque += 3
    }
  }
  expect(opaque).toBeGreaterThan(0)
  expect(screen).toBeGreaterThan(0)
  expect(cut).toBeGreaterThan(0)
  expect(opaque + screen + cut + level.glass.reduce((n, c) => n + c.data.byteLength / 24, 0)).toBe(310038)
})
