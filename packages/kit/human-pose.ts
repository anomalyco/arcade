import { add, at, clamp, cross, dirIn, dot, ik, len, lerp3, limb, moved, pitch, RIG, scale, smooth, smoother, sub, yawFrame, type Frame, type V3 } from "./rig"
import { plantedFoot, plantedToe, type Locomotion } from "./human-locomotion"

export type HumanBody = {
  pelvis: Frame; torso: Frame; head: Frame
  ua: [Frame, Frame]; fa: [Frame, Frame]; th: [Frame, Frame]; sh: [Frame, Frame]; ft: [Frame, Frame]; toe?: [Frame, Frame]
}

/** Solve the arms after the final torso attitude and action-specific hand targets are known. */
export function poseArms(torso: Frame, left: V3, right: V3): Pick<HumanBody, "ua" | "fa"> {
  const shL = at(torso, 0, RIG.shoulderY, -RIG.shoulderW), shR = at(torso, 0, RIG.shoulderY, RIG.shoulderW)
  const [eL, hL] = ik(shL, left, RIG.upper, RIG.fore, dirIn(torso, -0.15, -1, -1.1))
  const [eR, hR] = ik(shR, right, RIG.upper, RIG.fore, dirIn(torso, -0.5, -1, 0.8))
  return { ua: [limb(shL, eL, torso.x, torso.y), limb(shR, eR, torso.x, torso.y)],
    fa: [limb(eL, hL, [0, 1, 0], torso.x), limb(eR, hR, [0, 1, 0], torso.x)] }
}

export type UnarmedRigState = {
  gait: number
  motion: {
    run: number
    arms: readonly [ { x: number }, { x: number } ]
    hands: readonly [ { x: number }, { x: number } ]
  }
}

const DEG = Math.PI / 180

/**
 * Two-stage spring-driven unarmed hand targets calibrated against walk/run mocap and Williams key poses:
 * - Walk (1.4 m/s): shoulder sagittal swing [-29°, +18°], elbow flexion [7°, 35°] peaking on forward swing,
 *   natural ~12° coronal abduction, and true pendulum arc passing near the hip.
 * - Run (4.2 m/s): shoulder sagittal swing [-74°, +10°], compact bent-elbow pump [72°, 117°] peaking on
 *   forward swing with forearm angled upward (+5°..+121°), and slight medial cross toward centerline.
 */
export function unarmedHands(a: UnarmedRigState, torso: Frame, breathPhase = 0): [V3, V3] {
  const m = a.motion, gait = clamp(a.gait, 0, 1), run = clamp(m.run * gait, 0, 1)
  const crouchAmt = clamp(((m as { crouch?: { x: number } }).crouch?.x ?? 0) - 0.025, 0, 0.08) / 0.065
  const swNorm = 0.1575 + 0.1885 * run
  const hwNorm = 0.1518 + 0.1720 * run

  const hand = (i: 0 | 1): V3 => {
    const side = i === 0 ? -1 : 1
    const sw = m.arms[i]!.x, hw = m.hands[i]!.x
    const s = clamp(sw / swNorm, -1.35, 1.35)
    const h = clamp(hw / hwNorm, -1.35, 1.35)
    const q = clamp((s - h) * (2.6 - 0.8 * run), -1.2, 1.2)

    const walkWave = 0.25 * s + 0.75 * h - 0.14 * q
    const walkSh = (-1.6 * gait + walkWave * 23.8) * DEG

    const runWave = 0.22 * s + 0.78 * h - 0.16 * q
    // In a deep crouch-run, compensate for the extra forward torso pitch so world shoulder swing stays compact [-44°..+24°]
    const runShMean = -2.0 + 14.0 * crouchAmt
    const runShAmp = 39.5 * (1 - 0.12 * crouchAmt)
    const runSh = (runShMean * gait + runWave * runShAmp) * DEG
    const shFlex = walkSh + (runSh - walkSh) * run

    const walkAbd = (12.6 + 3.4 * h + 0.8 * q) * DEG
    const runAbd = ((14.5 - 2.2 * crouchAmt) - 3.0 * runWave - 3.5 * q) * DEG
    const shAbd = (walkAbd + (runAbd - walkAbd) * run) * (0.35 + 0.65 * gait) - side * 0.008 * Math.sin(breathPhase)

    const walkElb = (4.0 + 11.2 * gait + 15.8 * (0.2 * s + 0.8 * h) + 3.8 * h * h) * DEG
    const runElb = ((87.5 + 8.5 * crouchAmt) * gait + 15.5 * (0.50 * s + 0.50 * h) + 11.0 * runWave * runWave + 8.5 * q) * DEG
    const elbFlex = clamp(walkElb + (runElb - walkElb) * run, 2 * DEG, 128 * DEG)

    const inward = clamp((2.5 + 3.5 * Math.max(0, h)) * (1 - run) + (9.0 + 4.0 * crouchAmt + 9.0 * Math.max(0, runWave)) * run, 0, 22) * DEG * gait

    const u1 = [
      Math.sin(shFlex) * Math.cos(shAbd),
      -Math.cos(shFlex) * Math.cos(shAbd),
      side * Math.sin(shAbd),
    ] as const
    const faPitch = shFlex + elbFlex
    const faLat = shAbd * (1 - 0.50 * run) - inward
    const u2 = [
      Math.sin(faPitch) * Math.cos(faLat),
      -Math.cos(faPitch) * Math.cos(faLat),
      side * Math.sin(faLat),
    ] as const

    return at(
      torso,
      u1[0] * RIG.upper + u2[0] * RIG.fore,
      RIG.shoulderY + u1[1] * RIG.upper + u2[1] * RIG.fore,
      side * RIG.shoulderW + u1[2] * RIG.upper + u2[2] * RIG.fore,
    )
  }
  return [hand(0), hand(1)]
}

