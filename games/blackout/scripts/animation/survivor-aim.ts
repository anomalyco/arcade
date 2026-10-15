import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  buildCycleFromJointFrames,
  compareCycles,
  computePoseAngles,
  extractBonePoseJoints,
  jointsFromAngles,
  POSE_JOINTS,
  RIG_SEGMENTS,
  type CycleComparison,
  type CycleData,
  type KeyPoseAngles,
  type RigJointMap,
} from "@arcade/kit/pose-diff"
import { attachment, poseArms } from "@arcade/kit/human-pose"
import { at, clamp, dot, HIP, len, norm, pitch, RIG, roll, sub, yawFrame, type Frame, type V3 } from "@arcade/kit/rig"
import { angleDiff } from "@arcade/kit/sim/geom"
import { PISTOL_FIRE_COOLDOWN, PISTOL_RELOAD_TIME } from "../../../outbreak/shared/combat"
import { PISTOL_HOLD, PISTOL_LOW_READY, PISTOL_MUZZLE, Survivor as OutbreakSurvivor } from "../../../outbreak/src/survivor"
import { parseArgs } from "./common"

const dt = 1 / 60
const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Build a biomechanical reference cycle for two-handed pistol aim (walk or run) and low-ready walk,
 * combining Blackout soldier's proven weapon aim stance adapted to a two-handed Weaver/isosceles pistol
 * grip with Williams/mocap lower-body gait keyframes.
 */
