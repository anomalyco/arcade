import { expect, test } from "bun:test"
import { pickHorizontalPlane } from "../orbit-gestures"
import { writeOrbitCamera } from "./stage"
import {
  applyNumericTransformKey,
  computePointerYawRad,
  createTransformState,
  projectGroundRotateRing,
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

test("ground-plane rotate ring projects to a perspective ellipse and rotate handle tracks pointer angle around pivot 1:1", () => {
  const width = 1280
  const height = 800
  const vp = new Float32Array(16)
  const inv = new Float32Array(16)
  const eye = new Float32Array(3)
  const pivot = { x: 0, y: 0.03, z: 8, radius: 2.63 }

  writeOrbitCamera(width, height, vp, inv, eye, [0, 0.4, 2], 0.35, 0.68, 20)

  const projectWorld = (x: number, y: number, z: number) => {
    const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!
    const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!
    const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!
    if (cw <= 0.001) return { u: 0.5, v: 0.5, visible: false }
    const u = (cx / cw + 1) * 0.5
    const v = (1 - cy / cw) * 0.5
    return { u, v, visible: u >= 0 && u <= 1 && v >= 0 && v <= 1 }
  }

  const screenRayAt = (u: number, v: number): { origin: [number, number, number]; dir: [number, number, number] } => {
    const nx = u * 2 - 1
    const ny = 1 - v * 2
    const x = inv[0]! * nx + inv[4]! * ny + inv[8]! + inv[12]!
    const y = inv[1]! * nx + inv[5]! * ny + inv[9]! + inv[13]!
    const z = inv[2]! * nx + inv[6]! * ny + inv[10]! + inv[14]!
    const w = inv[3]! * nx + inv[7]! * ny + inv[11]! + inv[15]! || 1
    const dx = x / w - eye[0]!
    const dy = y / w - eye[1]!
    const dz = z / w - eye[2]!
    const len = Math.hypot(dx, dy, dz) || 1
    return { origin: [eye[0]!, eye[1]!, eye[2]!], dir: [dx / len, dy / len, dz / len] }
  }

  // 1. Projected ring on ground plane is foreshortened in Y (perspective ellipse, not a 1:1 screen circle)
  const ring0 = projectGroundRotateRing(pivot.x, pivot.y, pivot.z, pivot.radius, Math.PI, width, height, projectWorld)
  const xs = ring0.ringPoints.map(p => p.x)
  const ys = ring0.ringPoints.map(p => p.y)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  expect(spanX).toBeGreaterThan(spanY * 1.15)

  // 2. For any pointer position around the ring, computePointerYawRad places the rotate handle directly under the cursor
  for (const targetDeg of [-165, -120, -45, 0, 35, 90, 140, 175]) {
    const targetRad = (targetDeg * Math.PI) / 180
    const worldPt = {
      x: pivot.x + Math.sin(targetRad) * pivot.radius,
      y: pivot.y,
      z: pivot.z + Math.cos(targetRad) * pivot.radius,
    }
    const cursorScreen = projectWorld(worldPt.x, worldPt.y, worldPt.z)
    const hit = pickHorizontalPlane(screenRayAt(cursorScreen.u, cursorScreen.v), pivot.y)!
    expect(hit).not.toBeNull()

    const computedYaw = computePointerYawRad(pivot.x, pivot.z, hit.x, hit.z, false, false)
    expect(computedYaw).toBeCloseTo(targetRad, 4)

    const projected = projectGroundRotateRing(pivot.x, pivot.y, pivot.z, pivot.radius, computedYaw, width, height, projectWorld)
    expect(projected.handleScreen.x).toBeCloseTo(cursorScreen.u * width, 1)
    expect(projected.handleScreen.y).toBeCloseTo(cursorScreen.v * height, 1)

    const pointerScreenAngle = Math.atan2(cursorScreen.u * width - projected.screenX, cursorScreen.v * height - projected.screenY)
    const handleScreenAngle = Math.atan2(projected.handleOffset.x, projected.handleOffset.y)
    expect(handleScreenAngle).toBeCloseTo(pointerScreenAngle, 4)
  }

  // 3. Shift snaps to 15° steps; Alt/Option snaps to 1° steps
  const hit22 = {
    x: pivot.x + Math.sin((22.4 * Math.PI) / 180) * pivot.radius,
    z: pivot.z + Math.cos((22.4 * Math.PI) / 180) * pivot.radius,
  }
  expect((computePointerYawRad(pivot.x, pivot.z, hit22.x, hit22.z, true, false) * 180) / Math.PI).toBeCloseTo(15, 5)
  expect((computePointerYawRad(pivot.x, pivot.z, hit22.x, hit22.z, false, true) * 180) / Math.PI).toBeCloseTo(22, 5)
})