/**
 * Solve unarmed arms with a chord-adaptive posterior-lateral elbow pole so the olecranon stays strictly
 * behind the shoulder->wrist chord even on deep running backswings (preventing lateral pole-crossing flips).
 */
export function poseUnarmedArms(torso: Frame, left: V3, right: V3): Pick<HumanBody, "ua" | "fa"> {
  const solve = (side: -1 | 1, target: V3) => {
    const sh = at(torso, 0, RIG.shoulderY, side * RIG.shoulderW)
    const dWorld = sub(target, sh)
    const dx = dot(dWorld, torso.x)
    const dy = dot(dWorld, torso.y)
    const lift = clamp((dy + 0.35) / 0.45, 0, 1)
    const back = clamp((-dx + 0.10) / 0.35, 0, 1)
    const pole = dirIn(
      torso,
      -0.95 - 0.25 * lift,
      -0.55 + 0.70 * back,
      side * (0.24 + 0.14 * lift),
    )
    const [el, wr] = ik(sh, target, RIG.upper, RIG.fore, pole)
    return {
      ua: limb(sh, el, torso.x, torso.y),
      fa: limb(el, wr, torso.x, torso.y),
    }
  }
  const L = solve(-1, left), R = solve(1, right)
  return { ua: [L.ua, R.ua], fa: [L.fa, R.fa] }
}