export function buildPistolReferenceCycle(variant: "aim-walk" | "aim-run" | "low-ready-walk" | "reload-walk"): CycleData {
  const walkLegs = [
    { hipFlex: 28, kneeFlex: 8, ankPitch: 10, bobCm: 0.2, shFlex: -24, shAbd: 11, elbFlex: 12 },
    { hipFlex: 20, kneeFlex: 22, ankPitch: 0, bobCm: -2.1, shFlex: -21, shAbd: 11, elbFlex: 10 },
    { hipFlex: 4, kneeFlex: 12, ankPitch: 2, bobCm: 0.0, shFlex: -4, shAbd: 9, elbFlex: 18 },
    { hipFlex: -12, kneeFlex: 10, ankPitch: -12, bobCm: 2.0, shFlex: 13, shAbd: 10, elbFlex: 28 },
    { hipFlex: -15, kneeFlex: 28, ankPitch: -16, bobCm: 0.2, shFlex: 22, shAbd: 11, elbFlex: 34 },
    { hipFlex: 2, kneeFlex: 62, ankPitch: -10, bobCm: -2.1, shFlex: 19, shAbd: 11, elbFlex: 35 },
    { hipFlex: 26, kneeFlex: 66, ankPitch: 6, bobCm: 0.0, shFlex: 4, shAbd: 9, elbFlex: 20 },
    { hipFlex: 31, kneeFlex: 24, ankPitch: 12, bobCm: 2.0, shFlex: -14, shAbd: 10, elbFlex: 13 },
  ]
  const runLegs = [
    { hipFlex: 34, kneeFlex: 26, ankPitch: 6, bobCm: -0.4, shFlex: -52, shAbd: 16, elbFlex: 88 },
    { hipFlex: 18, kneeFlex: 48, ankPitch: 10, bobCm: -3.0, shFlex: -32, shAbd: 14, elbFlex: 88 },
    { hipFlex: -24, kneeFlex: 18, ankPitch: -18, bobCm: 0.5, shFlex: 8, shAbd: 12, elbFlex: 102 },
    { hipFlex: -32, kneeFlex: 68, ankPitch: -14, bobCm: 2.8, shFlex: 24, shAbd: 14, elbFlex: 112 },
    { hipFlex: -14, kneeFlex: 108, ankPitch: -8, bobCm: -0.4, shFlex: 16, shAbd: 15, elbFlex: 106 },
    { hipFlex: 22, kneeFlex: 116, ankPitch: 2, bobCm: -3.0, shFlex: -10, shAbd: 14, elbFlex: 82 },
    { hipFlex: 46, kneeFlex: 82, ankPitch: 10, bobCm: 0.5, shFlex: -40, shAbd: 16, elbFlex: 82 },
    { hipFlex: 40, kneeFlex: 36, ankPitch: 8, bobCm: 2.8, shFlex: -54, shAbd: 16, elbFlex: 90 },
  ]
  // 8-phase reload key poses for left & right arms (0/8 tilt gun, 1/8 drop mag, 2/8 belt reach, 3/8 grab mag, 4/8 lift to well, 5/8 seat mag, 6/8 rack slide, 7/8 return)
  const reloadArms = [
    { shFlexL: 52, shAbdL: 17, elbFlexL: 79, inL: 56, shFlexR: 51, shAbdR: 26, elbFlexR: 65, inR: 55, pitchDeg: 3 },
    { shFlexL: 34, shAbdL: 18, elbFlexL: 88, inL: 48, shFlexR: 42, shAbdR: 25, elbFlexR: 82, inR: 58, pitchDeg: 14 },
    { shFlexL: -10, shAbdL: 16, elbFlexL: 42, inL: 18, shFlexR: 38, shAbdR: 24, elbFlexR: 86, inR: 60, pitchDeg: 15 },
    { shFlexL: -8, shAbdL: 16, elbFlexL: 44, inL: 20, shFlexR: 38, shAbdR: 24, elbFlexR: 86, inR: 60, pitchDeg: 15 },
    { shFlexL: 20, shAbdL: 18, elbFlexL: 94, inL: 48, shFlexR: 40, shAbdR: 25, elbFlexR: 84, inR: 58, pitchDeg: 14 },
    { shFlexL: 38, shAbdL: 18, elbFlexL: 96, inL: 54, shFlexR: 44, shAbdR: 25, elbFlexR: 78, inR: 56, pitchDeg: 8 },
    { shFlexL: 44, shAbdL: 19, elbFlexL: 98, inL: 56, shFlexR: 46, shAbdR: 25, elbFlexR: 76, inR: 56, pitchDeg: 3 },
    { shFlexL: 52, shAbdL: 17, elbFlexL: 79, inL: 56, shFlexR: 51, shAbdR: 26, elbFlexR: 65, inR: 55, pitchDeg: 0 },
  ]

  const isRun = variant === "aim-run"
  const src = isRun ? runLegs : walkLegs
  const trunkPitch = isRun ? 11.5 : 4.2
  const denseN = 64
  const frames: RigJointMap[] = []

  for (let i = 0; i < denseN; i++) {
    const u = (i / denseN) * 8
    const sampleLeg = (fn: (row: (typeof src)[number]) => number, offset = 0) => {
      const pos = (u + offset) % 8
      const i0 = Math.floor(pos)
      const i1 = (i0 + 1) % 8
      const iPrev = (i0 + 7) % 8
      const iNext = (i1 + 1) % 8
      const t = pos - i0
      const p0 = fn(src[iPrev]!), p1 = fn(src[i0]!), p2 = fn(src[i1]!), p3 = fn(src[iNext]!)
      const t2 = t * t, t3 = t2 * t
      return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }
    const sampleReload = (fn: (row: (typeof reloadArms)[number]) => number) => {
      const pos = u % 8
      const i0 = Math.floor(pos)
      const i1 = (i0 + 1) % 8
      const t = pos - i0
      const s = t * t * (3 - 2 * t)
      return fn(reloadArms[i0]!) * (1 - s) + fn(reloadArms[i1]!) * s
    }

    const bobCm = sampleLeg(r => r.bobCm, 0)
    let keyAngles: KeyPoseAngles
    if (variant === "aim-walk" || variant === "aim-run") {
      // Two-handed Weaver/isosceles pistol aim at shoulder height with bladed chest (+13.5 deg):
      // Elbows bend downward and slightly outward (shAbdL +17 deg, shAbdR +26 deg) while forearms angle inward (+56 deg) to meet on the pistol grip.
      keyAngles = {
        trunkPitchDeg: trunkPitch,
        chestYawDeg: 13.5,
        pelvisBobCm: bobCm,
        shoulderFlexL: isRun ? 55 : 53,
        shoulderFlexR: isRun ? 53 : 51,
        shoulderAbdL: 17,
        shoulderAbdR: 26,
        elbowFlexL: 79,
        elbowFlexR: 65,
        forearmInwardL: 56,
        forearmInwardR: 55,
        hipFlexL: sampleLeg(r => r.hipFlex, 0),
        hipFlexR: sampleLeg(r => r.hipFlex, 4),
        kneeFlexL: sampleLeg(r => r.kneeFlex, 0),
        kneeFlexR: sampleLeg(r => r.kneeFlex, 4),
        anklePitchL: sampleLeg(r => r.ankPitch, 0),
        anklePitchR: sampleLeg(r => r.ankPitch, 4),
      }
    } else if (variant === "low-ready-walk") {
      // Low ready: right hand holds pistol forward/down in front of right ribcage; left arm swings naturally
      const rWave = Math.sin((i / denseN) * Math.PI * 2)
      keyAngles = {
        trunkPitchDeg: trunkPitch,
        chestYawDeg: 4.0,
        pelvisBobCm: bobCm,
        shoulderFlexL: sampleLeg(r => r.shFlex, 0),
        shoulderFlexR: 10 + 3 * rWave,
        shoulderAbdL: sampleLeg(r => r.shAbd, 0),
        shoulderAbdR: 16,
        elbowFlexL: sampleLeg(r => r.elbFlex, 0),
        elbowFlexR: 86 + 3 * rWave,
        forearmInwardL: 6,
        forearmInwardR: 18,
        hipFlexL: sampleLeg(r => r.hipFlex, 0),
        hipFlexR: sampleLeg(r => r.hipFlex, 4),
        kneeFlexL: sampleLeg(r => r.kneeFlex, 0),
        kneeFlexR: sampleLeg(r => r.kneeFlex, 4),
        anklePitchL: sampleLeg(r => r.ankPitch, 0),
        anklePitchR: sampleLeg(r => r.ankPitch, 4),
      }
    } else {
      keyAngles = {
        trunkPitchDeg: trunkPitch + 3,
        chestYawDeg: 10.0,
        pelvisBobCm: bobCm,
        shoulderFlexL: sampleReload(r => r.shFlexL),
        shoulderFlexR: sampleReload(r => r.shFlexR),
        shoulderAbdL: sampleReload(r => r.shAbdL),
        shoulderAbdR: sampleReload(r => r.shAbdR),
        elbowFlexL: sampleReload(r => r.elbFlexL),
        elbowFlexR: sampleReload(r => r.elbFlexR),
        forearmInwardL: sampleReload(r => r.inL),
        forearmInwardR: sampleReload(r => r.inR),
        hipFlexL: sampleLeg(r => r.hipFlex, 0),
        hipFlexR: sampleLeg(r => r.hipFlex, 4),
        kneeFlexL: sampleLeg(r => r.kneeFlex, 0),
        kneeFlexR: sampleLeg(r => r.kneeFlex, 4),
        anklePitchL: sampleLeg(r => r.ankPitch, 0),
        anklePitchR: sampleLeg(r => r.ankPitch, 4),
      }
    }

    const j = jointsFromAngles(keyAngles)
    const refTorso = pitch(
      yawFrame(j.waist, keyAngles.chestYawDeg ? keyAngles.chestYawDeg * RAD : 0),
      -keyAngles.trunkPitchDeg * RAD,
    )
    if (variant === "aim-walk" || variant === "aim-run") {
      const shCenter = at(refTorso, 0, RIG.shoulderY, 0)
      const holdFwd = PISTOL_HOLD.fwd - (isRun ? 0.02 : 0)
      const gripPos: V3 = [shCenter[0] + holdFwd, shCenter[1] + PISTOL_HOLD.up - (HIP + RIG.waist + RIG.shoulderY), PISTOL_HOLD.side]
      const gunF = yawFrame(gripPos, 0)
      const handR = at(gunF, 0, -0.035, 0)
      const handL = at(gunF, 0.025, -0.04, -0.022)
      const posed = poseArms(refTorso, handL, handR)
      j.shoulderL = [...posed.ua[0].p] as V3
      j.elbowL = [...posed.fa[0].p] as V3
      j.wristL = at(posed.fa[0], 0, -RIG.fore, 0)
      j.shoulderR = [...posed.ua[1].p] as V3
      j.elbowR = [...posed.fa[1].p] as V3
      j.wristR = at(posed.fa[1], 0, -RIG.fore, 0)
      j.gunGrip = at(gunF, 0, 0.03, 0)
      j.gunMuzzle = at(gunF, PISTOL_MUZZLE, 0.03, 0)
    } else if (variant === "low-ready-walk") {
      const shCenter = at(refTorso, 0, RIG.shoulderY, 0)
      const rWave = Math.sin((i / denseN) * Math.PI * 2)
      const gripPos: V3 = [
        shCenter[0] + PISTOL_LOW_READY.fwd + 0.008 * rWave,
        shCenter[1] + PISTOL_LOW_READY.up - (HIP + RIG.waist + RIG.shoulderY),
        PISTOL_LOW_READY.side,
      ]
      const gunF = roll(pitch(yawFrame(gripPos, -0.08), -0.48 + 0.03 * rWave), 0.16)
      const handR = at(gunF, 0, -0.035, 0)
      const posedR = poseArms(refTorso, j.wristL, handR)
      j.shoulderR = [...posedR.ua[1].p] as V3
      j.elbowR = [...posedR.fa[1].p] as V3
      j.wristR = at(posedR.fa[1], 0, -RIG.fore, 0)
      j.gunGrip = at(gunF, 0, 0.03, 0)
      j.gunMuzzle = at(gunF, PISTOL_MUZZLE, 0.03, 0)
    } else {
      const grip: V3 = [j.wristR[0], j.wristR[1] + 0.035, j.wristR[2]]
      const pRad = sampleReload(r => r.pitchDeg) * RAD
      j.gunGrip = grip
      j.gunMuzzle = [grip[0] + Math.cos(pRad) * PISTOL_MUZZLE, grip[1] + 0.03 + Math.sin(pRad) * PISTOL_MUZZLE, grip[2]]
    }
    frames.push(j)
  }

  const speed = isRun ? 4.2 : 1.4
  const dur = variant === "reload-walk" ? PISTOL_RELOAD_TIME : isRun ? 0.50 : 0.82
  return buildCycleFromJointFrames(`ref-${variant}`, isRun ? "run" : "walk", speed, dur, frames, 0)
}

