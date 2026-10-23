import { expect, test } from "bun:test"
import { calibrateMotion, checkBodyMotion, measureBodyMotion, type MotionCalibration, type MotionFrame } from "./motion-check"

const reference = { speed: 2, leg: 1 }
const permissive: MotionCalibration = { version: 1, sources: ["analytic control"], ...reference, margin: 1, limits: {} }

test("nonuniform divided differences recover cubic acceleration/jerk across a 100ms hitch", () => {
  let t = 0
  const frames: MotionFrame[] = [1 / 60, 1 / 60, 0.1, 1 / 144, 1 / 30].map(dt => {
    t += dt
    return { dt, speed: 0, joints: { pelvis: [t ** 3, 1, 0], wristL: [t ** 3 + 1, 1, 0] } }
  })
  const r = measureBodyMotion(frames, reference)
  for (const x of r.filter(x => x.metric === "jerk" && x.space === "world")) expect(x.value).toBeCloseTo(6, 8)
  for (const x of r.filter(x => x.metric === "velocity" && x.space === "pelvis")) expect(x.value).toBeLessThan(1e-10)
  expect(r.filter(x => x.frame === 0 && ["acceleration", "jerk", "velocity"].includes(x.metric))).toEqual([])
})

test("bad numbers are violations, and a reset never seeds velocity from a teleport", () => {
  const frames: MotionFrame[] = [
    { dt: 1 / 60, speed: 0, joints: { pelvis: [0, 1, 0] } },
    { dt: 1 / 60, speed: 0, joints: { pelvis: [100, 1, 0] }, reset: true },
    { dt: 1 / 60, speed: 0, joints: { pelvis: [NaN, 1, 0] } },
    { dt: 1 / 60, speed: 0, joints: { pelvis: [0, 1, 0] } },
    { dt: 0, speed: 0, joints: { pelvis: [0, 1, 0] } },
  ]
  const v = checkBodyMotion(frames, permissive)
  expect(v.length).toBeGreaterThan(0)
  expect(v.every(v => v.metric === "bad-number")).toBe(true)
  expect(v.map(v => v.frame)).toContain(2)
  expect(v.map(v => v.frame)).toContain(4)
})

test("wrapped yaw takes the short path; shrinking hip bars are measured independently", () => {
  const frames: MotionFrame[] = [0, 1, 2].map(i => ({ dt: 0.01, speed: 0,
    joints: { pelvis: [0, 1, 0], hipL: [0, 1, -0.1], hipR: [0, 1, i === 2 ? 0 : 0.1] },
    yaw: { pelvis: Math.PI - 0.01 + i * 0.01 > Math.PI ? -Math.PI + 0.01 : Math.PI - 0.01 + i * 0.01, torso: 0 },
  }))
  const r = measureBodyMotion(frames, reference)
  expect(r.filter(x => x.metric === "yaw-rate" && x.joint === "pelvis").map(x => x.value)).toEqual([expect.closeTo(1), expect.closeTo(1)])
  expect(r.find(x => x.metric === "width" && x.frame === 2)?.value).toBeCloseTo(0.1)
})

test("an absent joint does not retain stale derivative samples when it returns", () => {
  const frames: MotionFrame[] = [
    { dt: 0.1, speed: 0, joints: { pelvis: [0, 1, 0], wristL: [0, 1, 0] } },
    { dt: 0.1, speed: 0, joints: { pelvis: [0, 1, 0] } },
    { dt: 0.1, speed: 0, joints: { pelvis: [0, 1, 0], wristL: [100, 1, 0] } },
    { dt: 0.1, speed: 0, joints: { pelvis: [0, 1, 0], wristL: [100.1, 1, 0] } },
  ]
  const r = measureBodyMotion(frames, reference).filter(r => r.joint === "wristL" && r.space === "world")
  expect(r.filter(r => r.frame === 2)).toEqual([])
  expect(r.filter(r => r.metric === "velocity").map(r => r.value)).toEqual([expect.closeTo(1)])
  expect(r.some(r => r.metric === "acceleration")).toBe(false)
  expect(() => measureBodyMotion(frames, { speed: Infinity, leg: 1 })).toThrow("finite and positive")
})

test("grip history resets after release, while planted contact uses the sole rather than ankle height", () => {
  const frame = (x: number, gripping: boolean, planted: boolean): MotionFrame => ({ dt: 0.1, speed: 0,
    joints: { pelvis: [0, 1, 0], wristR: [x, 1, 0], ankleR: [0, 0.08, 0], ballR: [0.1, 0, 0], toeR: [0.2, 0, 0] },
    contacts: { ballR: { point: [0.1, 0, 0], ground: 0, planted } },
    grips: gripping ? { torch: { hand: "wristR", anchor: [0, 1, 0] } } : {},
  })
  const r = measureBodyMotion([frame(1, true, true), frame(1.1, true, true), frame(2, false, false), frame(3, true, true)], reference)
  expect(r.filter(x => x.metric === "grip").map(x => x.value)).toEqual([0, expect.closeTo(0.1), 0])
  expect(r.filter(x => x.metric === "foot-hover").every(x => x.value === 0)).toBe(true)
  expect(r.some(x => x.metric === "contact-snap" && x.joint === "ankleR")).toBe(true)
})

test("a single wrist pop is caught at each frame rate, including a hitch; the smooth control stays clean", () => {
  for (const fps of [30, 60, 144]) for (const hitch of [false, true]) {
    let t = 0
    const frames: MotionFrame[] = Array.from({ length: 16 }, (_, i) => {
      const dt = hitch && i === 8 ? 0.1 : 1 / fps
      t += dt
      return { dt, speed: 2, joints: { pelvis: [2 * t, 1, 0], hipL: [2 * t, 1, -0.1], kneeL: [2 * t, 0.5, -0.1], ankleL: [2 * t, 0, -0.1], wristL: [2 * t + 0.3, 1.2, -0.3] } }
    })
    const c = calibrateMotion([{ name: "analytic rigid translation", frames }])
    expect(checkBodyMotion(frames, c)).toEqual([])
    const popped = structuredClone(frames)
    popped[8]!.joints = { ...popped[8]!.joints, wristL: [popped[8]!.joints.wristL![0] + 0.2, 1.2, -0.3] }
    const v = checkBodyMotion(popped, c)
    for (const metric of ["velocity", "acceleration", "jerk"])
      expect(v.some(v => v.joint === "wristL" && v.metric === metric && v.frame === 8 && v.space === "pelvis")).toBe(true)
  }
})
