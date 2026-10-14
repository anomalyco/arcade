import { at, clamp, dot, len, norm, RIG, HIP, sub, type Frame, type V3 } from "./rig"
import type { BonePose, HumanBody } from "./human-pose"

export const POSE_JOINTS = [
  "pelvis",
  "waist",
  "chest",
  "neck",
  "headTop",
  "shoulderL",
  "elbowL",
  "wristL",
  "shoulderR",
  "elbowR",
  "wristR",
  "hipL",
  "kneeL",
  "ankleL",
  "toeL",
  "hipR",
  "kneeR",
  "ankleR",
  "toeR",
] as const

export type PoseJointId = (typeof POSE_JOINTS)[number]
export type RigJointMap = Record<PoseJointId, V3> & {
  gunGrip?: V3
  gunMuzzle?: V3
}

export type RigSegmentGroup = "spine" | "left" | "right" | "weapon"
export type RigSegment = { from: PoseJointId | "gunGrip"; to: PoseJointId | "gunMuzzle"; group: RigSegmentGroup }

export const RIG_SEGMENTS: readonly RigSegment[] = [
  // Spine & shoulder/hip bars (white)
  { from: "pelvis", to: "waist", group: "spine" },
  { from: "waist", to: "chest", group: "spine" },
  { from: "chest", to: "neck", group: "spine" },
  { from: "neck", to: "headTop", group: "spine" },
  { from: "shoulderL", to: "shoulderR", group: "spine" },
  { from: "hipL", to: "hipR", group: "spine" },
  // Left limbs (blue)
  { from: "shoulderL", to: "elbowL", group: "left" },
  { from: "elbowL", to: "wristL", group: "left" },
  { from: "hipL", to: "kneeL", group: "left" },
  { from: "kneeL", to: "ankleL", group: "left" },
  { from: "ankleL", to: "toeL", group: "left" },
  // Right limbs (orange)
  { from: "shoulderR", to: "elbowR", group: "right" },
  { from: "elbowR", to: "wristR", group: "right" },
  { from: "hipR", to: "kneeR", group: "right" },
  { from: "kneeR", to: "ankleR", group: "right" },
  { from: "ankleR", to: "toeR", group: "right" },
] as const

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000

/** Extract world-space 3D coordinates of all 19 canonical skeleton joints from a posed HumanBody. */
export function extractBodyJoints(body: HumanBody, gun?: Frame | null, muzzleDist = 0.66): RigJointMap {
  const pelvis = [...body.pelvis.p] as V3
  const waist = [...body.torso.p] as V3
  const chest = at(body.torso, 0, RIG.shoulderY, 0)
  const neck = [...body.head.p] as V3
  const headTop = at(body.head, 0, 0.26, 0)
  const shoulderL = [...body.ua[0].p] as V3
  const elbowL = [...body.fa[0].p] as V3
  const wristL = at(body.fa[0], 0, -RIG.fore, 0)
  const shoulderR = [...body.ua[1].p] as V3
  const elbowR = [...body.fa[1].p] as V3
  const wristR = at(body.fa[1], 0, -RIG.fore, 0)
  const hipL = [...body.th[0].p] as V3
  const kneeL = [...body.sh[0].p] as V3
  const ankleL = [...body.ft[0].p] as V3
  const toeL = at(body.ft[0], 0.19, -RIG.ankle, 0)
  const hipR = [...body.th[1].p] as V3
  const kneeR = [...body.sh[1].p] as V3
  const ankleR = [...body.ft[1].p] as V3
  const toeR = at(body.ft[1], 0.19, -RIG.ankle, 0)
  const out: RigJointMap = {
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
    toeL,
    hipR,
    kneeR,
    ankleR,
    toeR,
  }
  if (gun) {
    out.gunGrip = [...gun.p] as V3
    out.gunMuzzle = at(gun, muzzleDist, 0.03, 0)
  }
  return out
}

/** Extract world-space 3D coordinates from a BonePose (e.g. Outbreak Survivor.bones). */
export function extractBonePoseJoints(pose: BonePose): RigJointMap {
  const b: HumanBody = {
    pelvis: pose.pelvis!,
    torso: pose.torso!,
    head: pose.head!,
    ua: [pose["left.upperArm"]!, pose["right.upperArm"]!],
    fa: [pose["left.foreArm"]!, pose["right.foreArm"]!],
    th: [pose["left.thigh"]!, pose["right.thigh"]!],
    sh: [pose["left.shin"]!, pose["right.shin"]!],
    ft: [pose["left.foot"]!, pose["right.foot"]!],
  }
  return extractBodyJoints(b)
}

export type NormalizedPose = {
  /** Normalized 3D joints where pelvis is at [0, pelvisBobNorm, 0] and standing hip height = 1 (ground at y = -1). */
  joints: RigJointMap
  /** Normalized 3D joints strictly pelvis-locked at [0, 0, 0] with hipHeight = 1. */
  pelvisOriginJoints: RigJointMap
  hipHeight: number
  pelvisBobNorm: number
  groundY: number
}

/**
 * Normalize a 3D joint map so heading faces +X (up +Y, right +Z), hip height = 1,
 * and pelvis is at origin (with `pelvisBobNorm` preserving vertical COM oscillation relative to mean hip height).
 */
export function normalizeJoints(
  joints: RigJointMap,
  headingYaw = 0,
  refHipHeight = HIP,
  refPelvisMeanY = joints.pelvis[1],
): NormalizedPose {
  const c = Math.cos(-headingYaw), s = Math.sin(-headingYaw)
  const px = joints.pelvis[0], py = joints.pelvis[1], pz = joints.pelvis[2]
  const invH = 1 / Math.max(0.2, refHipHeight)
  const pelvisBobNorm = (py - refPelvisMeanY) * invH

  const xform = (pt: V3, lockY: boolean): V3 => {
    const dx = pt[0] - px, dz = pt[2] - pz
    const rx = dx * c - dz * s
    const rz = dx * s + dz * c
    const ry = lockY ? (pt[1] - py) * invH : (pt[1] - refPelvisMeanY) * invH
    return [r4(rx * invH), r4(ry), r4(rz * invH)]
  }

  const normMap = {} as RigJointMap
  const lockedMap = {} as RigJointMap
  for (const id of POSE_JOINTS) {
    normMap[id] = xform(joints[id], false)
    lockedMap[id] = xform(joints[id], true)
  }
  if (joints.gunGrip && joints.gunMuzzle) {
    normMap.gunGrip = xform(joints.gunGrip, false)
    normMap.gunMuzzle = xform(joints.gunMuzzle, false)
    lockedMap.gunGrip = xform(joints.gunGrip, true)
    lockedMap.gunMuzzle = xform(joints.gunMuzzle, true)
  }
  return {
    joints: normMap,
    pelvisOriginJoints: lockedMap,
    hipHeight: r4(refHipHeight),
    pelvisBobNorm: r4(pelvisBobNorm),
    groundY: r4(-refPelvisMeanY * invH),
  }
}