function extractSurvivorJointsWithWeapon(
  s: OutbreakSurvivor,
  p: { x: number; y: number; aim: number; recoil?: number; reloadRemaining?: number },
  legacyBefore: boolean,
): { joints: RigJointMap; gunFrame: Frame; forearmAimErrDeg: number; muzzleAimErrDeg: number; wristGapCm: number; muzzleHeightCm: number } {
  const gunProp = !legacyBefore ? (s as unknown as { gun?: Frame | null }).gun : null
  const j = extractBonePoseJoints(s.bones)
  let gunFrame: Frame
  if (gunProp) {
    gunFrame = gunProp
    j.gunGrip = at(gunFrame, 0, 0.03, 0)
    j.gunMuzzle = at(gunFrame, PISTOL_MUZZLE, 0.03, 0)
  } else {
    // Legacy before behavior: OutbreakCombatFX placed pistol at right.hand + [0, 0.04, 0], while right.foreArm hung down
    const hand = attachment(s.bones, "right.hand")
    const grip: V3 = hand ? [hand.p[0], hand.p[1] + 0.04, hand.p[2]] : [p.x + Math.cos(p.aim) * 0.32, 1.18, p.y + Math.sin(p.aim) * 0.32]
    const fa = s.bones["right.foreArm"]!
    const faDir: V3 = [-fa.y[0], -fa.y[1], -fa.y[2]]
    gunFrame = { p: grip, x: faDir, y: fa.x, z: fa.z }
    j.gunGrip = grip
    j.gunMuzzle = [grip[0] + faDir[0] * PISTOL_MUZZLE, grip[1] + faDir[1] * PISTOL_MUZZLE, grip[2] + faDir[2] * PISTOL_MUZZLE]
  }

  const aimVec: V3 = [Math.cos(p.aim), 0, Math.sin(p.aim)]
  const fa = s.bones["right.foreArm"]!
  const faDir = norm([-fa.y[0], -fa.y[1], -fa.y[2]])
  const forearmAimErrDeg = Math.acos(clamp(dot(faDir, aimVec), -1, 1)) * DEG
  const barrelDir = norm(sub(j.gunMuzzle!, j.gunGrip!))
  const muzzleAimErrDeg = Math.acos(clamp(dot(barrelDir, aimVec), -1, 1)) * DEG
  const wristGapCm = len(sub(j.wristL, j.wristR)) * 100
  const muzzleHeightCm = j.gunMuzzle![1] * 100

  return { joints: j, gunFrame, forearmAimErrDeg, muzzleAimErrDeg, wristGapCm, muzzleHeightCm }
}

