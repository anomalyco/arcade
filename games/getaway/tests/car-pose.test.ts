import { expect, test } from "bun:test"
import { bodyPoint } from "../src/game/car-pose"

test("bodyPoint uses the instance shader's roll, pitch, yaw order and full body height", () => {
  const p = bodyPoint({ x: 10, z: 20, h: Math.PI / 2 }, { height: 4, roll: Math.PI / 2, pitch: Math.PI / 2 }, [1, 2, 3])
  p.forEach((n, i) => expect(n).toBeCloseTo([11, 1, 22][i], 10))
})

test("braking lowers the front lamps and raises the rear; kerb roll lifts just one side", () => {
  const c = { x: 0, z: 0, h: 0 }
  const brake = { height: 0.2, roll: 0, pitch: 0.14 }
  expect(bodyPoint(c, brake, [0, 0.75, 2.5])[1]).toBeLessThan(0.75)
  expect(bodyPoint(c, brake, [0, 0.75, -2.5])[1]).toBeGreaterThan(0.95)
  const kerb = { height: 0.1, roll: 0.1, pitch: 0 }
  const left = bodyPoint(c, kerb, [-0.8, 0.75, 2.5]), right = bodyPoint(c, kerb, [0.8, 0.75, 2.5])
  expect(right[1] - left[1]).toBeCloseTo(1.6 * Math.sin(0.1), 10)
})

test("lamp spacing and beam direction remain rigid through combined body motion", () => {
  for (let i = 0; i < 30; i++) {
    const c = { x: 100, z: 25, h: i * 0.7 }, pose = { height: i * 0.1, roll: Math.sin(i) * 0.3, pitch: Math.cos(i) * 0.2 }
    const a = bodyPoint(c, pose, [-0.45, 1.9, 0]), b = bodyPoint(c, pose, [0.45, 1.9, 0])
    expect(Math.hypot(...a.map((n, k) => n - b[k]))).toBeCloseTo(0.9, 10)
    const head = bodyPoint(c, pose, [0, 1.3, 3]), aim = bodyPoint(c, pose, [0, 1, 3.95])
    expect(Math.hypot(...head.map((n, k) => n - aim[k]))).toBeCloseTo(Math.hypot(0.3, 0.95), 10)
  }
})
