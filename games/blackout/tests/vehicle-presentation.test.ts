import { expect, test } from "bun:test"
import { instanceRotation, presentationSpec } from "../src/game/vehicle-presentation"
import { bodyPoint } from "@arcade/kit/vehicle/body-pose"

test("Blackout instance adapter matches bodyPoint through combined roll, pitch and yaw", () => {
  for (let i = 0; i < 40; i++) {
    const yaw = i * 0.4, roll = Math.sin(i) * 0.4, pitch = Math.cos(i) * 0.2, out = { yaw: 0, roll: 0, pitch: 0 }
    instanceRotation(out, yaw, roll, pitch)
    for (const [x, y, z] of [[1, 2, 3], [0, 0.8, 2], [2, 0.3, 0]]) {
      const a = x! * Math.cos(out.pitch) - y! * Math.sin(out.pitch), b = x! * Math.sin(out.pitch) + y! * Math.cos(out.pitch)
      const ry = b * Math.cos(out.roll) - z! * Math.sin(out.roll), rz = b * Math.sin(out.roll) + z! * Math.cos(out.roll)
      const actual = [a * Math.cos(out.yaw) - rz * Math.sin(out.yaw), ry, a * Math.sin(out.yaw) + rz * Math.cos(out.yaw)]
      const expected = bodyPoint({ x: 0, z: 0, h: yaw }, { roll, pitch }, [-z!, y!, x!])
      actual.forEach((v, j) => expect(v).toBeCloseTo(expected[j]!, 10))
    }
  }
})
test("vehicle adapter preserves dimensions and authored wheel/lamp locations", () => {
  const jeep = presentationSpec("jeep"), scooter = presentationSpec("scooter")
  expect(jeep.mass).toBe(1.5); expect(jeep.length).toBe(3.9); expect(jeep.wheels![0]!.z).toBe(1.25)
  expect(jeep.lamps!.frontX).toBe(0.62); expect(scooter.id).toBe("bike"); expect(scooter.lamps!.rearY).toBe(0.5)
})