function sampleSurvivorCycle(
  name: string,
  mode: "walk" | "run",
  speed: number,
  stance: "aim" | "low-ready" | "reload",
  legacyBefore: boolean,
): CycleData {
  const s = new OutbreakSurvivor({ addModel: () => 0 })
  const totalFrames = 420
  const warmupFrames = 180
  let x = 0
  const y = 0
  let prevPlantedL = true
  const touchdownsL: number[] = []
  const jointHistory: RigJointMap[] = []

  for (let n = 0; n < totalFrames; n++) {
    const t = n * dt
    x += speed * dt
    const isFiring = stance === "aim" && (n === 60 || n === 150)
    const reloadRem =
      stance === "reload" && n >= warmupFrames
        ? Math.max(0.001, PISTOL_RELOAD_TIME * (1 - (((n - warmupFrames) * dt) % PISTOL_RELOAD_TIME) / PISTOL_RELOAD_TIME))
        : 0
    const p = {
      x,
      y,
      vx: speed,
      vy: 0,
      aim: 0,
      equippedItem: (legacyBefore ? "hands" : "pistol") as "pistol" | "hands",
      fireCooldown: isFiring ? PISTOL_FIRE_COOLDOWN : 0,
      recoil: isFiring ? 1.0 : 0,
      reloadRemaining: reloadRem,
      aiming: (stance === "aim" || (stance === "reload" && n < warmupFrames)) && !legacyBefore,
    }
    s.draw(p as any, dt, t, () => 0)
    const { joints } = extractSurvivorJointsWithWeapon(s, p, legacyBefore)
    const fts = (s as unknown as { feet: { planted: boolean }[] }).feet
    const plantedL = fts[0]!.planted
    if (n >= warmupFrames && !prevPlantedL && plantedL) {
      touchdownsL.push(n)
    }
    prevPlantedL = plantedL
    jointHistory.push(joints)
  }

  if (stance === "reload") {
    const reloadFrames = Math.round(PISTOL_RELOAD_TIME / dt)
    const slice = jointHistory.slice(warmupFrames, warmupFrames + reloadFrames)
    return buildCycleFromJointFrames(name, mode, speed, PISTOL_RELOAD_TIME, slice, 0)
  }

  const fStart = touchdownsL[1] ?? touchdownsL[0] ?? warmupFrames
  const fEnd = touchdownsL[2] ?? touchdownsL[1] ?? fStart + (mode === "walk" ? 48 : 30)
  const cycleSlice = jointHistory.slice(fStart, Math.max(fStart + 8, fEnd))
  const dur = cycleSlice.length * dt
  return buildCycleFromJointFrames(name, mode, speed, dur, cycleSlice, 0)
}