export type ProjectedPose2D = {
  view: "side" | "front"
  points: Record<PoseJointId, [number, number]> & {
    gunGrip?: [number, number]
    gunMuzzle?: [number, number]
  }
  groundY: number
}

/** Orthographic projection of normalized joints: side view = (fwd +X, up +Y), front view = (right +Z, up +Y). */
export function projectOrtho(normPose: NormalizedPose, view: "side" | "front", lockPelvisY = false): ProjectedPose2D {
  const src = lockPelvisY ? normPose.pelvisOriginJoints : normPose.joints
  const points = {} as ProjectedPose2D["points"]
  const proj = (v: V3): [number, number] => (view === "side" ? [v[0], v[1]] : [v[2], v[1]])
  for (const id of POSE_JOINTS) points[id] = proj(src[id])
  if (src.gunGrip && src.gunMuzzle) {
    points.gunGrip = proj(src.gunGrip)
    points.gunMuzzle = proj(src.gunMuzzle)
  }
  return {
    view,
    points,
    groundY: lockPelvisY ? -1 : normPose.groundY,
  }
}

export type PoseAngles = {
  /** Trunk forward lean in sagittal plane (deg, positive = leaning forward +X). */
  trunkPitchDeg: number
  /** Pelvis coronal tilt (deg, positive = right hip higher than left hip). */
  pelvisRollDeg: number
  /** Shoulder line coronal tilt (deg). */
  shoulderRollDeg: number
  /** Upper arm sagittal angle in world space (deg, 0 = straight down, + = forward flexion, - = backward extension). */
  shoulderFlexL: number
  shoulderFlexR: number
  /** Upper arm sagittal angle relative to trunk (deg, shoulderFlex - trunkPitch). */
  shoulderFlexRelL: number
  shoulderFlexRelR: number
  /** Upper arm coronal abduction angle away from body (deg, 0 = vertical, + = outward). */
  shoulderAbdL: number
  shoulderAbdR: number
  /** Forearm sagittal angle in world space (deg, 0 = straight down, +90 = horizontal forward). */
  forearmPitchL: number
  forearmPitchR: number
  /** 3D interior elbow flexion angle (deg, 0 = straight locked, 90 = right angle). */
  elbowFlexL: number
  elbowFlexR: number
  /** Wrist position relative to hip/pelvis center in cm (scaled to canonical HIP = 86 cm). */
  wristRelHipL: V3
  wristRelHipR: V3
  /** Elbow position relative to torso/chest center in cm (for checking torso silhouette clearance). */
  elbowRelTorsoL: V3
  elbowRelTorsoR: V3
  /** Thigh sagittal flexion/extension angle (deg, 0 = vertical, + = forward flexion, - = extension). */
  hipFlexL: number
  hipFlexR: number
  /** 3D interior knee flexion angle (deg, 0 = straight leg). */
  kneeFlexL: number
  kneeFlexR: number
  /** Foot pitch relative to floor (deg, 0 = flat, + = dorsiflexed / toe up, - = plantarflexed / toe down). */
  anklePitchL: number
  anklePitchR: number
  /** Pelvis vertical displacement from standing/mean height in cm. */
  pelvisBobCm: number
  /** Foot clearance above floor in cm. */
  footLiftLCm: number
  footLiftRCm: number
}

/** Extract all biomechanical joint angles and relative limb coordinates from a pose. */
export function computePoseAngles(
  joints: RigJointMap,
  headingYaw = 0,
  refHipHeight = HIP,
  refPelvisMeanY = joints.pelvis[1],
): PoseAngles {
  const np = normalizeJoints(joints, headingYaw, refHipHeight, refPelvisMeanY)
  const j = np.joints
  const cmScale = HIP * 100

  const trunk = sub(j.neck, j.pelvis)
  const trunkPitchDeg = Math.atan2(trunk[0], Math.max(1e-4, trunk[1])) * DEG
  const hipBar = sub(j.hipR, j.hipL)
  const pelvisRollDeg = Math.atan2(hipBar[1], Math.max(1e-4, hipBar[2])) * DEG
  const shBar = sub(j.shoulderR, j.shoulderL)
  const shoulderRollDeg = Math.atan2(shBar[1], Math.max(1e-4, shBar[2])) * DEG

  const armMetrics = (side: -1 | 1, sh: V3, el: V3, wr: V3) => {
    const ua = sub(el, sh)
    const fa = sub(wr, el)
    const uaL = len(ua) || 1e-4
    const faL = len(fa) || 1e-4
    const shFlex = Math.atan2(ua[0], Math.max(1e-4, -ua[1])) * DEG
    const shAbd = Math.atan2(side * ua[2], Math.max(1e-4, -ua[1])) * DEG
    const faPitch = Math.atan2(fa[0], -fa[1]) * DEG
    const cosElb = clamp(dot(ua, fa) / (uaL * faL), -1, 1)
    const elbFlex = Math.acos(cosElb) * DEG
    const wrRelHip: V3 = [
      r2((wr[0] - j.pelvis[0]) * cmScale),
      r2((wr[1] - j.pelvis[1]) * cmScale),
      r2((wr[2] - j.pelvis[2]) * cmScale),
    ]
    const elRelTorso: V3 = [
      r2((el[0] - j.waist[0]) * cmScale),
      r2((el[1] - j.waist[1]) * cmScale),
      r2((el[2] - j.waist[2]) * cmScale),
    ]
    return { shFlex, shAbd, faPitch, elbFlex, wrRelHip, elRelTorso }
  }

  const leftA = armMetrics(-1, j.shoulderL, j.elbowL, j.wristL)
  const rightA = armMetrics(1, j.shoulderR, j.elbowR, j.wristR)

  const legMetrics = (hip: V3, knee: V3, ank: V3, toe: V3) => {
    const th = sub(knee, hip)
    const shn = sub(ank, knee)
    const ft = sub(toe, ank)
    const hipFlex = Math.atan2(th[0], Math.max(1e-4, -th[1])) * DEG
    const cosKnee = clamp(dot(th, shn) / ((len(th) || 1e-4) * (len(shn) || 1e-4)), -1, 1)
    const kneeFlex = Math.acos(cosKnee) * DEG
    // Flat foot has ankle at y = RIG.ankle and toe at y = 0, so baseline pitch is atan2(-RIG.ankle, 0.19)
    const baseFootPitch = Math.atan2(-RIG.ankle, 0.19)
    const rawFootPitch = Math.atan2(ft[1], Math.max(1e-4, ft[0]))
    const anklePitch = (rawFootPitch - baseFootPitch) * DEG
    return { hipFlex, kneeFlex, anklePitch }
  }

  const leftL = legMetrics(j.hipL, j.kneeL, j.ankleL, j.toeL)
  const rightL = legMetrics(j.hipR, j.kneeR, j.ankleR, j.toeR)

  const baseAnkleNorm = RIG.ankle / HIP
  const footLiftLCm = Math.max(0, (j.ankleL[1] - np.groundY - baseAnkleNorm) * cmScale)
  const footLiftRCm = Math.max(0, (j.ankleR[1] - np.groundY - baseAnkleNorm) * cmScale)

  return {
    trunkPitchDeg: r2(trunkPitchDeg),
    pelvisRollDeg: r2(pelvisRollDeg),
    shoulderRollDeg: r2(shoulderRollDeg),
    shoulderFlexL: r2(leftA.shFlex),
    shoulderFlexR: r2(rightA.shFlex),
    shoulderFlexRelL: r2(leftA.shFlex - trunkPitchDeg),
    shoulderFlexRelR: r2(rightA.shFlex - trunkPitchDeg),
    shoulderAbdL: r2(leftA.shAbd),
    shoulderAbdR: r2(rightA.shAbd),
    forearmPitchL: r2(leftA.faPitch),
    forearmPitchR: r2(rightA.faPitch),
    elbowFlexL: r2(leftA.elbFlex),
    elbowFlexR: r2(rightA.elbFlex),
    wristRelHipL: leftA.wrRelHip,
    wristRelHipR: rightA.wrRelHip,
    elbowRelTorsoL: leftA.elRelTorso,
    elbowRelTorsoR: rightA.elRelTorso,
    hipFlexL: r2(leftL.hipFlex),
    hipFlexR: r2(rightL.hipFlex),
    kneeFlexL: r2(leftL.kneeFlex),
    kneeFlexR: r2(rightL.kneeFlex),
    anklePitchL: r2(leftL.anklePitch),
    anklePitchR: r2(rightL.anklePitch),
    pelvisBobCm: r2(np.pelvisBobNorm * cmScale),
    footLiftLCm: r2(footLiftLCm),
    footLiftRCm: r2(footLiftRCm),
  }
}

