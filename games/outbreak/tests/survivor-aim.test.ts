import { expect, test } from "bun:test"
import { extractBonePoseJoints } from "@arcade/kit/pose-diff"
import { at, clamp, dot, len, norm, RIG, sub, type V3 } from "@arcade/kit/rig"
import { angleDiff } from "@arcade/kit/sim/geom"
import { PISTOL_FIRE_COOLDOWN, PISTOL_RELOAD_TIME } from "../shared/combat"
import {
  PISTOL_MUZZLE,
  Survivor,
  survivorAimControls,
  survivorAimTuning,
} from "../src/survivor"

const dt = 1 / 60
const DEG = 180 / Math.PI

test("Survivor aim Lab controls cover raise time, hold time, recoil, twist limit and strafe", () => {
  expect(survivorAimControls.every(c => c.group === "Survivor aim" || c.group === "Survivor strafe")).toBe(true)
  expect(survivorAimControls.map(c => c.key).sort()).toEqual(Object.keys(survivorAimTuning).sort())
})

test("equipped pistol stays in visible low ready while idle and walking with free left-arm counter-swing", () => {
  const s = new Survivor({ addModel: () => 0 })
  let x = 0
  let maxLeftArmSwingX = -Infinity
  let minLeftArmSwingX = Infinity
  for (let n = 0; n < 120; n++) {
    x += 1.4 * dt
    const batches = s.draw(
      { x, y: 0, vx: 1.4, vy: 0, aim: 0, equippedItem: "pistol", fireCooldown: 0, recoil: 0, reloadRemaining: 0 },
      dt,
      n * dt,
      () => 0,
    )
    expect(batches).toHaveLength(16)
    expect(s.gun).not.toBeNull()
    expect(s.aimWeight).toBeLessThan(0.05)
    if (n >= 60) {
      const j = extractBonePoseJoints(s.bones)
      maxLeftArmSwingX = Math.max(maxLeftArmSwingX, j.wristL[0] - j.pelvis[0])
      minLeftArmSwingX = Math.min(minLeftArmSwingX, j.wristL[0] - j.pelvis[0])
      // Muzzle pitched downward/forward in low ready (~-20..-35 deg), held in front of right torso
      const pitchDeg = Math.asin(clamp(s.gun!.x[1], -1, 1)) * DEG
      expect(pitchDeg).toBeLessThan(-18)
      expect(pitchDeg).toBeGreaterThan(-38)
      expect(s.gun!.p[0] - j.pelvis[0]).toBeGreaterThan(0.20)
    }
  }
  expect(maxLeftArmSwingX - minLeftArmSwingX).toBeGreaterThan(0.18)
})