function measureLifecycleAndRecoil(legacyBefore: boolean) {
  const s = new OutbreakSurvivor({ addModel: () => 0 })
  const series: {
    t: number
    aimWeight: number
    muzzleHeightCm: number
    muzzlePitchDeg: number
    muzzleErrorDeg: number
    forearmErrorDeg: number
    wristGapCm: number
    elbowFlexR: number
    elbowFlexL: number
    recoilBackCm: number
    torsoKickDeg: number
  }[] = []

  // Phase 1: 0..1.0s low-ready walk warmup (1.4 m/s) -> stop at t=0.6s
  // Phase 2: t=1.00s..3.50s continuous raised aim (first shot at t=1.00s, second shot at t=1.40s, hold until t=1.40 + 2.50 = 3.90s)
  // Phase 3: t=3.90s..4.80s ease back to low ready
  let x = 0
  let recoil = 0
  let fireCooldown = 0
  const shot1Frame = 60 // t = 1.00s
  const shot2Frame = 96 // t = 1.60s
  const totalFrames = 300 // 5.00s

  for (let n = 0; n < totalFrames; n++) {
    const t = n * dt
    const vx = n < 36 ? 1.4 : 0
    x += vx * dt
    if (n === shot1Frame || n === shot2Frame) {
      recoil = 1.0
      fireCooldown = PISTOL_FIRE_COOLDOWN
    } else {
      recoil = Math.max(0, recoil - dt * 5.5)
      fireCooldown = Math.max(0, fireCooldown - dt)
    }

    const p = {
      x,
      y: 0,
      vx,
      vy: 0,
      aim: 0,
      equippedItem: (legacyBefore ? "hands" : "pistol") as "pistol" | "hands",
      fireCooldown,
      recoil,
      reloadRemaining: 0,
    }
    s.draw(p as any, dt, t, () => 0)
    const { joints, gunFrame, forearmAimErrDeg, muzzleAimErrDeg, wristGapCm, muzzleHeightCm } =
      extractSurvivorJointsWithWeapon(s, p, legacyBefore)
    const angles = computePoseAngles(joints, 0, HIP, joints.pelvis[1])
    const aimWeight = legacyBefore ? 0 : ((s as unknown as { aimWeight?: number }).aimWeight ?? 0)
    const recBackCm = legacyBefore ? 0 : ((s as unknown as { recBack?: { x: number } }).recBack?.x ?? 0) * 100
    const torsoKickDeg = legacyBefore ? 0 : (((s as unknown as { torsoKick?: { x: number } }).torsoKick?.x ?? 0) * DEG)
    const barrelDir = norm(sub(joints.gunMuzzle!, joints.gunGrip!))
    const muzzlePitchDeg = Math.asin(clamp(barrelDir[1], -1, 1)) * DEG

    void gunFrame
    series.push({
      t: r3(t),
      aimWeight: r3(aimWeight),
      muzzleHeightCm: r2(muzzleHeightCm),
      muzzlePitchDeg: r2(muzzlePitchDeg),
      muzzleErrorDeg: r2(muzzleAimErrDeg),
      forearmErrorDeg: r2(forearmAimErrDeg),
      wristGapCm: r2(wristGapCm),
      elbowFlexR: r2(angles.elbowFlexR),
      elbowFlexL: r2(angles.elbowFlexL),
      recoilBackCm: r2(recBackCm),
      torsoKickDeg: r2(torsoKickDeg),
    })
  }

  // Also measure pure raise-to-aim response (without recoil climb superimposed) to get clean raise time & settle
  const sRaise = new OutbreakSurvivor({ addModel: () => 0 })
  for (let n = 0; n < 60; n++) {
    sRaise.draw({ x: 0, y: 0, vx: 0, vy: 0, aim: 0, equippedItem: legacyBefore ? "hands" : "pistol" } as any, dt, n * dt, () => 0)
  }
  const baseMuzzleH = extractSurvivorJointsWithWeapon(sRaise, { x: 0, y: 0, aim: 0 }, legacyBefore).muzzleHeightCm
  let t90Ms: number | null = null
  let t95Ms: number | null = null
  let minMuzzleH = baseMuzzleH
  let maxAimW = 0
  for (let n = 1; n <= 60; n++) {
    sRaise.draw(
      {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        aim: 0,
        equippedItem: legacyBefore ? "hands" : "pistol",
        aiming: !legacyBefore,
      } as any,
      dt,
      (60 + n) * dt,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      () => 0,
    )
    const aw = legacyBefore ? 0 : ((sRaise as unknown as { aimWeight?: number }).aimWeight ?? 0)
    const mh = extractSurvivorJointsWithWeapon(sRaise, { x: 0, y: 0, aim: 0 }, legacyBefore).muzzleHeightCm
    if (n <= 12) minMuzzleH = Math.min(minMuzzleH, mh)
    maxAimW = Math.max(maxAimW, aw)
    if (t90Ms === null && aw >= 0.90) t90Ms = r2(n * dt * 1000)
    if (t95Ms === null && aw >= 0.95) t95Ms = r2(n * dt * 1000)
  }

  // Measure hold duration after shot2Frame (t = 1.60s)
  const lastShotT = shot2Frame * dt
  let holdEndT = lastShotT
  let lowerEndT = lastShotT
  for (let n = shot2Frame + 1; n < totalFrames; n++) {
    if (series[n]!.aimWeight >= 0.90) holdEndT = series[n]!.t
    if (series[n]!.aimWeight >= 0.10) lowerEndT = series[n]!.t
  }

  // Measure single-shot recoil curve from already-raised aim (shot2 at n = shot2Frame, with pre-shot baseline at shot2Frame - 1)
  const baseElbowR = series[shot2Frame - 1]!.elbowFlexR
  const recoilSlice = series.slice(shot2Frame - 1, shot2Frame + 24)
  const peakPitchDeg = Math.max(...recoilSlice.map(r => r.muzzlePitchDeg))
  const peakIdx = recoilSlice.findIndex(r => r.muzzlePitchDeg === peakPitchDeg)
  const timeToPeakMs = r2(peakIdx * dt * 1000)
  const peakBackCm = Math.max(...recoilSlice.map(r => r.recoilBackCm))
  const peakElbowAbsorbDeg = r2(Math.max(...recoilSlice.map(r => Math.abs(r.elbowFlexR - baseElbowR))))
  const peakTorsoKickDeg = Math.max(...recoilSlice.map(r => r.torsoKickDeg))
  let recovery90Ms = 240
  for (let k = peakIdx + 1; k < recoilSlice.length; k++) {
    if (Math.abs(recoilSlice[k]!.muzzlePitchDeg) <= Math.max(0.8, peakPitchDeg * 0.12)) {
      recovery90Ms = r2(k * dt * 1000)
      break
    }
  }

  return {
    raiseTimeTo90Ms: t90Ms ?? 9999,
    raiseTimeTo95Ms: t95Ms ?? 9999,
    anticipationDipMm: r2(Math.max(0, (baseMuzzleH - minMuzzleH) * 10)),
    settleOvershootPct: r2(Math.max(0, (maxAimW - 1) * 100)),
    holdDurationSec: r2(holdEndT - lastShotT),
    lowerDurationSec: r2(Math.max(0, lowerEndT - holdEndT)),
    recoil: {
      peakPitchDeg: r2(peakPitchDeg),
      timeToPeakMs,
      peakBackCm: r2(peakBackCm),
      peakElbowAbsorbDeg,
      peakTorsoKickDeg: r2(peakTorsoKickDeg),
      recovery90Ms,
    },
    series,
  }
}

