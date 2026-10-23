import { describe, expect, test } from "bun:test"
import { mat4 } from "wgpu-matrix"
import { validateWgsl } from "../test-naga"
import { CAMERA_BLUR_DEFAULTS, CAMERA_BLUR_WGSL, CameraBlur, rotationReprojection } from "./camera-blur"

/** The renderer's frame layout: viewProj at 0..15, eye at 16..18, time at 19. */
function frame(eye: [number, number, number], yaw: number, time = 0): Float32Array {
  const f = new Float32Array(20)
  const look = [eye[0] - Math.sin(yaw), eye[1], eye[2] - Math.cos(yaw)]
  f.set(mat4.multiply(mat4.perspective(1.2, 16 / 9, 0.1, 300), mat4.lookAt(eye, look, [0, 1, 0])), 0)
  f.set(eye, 16)
  f[19] = time
  return f
}
const apply = (m: Float32Array, x: number, y: number) => {
  const q = [0, 1, 2, 3].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * 0.5 + m[12 + r]!)
  return [q[0]! / q[3]!, q[1]! / q[3]!]
}

describe("camera blur", () => {
  test("off by default, so the chain skips it", () => {
    expect(new CameraBlur({} as GPUDevice, "bgra8unorm").active).toBe(false)
    expect(CAMERA_BLUR_DEFAULTS.strength).toBe(0)
  })

  test("walking reprojects to the same pixel; only turning moves it", () => {
    const still = rotationReprojection(frame([1, 1.7, 2], 0.3), frame([1, 1.7, 2], 0.3))
    const walked = rotationReprojection(frame([1.4, 1.75, 1.2], 0.3), frame([1, 1.7, 2], 0.3))
    for (const m of [still, walked]) for (const [x, y] of [[0, 0], [0.7, -0.4], [-0.9, 0.8]] as const) {
      const [px, py] = apply(m, x, y)
      expect(px).toBeCloseTo(x, 4)
      expect(py).toBeCloseTo(y, 4)
    }
    // Turning left (yaw up): what is now in the middle sat left of the middle a frame ago.
    const [px, py] = apply(rotationReprojection(frame([0, 1.7, 0], 0.05), frame([0, 1.7, 0], 0)), 0, 0)
    expect(px).toBeLessThan(-0.03)
    expect(Math.abs(py)).toBeLessThan(1e-4)
  })

  test("its shader validates", () => validateWgsl(CAMERA_BLUR_WGSL))
})