export type KeyPoseAngles = {
  trunkPitchDeg: number
  pelvisYawDeg?: number
  chestYawDeg?: number
  pelvisRollDeg?: number
  pelvisBobCm: number
  shoulderFlexL: number
  shoulderFlexR: number
  shoulderAbdL: number
  shoulderAbdR: number
  elbowFlexL: number
  elbowFlexR: number
  forearmInwardL?: number
  forearmInwardR?: number
  hipFlexL: number
  hipFlexR: number
  kneeFlexL: number
  kneeFlexR: number
  anklePitchL: number
  anklePitchR: number
}

/** Construct a 3D RigJointMap from authored joint angles using exact RIG proportions. */
export function jointsFromAngles(a: KeyPoseAngles): RigJointMap {
  const pelY = HIP + a.pelvisBobCm * 0.01
  const pelvis: V3 = [0, pelY, 0]
  const trRad = a.trunkPitchDeg * RAD
  const pelRoll = (a.pelvisRollDeg ?? 0) * RAD
  const pelYaw = (a.pelvisYawDeg ?? 0) * RAD
  const chYaw = (a.chestYawDeg ?? 0) * RAD

  const trDir: V3 = [Math.sin(trRad), Math.cos(trRad), 0]
  const waist: V3 = [pelvis[0] + trDir[0] * RIG.waist, pelvis[1] + trDir[1] * RIG.waist, 0]
  const chest: V3 = [waist[0] + trDir[0] * RIG.shoulderY, waist[1] + trDir[1] * RIG.shoulderY, 0]
  const neck: V3 = [waist[0] + trDir[0] * RIG.neckY + 0.02, waist[1] + trDir[1] * RIG.neckY, 0]
  const headTop: V3 = [neck[0] + Math.sin(trRad * 0.35) * 0.26, neck[1] + Math.cos(trRad * 0.35) * 0.26, 0]

  const buildArm = (side: -1 | 1, shFlexDeg: number, shAbdDeg: number, elbFlexDeg: number, inwardDeg = 6): [V3, V3, V3] => {
    const sh: V3 = [
      chest[0] - side * RIG.shoulderW * Math.sin(chYaw),
      chest[1],
      chest[2] + side * RIG.shoulderW * Math.cos(chYaw),
    ]
    const sf = shFlexDeg * RAD
    const sa = shAbdDeg * RAD
    const uaDir = norm([Math.sin(sf) * Math.cos(sa), -Math.cos(sf) * Math.cos(sa), side * Math.sin(sa)])
    const elbow: V3 = [sh[0] + uaDir[0] * RIG.upper, sh[1] + uaDir[1] * RIG.upper, sh[2] + uaDir[2] * RIG.upper]
    const ff = (shFlexDeg + elbFlexDeg) * RAD
    const faLat = sa - inwardDeg * RAD
    const faDir = norm([Math.sin(ff) * Math.cos(faLat), -Math.cos(ff) * Math.cos(faLat), side * Math.sin(faLat)])
    const wrist: V3 = [elbow[0] + faDir[0] * RIG.fore, elbow[1] + faDir[1] * RIG.fore, elbow[2] + faDir[2] * RIG.fore]
    return [sh, elbow, wrist]
  }

  const [shoulderL, elbowL, wristL] = buildArm(-1, a.shoulderFlexL, a.shoulderAbdL, a.elbowFlexL, a.forearmInwardL ?? 6)
  const [shoulderR, elbowR, wristR] = buildArm(1, a.shoulderFlexR, a.shoulderAbdR, a.elbowFlexR, a.forearmInwardR ?? 6)

  const buildLeg = (side: -1 | 1, hipFlexDeg: number, kneeFlexDeg: number, ankPitchDeg: number): [V3, V3, V3, V3] => {
    const hip: V3 = [
      pelvis[0] - side * RIG.hipW * Math.sin(pelYaw),
      pelvis[1] + side * RIG.hipW * Math.sin(pelRoll),
      pelvis[2] + side * RIG.hipW * Math.cos(pelYaw) * Math.cos(pelRoll),
    ]
    const hf = hipFlexDeg * RAD
    const thDir: V3 = [Math.sin(hf), -Math.cos(hf), 0]
    const knee: V3 = [hip[0] + thDir[0] * RIG.thigh, hip[1] + thDir[1] * RIG.thigh, hip[2]]
    const sf = (hipFlexDeg - kneeFlexDeg) * RAD
    const shDir: V3 = [Math.sin(sf), -Math.cos(sf), 0]
    const ankle: V3 = [knee[0] + shDir[0] * RIG.shin, knee[1] + shDir[1] * RIG.shin, knee[2]]
    const baseFootAngle = Math.atan2(-RIG.ankle, 0.19)
    const footAngle = baseFootAngle + ankPitchDeg * RAD
    const footLen = Math.hypot(0.19, RIG.ankle)
    const toe: V3 = [ankle[0] + Math.cos(footAngle) * footLen, Math.max(0, ankle[1] + Math.sin(footAngle) * footLen), ankle[2]]
    return [hip, knee, ankle, toe]
  }

  const [hipL, kneeL, ankleL, toeL] = buildLeg(-1, a.hipFlexL, a.kneeFlexL, a.anklePitchL)
  const [hipR, kneeR, ankleR, toeR] = buildLeg(1, a.hipFlexR, a.kneeFlexR, a.anklePitchR)

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
    toeL,
    hipR,
    kneeR,
    ankleR,
    toeR,
  }
}