function measureLocomotionModes(legacyBefore: boolean) {
  const modes = [
    { name: "idle", vx: 0, vy: 0, aim: 0 },
    { name: "walk", vx: 1.4, vy: 0, aim: 0 },
    { name: "run", vx: 4.2, vy: 0, aim: 0 },
    { name: "strafe", vx: 0, vy: 3.4, aim: 0 },
    { name: "backpedal", vx: -2.8, vy: 0, aim: 0 },
  ] as const

  const out: Record<
    string,
    {
      muzzleAngleErrMeanDeg: number
      muzzleAngleErrMaxDeg: number
      forearmAimErrMeanDeg: number
      muzzleHeightMeanCm: number
      wristGripGapCm: number
      torsoTwistMeanDeg: number
      maxPlantedToeSlipM: number
    }
  > = {}

  for (const m of modes) {
    const s = new OutbreakSurvivor({ addModel: () => 0 })
    let x = 0, y = 0
    const warmup = 120
    const count = 180
    let prevPlanted: [boolean, boolean] = [true, true]
    let prevToes: [V3, V3] | null = null
    let maxPlantedToeSlipM = 0
    const muzzleErrs: number[] = []
    const forearmErrs: number[] = []
    const heights: number[] = []
    const gaps: number[] = []
    const twists: number[] = []

    for (let n = 0; n < warmup + count; n++) {
      const t = n * dt
      x += m.vx * dt
      y += m.vy * dt
      const p = {
        x,
        y,
        vx: m.vx,
        vy: m.vy,
        aim: m.aim,
        equippedItem: (legacyBefore ? "hands" : "pistol") as "pistol" | "hands",
        fireCooldown: n === 10 ? PISTOL_FIRE_COOLDOWN : 0,
        recoil: n === 10 ? 1.0 : 0,
        reloadRemaining: 0,
        aiming: !legacyBefore,
      }
      s.draw(p as any, dt, t, () => 0)
      const fts = (s as unknown as { feet: { planted: boolean }[] }).feet
      const curPlanted: [boolean, boolean] = [fts[0]!.planted, fts[1]!.planted]
      const toes: [V3, V3] = [
        s.bones["left.toe"] ? [...s.bones["left.toe"]!.p] : at(s.bones["left.foot"]!, RIG.foot, -RIG.ankle, 0),
        s.bones["right.toe"] ? [...s.bones["right.toe"]!.p] : at(s.bones["right.foot"]!, RIG.foot, -RIG.ankle, 0),
      ]
      if (n >= warmup) {
        for (const i of [0, 1] as const) {
          if (prevPlanted[i] && curPlanted[i] && prevToes) {
            const slip = len(sub(toes[i], prevToes[i]))
            maxPlantedToeSlipM = Math.max(maxPlantedToeSlipM, slip)
          }
        }
        const ext = extractSurvivorJointsWithWeapon(s, p, legacyBefore)
        muzzleErrs.push(ext.muzzleAimErrDeg)
        forearmErrs.push(ext.forearmAimErrDeg)
        heights.push(ext.muzzleHeightCm)
        gaps.push(ext.wristGapCm)
        const pelYaw = Math.atan2(s.bones.pelvis!.x[2], s.bones.pelvis!.x[0])
        const torYaw = Math.atan2(s.bones.torso!.x[2], s.bones.torso!.x[0])
        twists.push(Math.abs(angleDiff(torYaw, pelYaw)) * DEG)
      }
      prevPlanted = curPlanted
      prevToes = toes
    }

    const avg = (a: number[]) => a.reduce((acc, v) => acc + v, 0) / Math.max(1, a.length)
    out[m.name] = {
      muzzleAngleErrMeanDeg: r2(avg(muzzleErrs)),
      muzzleAngleErrMaxDeg: r2(Math.max(...muzzleErrs)),
      forearmAimErrMeanDeg: r2(avg(forearmErrs)),
      muzzleHeightMeanCm: r2(avg(heights)),
      wristGripGapCm: r2(avg(gaps)),
      torsoTwistMeanDeg: r2(avg(twists)),
      maxPlantedToeSlipM,
    }
  }
  return out
}