test("firing raises pistol in 0.12-0.18s without anticipation dip, aligns muzzle within 1 deg, kicks recoil and holds for holdTime", () => {
  const s = new Survivor({ addModel: () => 0 })
  // Settle in low ready
  for (let n = 0; n < 60; n++) {
    s.draw({ x: 0, y: 0, vx: 0, vy: 0, aim: 0.4, equippedItem: "pistol" }, dt, n * dt, () => 0)
  }
  const baseGunY = s.gun!.p[1]
  let minGunYDuringRaise = baseGunY
  let raise90Sec: number | null = null
  let maxAimWeight = 0

  // Trigger aim raise
  for (let n = 1; n <= 40; n++) {
    s.draw({ x: 0, y: 0, vx: 0, vy: 0, aim: 0.4, equippedItem: "pistol", aiming: true }, dt, (60 + n) * dt, () => 0)
    if (n <= 10) minGunYDuringRaise = Math.min(minGunYDuringRaise, s.gun!.p[1])
    maxAimWeight = Math.max(maxAimWeight, s.aimWeight)
    if (raise90Sec === null && s.aimWeight >= 0.90) raise90Sec = n * dt
  }
  expect(minGunYDuringRaise).toBeGreaterThanOrEqual(baseGunY - 1e-4)
  expect(raise90Sec).not.toBeNull()
  expect(raise90Sec!).toBeGreaterThanOrEqual(0.12)
  expect(raise90Sec!).toBeLessThanOrEqual(0.18)
  expect(maxAimWeight).toBeGreaterThan(1.005)
  expect(maxAimWeight).toBeLessThan(1.06)

  // Settled two-handed aim: check muzzle alignment and two-hand grip lock
  const aim = 0.4
  const aimVec: V3 = [Math.cos(aim), 0, Math.sin(aim)]
  const muzzleErrDeg = Math.acos(clamp(dot(s.gun!.x, aimVec), -1, 1)) * DEG
  expect(muzzleErrDeg).toBeLessThan(0.5)
  const jAim = extractBonePoseJoints(s.bones)
  const wristGapCm = len(sub(jAim.wristL, jAim.wristR)) * 100
  expect(wristGapCm).toBeLessThan(4.0)
  const muzzleWorld = at(s.gun!, PISTOL_MUZZLE, 0.03, 0)
  expect(muzzleWorld[1]).toBeGreaterThan(1.32)

  // Fire a shot and measure recoil climb, axial kick and hold duration (custom holdTime = 2.2s)
  let fireCooldown = PISTOL_FIRE_COOLDOWN
  let recoil = 1.0
  let peakClimbDeg = 0
  let peakBackM = 0
  let holdDuration = 0
  for (let n = 0; n < 200; n++) {
    const t = (100 + n) * dt
    s.draw(
      { x: 0, y: 0, vx: 0, vy: 0, aim, equippedItem: "pistol", fireCooldown, recoil },
      dt,
      t,
      () => 0,
      { aimHoldTime: 2.2 },
    )
    fireCooldown = Math.max(0, fireCooldown - dt)
    recoil = Math.max(0, recoil - dt * 5.5)
    const climbDeg = Math.asin(clamp(s.gun!.x[1], -1, 1)) * DEG
    peakClimbDeg = Math.max(peakClimbDeg, climbDeg)
    peakBackM = Math.max(peakBackM, s.recBack.x)
    if (s.aimWeight >= 0.90) holdDuration = (n + 1) * dt
  }
  expect(peakClimbDeg).toBeGreaterThan(8.0)
  expect(peakBackM).toBeGreaterThan(0.03)
  expect(holdDuration).toBeGreaterThan(2.1)
  expect(holdDuration).toBeLessThan(2.4)
  // After 200 frames (3.33s > 2.2s hold), gun has eased back to low ready
  expect(s.aimWeight).toBeLessThan(0.08)
})

test("reloading drives left hand from belt pouch to pistol grip well with visible magazine and head look-down", () => {
  const s = new Survivor({ addModel: () => 0 })
  for (let n = 0; n < 30; n++) {
    s.draw({ x: 0, y: 0, vx: 0, vy: 0, aim: 0, equippedItem: "pistol", aiming: true }, dt, n * dt, () => 0)
  }
  let minHipDist = Infinity
  let minWellDist = Infinity
  let sawMagBatch = false
  const steps = Math.round(PISTOL_RELOAD_TIME / dt)
  for (let i = 0; i <= steps; i++) {
    const rem = Math.max(0.001, PISTOL_RELOAD_TIME * (1 - i / steps))
    const batches = s.draw(
      { x: 0, y: 0, vx: 0, vy: 0, aim: 0, equippedItem: "pistol", reloadRemaining: rem },
      dt,
      (30 + i) * dt,
      () => 0,
    )
    if (batches.length === 17 && s.mag !== null) sawMagBatch = true
    const j = extractBonePoseJoints(s.bones)
    minHipDist = Math.min(minHipDist, len(sub(j.wristL, j.hipL)))
    const well: V3 = [s.gun!.p[0], s.gun!.p[1] - 0.05, s.gun!.p[2]]
    minWellDist = Math.min(minWellDist, len(sub(j.wristL, well)))
  }
  expect(sawMagBatch).toBe(true)
  expect(minHipDist).toBeLessThan(0.04)
  expect(minWellDist).toBeLessThan(0.05)
})