// BVH Parsing and Retargeting ---------------------------------------------------------------------------------------

type Mat3 = [number, number, number, number, number, number, number, number, number]
const mul3 = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
]
const mv3 = (m: Mat3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
function rotZXY(zd: number, xd: number, yd: number): Mat3 {
  const z = zd * RAD, x = xd * RAD, y = yd * RAD
  const cz = Math.cos(z), sz = Math.sin(z), cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y)
  const Rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  const Rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const Ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  return mul3(mul3(Rz, Rx), Ry)
}

export type BvhClip = {
  dt: number
  /** Frames in canonical world orientation: +X forward, +Y up, +Z right. */
  frames: Record<string, V3>[]
}

export function parseBvh(text: string): BvhClip {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const joints: { name: string; parent: number; offset: V3; channels: string[] }[] = []
  const stack: number[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("ROOT") || l.startsWith("JOINT")) {
      const jn = l.split(/\s+/)[1]!
      const parent = stack.length ? stack[stack.length - 1]! : -1
      joints.push({ name: jn, parent, offset: [0, 0, 0], channels: [] })
      stack.push(joints.length - 1)
    } else if (l.startsWith("End Site")) {
      const parent = stack[stack.length - 1]!
      joints.push({ name: joints[parent]!.name + "_End", parent, offset: [0, 0, 0], channels: [] })
      stack.push(joints.length - 1)
    } else if (l.startsWith("OFFSET")) {
      joints[stack[stack.length - 1]!]!.offset = l.split(/\s+/).slice(1, 4).map(Number) as V3
    } else if (l.startsWith("CHANNELS")) {
      const p = l.split(/\s+/)
      joints[stack[stack.length - 1]!]!.channels = p.slice(2, 2 + Number(p[1]))
    } else if (l === "}") stack.pop()
    else if (l === "MOTION") break
  }
  const nFrames = Number(lines[i + 1]!.split(/\s+/)[1])
  const dt = Number(lines[i + 2]!.split(/\s+/)[2])
  const rows = lines.slice(i + 3, i + 3 + nFrames).map(r => r.split(/\s+/).map(Number))

  const frames = rows.map(row => {
    const pos: Record<string, V3> = {}
    const rot: Record<string, Mat3> = {}
    let c = 0
    for (const j of joints) {
      let lp: V3, lr: Mat3
      if (j.channels.length === 6) {
        lp = [row[c]! * 0.01, row[c + 1]! * 0.01, row[c + 2]! * 0.01]
        lr = rotZXY(row[c + 3]!, row[c + 4]!, row[c + 5]!)
        c += 6
      } else {
        lp = [j.offset[0] * 0.01, j.offset[1] * 0.01, j.offset[2] * 0.01]
        lr = [1, 0, 0, 0, 1, 0, 0, 0, 1]
      }
      if (j.parent === -1) {
        pos[j.name] = lp
        rot[j.name] = lr
      } else {
        const pn = joints[j.parent]!.name
        const pp = pos[pn]!, pr = rot[pn]!
        const dp = mv3(pr, lp)
        pos[j.name] = [pp[0] + dp[0], pp[1] + dp[1], pp[2] + dp[2]]
        rot[j.name] = mul3(pr, lr)
      }
    }
    // Convert BVH (+Z forward, +Y up, +X left) to canonical (+X forward, +Y up, +Z right)
    const out: Record<string, V3> = {}
    for (const [k, v] of Object.entries(pos)) out[k] = [v[2], v[1], -v[0]]
    return out
  })
  return { dt, frames }
}

/**
 * Retarget a single BVH frame to our exact RIG proportions by preserving all 3D bone unit directions
 * and scaling pelvis height to HIP = 0.86 m.
 */
export function retargetBvhFrame(p: Record<string, V3>, meanPelvisY: number, minFootY: number): RigJointMap {
  const bvhHipH = Math.max(0.4, meanPelvisY - minFootY)
  const scaleH = HIP / bvhHipH
  const pelvis: V3 = [0, (p.Hips![1] - minFootY) * scaleH, 0]

  const dir = (a: V3, b: V3): V3 => norm(sub(b, a))
  const step = (origin: V3, d: V3, l: number): V3 => [origin[0] + d[0] * l, origin[1] + d[1] * l, origin[2] + d[2] * l]

  const spineDir = dir(p.Hips!, p.Neck!)
  const waist = step(pelvis, spineDir, RIG.waist)
  const chest = step(waist, spineDir, RIG.shoulderY)
  const neck = step(waist, spineDir, RIG.neckY)
  const headDir = p.Head_End && len(sub(p.Head_End, p.Head!)) > 0.01 ? dir(p.Neck!, p.Head_End) : dir(p.Neck!, p.Head!)
  const headTop = step(neck, headDir, 0.26)

  // Compensate for upper-thoracic & clavicle forward hunch (Chest->Neck vs Hips->Chest) when mapping
  // the multi-segment BVH spine/clavicle onto our single rigid torso bone (0° in upright walk, ~+15° in run).
  const hipToChestPitch = Math.atan2(p.Chest![0] - p.Hips![0], Math.max(1e-4, p.Chest![1] - p.Hips![1]))
  const chestToNeckPitch = Math.atan2(p.Neck![0] - p.Chest![0], Math.max(1e-4, p.Neck![1] - p.Chest![1]))
  const thoracicDelta = clamp(Math.max(0, chestToNeckPitch - hipToChestPitch) * 1.35, 0, 0.32)
  const unbendThoracic = (d: V3): V3 => {
    const c = Math.cos(thoracicDelta), s = Math.sin(thoracicDelta)
    // Rotate in sagittal XY plane by +thoracicDelta (lifting forward/upward to match rigid torso)
    return norm([d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]])
  }

  const shBarDir = dir(p.UpperArm_L!, p.UpperArm_R!)
  const shoulderL = step(chest, shBarDir, -RIG.shoulderW)
  const shoulderR = step(chest, shBarDir, RIG.shoulderW)

  const uaDirL = unbendThoracic(dir(p.UpperArm_L!, p.LowerArm_L!))
  const faDirL = unbendThoracic(dir(p.LowerArm_L!, p.Hand_L!))
  const elbowL = step(shoulderL, uaDirL, RIG.upper)
  const wristL = step(elbowL, faDirL, RIG.fore)

  const uaDirR = unbendThoracic(dir(p.UpperArm_R!, p.LowerArm_R!))
  const faDirR = unbendThoracic(dir(p.LowerArm_R!, p.Hand_R!))
  const elbowR = step(shoulderR, uaDirR, RIG.upper)
  const wristR = step(elbowR, faDirR, RIG.fore)

  const hipBarDir = dir(p.UpperLeg_L!, p.UpperLeg_R!)
  const hipL = step(pelvis, hipBarDir, -RIG.hipW)
  const hipR = step(pelvis, hipBarDir, RIG.hipW)

  const thDirL = dir(p.UpperLeg_L!, p.LowerLeg_L!)
  const shDirL = dir(p.LowerLeg_L!, p.Foot_L!)
  const ftDirL = dir(p.Foot_L!, p.Toes_L!)
  const kneeL = step(hipL, thDirL, RIG.thigh)
  const ankleL = step(kneeL, shDirL, RIG.shin)
  const toeL = step(ankleL, ftDirL, Math.hypot(0.19, RIG.ankle))

  const thDirR = dir(p.UpperLeg_R!, p.LowerLeg_R!)
  const shDirR = dir(p.LowerLeg_R!, p.Foot_R!)
  const ftDirR = dir(p.Foot_R!, p.Toes_R!)
  const kneeR = step(hipR, thDirR, RIG.thigh)
  const ankleR = step(kneeR, shDirR, RIG.shin)
  const toeR = step(ankleR, ftDirR, Math.hypot(0.19, RIG.ankle))

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
    toeL,
    hipR,
    kneeR,
    ankleR,
    toeR,
  }
}

