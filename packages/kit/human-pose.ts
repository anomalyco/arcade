import { add, at, clamp, cross, dirIn, dot, ik, len, lerp3, limb, moved, pitch, RIG, scale, smooth, sub, yawFrame, type Frame, type V3 } from "./rig"
import { plantedFoot, type Locomotion } from "./human-locomotion"

export type HumanBody = {
  pelvis: Frame; torso: Frame; head: Frame
  ua: [Frame, Frame]; fa: [Frame, Frame]; th: [Frame, Frame]; sh: [Frame, Frame]; ft: [Frame, Frame]
}

/** Solve the arms after the final torso attitude and action-specific hand targets are known. */
export function poseArms(torso: Frame, left: V3, right: V3): Pick<HumanBody, "ua" | "fa"> {
  const shL = at(torso, 0, RIG.shoulderY, -RIG.shoulderW), shR = at(torso, 0, RIG.shoulderY, RIG.shoulderW)
  const [eL, hL] = ik(shL, left, RIG.upper, RIG.fore, dirIn(torso, -0.15, -1, -1.1))
  const [eR, hR] = ik(shR, right, RIG.upper, RIG.fore, dirIn(torso, -0.5, -1, 0.8))
  return { ua: [limb(shL, eL, torso.x, torso.y), limb(shR, eR, torso.x, torso.y)],
    fa: [limb(eL, hL, [0, 1, 0], torso.x), limb(eR, hR, [0, 1, 0], torso.x)] }
}

/** Contact owns the rendered boot; relaxed swing ankles recover before touchdown. */
export function poseLegs(a: Locomotion, pelvis: Frame): Pick<HumanBody, "th" | "sh" | "ft"> {
  const th: Frame[] = [], sh: Frame[] = [], ft: Frame[] = [], m = a.motion
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1, f = a.feet[i]!
    const hip = at(pelvis, 0, 0, side * RIG.hipW)
    const contact = f.planted ? plantedFoot(a, i) : null
    const ankle: V3 = contact?.p ?? [f.p[0], f.p[1] + RIG.ankle, f.p[2]]
    const pole = dirIn(pelvis, 1, 0, side * 0.3)
    const [knee, ank] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
    th.push(limb(hip, knee, pole, pelvis.x)); sh.push(limb(knee, ank, pole, pelvis.x))
    const u = m.swings[i]!
    const swingReach = !f.planted ? smooth(u / 0.22) * (1 - smooth((u - 0.75) / 0.25)) : 0
    let foot = contact ?? pitch(yawFrame(lerp3(ankle, ank, swingReach), f.yaw), f.pitch)
    if (!f.planted) {
      const relaxed = smooth(u / 0.22) * (1 - smooth((u - 0.68) / 0.32))
      const shinPitch = Math.atan2(sh[i]!.x[1], Math.hypot(sh[i]!.x[0], sh[i]!.x[2]))
      foot = pitch(foot, (shinPitch - 0.12 - f.pitch) * relaxed)
      const low = Math.min(at(foot, -0.08, -RIG.ankle, 0)[1], at(foot, 0.19, -RIG.ankle, 0)[1])
      if (low < 0) foot = moved(foot, [foot.p[0], foot.p[1] - low, foot.p[2]])
    }
    ft.push(foot)
  }
  return { th: [th[0]!, th[1]!], sh: [sh[0]!, sh[1]!], ft: [ft[0]!, ft[1]!] }
}

export function jointVelocities(points: V3[], previous: V3[], dt: number, limit = 15): V3[] {
  return points.map((p, i) => p.map((v, axis) => dt > 0 && previous[i] ? clamp((v - previous[i]![axis]!) / dt, -limit, limit) : 0) as V3)
}
/** Semantic IDs are independent of array order and model registration. Left is index 0. */
export const boneIds = ["pelvis", "torso", "head", "left.upperArm", "right.upperArm", "left.foreArm", "right.foreArm",
  "left.thigh", "right.thigh", "left.shin", "right.shin", "left.foot", "right.foot"] as const
export type BoneId = typeof boneIds[number]
/** Stable cosmetic IDs, not array positions or renderer model IDs. Never renumber existing entries. */
export const limbIds = {
  pelvis: 0, torso: 1, head: 2,
  "left.upperArm": 3, "right.upperArm": 4, "left.foreArm": 5, "right.foreArm": 6,
  "left.thigh": 7, "right.thigh": 8, "left.shin": 9, "right.shin": 10, "left.foot": 11, "right.foot": 12,
} as const satisfies Record<BoneId, number>
export type BonePose = Partial<Record<BoneId, Frame>>
export type HiddenBones = ReadonlySet<BoneId>
export const boneParent: Record<BoneId, BoneId | null> = {
  pelvis: null, torso: "pelvis", head: "torso",
  "left.upperArm": "torso", "right.upperArm": "torso", "left.foreArm": "left.upperArm", "right.foreArm": "right.upperArm",
  "left.thigh": "pelvis", "right.thigh": "pelvis", "left.shin": "left.thigh", "right.shin": "right.thigh",
  "left.foot": "left.shin", "right.foot": "right.shin",
}
export function bodyBones(b: HumanBody): BonePose {
  return { pelvis: b.pelvis, torso: b.torso, head: b.head,
    "left.upperArm": b.ua[0], "right.upperArm": b.ua[1], "left.foreArm": b.fa[0], "right.foreArm": b.fa[1],
    "left.thigh": b.th[0], "right.thigh": b.th[1], "left.shin": b.sh[0], "right.shin": b.sh[1],
    "left.foot": b.ft[0], "right.foot": b.ft[1] }
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