test("aiming while walking, running, strafing and backpedalling respects twist limit and keeps planted toes locked", () => {
  for (const [vx, vy, twistLim] of [
    [1.4, 0, 1.05],
    [4.2, 0, 1.05],
    [0, 3.4, 0.65],
    [-2.8, 0, 1.05],
  ] as const) {
    const s = new Survivor({ addModel: () => 0 })
    let x = 0, y = 0
    let prevPlanted: [boolean, boolean] = [true, true]
    let prevToes: [V3, V3] | null = null
    let maxToeSlip = 0
    for (let n = 0; n < 180; n++) {
      x += vx * dt
      y += vy * dt
      s.draw(
        { x, y, vx, vy, aim: 0, equippedItem: "pistol", aiming: true },
        dt,
        n * dt,
        () => 0,
        { aimTwistLimit: twistLim },
      )
      const fts = (s as unknown as { feet: { planted: boolean }[] }).feet
      const curPlanted: [boolean, boolean] = [fts[0]!.planted, fts[1]!.planted]
      const toes: [V3, V3] = [
        [...s.bones["left.toe"]!.p],
        [...s.bones["right.toe"]!.p],
      ]
      if (n >= 60) {
        for (const i of [0, 1] as const) {
          if (prevPlanted[i] && curPlanted[i] && prevToes) {
            maxToeSlip = Math.max(maxToeSlip, len(sub(toes[i], prevToes[i])))
          }
        }
        const muzzleErrDeg = Math.acos(clamp(s.gun!.x[0], -1, 1)) * DEG
        expect(muzzleErrDeg).toBeLessThan(0.5)
        const pelYaw = Math.atan2(s.bones.pelvis!.x[2], s.bones.pelvis!.x[0])
        const torYaw = Math.atan2(s.bones.torso!.x[2], s.bones.torso!.x[0])
        expect(Math.abs(angleDiff(torYaw, pelYaw))).toBeLessThan(twistLim + 0.38)
      }
      prevPlanted = curPlanted
      prevToes = toes
    }
    expect(maxToeSlip).toBeLessThan(1e-6)
  }
})

test("co-op remote survivor raises on snapshot recoil pulse and animates reload from boolean snapshot state", () => {
  const remote = new Survivor({ addModel: () => 0 })
  // Low ready
  for (let n = 0; n < 30; n++) {
    remote.draw({ x: 5, y: 5, vx: 0, vy: 0, aim: 0, equippedItem: "pistol", recoil: 0, reloadRemaining: 0 }, dt, n * dt, () => 0)
  }
  expect(remote.aimWeight).toBeLessThan(0.05)

  // Snapshot recoil pulse (no fireCooldown on RemoteSurvivor)
  let rec = 0.85
  for (let n = 0; n < 20; n++) {
    remote.draw({ x: 5, y: 5, vx: 0, vy: 0, aim: 0, equippedItem: "pistol", recoil: rec, reloadRemaining: 0 }, dt, (30 + n) * dt, () => 0)
    rec = Math.max(0, rec - dt * 5.5)
  }
  expect(remote.aimWeight).toBeGreaterThan(0.95)

  // Snapshot boolean reload (reloadRemaining fixed at 0.5 while reloading)
  let sawRemoteMag = false
  for (let n = 0; n < 60; n++) {
    remote.draw({ x: 5, y: 5, vx: 0, vy: 0, aim: 0, equippedItem: "pistol", recoil: 0, reloadRemaining: 0.5 }, dt, (50 + n) * dt, () => 0)
    if (remote.mag !== null) sawRemoteMag = true
  }
  expect(sawRemoteMag).toBe(true)
})