export type PhaseSample = {
  phaseIndex: number
  phaseFrac: number
  joints: RigJointMap
  normalized: NormalizedPose
  orthoSide: ProjectedPose2D
  orthoFront: ProjectedPose2D
  angles: PoseAngles
}

export type CycleData = {
  name: string
  mode: "walk" | "run"
  speed: number
  cycleDurationSec: number
  cadenceStepsPerMin: number
  phases8: PhaseSample[]
  phases16: PhaseSample[]
  denseSamples: PhaseSample[]
}

function interpolateJointMap(a: RigJointMap, b: RigJointMap, t: number): RigJointMap {
  const out = {} as RigJointMap
  for (const id of POSE_JOINTS) {
    const pa = a[id], pb = b[id]
    out[id] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]
  }
  if (a.gunGrip && b.gunGrip && a.gunMuzzle && b.gunMuzzle) {
    out.gunGrip = [
      a.gunGrip[0] + (b.gunGrip[0] - a.gunGrip[0]) * t,
      a.gunGrip[1] + (b.gunGrip[1] - a.gunGrip[1]) * t,
      a.gunGrip[2] + (b.gunGrip[2] - a.gunGrip[2]) * t,
    ]
    out.gunMuzzle = [
      a.gunMuzzle[0] + (b.gunMuzzle[0] - a.gunMuzzle[0]) * t,
      a.gunMuzzle[1] + (b.gunMuzzle[1] - a.gunMuzzle[1]) * t,
      a.gunMuzzle[2] + (b.gunMuzzle[2] - a.gunMuzzle[2]) * t,
    ]
  }
  return out
}

export function buildCycleFromJointFrames(
  name: string,
  mode: "walk" | "run",
  speed: number,
  cycleDurationSec: number,
  rawFrames: RigJointMap[],
  headingYaw = 0,
): CycleData {
  const meanPelvisY = rawFrames.reduce((s, j) => s + j.pelvis[1], 0) / Math.max(1, rawFrames.length)
  const sampleAt = (u: number, idx: number): PhaseSample => {
    const pos = clamp(u, 0, 0.999999) * rawFrames.length
    const i0 = Math.floor(pos)
    const i1 = (i0 + 1) % rawFrames.length
    const frac = pos - i0
    const joints = interpolateJointMap(rawFrames[i0]!, rawFrames[i1]!, frac)
    const normalized = normalizeJoints(joints, headingYaw, HIP, meanPelvisY)
    const orthoSide = projectOrtho(normalized, "side")
    const orthoFront = projectOrtho(normalized, "front")
    const angles = computePoseAngles(joints, headingYaw, HIP, meanPelvisY)
    return {
      phaseIndex: idx,
      phaseFrac: r4(u),
      joints,
      normalized,
      orthoSide,
      orthoFront,
      angles,
    }
  }

  const phases8 = Array.from({ length: 8 }, (_, k) => sampleAt(k / 8, k))
  const phases16 = Array.from({ length: 16 }, (_, k) => sampleAt(k / 16, k))
  const denseSamples = Array.from({ length: 64 }, (_, k) => sampleAt(k / 64, k))
  const cadenceStepsPerMin = r2(120 / Math.max(0.1, cycleDurationSec))
  return { name, mode, speed, cycleDurationSec: r4(cycleDurationSec), cadenceStepsPerMin, phases8, phases16, denseSamples }
}

/**
 * Extract one phase-aligned gait cycle (Left Heel Strike -> Left Heel Strike) from a BVH clip
 * and retarget to our RIG proportions.
 */
