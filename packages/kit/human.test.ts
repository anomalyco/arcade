import { expect, test } from "bun:test"
import { locomotion, newMotion, pelvisPoint, type Locomotion, type Foot } from "./human-locomotion"
import { humanProfiles, profileHands, profileTorso } from "./human-profile"
import { attachment, bodyBones, boneVisible, detach, frameMotion, limbIds, pointVelocity, poseArms, poseLegs, type BoneId } from "./human-pose"
import { at, len, moved, scale, spring, turn, yawFrame, RIG, type V3 } from "./rig"

function actor(): Locomotion {
  const foot = (): Foot => ({ p: [0, 0, 0], yaw: 0, pitch: 0, planted: true, lift: [0, 0, 0], liftYaw: 0 })
  return { x: 0, y: 0, vx: 1.1, vy: 0, svx: 1.1, svy: 0, acx: 0, acy: 0, aim: 0, legYaw: 0,
    gait: 1, duty: 0.6, phase: 0, back: false, turning: false, feet: [foot(), foot()], motion: newMotion(0, 0, 0),
    leanX: spring(), leanY: spring(), dip: spring(), hitX: spring(), hitY: spring() }
}

test("shared zombie gait locks toes, bounds uneven timing and drags only the swing foot", () => {
  const a = actor(), dt = 1 / 60, profile = humanProfiles.zombie
  let contacts = 0, leftLift = 0, rightLift = 0
  for (let n = 0; n < 360; n++) {
    const before = a.feet.map(f => f.planted), toes = a.motion.toes.map((p): V3 => [...p])
    a.x += a.vx * dt
    locomotion(a, dt, a.vx * dt, n === 0, profile)
    const pelvis = yawFrame(pelvisPoint(a), a.motion.pelvis.x)
    const legs = poseLegs(a, pelvis)
    for (let i = 0; i < 2; i++) {
      if (n > 0 && before[i] && a.feet[i]!.planted) {
        expect(a.motion.toes[i]).toEqual(toes[i])
        const toe = at(legs.ft[i]!, 0.19, -RIG.ankle, 0)
        toe.forEach((v, j) => expect(v).toBeCloseTo(toes[i]![j]!, 12))
        contacts++
      }
      expect(a.motion.durations[i]!).toBeGreaterThanOrEqual(0.077)
      expect(a.motion.durations[i]!).toBeLessThanOrEqual(0.39)
    }
    leftLift = Math.max(leftLift, a.feet[0].p[1]); rightLift = Math.max(rightLift, a.feet[1].p[1])
  }
  expect(contacts).toBeGreaterThan(100)
  expect(leftLift).toBeGreaterThan(0.06)
  expect(rightLift).toBeLessThan(leftLift * 0.2)
  expect(a.motion.durations[1]!).toBeGreaterThan(a.motion.durations[0]!)
})

test("preset and extreme asymmetries produce finite poses with any hidden subtree", () => {
  for (const preset of Object.values(humanProfiles)) for (const sign of [-1, 1]) {
    const a = actor(), profile = { ...preset, timingBias: sign * 20, armAsymmetry: sign * 20, torsoRoll: sign * 20 }
    for (let n = 0; n < 120; n++) {
      a.x += 1.1 / 60
      locomotion(a, 1 / 60, 1.1 / 60, n === 0, profile)
      const pelvis = yawFrame(pelvisPoint(a), a.motion.pelvis.x)
      const torso = profileTorso(yawFrame(at(pelvis, 0, RIG.waist, 0), 0), profile)
      const hands = profileHands(torso, profile) ?? [at(torso, 0.3, 0.3, -0.1), at(torso, 0.3, 0.3, 0.1)]
      const bones = bodyBones({ pelvis, torso, head: yawFrame(at(torso, 0.02, RIG.neckY, 0), 0), ...poseArms(torso, ...hands), ...poseLegs(a, pelvis) })
      for (const frame of Object.values(bones)) expect(Object.values(frame).flat().every(Number.isFinite)).toBe(true)
      for (const root of ["left.thigh", "right.upperArm", "head", "pelvis"] as const) {
        const hidden = new Set<BoneId>()
        const parts = detach(bones, undefined, 1 / 60, root, hidden)
        expect(parts.length).toBeGreaterThan(0)
        expect(parts.every(part => !boneVisible(part.bone, hidden))).toBe(true)
        expect(detach(bones, undefined, 1 / 60, root, hidden)).toEqual([])
        if (root === "right.upperArm" || root === "pelvis") expect(attachment(bones, "right.hand", hidden)).toBeNull()
      }
    }
  }
})

test("detachment copies exact frames and seeds translational and angular velocity", () => {
  for (const angle of [0, 0.12, Math.PI]) {
    const previous = yawFrame([1, 2, 3], 0.7), axis: V3 = scale([1, 2, 3], 1 / Math.sqrt(14))
    const current = moved(turn(previous, axis, angle), [1.04, 2.02, 2.98])
    const hidden = new Set<BoneId>()
    const [piece] = detach({ "right.foreArm": current }, { "right.foreArm": previous }, 0.02, "right.foreArm", hidden)
    expect(piece!.frame).toEqual(current)
    expect(piece!.linear[0]).toBeCloseTo(2, 10)
    expect(piece!.linear[1]).toBeCloseTo(1, 10)
    expect(piece!.linear[2]).toBeCloseTo(-1, 10)
    const speed = len(piece!.angular)
    const reconstructed = speed ? turn(previous, scale(piece!.angular, 1 / speed), speed * 0.02) : previous
    for (const key of ["x", "y", "z"] as const) current[key].forEach((v, j) => expect(reconstructed[key][j]!).toBeCloseTo(v, 7))
    piece!.frame.p[0] = 999; piece!.frame.x[0] = 999
    expect(current.p[0]).toBe(1.04)
    expect(current.x[0]).not.toBe(999)
  }
  expect(frameMotion(yawFrame([0, 0, 0], 0), undefined, 0).angular).toEqual([0, 0, 0])
  expect(detach({}, {}, 0.02, "head", new Set())).toEqual([])
})

test("cosmetic limb IDs remain stable and offset emitters inherit rotational motion", () => {
  expect(limbIds).toEqual({ pelvis: 0, torso: 1, head: 2, "left.upperArm": 3, "right.upperArm": 4,
    "left.foreArm": 5, "right.foreArm": 6, "left.thigh": 7, "right.thigh": 8,
    "left.shin": 9, "right.shin": 10, "left.foot": 11, "right.foot": 12 })
  const frame = yawFrame([10, 2, 4], 0)
  const part = { frame, linear: [1, 0, 0] as V3, angular: [0, 0, 2] as V3 }
  expect(pointVelocity(part, frame.p)).toEqual([1, 0, 0])
  expect(pointVelocity(part, [10, 1.5, 4])).toEqual([2, 0, 0])
  expect(pointVelocity(part, [10, 2.5, 4])).toEqual([0, 0, 0])
})
