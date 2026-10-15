import { at, clamp, HIP, norm, pitch, RIG, roll, smooth, sub, yawFrame, type Frame, type V3 } from "./rig"
import type { HumanProfile } from "./human-profile"
import {
  buildCycleFromJointFrames,
  retargetBvhFrame,
  type BvhClip,
  type CycleData,
  type KeyPoseAngles,
  type RigJointMap,
} from "./pose-diff"

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const TAU = Math.PI * 2
const r2 = (n: number) => Math.round(n * 100) / 100

export type ZombieVariant = "auto" | "limper" | "dragger" | "reacher" | "lunger"
export const ZOMBIE_VARIANTS: readonly Exclude<ZombieVariant, "auto">[] = ["limper", "dragger", "reacher", "lunger"]

export function zombieSeedHash(seed: number, channel: number): number {
  let h = Math.imul((Math.round(seed * 1000) | 0) ^ Math.imul(channel + 1, 0x9e3779b1), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1
}

export function resolveZombieVariant(
  variant: ZombieVariant | number | undefined,
  seed = 0,
): Exclude<ZombieVariant, "auto"> {
  if (variant === "limper" || variant === 1) return "limper"
  if (variant === "dragger" || variant === 2) return "dragger"
  if (variant === "reacher" || variant === 3) return "reacher"
  if (variant === "lunger" || variant === 4) return "lunger"
  if (seed === 0) return "dragger"
  const h = Math.imul(Math.round(seed * 997) ^ 0x9e3779b9, 0x85ebca6b)
  const idx = ((h ^ (h >>> 15)) >>> 0) % ZOMBIE_VARIANTS.length
  return ZOMBIE_VARIANTS[idx]!
}

/**
 * Returns which foot drags (0 = left, 1 = right).
 * Seed 0 defaults to 1 (right foot) so deterministic single-actor tests and reference sheets stay canonical;
 * non-zero crowd seeds mix left and right draggers so hordes never limp in lockstep.
 */
export function resolveDragFoot(seed = 0): 0 | 1 {
  if (seed === 0) return 1
  return zombieSeedHash(seed, 3) < -0.25 ? 0 : 1
}

export type ExtendedKeyPoseAngles = KeyPoseAngles & {
  torsoRollDeg?: number
  headPitchDeg?: number
  headRollDeg?: number
  /** Physical foot pitch relative to flat ground (deg, 0 = flat, + = toe up, - = toe down). */
  footWorldPitchL?: number
  footWorldPitchR?: number
}

/**
 * Construct a 3D RigJointMap from authored joint angles using exact RIG proportions,
 * including coronal torso roll, head lolling, and physical world foot pitch.
 */
export function jointsFromExtendedAngles(a: ExtendedKeyPoseAngles): RigJointMap {
  const pelY = HIP + a.pelvisBobCm * 0.01
  const pelvis: V3 = [0, pelY, 0]
  const trPitch = a.trunkPitchDeg * RAD
  const trRoll = (a.torsoRollDeg ?? 0) * RAD
  const pelRoll = (a.pelvisRollDeg ?? 0) * RAD
  const pelYaw = (a.pelvisYawDeg ?? 0) * RAD
  const chYaw = (a.chestYawDeg ?? 0) * RAD

  const pelFrame = roll(yawFrame(pelvis, pelYaw), pelRoll)
  const waist = at(pelFrame, 0, RIG.waist, 0)
  const torsoFrame = roll(pitch(yawFrame(waist, chYaw), -trPitch), trRoll)
  const chest = at(torsoFrame, 0, RIG.shoulderY, 0)
  const neck = at(torsoFrame, 0.02, RIG.neckY, 0)
  const hPitch = (a.headPitchDeg ?? -a.trunkPitchDeg * 0.55) * RAD
  const hRoll = (a.headRollDeg ?? 0) * RAD
  const headFrame = roll(pitch(torsoFrame, -hPitch), hRoll)
  const headTop = at(headFrame, 0, 0.26, 0)

  const buildArm = (
    side: -1 | 1,
    shFlexDeg: number,
    shAbdDeg: number,
    elbFlexDeg: number,
    inwardDeg = 6,
  ): [V3, V3, V3] => {
    const sh = at(torsoFrame, 0, RIG.shoulderY, side * RIG.shoulderW)
    const sf = shFlexDeg * RAD
    const sa = shAbdDeg * RAD
    // shFlexDeg and shAbdDeg are world-sagittal / coronal angles (matching computePoseAngles)
    const uaDir = norm([Math.sin(sf) * Math.cos(sa), -Math.cos(sf) * Math.cos(sa), side * Math.sin(sa)])
    const elbow: V3 = [
      sh[0] + uaDir[0] * RIG.upper,
      sh[1] + uaDir[1] * RIG.upper,
      sh[2] + uaDir[2] * RIG.upper,
    ]
    const ff = (shFlexDeg + elbFlexDeg) * RAD
    const faLat = sa - inwardDeg * RAD
    const faDir = norm([Math.sin(ff) * Math.cos(faLat), -Math.cos(ff) * Math.cos(faLat), side * Math.sin(faLat)])
    const wrist: V3 = [
      elbow[0] + faDir[0] * RIG.fore,
      elbow[1] + faDir[1] * RIG.fore,
      elbow[2] + faDir[2] * RIG.fore,
    ]
    return [sh, elbow, wrist]
  }

  const [shoulderL, elbowL, wristL] = buildArm(
    -1,
    a.shoulderFlexL,
    a.shoulderAbdL,
    a.elbowFlexL,
    a.forearmInwardL ?? 6,
  )
  const [shoulderR, elbowR, wristR] = buildArm(
    1,
    a.shoulderFlexR,
    a.shoulderAbdR,
    a.elbowFlexR,
    a.forearmInwardR ?? 6,
  )

  const buildLeg = (
    side: -1 | 1,
    hipFlexDeg: number,
    kneeFlexDeg: number,
    ankPitchDeg: number,
    worldFootPitchDeg?: number,
  ): [V3, V3, V3, V3, V3] => {
    const hip = at(pelFrame, 0, 0, side * RIG.hipW)
    const hf = hipFlexDeg * RAD
    const thDir: V3 = [Math.sin(hf), -Math.cos(hf), 0]
    const knee: V3 = [hip[0] + thDir[0] * RIG.thigh, hip[1] + thDir[1] * RIG.thigh, hip[2]]
    const sf = (hipFlexDeg - kneeFlexDeg) * RAD
    const shDir: V3 = [Math.sin(sf), -Math.cos(sf), 0]
    const ankle: V3 = [knee[0] + shDir[0] * RIG.shin, knee[1] + shDir[1] * RIG.shin, knee[2]]
    const baseFootAngle = Math.atan2(-RIG.ankle, RIG.foot)
    const worldFootPitch = sf + ankPitchDeg * RAD
    const footAngle = baseFootAngle + worldFootPitch
    const footLen = Math.hypot(RIG.foot, RIG.ankle)
    const ball: V3 = [
      ankle[0] + Math.cos(footAngle) * footLen,
      ankle[1] + Math.sin(footAngle) * footLen,
      ankle[2],
    ]
    const toeAngle = ball[1] <= 0.02 && worldFootPitch < 0 ? 0 : worldFootPitch
    const toe: V3 = [
      ball[0] + Math.cos(toeAngle) * RIG.toe,
      Math.max(0, ball[1] + Math.sin(toeAngle) * RIG.toe),
      ball[2],
    ]
    void worldFootPitchDeg
    return [hip, knee, ankle, ball, toe]
  }

  const [hipL, kneeL, ankleL, ballL, toeL] = buildLeg(
    -1,
    a.hipFlexL,
    a.kneeFlexL,
    a.anklePitchL,
    a.footWorldPitchL,
  )
  const [hipR, kneeR, ankleR, ballR, toeR] = buildLeg(
    1,
    a.hipFlexR,
    a.kneeFlexR,
    a.anklePitchR,
    a.footWorldPitchR,
  )

  return {
    pelvis,
    waist,
    chest,
    neck,
    headTop,
    shoulderL,
    elbowL,
    wristL,
    shoulderR,
    elbowR,
    wristR,
    hipL,
    kneeL,
    ankleL,
    ballL,
    toeL,
    hipR,
    kneeR,
    ankleR,
    ballR,
    toeR,
  }
}

/**
 * Extract one phase-aligned gait cycle (Left Heel Strike -> Left Heel Strike) from a BVH clip
 * WITHOUT symmetrizing L and R half-cycles, preserving limp, drag, and lateral asymmetry.
 */
export function extractAsymmetricBvhCycle(
  bvh: BvhClip,
  name: string,
  mode: "walk" | "run",
  searchStart = 15,
  searchEnd = 180,
): CycleData {
  const slice = bvh.frames.slice(searchStart, Math.min(searchEnd, bvh.frames.length))
  const lFwd = slice.map(p => p.Foot_L![0] - p.Hips![0])
  const minGap = mode === "walk" ? 20 : 12
  const peaks: number[] = []
  for (let i = 2; i < lFwd.length - 2; i++) {
    if (
      lFwd[i]! >= lFwd[i - 1]! &&
      lFwd[i]! >= lFwd[i + 1]! &&
      lFwd[i]! >= lFwd[i - 2]! &&
      lFwd[i]! >= lFwd[i + 2]! &&
      lFwd[i]! > 0.08
    ) {
      if (!peaks.length || i - peaks[peaks.length - 1]! >= minGap) peaks.push(i)
    }
  }
  const c0 = peaks[0] ?? 0
  const c1 = peaks[1] ?? slice.length - 1
  const cycleSlice = slice.slice(c0, c1)
  const minFootY = Math.min(
    ...cycleSlice.map(p => Math.min(p.Foot_L![1], p.Foot_R![1], p.Toes_L![1], p.Toes_R![1])),
  )
  const meanPelvisY = cycleSlice.reduce((s, p) => s + p.Hips![1], 0) / cycleSlice.length
  const dur = cycleSlice.length * bvh.dt
  const dist = Math.hypot(
    slice[c1]!.Hips![0] - slice[c0]!.Hips![0],
    slice[c1]!.Hips![2] - slice[c0]!.Hips![2],
  )
  const speed = r2(dist / Math.max(0.1, dur))
  const retargeted = cycleSlice.map(p => retargetBvhFrame(p, meanPelvisY, minFootY))
  return buildCycleFromJointFrames(name, mode, speed, dur, retargeted, 0)
}

/**
 * Williams-style 8-phase key-pose reference cycle for a zombie shamble:
 * - Dragging right foot (low 1..2.5 cm clearance, plantarflexed toe scrape, late short plant)
 * - Uneven step timing (timingBias ~ 0.26, long left catch stance, brief buckling right stance)
 * - Lurching torso (forward pitch surges to 26° on catch step, rolls 9..12° toward crippled side)
 * - Head lolling (lagging forward & sideways roll)
 * - Arms hanging/reaching asymmetrically (left arm reaching/clawing forward, right arm hanging lower and trailing)
 * - Weight falling forward on crippled leg buckle and catching on left contact
 */
export function buildShambleReferenceCycle(): CycleData {
  const keys: ExtendedKeyPoseAngles[] = [
    // 0/8: L Contact (Weight falling forward is caught by L foot planting ahead; R leg trails behind)
    {
      trunkPitchDeg: 19.5, torsoRollDeg: 5.0, pelvisRollDeg: -2.0, pelvisYawDeg: -5, chestYawDeg: 6,
      headPitchDeg: -4.0, headRollDeg: 10.0, pelvisBobCm: -1.4,
      shoulderFlexL: 34, shoulderAbdL: 15, elbowFlexL: 36, forearmInwardL: 10,
      shoulderFlexR: 12, shoulderAbdR: 18, elbowFlexR: 22, forearmInwardR: 6,
      hipFlexL: 24, kneeFlexL: 12, anklePitchL: -10,
      hipFlexR: -16, kneeFlexR: 10, anklePitchR: 18,
    },
    // 1/8: L Down / Catch (Deep L knee bend absorbs the lurch; torso pitches forward to peak; head lolls down/right)
    {
      trunkPitchDeg: 23.5, torsoRollDeg: 9.0, pelvisRollDeg: -5.0, pelvisYawDeg: -3, chestYawDeg: 4,
      headPitchDeg: -8.0, headRollDeg: 14.0, pelvisBobCm: -3.6,
      shoulderFlexL: 42, shoulderAbdL: 16, elbowFlexL: 42, forearmInwardL: 12,
      shoulderFlexR: 18, shoulderAbdR: 19, elbowFlexR: 25, forearmInwardR: 6,
      hipFlexL: 31, kneeFlexL: 44, anklePitchL: 12,
      hipFlexR: -22, kneeFlexR: 12, anklePitchR: 24,
    },
    // 2/8: L Passing / Drag Start (L leg vaults body upward; R foot drags forward with toe scraping low)
    {
      trunkPitchDeg: 19.5, torsoRollDeg: 6.5, pelvisRollDeg: -6.5, pelvisYawDeg: 2, chestYawDeg: -3,
      headPitchDeg: -5.0, headRollDeg: 12.0, pelvisBobCm: -0.6,
      shoulderFlexL: 48, shoulderAbdL: 16, elbowFlexL: 44, forearmInwardL: 12,
      shoulderFlexR: 24, shoulderAbdR: 18, elbowFlexR: 28, forearmInwardR: 8,
      hipFlexL: 25, kneeFlexL: 52, anklePitchL: 22,
      hipFlexR: 2, kneeFlexR: 42, anklePitchR: 28,
    },
    // 3/8: L Up / Hitch Peak (Hip hikes to haul dragged R foot past stance ankle; torso recovers slightly)
    {
      trunkPitchDeg: 16.5, torsoRollDeg: 1.5, pelvisRollDeg: -4.0, pelvisYawDeg: 6, chestYawDeg: -6,
      headPitchDeg: -1.0, headRollDeg: 8.0, pelvisBobCm: 2.2,
      shoulderFlexL: 46, shoulderAbdL: 15, elbowFlexL: 40, forearmInwardL: 10,
      shoulderFlexR: 26, shoulderAbdR: 17, elbowFlexR: 28, forearmInwardR: 8,
      hipFlexL: 12, kneeFlexL: 42, anklePitchL: 26,
      hipFlexR: 28, kneeFlexR: 46, anklePitchR: 12,
    },
    // 4/8: R Contact / Short Plant (Dragged R foot plants short and flat; L leg is behind)
    {
      trunkPitchDeg: 17.5, torsoRollDeg: -3.0, pelvisRollDeg: 2.5, pelvisYawDeg: 5, chestYawDeg: -5,
      headPitchDeg: -2.0, headRollDeg: 6.0, pelvisBobCm: 0.4,
      shoulderFlexL: 38, shoulderAbdL: 14, elbowFlexL: 34, forearmInwardL: 8,
      shoulderFlexR: 20, shoulderAbdR: 17, elbowFlexR: 24, forearmInwardR: 6,
      hipFlexL: -6, kneeFlexL: 24, anklePitchL: 22,
      hipFlexR: 30, kneeFlexR: 36, anklePitchR: 4,
    },
    // 5/8: R Down / Buckle (Crippled R knee gives way; pelvis drops & rolls; torso lurches forward)
    {
      trunkPitchDeg: 22.0, torsoRollDeg: -7.5, pelvisRollDeg: 6.5, pelvisYawDeg: 2, chestYawDeg: -2,
      headPitchDeg: -6.0, headRollDeg: 9.0, pelvisBobCm: -2.8,
      shoulderFlexL: 30, shoulderAbdL: 14, elbowFlexL: 30, forearmInwardL: 8,
      shoulderFlexR: 10, shoulderAbdR: 19, elbowFlexR: 18, forearmInwardR: 5,
      hipFlexL: -18, kneeFlexL: 16, anklePitchL: 24,
      hipFlexR: 26, kneeFlexR: 45, anklePitchR: 14,
    },
    // 6/8: R Passing / Fall Forward (Weight pitches forward over collapsing R leg; L leg swings high to catch)
    {
      trunkPitchDeg: 23.0, torsoRollDeg: -4.5, pelvisRollDeg: 5.0, pelvisYawDeg: -3, chestYawDeg: 3,
      headPitchDeg: -7.5, headRollDeg: 11.0, pelvisBobCm: -1.0,
      shoulderFlexL: 26, shoulderAbdL: 14, elbowFlexL: 28, forearmInwardL: 8,
      shoulderFlexR: 6, shoulderAbdR: 20, elbowFlexR: 16, forearmInwardR: 5,
      hipFlexL: 10, kneeFlexL: 62, anklePitchL: 36,
      hipFlexR: 17, kneeFlexR: 44, anklePitchR: 22,
    },
    // 7/8: R Up / Lunge into Catch (Body falls forward into L foot reach)
    {
      trunkPitchDeg: 21.0, torsoRollDeg: 1.0, pelvisRollDeg: 1.5, pelvisYawDeg: -5, chestYawDeg: 5,
      headPitchDeg: -5.5, headRollDeg: 10.5, pelvisBobCm: 1.2,
      shoulderFlexL: 29, shoulderAbdL: 15, elbowFlexL: 32, forearmInwardL: 9,
      shoulderFlexR: 8, shoulderAbdR: 19, elbowFlexR: 18, forearmInwardR: 6,
      hipFlexL: 34, kneeFlexL: 56, anklePitchL: 12,
      hipFlexR: -2, kneeFlexR: 22, anklePitchR: 20,
    },
  ]

  const frames: RigJointMap[] = []
  const denseN = 64
  for (let i = 0; i < denseN; i++) {
    const u = (i / denseN) * 8
    const sample = (fn: (row: ExtendedKeyPoseAngles) => number) => {
      const pos = u % 8
      const i0 = Math.floor(pos)
      const i1 = (i0 + 1) % 8
      const iPrev = (i0 + 7) % 8
      const iNext = (i1 + 1) % 8
      const t = pos - i0
      const p0 = fn(keys[iPrev]!), p1 = fn(keys[i0]!), p2 = fn(keys[i1]!), p3 = fn(keys[iNext]!)
      const t2 = t * t, t3 = t2 * t
      return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }
    frames.push(
      jointsFromExtendedAngles({
        trunkPitchDeg: sample(r => r.trunkPitchDeg),
        torsoRollDeg: sample(r => r.torsoRollDeg ?? 0),
        pelvisRollDeg: sample(r => r.pelvisRollDeg ?? 0),
        pelvisYawDeg: sample(r => r.pelvisYawDeg ?? 0),
        chestYawDeg: sample(r => r.chestYawDeg ?? 0),
        headPitchDeg: sample(r => r.headPitchDeg ?? 0),
        headRollDeg: sample(r => r.headRollDeg ?? 0),
        pelvisBobCm: sample(r => r.pelvisBobCm),
        shoulderFlexL: sample(r => r.shoulderFlexL),
        shoulderFlexR: sample(r => r.shoulderFlexR),
        shoulderAbdL: sample(r => r.shoulderAbdL),
        shoulderAbdR: sample(r => r.shoulderAbdR),
        elbowFlexL: sample(r => r.elbowFlexL),
        elbowFlexR: sample(r => r.elbowFlexR),
        forearmInwardL: sample(r => r.forearmInwardL ?? 8),
        forearmInwardR: sample(r => r.forearmInwardR ?? 6),
        hipFlexL: sample(r => r.hipFlexL),
        hipFlexR: sample(r => r.hipFlexR),
        kneeFlexL: sample(r => r.kneeFlexL),
        kneeFlexR: sample(r => r.kneeFlexR),
        anklePitchL: sample(r => r.anklePitchL),
        anklePitchR: sample(r => r.anklePitchR),
        footWorldPitchL: sample(r => r.footWorldPitchL ?? r.anklePitchL),
        footWorldPitchR: sample(r => r.footWorldPitchR ?? r.anklePitchR),
      }),
    )
  }

  return buildCycleFromJointFrames("williams-shamble", "walk", 0.95, 1.12, frames, 0)
}

/**
 * Williams-style 8-phase key-pose reference cycle for a crouch-run:
 * - Low pelvis (-8.5 cm mean crouch depth, compact ±2.0 cm vertical oscillation to stay low under cover)
 * - Forward lean from hips (28° trunk pitch, head stabilised looking forward)
 * - Short fast steps (235 steps/min, low skimming foot trajectory)
 * - Bent knees through stance (32° at contact -> 54° at mid-stance Down -> 30° at toe-off, 98° in swing)
 * - Arms tight (compact 88°..116° elbow bend, close to ribs)
 */
export function buildCrouchRunReferenceCycle(): CycleData {
  const half = [
    // 0/8: L Contact (Low pelvis, flexed hip & bent stance knee at touchdown, arms tight)
    { shFlex: -44, shAbd: 13, elbFlex: 92, hipFlex: 42, kneeFlex: 54, ankPitch: 8, bobCm: -8.8 },
    // 1/8: L Down / Mid-Stance (Deep stance knee flexion absorbing load while staying low)
    { shFlex: -24, shAbd: 12, elbFlex: 90, hipFlex: 28, kneeFlex: 68, ankPitch: 32, bobCm: -10.6 },
    // 2/8: L Toe-Off (Pushes off without locking knee straight; opposite knee drives forward)
    { shFlex: 8, shAbd: 11, elbFlex: 104, hipFlex: -2, kneeFlex: 48, ankPitch: 36, bobCm: -8.2 },
    // 3/8: Flight L->R (Compact low-ceiling flight, tight forward arm guard)
    { shFlex: 24, shAbd: 12, elbFlex: 116, hipFlex: -32, kneeFlex: 18, ankPitch: -10, bobCm: -6.6 },
    // 4/8: R Contact (L leg folding behind under low pelvis)
    { shFlex: 16, shAbd: 13, elbFlex: 110, hipFlex: -30, kneeFlex: 28, ankPitch: -18, bobCm: -8.8 },
    // 5/8: R Down (L knee driving forward low under crouched torso)
    { shFlex: -8, shAbd: 12, elbFlex: 88, hipFlex: 18, kneeFlex: 98, ankPitch: -18, bobCm: -10.6 },
    // 6/8: R Toe-Off (L knee forward, compact hip flexion without jackknifing into chest)
    { shFlex: -34, shAbd: 13, elbFlex: 88, hipFlex: 52, kneeFlex: 88, ankPitch: -6, bobCm: -8.2 },
    // 7/8: Flight R->L (L leg extending forward/down for bent-knee contact)
    { shFlex: -46, shAbd: 13, elbFlex: 92, hipFlex: 40, kneeFlex: 28, ankPitch: -8, bobCm: -6.6 },
  ]

  const frames: RigJointMap[] = []
  const denseN = 64
  for (let i = 0; i < denseN; i++) {
    const u = (i / denseN) * 8
    const sample = (fn: (row: (typeof half)[number]) => number, offset = 0) => {
      const pos = (u + offset) % 8
      const i0 = Math.floor(pos)
      const i1 = (i0 + 1) % 8
      const iPrev = (i0 + 7) % 8
      const iNext = (i1 + 1) % 8
      const t = pos - i0
      const p0 = fn(half[iPrev]!), p1 = fn(half[i0]!), p2 = fn(half[i1]!), p3 = fn(half[iNext]!)
      const t2 = t * t, t3 = t2 * t
      return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }
    frames.push(
      jointsFromExtendedAngles({
        trunkPitchDeg: 28.5,
        headPitchDeg: -2.0,
        pelvisBobCm: sample(r => r.bobCm, 0),
        shoulderFlexL: sample(r => r.shFlex, 0),
        shoulderFlexR: sample(r => r.shFlex, 4),
        shoulderAbdL: sample(r => r.shAbd, 0),
        shoulderAbdR: sample(r => r.shAbd, 4),
        elbowFlexL: sample(r => r.elbFlex, 0),
        elbowFlexR: sample(r => r.elbFlex, 4),
        forearmInwardL: 16,
        forearmInwardR: 16,
        hipFlexL: sample(r => r.hipFlex, 0),
        hipFlexR: sample(r => r.hipFlex, 4),
        kneeFlexL: sample(r => r.kneeFlex, 0),
        kneeFlexR: sample(r => r.kneeFlex, 4),
        anklePitchL: sample(r => r.ankPitch, 0),
        anklePitchR: sample(r => r.ankPitch, 4),
        footWorldPitchL: sample(r => r.ankPitch, 0),
        footWorldPitchR: sample(r => r.ankPitch, 4),
      }),
    )
  }

  return buildCycleFromJointFrames("williams-crouch-run", "run", 4.2, 0.51, frames, 0)
}

/**
 * FK-driven zombie shamble arm solver calibrated from mocap (`walkTired`, `walkExhausted`) and `williams-shamble`.
 * Computes shoulder flexion, coronal abduction, elbow flexion and medial forearm turn per arm,
 * then constructs world-space hand targets on the exact `RIG.upper + RIG.fore` sphere for `poseUnarmedArms`.
 */
export function shambleHandsFK(
  torso: Frame,
  phase: number,
  moving: number,
  run: number,
  profile: HumanProfile,
  seed = 0,
): [V3, V3] {
  const variant = resolveZombieVariant((profile as { zombieVariant?: ZombieVariant }).zombieVariant, seed)
  const dragFoot = resolveDragFoot(seed)
  const dragSign = dragFoot === 1 ? 1 : -1 // +1 when right leg drags, -1 when left leg drags
  const th = phase * TAU + (seed !== 0 ? zombieSeedHash(seed, 1) * 0.35 : 0)
  const reachNorm = clamp((profile.armReach - 0.2) / 0.32, 0, 1)
  const asymNorm = clamp(profile.armAsymmetry / 0.18, -1, 1)
  const dragAmt = clamp(profile.footDrag, 0, 1)
  const lurchAmt = clamp(profile.torsoLean / 0.28, 0, 1.25)
  const swingScale = clamp(profile.armSwing ?? 0.75, 0, 2) * moving

  // Smooth C∞ gait wave with stumble-and-catch harmonic (peaks as weight falls into the catch step)
  const catchWave = Math.sin(th - 0.35) + 0.22 * Math.sin(2 * th - 0.8)
  const trailWave = Math.sin(th - 0.55) + 0.18 * Math.sin(2 * th - 0.9)

  // Variant-specific baseline posture in degrees
  let leadShBase = 29 + 7 * reachNorm + 6 * run
  let trailShBase = 11 + 6 * reachNorm + 8 * run
  let leadShAmp = 10.5 * swingScale
  let trailShAmp = 9.5 * swingScale
  let leadElbBase = 36 + 8 * run
  let trailElbBase = 22 + 8 * run
  let leadAbdBase = 15
  let trailAbdBase = 18.5

  if (variant === "limper") {
    // Limper: crippled-side arm hangs low & dead near the hip while lead arm reaches out for balance
    leadShBase = 28 + 7 * reachNorm
    trailShBase = 2 + 6 * reachNorm
    leadShAmp = 13 * swingScale
    trailShAmp = 9 * swingScale
    leadElbBase = 36
    trailElbBase = 18
    leadAbdBase = 15
    trailAbdBase = 20
  } else if (variant === "dragger") {
    // Dragger: asymmetric reach with trailing side hanging lower on the dropped shoulder
    leadShBase = 29 + 6 * reachNorm + 4 * asymNorm
    trailShBase = 12 + 6 * reachNorm - 3 * asymNorm
    leadShAmp = 10.5 * swingScale * (0.7 + 0.3 * lurchAmt)
    trailShAmp = 9.5 * swingScale * (0.7 + 0.3 * dragAmt)
    leadElbBase = 36
    trailElbBase = 22.5
    leadAbdBase = 15
    trailAbdBase = 18.5
  } else if (variant === "reacher") {
    // Reacher: both arms clawing forward asymmetrically, surging on the catch step
    leadShBase = 38 + 9 * reachNorm + 5 * asymNorm
    trailShBase = 24 + 8 * reachNorm - 4 * asymNorm
    leadShAmp = 12 * swingScale
    trailShAmp = 11 * swingScale
    leadElbBase = 41
    trailElbBase = 31
    leadAbdBase = 16
    trailAbdBase = 19
  } else if (variant === "lunger") {
    // Fast-lunger: aggressive wide-elbow raking reach
    leadShBase = 42 + 8 * reachNorm + 8 * run
    trailShBase = 22 + 8 * reachNorm + 10 * run
    leadShAmp = 15 * swingScale
    trailShAmp = 13 * swingScale
    leadElbBase = 46
    trailElbBase = 35
    leadAbdBase = 18
    trailAbdBase = 22
  }

  // Per-zombie personality offset (zero when seed === 0)
  const seedShOffset = seed !== 0 ? zombieSeedHash(seed, 4) * 5.5 : 0
  const seedElbOffset = seed !== 0 ? zombieSeedHash(seed, 5) * 4.5 : 0

  const buildHand = (i: 0 | 1): V3 => {
    const side = i === 0 ? -1 : 1
    const isTrail = (i === 1 && dragSign > 0) || (i === 0 && dragSign < 0)
    const wave = isTrail ? trailWave : catchWave
    const shFlexDeg =
      (isTrail ? trailShBase + trailShAmp * wave : leadShBase + leadShAmp * wave) + side * seedShOffset
    const elbFlexDeg = clamp(
      (isTrail ? trailElbBase + 5.5 * swingScale * wave : leadElbBase + 6.5 * swingScale * wave) + seedElbOffset,
      6,
      115,
    )
    const shAbdDeg = clamp(
      (isTrail ? trailAbdBase + 1.5 * Math.cos(th) : leadAbdBase + 1.2 * Math.sin(th)),
      8,
      32,
    )
    const inwardDeg = isTrail ? 6 + 3 * Math.max(0, wave) : 10 + 4 * Math.max(0, wave)

    const sf = shFlexDeg * RAD
    const sa = shAbdDeg * RAD
    const cosSa = Math.cos(sa), sinSa = Math.sin(sa)
    const u1x = Math.sin(sf) * cosSa
    const u1y = -Math.cos(sf) * cosSa
    const u1z = side * sinSa
    const ff = (shFlexDeg + elbFlexDeg) * RAD
    const faLat = sa - inwardDeg * RAD
    const cosFa = Math.cos(faLat), sinFa = Math.sin(faLat)
    const u2x = Math.sin(ff) * cosFa
    const u2y = -Math.cos(ff) * cosFa
    const u2z = side * sinFa

    // Project in horizontal heading of torso (yaw-aligned, world-vertical) so world shoulder/elbow angles
    // match the authored FK trajectories regardless of torso pitch/roll hunch.
    const sh = at(torso, 0, RIG.shoulderY, side * RIG.shoulderW)
    const hx = torso.x[0], hz = torso.x[2]
    const hLen = Math.hypot(hx, hz) || 1
    const fx = hx / hLen, fz = hz / hLen
    const rx = -fz, rz = fx
    const dx = u1x * RIG.upper + u2x * RIG.fore
    const dy = u1y * RIG.upper + u2y * RIG.fore
    const dz = u1z * RIG.upper + u2z * RIG.fore
    return [
      sh[0] + fx * dx + rx * dz,
      sh[1] + dy,
      sh[2] + fz * dx + rz * dz,
    ]
  }

  return [buildHand(0), buildHand(1)]
}

const MOD_ZERO = Object.freeze({
  pelvisRollAdd: 0,
  pelvisBobAdd: 0,
  torsoPitchAdd: 0,
  torsoRollAdd: 0,
  torsoYawAdd: 0,
  headPitchAdd: 0,
  headRollAdd: 0,
  headYawAdd: 0,
})

const MOD_OUT = {
  pelvisRollAdd: 0,
  pelvisBobAdd: 0,
  torsoPitchAdd: 0,
  torsoRollAdd: 0,
  torsoYawAdd: 0,
  headPitchAdd: 0,
  headRollAdd: 0,
  headYawAdd: 0,
}

/**
 * Computes cyclic shamble lurch (sagittal stumble-and-catch pitch + coronal cant + head loll)
 * from phase and profile parameters. Smooth C∞ harmonics prevent acceleration/jerk spikes.
 */
export function shambleTorsoModulation(
  phase: number,
  moving: number,
  profile: HumanProfile,
  seed = 0,
): typeof MOD_OUT {
  const drag = clamp(profile.footDrag, 0, 1)
  const lurch = clamp(profile.torsoLean / 0.24, 0, 1.4)
  const asym = clamp(Math.abs(profile.timingBias) / 0.28, 0, 1.4)
  const shambleWeight = clamp(Math.max(drag, (profile.handPose === "reach" ? 0.8 : 0) * lurch), 0, 1) * moving
  if (shambleWeight <= 1e-4) return MOD_ZERO
  const variant = resolveZombieVariant((profile as { zombieVariant?: ZombieVariant }).zombieVariant, seed)
  const dragSign = resolveDragFoot(seed) === 1 ? 1 : -1
  const th = phase * TAU + (seed !== 0 ? zombieSeedHash(seed, 2) * 0.25 : 0)
  const vScale = variant === "lunger" ? 1.28 : variant === "limper" ? 1.18 : variant === "dragger" ? 1.05 : 0.95

  const sin1 = Math.sin(th + 0.55)
  const sin2 = Math.sin(2 * th - 0.35)
  const cos2 = Math.cos(2 * th)
  MOD_OUT.pelvisRollAdd = -0.085 * Math.sin(th + 0.3) * dragSign * shambleWeight * vScale
  MOD_OUT.pelvisBobAdd = (-0.018 * Math.sin(th + 0.4) - 0.014 * Math.sin(2 * th - 0.2)) * shambleWeight * vScale
  MOD_OUT.torsoPitchAdd = (0.068 * sin1 - 0.048 * sin2) * shambleWeight * lurch * vScale
  MOD_OUT.torsoRollAdd = (0.125 * Math.sin(th + 0.35) + 0.042 * cos2) * dragSign * shambleWeight * (0.5 + 0.5 * asym) * vScale
  MOD_OUT.torsoYawAdd = -0.10 * Math.cos(th - 0.25) * dragSign * shambleWeight * vScale
  MOD_OUT.headPitchAdd = (0.085 * Math.sin(th + 0.15) - 0.04 * cos2) * shambleWeight * vScale
  MOD_OUT.headRollAdd = (0.11 * Math.sin(th - 0.35) + 0.04 * Math.sin(2 * th)) * dragSign * shambleWeight * vScale
  MOD_OUT.headYawAdd = 0.07 * Math.cos(th - 0.5) * dragSign * shambleWeight
  return MOD_OUT
}