export function extractBvhCycle(bvh: BvhClip, mode: "walk" | "run", searchStart = 10, searchEnd = 150): CycleData {
  const slice = bvh.frames.slice(searchStart, Math.min(searchEnd, bvh.frames.length))
  // Left heel strike occurs at local maximum of Foot_L forward offset relative to Hips
  const lFwd = slice.map(p => p.Foot_L![0] - p.Hips![0])
  const minGap = mode === "walk" ? 20 : 14
  const peaks: number[] = []
  for (let i = 2; i < lFwd.length - 2; i++) {
    if (lFwd[i]! >= lFwd[i - 1]! && lFwd[i]! >= lFwd[i + 1]! && lFwd[i]! >= lFwd[i - 2]! && lFwd[i]! >= lFwd[i + 2]! && lFwd[i]! > 0.12) {
      if (!peaks.length || i - peaks[peaks.length - 1]! >= minGap) peaks.push(i)
    }
  }
  const c0 = peaks[0] ?? 0
  const c1 = peaks[1] ?? slice.length - 1
  const cycleSlice = slice.slice(c0, c1)
  const minFootY = Math.min(...cycleSlice.map(p => Math.min(p.Foot_L![1], p.Foot_R![1], p.Toes_L![1], p.Toes_R![1])))
  const meanPelvisY = cycleSlice.reduce((s, p) => s + p.Hips![1], 0) / cycleSlice.length
  const dur = cycleSlice.length * bvh.dt
  const dist = slice[c1]!.Hips![0] - slice[c0]!.Hips![0]
  const speed = r2(dist / Math.max(0.1, dur))

  const retargeted = cycleSlice.map(p => retargetBvhFrame(p, meanPelvisY, minFootY))
  // Symmetrize L and R half-cycles in mocap so left/right limb idiosyncrasies of a single actor trial don't bias symmetry checks,
  // while preserving the exact recorded mocap waveform shape and amplitude!
  const n = retargeted.length
  const symmetrized = retargeted.map((f, idx) => {
    const oppIdx = (idx + Math.floor(n / 2)) % n
    const opp = retargeted[oppIdx]!
    const mirrorV = (v: V3): V3 => [v[0], v[1], -v[2]]
    const avgV = (a: V3, b: V3): V3 => [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
    return {
      pelvis: avgV(f.pelvis, mirrorV(opp.pelvis)),
      waist: avgV(f.waist, mirrorV(opp.waist)),
      chest: avgV(f.chest, mirrorV(opp.chest)),
      neck: avgV(f.neck, mirrorV(opp.neck)),
      headTop: avgV(f.headTop, mirrorV(opp.headTop)),
      shoulderL: avgV(f.shoulderL, mirrorV(opp.shoulderR)),
      elbowL: avgV(f.elbowL, mirrorV(opp.elbowR)),
      wristL: avgV(f.wristL, mirrorV(opp.wristR)),
      shoulderR: avgV(f.shoulderR, mirrorV(opp.shoulderL)),
      elbowR: avgV(f.elbowR, mirrorV(opp.elbowL)),
      wristR: avgV(f.wristR, mirrorV(opp.wristL)),
      hipL: avgV(f.hipL, mirrorV(opp.hipR)),
      kneeL: avgV(f.kneeL, mirrorV(opp.kneeR)),
      ankleL: avgV(f.ankleL, mirrorV(opp.ankleR)),
      toeL: avgV(f.toeL, mirrorV(opp.toeR)),
      hipR: avgV(f.hipR, mirrorV(opp.hipL)),
      kneeR: avgV(f.kneeR, mirrorV(opp.kneeL)),
      ankleR: avgV(f.ankleR, mirrorV(opp.ankleL)),
      toeR: avgV(f.toeR, mirrorV(opp.toeL)),
    }
  })

  return buildCycleFromJointFrames(`mocap-${mode}`, mode, speed, dur, symmetrized, 0)
}

/**
 * Classic Richard Williams (Animator's Survival Kit) 8-phase key poses authored as joint angles:
 * 0/8 L Contact, 1/8 L Down, 2/8 L Passing, 3/8 L Up, 4/8 R Contact, 5/8 R Down, 6/8 R Passing, 7/8 R Up.
 */
export function buildWilliamsReferenceCycle(mode: "walk" | "run"): CycleData {
  // Half-cycle waveforms [0/8, 1/8, 2/8, 3/8] for Left side; Right side is shifted by 4/8.
  const walkHalf = [
    // 0/8: L Contact (L leg extended forward, L arm back at peak extension, R arm forward at peak flexion)
    { shFlex: -24, shAbd: 11, elbFlex: 12, hipFlex: 28, kneeFlex: 8, ankPitch: 10, bobCm: 0.2 },
    // 1/8: L Down / Loading (arms widest/delayed follow-through, L knee absorbs load)
    { shFlex: -21, shAbd: 11, elbFlex: 10, hipFlex: 20, kneeFlex: 22, ankPitch: 0, bobCm: -2.1 },
    // 2/8: L Passing (L arm passes hip at lowest point of pendulum arc, R leg swings past stance ankle)
    { shFlex: -4, shAbd: 9, elbFlex: 18, hipFlex: 4, kneeFlex: 12, ankPitch: 2, bobCm: 0.0 },
    // 3/8: L Up / Push-off (L arm swings forward, L heel lifts in terminal stance)
    { shFlex: 13, shAbd: 10, elbFlex: 28, hipFlex: -12, kneeFlex: 10, ankPitch: -12, bobCm: 2.0 },
    // 4/8: R Contact (L arm at peak forward swing, R leg extended forward)
    { shFlex: 22, shAbd: 11, elbFlex: 34, hipFlex: -15, kneeFlex: 28, ankPitch: -16, bobCm: 0.2 },
    // 5/8: R Down (L arm starts backswing with forearm follow-through, L leg lifts into swing)
    { shFlex: 19, shAbd: 11, elbFlex: 35, hipFlex: 2, kneeFlex: 62, ankPitch: -10, bobCm: -2.1 },
    // 6/8: R Passing (L leg high knee passing, L arm swings back past hip)
    { shFlex: 4, shAbd: 9, elbFlex: 20, hipFlex: 26, kneeFlex: 66, ankPitch: 6, bobCm: 0.0 },
    // 7/8: R Up (L leg extends for heel strike, L arm reaches back)
    { shFlex: -14, shAbd: 10, elbFlex: 13, hipFlex: 31, kneeFlex: 24, ankPitch: 12, bobCm: 2.0 },
  ]

  const runHalf = [
    // 0/8: L Contact (L foot touches down under COM, L arm driven back with ~88° bend, R arm pumped forward/up)
    { shFlex: -52, shAbd: 16, elbFlex: 88, hipFlex: 34, kneeFlex: 26, ankPitch: 6, bobCm: -0.4 },
    // 1/8: L Down / Mid-Stance (max load absorption, L arm sweeping forward from backswing)
    { shFlex: -32, shAbd: 14, elbFlex: 88, hipFlex: 18, kneeFlex: 48, ankPitch: 10, bobCm: -3.0 },
    // 2/8: L Toe-Off (explosive push-off, L arm crosses hip pumping upward)
    { shFlex: 8, shAbd: 12, elbFlex: 102, hipFlex: -24, kneeFlex: 18, ankPitch: -18, bobCm: 0.5 },
    // 3/8: Flight L->R (peak airborne reach, L arm at forward/upward pump peak)
    { shFlex: 24, shAbd: 14, elbFlex: 112, hipFlex: -32, kneeFlex: 68, ankPitch: -14, bobCm: 2.8 },
    // 4/8: R Contact (L arm beginning return from forward upper-cut peak, L leg folding behind)
    { shFlex: 16, shAbd: 15, elbFlex: 106, hipFlex: -14, kneeFlex: 108, ankPitch: -8, bobCm: -0.4 },
    // 5/8: R Down (L arm sweeping downward/backward past waist, L knee driving through)
    { shFlex: -10, shAbd: 14, elbFlex: 82, hipFlex: 22, kneeFlex: 116, ankPitch: 2, bobCm: -3.0 },
    // 6/8: R Toe-Off (L knee high in front, L elbow driving behind torso with ~82° bend)
    { shFlex: -40, shAbd: 16, elbFlex: 82, hipFlex: 46, kneeFlex: 82, ankPitch: 10, bobCm: 0.5 },
    // 7/8: Flight R->L (L leg extending down toward contact, L arm at backswing peak)
    { shFlex: -54, shAbd: 16, elbFlex: 90, hipFlex: 40, kneeFlex: 36, ankPitch: 8, bobCm: 2.8 },
  ]

  const src = mode === "walk" ? walkHalf : runHalf
  const trunkPitch = mode === "walk" ? 3.5 : 14.0
  const frames: RigJointMap[] = []
  const denseN = 64
  for (let i = 0; i < denseN; i++) {
    const u = (i / denseN) * 8
    const sampleChannel = (fn: (row: (typeof src)[number]) => number, offset = 0) => {
      const pos = (u + offset) % 8
      const i0 = Math.floor(pos)
      const i1 = (i0 + 1) % 8
      const iPrev = (i0 + 7) % 8
      const iNext = (i1 + 1) % 8
      const t = pos - i0
      // Catmull-Rom spline across the 8 periodic key poses for smooth C1 reference curves
      const p0 = fn(src[iPrev]!), p1 = fn(src[i0]!), p2 = fn(src[i1]!), p3 = fn(src[iNext]!)
      const t2 = t * t, t3 = t2 * t
      return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }
    const keyAngles: KeyPoseAngles = {
      trunkPitchDeg: trunkPitch,
      pelvisBobCm: sampleChannel(r => r.bobCm, 0),
      shoulderFlexL: sampleChannel(r => r.shFlex, 0),
      shoulderFlexR: sampleChannel(r => r.shFlex, 4),
      shoulderAbdL: sampleChannel(r => r.shAbd, 0),
      shoulderAbdR: sampleChannel(r => r.shAbd, 4),
      elbowFlexL: sampleChannel(r => r.elbFlex, 0),
      elbowFlexR: sampleChannel(r => r.elbFlex, 4),
      forearmInwardL: mode === "walk" ? 6 : 14,
      forearmInwardR: mode === "walk" ? 6 : 14,
      hipFlexL: sampleChannel(r => r.hipFlex, 0),
      hipFlexR: sampleChannel(r => r.hipFlex, 4),
      kneeFlexL: sampleChannel(r => r.kneeFlex, 0),
      kneeFlexR: sampleChannel(r => r.kneeFlex, 4),
      anklePitchL: sampleChannel(r => r.ankPitch, 0),
      anklePitchR: sampleChannel(r => r.ankPitch, 4),
    }
    frames.push(jointsFromAngles(keyAngles))
  }

  const speed = mode === "walk" ? 1.4 : 4.2
  const dur = mode === "walk" ? 0.85 : 0.52
  return buildCycleFromJointFrames(`williams-${mode}`, mode, speed, dur, frames, 0)
}

export type JointErrorVector2D = {
  joint: PoseJointId
  ours: [number, number]
  ref: [number, number]
  dx: number
  dy: number
  dist: number
}

export type CycleComparison = {
  targetName: string
  refName: string
  mode: "walk" | "run"
  angleRmseDeg: {
    shoulderFlex: number
    shoulderAbd: number
    elbowFlex: number
    forearmPitch: number
    hipFlex: number
    kneeFlex: number
    anklePitch: number
    meanArmAngleRmse: number
    meanLegAngleRmse: number
    overallAngleRmse: number
  }
  positionRmse: {
    wristRelHipXCm: number
    wristRelHipYCm: number
    side2DNorm: number
    front2DNorm: number
  }
  kinematics: {
    ours: {
      shoulderFlexMinDeg: number
      shoulderFlexMaxDeg: number
      shoulderFlexP2PDeg: number
      elbowFlexMinDeg: number
      elbowFlexMaxDeg: number
      elbowFlexRangeDeg: number
      forearmPitchMinDeg: number
      forearmPitchMaxDeg: number
      wristRelHipXMinCm: number
      wristRelHipXMaxCm: number
      wristRelHipYMinCm: number
      wristRelHipYMaxCm: number
      elbowRelTorsoXMinCm: number
      elbowRelTorsoXMaxCm: number
      armOppositeLegCorr: number
      armPhaseLagDeg: number
    }
    ref: {
      shoulderFlexMinDeg: number
      shoulderFlexMaxDeg: number
      shoulderFlexP2PDeg: number
      elbowFlexMinDeg: number
      elbowFlexMaxDeg: number
      elbowFlexRangeDeg: number
      forearmPitchMinDeg: number
      forearmPitchMaxDeg: number
      wristRelHipXMinCm: number
      wristRelHipXMaxCm: number
      wristRelHipYMinCm: number
      wristRelHipYMaxCm: number
      elbowRelTorsoXMinCm: number
      elbowRelTorsoXMaxCm: number
      armOppositeLegCorr: number
      armPhaseLagDeg: number
    }
  }
  phase8ErrorsSide: JointErrorVector2D[][]
}

function rmsePair(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i]! - b[i]!) ** 2
  return Math.sqrt(s / n)
}