/** Contact owns the rendered boot and ball-of-foot toe joint; relaxed swing ankles and toes clear the floor and recover before touchdown. */
export function poseLegs(a: Locomotion, pelvis: Frame): Required<Pick<HumanBody, "th" | "sh" | "ft" | "toe">> {
  const th: Frame[] = [], sh: Frame[] = [], ft: Frame[] = [], toe: Frame[] = [], m = a.motion
  const run = clamp(m.run * a.gait, 0, 1)
  const sp = Math.hypot(a.svx, a.svy)
  const fwdFlow = sp > 0.2 ? clamp((a.svx * Math.cos(a.legYaw) + a.svy * Math.sin(a.legYaw)) / sp, 0, 1) : 0
  const athletic = smooth((fwdFlow - 0.25) / 0.55) * smooth((Math.hypot(a.vx, a.vy) - 0.3) / 0.8)
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1, f = a.feet[i]!
    const hip = at(pelvis, 0, 0, side * RIG.hipW)
    const contact = f.planted ? plantedFoot(a, i) : null
    const u = m.swings[i]!
    // Up-biased pole in pelvis space (+0.28 y) counteracts forward crouch-run pelvis pitch so the
    // pole vector stays above the hip->ankle swing chord and never bows the knee outward.
    const pole = dirIn(pelvis, 1, 0.28, side * 0.25)
    if (contact) {
      const [knee, ank] = ik(hip, contact.p, RIG.thigh, RIG.shin, pole)
      th.push(limb(hip, knee, pole, pelvis.x)); sh.push(limb(knee, ank, pole, pelvis.x))
      ft.push(contact)
      toe.push(plantedToe(a, i, contact))
    } else {
      const isDrag = i === (m.dragFoot ?? 1) && (m.footDrag ?? 0) > 0
      const drag = isDrag ? clamp(m.footDrag ?? 0, 0, 0.95) : 0
      const dragKeep = 1 - drag
      // When crouch-running (m.crouch.x > 0.025), the pelvis is already lowered 8..14 cm toward the floor;
      // scale swing heel-kick so the thigh drives to ~46° instead of jackknifing into the crouched chest.
      const crouchT = clamp(((m.crouch?.x ?? 0) - 0.025) / 0.065, 0, 1)
      const crouchSwingScale = 1 - 0.55 * crouchT
      // Smoothly release from the terminal-stance ball-of-foot pivot over the first 36% of swing,
      // and blend into the heel-strike contact frame over the last 28% of swing so liftoff and touchdown are C1 continuous.
      const liftOffBlend = (1 - smooth(u / (0.36 - 0.10 * run))) * a.gait * dragKeep
      const toeOffPitch = -(0.44 + 0.08 * m.run) * liftOffBlend * (1 - 0.55 * drag)
      const toeFrame = pitch(yawFrame([0, 0, 0], f.yaw), toeOffPitch)
      const ballOff = at(toeFrame, RIG.foot, -RIG.ankle, 0)
      const liftBallX = f.lift[0] + Math.cos(f.liftYaw) * RIG.foot
      const liftBallZ = f.lift[2] + Math.sin(f.liftYaw) * RIG.foot
      const liftAnkX = liftBallX - ballOff[0] - f.lift[0]
      const liftAnkY = Math.max(0, -ballOff[1] - RIG.ankle)
      const liftAnkZ = liftBallZ - ballOff[2] - f.lift[2]

      // Mocap-calibrated swing heel kick-up (butt-kick in mid-swing), early push-off drive, and late-swing heel-tuck lag
      // so 5/8 advances the swing hip, 6/8..7/8 keep the shin tucked under the knee, and u=1 settles at zero velocity.
      const liftVar = m.stepLiftVar?.[i] ?? 1
      const sinU = Math.sin(Math.PI * u)
      const uprightRun = 1 - crouchT
      const lateTaper = 1 - smoother((u - (0.74 + 0.08 * uprightRun)) / 0.16)
      const kickBell = sinU * sinU * (0.42 + 0.92 * Math.pow(u, 0.80)) * lateTaper
      const tuckBell = sinU * sinU * Math.pow(u, 0.95 - 0.10 * uprightRun) * (1.65 + 0.13 * uprightRun) * lateTaper
      const earlyPushFwd = (0.085 * (1 - run) + 0.025 * run * uprightRun) * athletic * Math.sin(Math.PI * clamp(u / 0.46, 0, 1)) ** 2 * dragKeep
      const lateWalkTuck = 0.125 * (1 - run) * athletic * Math.sin(Math.PI * clamp((u - 0.42) / 0.52, 0, 1)) ** 2 * dragKeep
      const heelKickUp = (0.022 * (1 - run) * smooth((u - 0.22) / 0.35) + 0.22 * run * crouchSwingScale) * liftVar * athletic * kickBell * dragKeep
      const heelTuckBack = (0.015 * (1 - run) + (0.24 + 0.035 * uprightRun) * run * (1 - 0.35 * crouchT)) * athletic * tuckBell * dragKeep + lateWalkTuck - earlyPushFwd
      const fwdX = Math.cos(f.yaw), fwdZ = Math.sin(f.yaw)
      const walkEarlyDamp = 1 - 0.62 * (1 - run) * (1 - smooth((u - 0.15) / 0.32))
      const swingLiftY = f.p[1] * (1 - 0.32 * crouchT) * walkEarlyDamp
      const ankle: V3 = [
        f.p[0] + liftAnkX * liftOffBlend - fwdX * heelTuckBack,
        swingLiftY + RIG.ankle + liftAnkY * liftOffBlend * (0.25 + 0.75 * run) + heelKickUp,
        f.p[2] + liftAnkZ * liftOffBlend - fwdZ * heelTuckBack,
      ]
      // When the heel kicks up behind the hip (cx < 0), tilt the pole downward from +0.28 toward -0.35
      // so the pole stays orthogonal to the backward hip->ankle chord without bowing the knee sideways.
      const chord = sub(ankle, hip)
      const cx = dot(chord, pelvis.x)
      const backKick = run * kickBell * clamp(-cx / 0.35, 0, 1) * dragKeep
      const swingPole = dirIn(pelvis, 1, 0.28 - 0.65 * backKick, side * (0.25 - 0.17 * run * kickBell * dragKeep))
      const [knee0, ank0] = ik(hip, ankle, RIG.thigh, RIG.shin, swingPole)
      const sh0 = limb(knee0, ank0, swingPole, pelvis.x)
      const relaxed = smooth(u / 0.12) * (1 - smooth((u - 0.74) / 0.20))
      const tdBlend = smoother((u - 0.72) / 0.28)
      const heelStrike0 = a.back ? 0 : (0.26 - 0.04 * m.run) * (1 - 0.55 * crouchT) * a.gait * dragKeep
      const tdPitch = heelStrike0 * tdBlend
      const basePitch = toeOffPitch + tdPitch + f.pitch * (1 - liftOffBlend) * (1 - tdBlend)
      const swingAnkleRel = -(0.24 + 0.12 * run) * (1 - smooth((u - 0.46) / 0.30)) + (0.04 + (0.16 + 0.08 * uprightRun) * run) * smooth((u - (0.60 - 0.08 * uprightRun)) / 0.26)
      const shinFwd0 = sh0.y[0] * fwdX + sh0.y[2] * fwdZ
      const shinPitch0 = -Math.atan2(shinFwd0, sh0.y[1])
      let footPitch = basePitch + (shinPitch0 + swingAnkleRel - basePitch) * relaxed
      // Toe joint relative pitch: keeps toe dorsiflexed against the floor during early push-off, then dorsiflexes in mid-swing for floor clearance.
      const liftOffToe = Math.max(0, -footPitch) * (1 - smooth(u / 0.34))
      const pushOffCurl = -0.12 * Math.sin(Math.PI * clamp((u - 0.18) / 0.26, 0, 1)) * a.gait * dragKeep
      const swingClearanceToe = (0.20 + 0.10 * run) * Math.sin(Math.PI * clamp((u - 0.28) / 0.56, 0, 1)) * a.gait * dragKeep
      let toeRelPitch = liftOffToe + pushOffCurl + swingClearanceToe - tdPitch
      if (drag > 0) {
        // A dragged foot's ball and toe scrape along the floor rather than pitching underground and levitating the ankle.
        const maxNoseDown = -Math.asin(clamp(Math.max(0, ankle[1] - RIG.ankle) / (RIG.foot + RIG.toe), 0, 0.95))
        footPitch = Math.max(footPitch, maxNoseDown * (1 - drag) + footPitch * (1 - drag))
        // Bend the dragged toe flat along the ground when the midfoot pitches nose-down.
        if (footPitch < 0) toeRelPitch = -footPitch * drag
      }
      const testFoot = pitch(yawFrame(ankle, f.yaw), footPitch)
      const testBall = at(testFoot, RIG.foot, -RIG.ankle, 0)
      const testToe = pitch(yawFrame(testBall, f.yaw), footPitch + toeRelPitch)
      const low = Math.min(at(testFoot, -0.08 * (1 - tdBlend), -RIG.ankle, 0)[1], testBall[1], at(testToe, RIG.toe, 0, 0)[1])
      if (low < 0) ankle[1] -= low
      const [knee, ank] = ik(hip, ankle, RIG.thigh, RIG.shin, swingPole)
      const shFinal = limb(knee, ank, swingPole, pelvis.x)
      if (low < 0 && drag === 0) {
        const shinFwd = shFinal.y[0] * fwdX + shFinal.y[2] * fwdZ
        const shinPitch = -Math.atan2(shinFwd, shFinal.y[1])
        footPitch = basePitch + (shinPitch + swingAnkleRel - basePitch) * relaxed
      }
      th.push(limb(hip, knee, swingPole, pelvis.x)); sh.push(shFinal)
      const swingReach = smooth(u / 0.22) * (1 - smooth((u - 0.68) / 0.24))
      const finalFoot = pitch(yawFrame(lerp3(ankle, ank, swingReach), f.yaw), footPitch)
      const finalBall = at(finalFoot, RIG.foot, -RIG.ankle, 0)
      const finalToe = pitch(yawFrame(finalBall, f.yaw), footPitch + toeRelPitch)
      ft.push(finalFoot)
      toe.push(finalToe)
    }
  }
  return { th: [th[0]!, th[1]!], sh: [sh[0]!, sh[1]!], ft: [ft[0]!, ft[1]!], toe: [toe[0]!, toe[1]!] }
}