function measureReloadKinematics(legacyBefore: boolean) {
  const s = new OutbreakSurvivor({ addModel: () => 0 })
  for (let n = 0; n < 60; n++) {
    s.draw({ x: 0, y: 0, vx: 0, vy: 0, aim: 0, equippedItem: legacyBefore ? "hands" : "pistol", aiming: !legacyBefore } as any, dt, n * dt, () => 0)
  }
  let minHandToHipCm = Infinity
  let minHandToGripWellCm = Infinity
  let maxGunRollDeg = 0
  let maxHeadLookDownDeg = 0
  const steps = Math.round(PISTOL_RELOAD_TIME / dt)
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    const rem = Math.max(0.001, PISTOL_RELOAD_TIME * (1 - u))
    const p = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: 0,
      equippedItem: (legacyBefore ? "hands" : "pistol") as "pistol" | "hands",
      reloadRemaining: rem,
    }
    s.draw(p as any, dt, (60 + i) * dt, () => 0)
    const { joints, gunFrame } = extractSurvivorJointsWithWeapon(s, p, legacyBefore)
    const hipL = joints.hipL
    const gripWell: V3 = [gunFrame.p[0], gunFrame.p[1] - 0.05, gunFrame.p[2]]
    if (u >= 0.20 && u <= 0.48) {
      minHandToHipCm = Math.min(minHandToHipCm, len(sub(joints.wristL, hipL)) * 100)
    }
    if (u >= 0.52 && u <= 0.72) {
      minHandToGripWellCm = Math.min(minHandToGripWellCm, len(sub(joints.wristL, gripWell)) * 100)
    }
    const rollDeg = Math.abs(Math.atan2(-gunFrame.z[1], gunFrame.y[1])) * DEG
    maxGunRollDeg = Math.max(maxGunRollDeg, rollDeg)
    const headPitchDeg = -Math.asin(clamp(s.bones.head!.x[1], -1, 1)) * DEG
    maxHeadLookDownDeg = Math.max(maxHeadLookDownDeg, headPitchDeg)
  }
  return {
    minHandToHipCm: r2(minHandToHipCm),
    minHandToGripWellCm: r2(minHandToGripWellCm),
    maxGunRollDeg: r2(maxGunRollDeg),
    maxHeadLookDownDeg: r2(maxHeadLookDownDeg),
  }
}

const { tag, out: outDir, flags } = parseArgs(process.argv.slice(2), {
  tag: "after",
  out: "survivor-aim",
})
mkdirSync(outDir, { recursive: true })