function computeArmPhaseStats(samples: PhaseSample[]) {
  const n = samples.length
  const shL = samples.map(s => s.angles.shoulderFlexL)
  const hipR = samples.map(s => s.angles.hipFlexR)
  const mSh = shL.reduce((a, b) => a + b, 0) / n
  const mHip = hipR.reduce((a, b) => a + b, 0) / n
  let cov = 0, vSh = 0, vHip = 0
  for (let i = 0; i < n; i++) {
    const ds = shL[i]! - mSh, dh = hipR[i]! - mHip
    cov += ds * dh
    vSh += ds * ds
    vHip += dh * dh
  }
  const corr = cov / Math.max(1e-9, Math.sqrt(vSh * vHip))

  // Circular cross-correlation over the N=64 periodic cycle samples:
  // Positive lag means arm peaks AFTER the opposite leg's forward hip flexion peak.
  let bestLag = 0, bestDot = -Infinity
  const maxShift = Math.floor(n / 4)
  for (let lag = -maxShift; lag <= maxShift; lag++) {
    let d = 0
    for (let i = 0; i < n; i++) {
      const j = (i + lag + n) % n
      d += (shL[j]! - mSh) * (hipR[i]! - mHip)
    }
    if (d > bestDot) {
      bestDot = d
      bestLag = lag
    }
  }
  const lagDeg = (bestLag / n) * 360

  const elb = samples.flatMap(s => [s.angles.elbowFlexL, s.angles.elbowFlexR])
  const sh = samples.flatMap(s => [s.angles.shoulderFlexL, s.angles.shoulderFlexR])
  const fa = samples.flatMap(s => [s.angles.forearmPitchL, s.angles.forearmPitchR])
  const wx = samples.flatMap(s => [s.angles.wristRelHipL[0], s.angles.wristRelHipR[0]])
  const wy = samples.flatMap(s => [s.angles.wristRelHipL[1], s.angles.wristRelHipR[1]])
  const ex = samples.flatMap(s => [s.angles.elbowRelTorsoL[0], s.angles.elbowRelTorsoR[0]])

  return {
    shoulderFlexMinDeg: r2(Math.min(...sh)),
    shoulderFlexMaxDeg: r2(Math.max(...sh)),
    shoulderFlexP2PDeg: r2(Math.max(...sh) - Math.min(...sh)),
    elbowFlexMinDeg: r2(Math.min(...elb)),
    elbowFlexMaxDeg: r2(Math.max(...elb)),
    elbowFlexRangeDeg: r2(Math.max(...elb) - Math.min(...elb)),
    forearmPitchMinDeg: r2(Math.min(...fa)),
    forearmPitchMaxDeg: r2(Math.max(...fa)),
    wristRelHipXMinCm: r2(Math.min(...wx)),
    wristRelHipXMaxCm: r2(Math.max(...wx)),
    wristRelHipYMinCm: r2(Math.min(...wy)),
    wristRelHipYMaxCm: r2(Math.max(...wy)),
    elbowRelTorsoXMinCm: r2(Math.min(...ex)),
    elbowRelTorsoXMaxCm: r2(Math.max(...ex)),
    armOppositeLegCorr: r4(corr),
    armPhaseLagDeg: r2(lagDeg),
  }
}