/** Active world-locked ground contact pivot on a planted foot: heel during heel-strike roll, ball during foot-flat and heel-rise. */
export function plantedContactPoint(ft: Frame, toe?: Frame): V3 {
  if (!toe) return at(ft, RIG.foot + RIG.toe, -RIG.ankle, 0)
  return toe.p[1] > 1e-5 ? at(ft, -RIG.heel, -RIG.ankle, 0) : toe.p
}

export function jointVelocities(points: V3[], previous: V3[], dt: number, limit = 15): V3[] {
  return points.map((p, i) => p.map((v, axis) => dt > 0 && previous[i] ? clamp((v - previous[i]![axis]!) / dt, -limit, limit) : 0) as V3)
}
/** Semantic IDs are independent of array order and model registration. Left is index 0. */
export const boneIds = ["pelvis", "torso", "head", "left.upperArm", "right.upperArm", "left.foreArm", "right.foreArm",
  "left.thigh", "right.thigh", "left.shin", "right.shin", "left.foot", "right.foot", "left.toe", "right.toe"] as const
export type BoneId = typeof boneIds[number]
/** Stable cosmetic IDs, not array positions or renderer model IDs. Never renumber existing entries. */
export const limbIds = {
  pelvis: 0, torso: 1, head: 2,
  "left.upperArm": 3, "right.upperArm": 4, "left.foreArm": 5, "right.foreArm": 6,
  "left.thigh": 7, "right.thigh": 8, "left.shin": 9, "right.shin": 10, "left.foot": 11, "right.foot": 12,
  "left.toe": 13, "right.toe": 14,
} as const satisfies Record<BoneId, number>
export type BonePose = Partial<Record<BoneId, Frame>>
export type HiddenBones = ReadonlySet<BoneId>
export const boneParent: Record<BoneId, BoneId | null> = {
  pelvis: null, torso: "pelvis", head: "torso",
  "left.upperArm": "torso", "right.upperArm": "torso", "left.foreArm": "left.upperArm", "right.foreArm": "right.upperArm",
  "left.thigh": "pelvis", "right.thigh": "pelvis", "left.shin": "left.thigh", "right.shin": "right.thigh",
  "left.foot": "left.shin", "right.foot": "right.shin", "left.toe": "left.foot", "right.toe": "right.foot",
}
export function bodyBones(b: HumanBody): BonePose {
  const toeL = b.toe?.[0] ?? moved(b.ft[0], at(b.ft[0], RIG.foot, -RIG.ankle, 0))
  const toeR = b.toe?.[1] ?? moved(b.ft[1], at(b.ft[1], RIG.foot, -RIG.ankle, 0))
  return { pelvis: b.pelvis, torso: b.torso, head: b.head,
    "left.upperArm": b.ua[0], "right.upperArm": b.ua[1], "left.foreArm": b.fa[0], "right.foreArm": b.fa[1],
    "left.thigh": b.th[0], "right.thigh": b.th[1], "left.shin": b.sh[0], "right.shin": b.sh[1],
    "left.foot": b.ft[0], "right.foot": b.ft[1], "left.toe": toeL, "right.toe": toeR }
}
export function boneVisible(id: BoneId, hidden?: HiddenBones): boolean {
  for (let bone: BoneId | null = id; bone; bone = boneParent[bone]) if (hidden?.has(bone)) return false
  return true
}
export type AttachmentId = "left.hand" | "right.hand" | "head.top"
const attachments: Record<AttachmentId, { bone: BoneId; point: V3 }> = {
  "left.hand": { bone: "left.foreArm", point: [0, -RIG.fore, 0] },
  "right.hand": { bone: "right.foreArm", point: [0, -RIG.fore, 0] },
  "head.top": { bone: "head", point: [0, 0.26, 0] },
}
export function attachment(pose: BonePose, id: AttachmentId, hidden?: HiddenBones): Frame | null {
  const { bone, point } = attachments[id], frame = pose[bone]
  return frame && boneVisible(bone, hidden) ? { ...frame, p: at(frame, ...point) } : null
}
export const copyFrame = (f: Frame): Frame => ({ p: [...f.p], x: [...f.x], y: [...f.y], z: [...f.z] })

