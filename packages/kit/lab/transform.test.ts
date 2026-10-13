import { expect, test } from "bun:test"
import {
  applyNumericTransformKey,
  createTransformState,
  snapGroundCoord,
  snapYawDeg,
  snapYawRad,
} from "./transform"
import type { LabWorldObject } from "./types"

test("ground coordinate snapping and yaw snapping respect default, coarse (Shift), and fine (Alt) modifiers", () => {
  expect(snapGroundCoord(2.13, false)).toBe(2.25)
  expect(snapGroundCoord(2.13, true)).toBe(2.15)
  expect(snapYawDeg(13, false, false)).toBe(15)
  expect(snapYawDeg(22, true, false)).toBe(15)
  expect(snapYawDeg(22, false, true)).toBe(22)
  expect(snapYawRad((44 * Math.PI) / 180, true, false)).toBeCloseTo((45 * Math.PI) / 180, 5)
})

test("modal transform state preserves multi-object offsets and parses live numeric entry", () => {
  const objs: LabWorldObject[] = [
    { id: "prop:1", label: "Cone #1", category: "prop", x: -2, y: 0, z: 2, yaw: 0, movable: true },
    { id: "prop:2", label: "Cone #2", category: "prop", x: 0, y: 0, z: 4, yaw: 0, movable: true },
  ]
  const st = createTransformState("move", objs[1]!, objs)
  expect(st.offsets).toEqual([
    { id: "prop:1", dx: -2, dz: -2, origX: -2, origZ: 2, origYaw: 0 },
    { id: "prop:2", dx: 0, dz: 0, origX: 0, origZ: 4, origYaw: 0 },
  ])

  // Numeric entry for X = -4.5
  for (const ch of ["-", "4", ".", "5"]) {
    applyNumericTransformKey(st, ch)
  }
  expect(st.currentX).toBe(-4.5)

  // Tab switches to Z axis, type 6.25
  applyNumericTransformKey(st, "Tab")
  expect(st.numericAxis).toBe("z")
  for (const ch of ["6", ".", "2", "5"]) {
    applyNumericTransformKey(st, ch)
  }
  expect(st.currentZ).toBe(6.25)

  // Rotate mode numeric entry: 90 degrees
  const rot = createTransformState("rotate", objs[1]!, objs)
  for (const ch of ["9", "0"]) {
    applyNumericTransformKey(rot, ch)
  }
  expect(rot.currentYaw).toBeCloseTo(Math.PI / 2, 5)
})
