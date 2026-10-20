import { expect, test } from "bun:test"
import { buildWilliamsReferenceCycle, extractBodyJoints, jointsToBody, parseBvh, POSE_JOINTS } from "./pose-diff"

test("jointsToBody draws a retargeted pose back onto the same joints", () => {
  for (const mode of ["walk", "run"] as const) {
    for (const s of buildWilliamsReferenceCycle(mode).phases16) {
      const back = extractBodyJoints(jointsToBody(s.joints))
      for (const id of POSE_JOINTS) {
        const a = s.joints[id], b = back[id]
        // Reference toe tips are clamped to the floor, so only their direction survives the RIG.toe-long toe part.
        const tol = id === "toeL" || id === "toeR" ? 0.03 : 1e-6
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(tol)
      }
    }
  }
})

test("parseBvh applies each joint's own channel order and rotation-only joints", () => {
  // Root ZXY with positions, child with rotation-only YXZ channels: a 90° Y turn swings the child's offset from +X to -Z.
  const bvh = [
    "HIERARCHY",
    "ROOT Hips",
    "{",
    " OFFSET 0 0 0",
    " CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation",
    " JOINT Knee",
    " {",
    "  OFFSET 0 -40 0",
    "  CHANNELS 3 Yrotation Xrotation Zrotation",
    "  End Site",
    "  {",
    "   OFFSET 10 0 0",
    "  }",
    " }",
    "}",
    "MOTION",
    "Frames: 1",
    "Frame Time: 0.016667",
    "0 90 0 0 0 0 90 0 0",
  ].join("\n")
  const f = parseBvh(bvh).frames[0]!
  // Canonical axes: (x, y, z)_bvh → (z, y, -x).
  expect(f.Hips).toEqual([0, 0.9, -0])
  expect(f.Knee![1]).toBeCloseTo(0.5)
  const end = f.Knee_End!
  // The end offset +X (BVH) turned 90° about Y points along -Z (BVH), which is -X in canonical axes.
  expect(end[0]).toBeCloseTo(-0.1)
  expect(end[1]).toBeCloseTo(0.5)
  expect(end[2]).toBeCloseTo(0)
})