export type PartMotion = { frame: Frame; linear: V3; angular: V3 }
/** Velocity at an attachment or centre of mass, in world XYZ / Y-up. */
export function pointVelocity(part: PartMotion, point: V3): V3 {
  return add(part.linear, cross(part.angular, sub(point, part.frame.p)))
}
/** World-space angular velocity from the shortest relative rotation, including a half turn. */
export function frameMotion(frame: Frame, previous: Frame | undefined, dt: number): PartMotion {
  if (!previous || !(dt > 0) || !Number.isFinite(dt)) return { frame: copyFrame(frame), linear: [0, 0, 0], angular: [0, 0, 0] }
  const axes = ["x", "y", "z"] as const
  const cosine = clamp((axes.reduce((sum, axis) => sum + dot(previous[axis], frame[axis]), 0) - 1) / 2, -1, 1)
  const skew = axes.reduce<V3>((sum, axis) => add(sum, cross(previous[axis], frame[axis])), [0, 0, 0])
  const sine = len(skew) / 2, angle = Math.atan2(sine, cosine)
  let axis: V3 = sine > 1e-7 ? scale(skew, 1 / (2 * sine)) : [0, 0, 0]
  if (sine <= 1e-7 && cosine < 0) {
    // At pi the skew vanishes. A column of R + I gives the rotation axis.
    const columns = axes.map((_, j) => axes.reduce<V3>((sum, key) => add(sum, scale(frame[key], previous[key][j]!)), [0, 0, 0]))
    const candidates = columns.map((column, i) => column.map((v, j) => v + (i === j ? 1 : 0)) as V3)
    const best = candidates.reduce((a, b) => len(a) > len(b) ? a : b)
    axis = scale(best, 1 / (len(best) || 1))
  }
  return { frame: copyFrame(frame), linear: scale(sub(frame.p, previous.p), 1 / dt), angular: scale(axis, angle / dt) }
}

/** Copy at the displayed pose, then hide that subtree. Physics owns the returned pieces, never the source pose.
 * Velocities are at each model origin; v(COM) = linear + angular × (COM - origin).
 * Call after posing and before emitting. A second detach of an already hidden part returns nothing.
 */
export function detach(pose: BonePose, previous: BonePose | undefined, dt: number, root: BoneId, hidden: Set<BoneId>): (PartMotion & { bone: BoneId })[] {
  if (!pose[root] || !boneVisible(root, hidden)) return []
  const parts: (PartMotion & { bone: BoneId })[] = []
  for (const bone of boneIds) {
    let ancestor: BoneId | null = bone
    while (ancestor && ancestor !== root) ancestor = boneParent[ancestor]
    const frame = pose[bone]
    if (ancestor && frame && boneVisible(bone, hidden)) parts.push({ bone, ...frameMotion(frame, previous?.[bone], dt) })
  }
  hidden.add(root)
  return parts
}