/** Compare our gait cycle against a reference gait cycle (Mocap or Williams key poses). */
export function compareCycles(ours: CycleData, ref: CycleData): CycleComparison {
  const oS = ours.denseSamples
  const rS = ref.denseSamples

  const shFlexRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.shoulderFlexL), rS.map(s => s.angles.shoulderFlexL)),
    rmsePair(oS.map(s => s.angles.shoulderFlexR), rS.map(s => s.angles.shoulderFlexR)),
  ) / Math.SQRT2
  const shAbdRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.shoulderAbdL), rS.map(s => s.angles.shoulderAbdL)),
    rmsePair(oS.map(s => s.angles.shoulderAbdR), rS.map(s => s.angles.shoulderAbdR)),
  ) / Math.SQRT2
  const elbRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.elbowFlexL), rS.map(s => s.angles.elbowFlexL)),
    rmsePair(oS.map(s => s.angles.elbowFlexR), rS.map(s => s.angles.elbowFlexR)),
  ) / Math.SQRT2
  const faRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.forearmPitchL), rS.map(s => s.angles.forearmPitchL)),
    rmsePair(oS.map(s => s.angles.forearmPitchR), rS.map(s => s.angles.forearmPitchR)),
  ) / Math.SQRT2
  const hipRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.hipFlexL), rS.map(s => s.angles.hipFlexL)),
    rmsePair(oS.map(s => s.angles.hipFlexR), rS.map(s => s.angles.hipFlexR)),
  ) / Math.SQRT2
  const kneeRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.kneeFlexL), rS.map(s => s.angles.kneeFlexL)),
    rmsePair(oS.map(s => s.angles.kneeFlexR), rS.map(s => s.angles.kneeFlexR)),
  ) / Math.SQRT2
  const ankRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.anklePitchL), rS.map(s => s.angles.anklePitchL)),
    rmsePair(oS.map(s => s.angles.anklePitchR), rS.map(s => s.angles.anklePitchR)),
  ) / Math.SQRT2

  const wxRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.wristRelHipL[0]), rS.map(s => s.angles.wristRelHipL[0])),
    rmsePair(oS.map(s => s.angles.wristRelHipR[0]), rS.map(s => s.angles.wristRelHipR[0])),
  ) / Math.SQRT2
  const wyRmse = Math.hypot(
    rmsePair(oS.map(s => s.angles.wristRelHipL[1]), rS.map(s => s.angles.wristRelHipL[1])),
    rmsePair(oS.map(s => s.angles.wristRelHipR[1]), rS.map(s => s.angles.wristRelHipR[1])),
  ) / Math.SQRT2

  let sideSq = 0, frontSq = 0, countJoints = 0
  for (let i = 0; i < oS.length; i++) {
    const oSide = oS[i]!.orthoSide.points, rSide = rS[i]!.orthoSide.points
    const oFront = oS[i]!.orthoFront.points, rFront = rS[i]!.orthoFront.points
    for (const id of POSE_JOINTS) {
      sideSq += (oSide[id][0] - rSide[id][0]) ** 2 + (oSide[id][1] - rSide[id][1]) ** 2
      frontSq += (oFront[id][0] - rFront[id][0]) ** 2 + (oFront[id][1] - rFront[id][1]) ** 2
      countJoints++
    }
  }

  const phase8ErrorsSide: JointErrorVector2D[][] = ours.phases8.map((oP, k) => {
    const rP = ref.phases8[k]!
    return POSE_JOINTS.map(joint => {
      const oPt = oP.orthoSide.points[joint]
      const rPt = rP.orthoSide.points[joint]
      const dx = oPt[0] - rPt[0]
      const dy = oPt[1] - rPt[1]
      return {
        joint,
        ours: [r4(oPt[0]), r4(oPt[1])],
        ref: [r4(rPt[0]), r4(rPt[1])],
        dx: r4(dx),
        dy: r4(dy),
        dist: r4(Math.hypot(dx, dy)),
      }
    })
  })

  const meanArmAngleRmse = (shFlexRmse + shAbdRmse + elbRmse + faRmse) / 4
  const meanLegAngleRmse = (hipRmse + kneeRmse + ankRmse) / 3
  const overallAngleRmse = (shFlexRmse + shAbdRmse + elbRmse + faRmse + hipRmse + kneeRmse + ankRmse) / 7

  return {
    targetName: ours.name,
    refName: ref.name,
    mode: ours.mode,
    angleRmseDeg: {
      shoulderFlex: r2(shFlexRmse),
      shoulderAbd: r2(shAbdRmse),
      elbowFlex: r2(elbRmse),
      forearmPitch: r2(faRmse),
      hipFlex: r2(hipRmse),
      kneeFlex: r2(kneeRmse),
      anklePitch: r2(ankRmse),
      meanArmAngleRmse: r2(meanArmAngleRmse),
      meanLegAngleRmse: r2(meanLegAngleRmse),
      overallAngleRmse: r2(overallAngleRmse),
    },
    positionRmse: {
      wristRelHipXCm: r2(wxRmse),
      wristRelHipYCm: r2(wyRmse),
      side2DNorm: r4(Math.sqrt(sideSq / Math.max(1, countJoints))),
      front2DNorm: r4(Math.sqrt(frontSq / Math.max(1, countJoints))),
    },
    kinematics: {
      ours: computeArmPhaseStats(oS),
      ref: computeArmPhaseStats(rS),
    },
    phase8ErrorsSide,
  }
}