const references = {
  pistolAimWalkRef: buildPistolReferenceCycle("aim-walk"),
  pistolAimRunRef: buildPistolReferenceCycle("aim-run"),
  pistolLowReadyWalkRef: buildPistolReferenceCycle("low-ready-walk"),
  pistolReloadWalkRef: buildPistolReferenceCycle("reload-walk"),
}

function runPass(passTag: string, legacyBefore: boolean, render: boolean) {
  const cycles = {
    outbreakAimWalk: sampleSurvivorCycle("outbreak-aim-walk", "walk", 1.4, "aim", legacyBefore),
    outbreakAimRun: sampleSurvivorCycle("outbreak-aim-run", "run", 4.2, "aim", legacyBefore),
    outbreakLowReadyWalk: sampleSurvivorCycle("outbreak-low-ready-walk", "walk", 1.4, "low-ready", legacyBefore),
    outbreakReloadWalk: sampleSurvivorCycle("outbreak-reload-walk", "walk", 1.4, "reload", legacyBefore),
  }

  const comparisons: Record<string, CycleComparison> = {
    aimWalkVsRef: compareCycles(cycles.outbreakAimWalk, references.pistolAimWalkRef),
    aimRunVsRef: compareCycles(cycles.outbreakAimRun, references.pistolAimRunRef),
    lowReadyWalkVsRef: compareCycles(cycles.outbreakLowReadyWalk, references.pistolLowReadyWalkRef),
    reloadWalkVsRef: compareCycles(cycles.outbreakReloadWalk, references.pistolReloadWalkRef),
  }

  const lifecycle = measureLifecycleAndRecoil(legacyBefore)
  const locomotionModes = measureLocomotionModes(legacyBefore)
  const reloadKinematics = measureReloadKinematics(legacyBefore)

  const payload = {
    tag: passTag,
    timestamp: new Date().toISOString(),
    joints: POSE_JOINTS,
    segments: RIG_SEGMENTS,
    references,
    cycles,
    comparisons,
    lifecycle,
    locomotionModes,
    reloadKinematics,
  }

  const jsonPath = join(outDir, `survivor-aim-${passTag}.json`)
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2))

  console.log(`\n=== Survivor Aim Audit (${passTag}) ===`)
  console.log(
    `Lifecycle: raise90=${lifecycle.raiseTimeTo90Ms}ms raise95=${lifecycle.raiseTimeTo95Ms}ms dip=${lifecycle.anticipationDipMm}mm settle=${lifecycle.settleOvershootPct}% hold=${lifecycle.holdDurationSec}s lower=${lifecycle.lowerDurationSec}s`,
  )
  console.log(
    `Recoil: peakPitch=${lifecycle.recoil.peakPitchDeg}° @ ${lifecycle.recoil.timeToPeakMs}ms | peakBack=${lifecycle.recoil.peakBackCm}cm | elbowAbsorb=${lifecycle.recoil.peakElbowAbsorbDeg}° | torsoKick=${lifecycle.recoil.peakTorsoKickDeg}° | rec90=${lifecycle.recoil.recovery90Ms}ms`,
  )
  console.log(
    `Reload: handToHip=${reloadKinematics.minHandToHipCm}cm | handToWell=${reloadKinematics.minHandToGripWellCm}cm | gunRoll=${reloadKinematics.maxGunRollDeg}° | headLookDown=${reloadKinematics.maxHeadLookDownDeg}°`,
  )
  for (const [m, stats] of Object.entries(locomotionModes)) {
    console.log(
      `  Mode [${m}]: muzzleErr=${stats.muzzleAngleErrMeanDeg}° (max ${stats.muzzleAngleErrMaxDeg}°) | forearmErr=${stats.forearmAimErrMeanDeg}° | muzzleH=${stats.muzzleHeightMeanCm}cm | wristGap=${stats.wristGripGapCm}cm | twist=${stats.torsoTwistMeanDeg}° | toeSlip=${stats.maxPlantedToeSlipM}`,
    )
  }
  for (const [k, c] of Object.entries(comparisons)) {
    console.log(
      `  PoseDiff [${k}]: OverallRMSE=${c.angleRmseDeg.overallAngleRmse}° | ArmRMSE=${c.angleRmseDeg.meanArmAngleRmse}° (sh=${c.angleRmseDeg.shoulderFlex}° abd=${c.angleRmseDeg.shoulderAbd}° elb=${c.angleRmseDeg.elbowFlex}° fa=${c.angleRmseDeg.forearmPitch}°) | LegRMSE=${c.angleRmseDeg.meanLegAngleRmse}°`,
    )
  }

  if (render && !flags.has("no-render")) {
    const py = spawnSync("python3", [join(import.meta.dir, "survivor-aim-render.py"), outDir, passTag], {
      stdio: "inherit",
    })
    if (py.status !== 0) process.exit(py.status ?? 1)
  }
}

if (tag === "before") {
  runPass("before", true, !flags.has("no-render"))
} else {
  runPass("before", true, false)
  runPass(tag, false, !flags.has("no-render"))
}
