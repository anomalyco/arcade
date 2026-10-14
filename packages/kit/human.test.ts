import { expect, test } from "bun:test"
import { locomotion, newMotion, pelvisPoint, type Locomotion, type Foot } from "./human-locomotion"
import { humanProfiles, profileHands, profileTorso } from "./human-profile"
import { attachment, bodyBones, boneVisible, detach, frameMotion, limbIds, pointVelocity, poseArms, poseLegs, unarmedHands, type BoneId } from "./human-pose"
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

test("mid-swing retargeting, strafe transitions, reversals and pole vector prevent foot kick-outs and knee flips", () => {
  const dt = 1 / 60
  for (const scenario of ["reversal", "strafeCircle", "stop", "mux"] as const) {
    const a = actor()
    let x = 0, y = 0, muxX = 0
    let prevFootP: [V3, V3] | null = null, prevAnkles: [V3, V3] | null = null
    for (let n = 0; n < 240; n++) {
      const vx = scenario === "reversal" ? (n < 90 ? 6.3 : -6.3)
        : scenario === "strafeCircle" ? Math.cos(n / 240 * Math.PI * 2) * 4.2
        : scenario === "stop" ? (n < 120 ? 6.3 : 0) : 4.2
      const vy = scenario === "strafeCircle" ? Math.sin(n / 240 * Math.PI * 2) * 4.2 : 0
      const kv = 1 - Math.exp(-dt * 14)
      const nvx = a.svx + (vx - a.svx) * kv, nvy = a.svy + (vy - a.svy) * kv
      a.acx += ((nvx - a.svx) / dt - a.acx) * (1 - Math.exp(-dt * 10))
      a.acy += ((nvy - a.svy) / dt - a.acy) * (1 - Math.exp(-dt * 10))
      a.svx = nvx; a.svy = nvy; a.vx = vx; a.vy = vy
      if (scenario === "mux") {
        if (n % 2 === 0) muxX += vx * (2 / 60)
        x = muxX
      } else {
        x += vx * dt; y += vy * dt
      }
      const distStep = Math.hypot(x - a.x, y - a.y)
      a.x = x; a.y = y
      locomotion(a, dt, distStep, n === 0, humanProfiles.soldier)
      const pelvis = yawFrame(pelvisPoint(a), a.motion.pelvis.x + a.motion.twist.x)
      const legs = poseLegs(a, pelvis)
      const footP: [V3, V3] = [[...a.feet[0].p], [...a.feet[1].p]]
      const ankles: [V3, V3] = [[...legs.ft[0].p], [...legs.ft[1].p]]
      if (n > 0) {
        for (let i = 0; i < 2; i++) {
          expect(len([footP[i]![0] - prevFootP![i]![0], footP[i]![1] - prevFootP![i]![1], footP[i]![2] - prevFootP![i]![2]])).toBeLessThan(0.35)
          expect(len([ankles[i]![0] - prevAnkles![i]![0], ankles[i]![1] - prevAnkles![i]![1], ankles[i]![2] - prevAnkles![i]![2]])).toBeLessThan(0.35)
        }
      }
      for (let i = 0; i < 2; i++) {
        const hip = legs.th[i]!.p, knee = at(legs.th[i]!, 0, -RIG.thigh, 0), shinEnd = at(legs.sh[i]!, 0, -RIG.shin, 0)
        const mid: V3 = [(hip[0] + shinEnd[0]) * 0.5, (hip[1] + shinEnd[1]) * 0.5, (hip[2] + shinEnd[2]) * 0.5]
        const kneeFwd = (knee[0] - mid[0]) * pelvis.x[0] + (knee[1] - mid[1]) * pelvis.x[1] + (knee[2] - mid[2]) * pelvis.x[2]
        const kneeSide = Math.abs((knee[0] - mid[0]) * pelvis.z[0] + (knee[1] - mid[1]) * pelvis.z[1] + (knee[2] - mid[2]) * pelvis.z[2])
        expect(kneeFwd).toBeGreaterThan(-0.01)
        expect(kneeSide).toBeLessThan(0.20)
      }
      prevFootP = footP; prevAnkles = ankles
    }
  }
})

test("phase-synchronised walk-run-sprint ramp and unarmed arm follow-through stay continuous", () => {
  const a = actor(), dt = 1 / 60, profile = humanProfiles.soldier
  let x = 0, prevPhase = 0, prevLegYaw = 0
  let midTransitionBobMax = 0
  for (let n = 0; n < 360; n++) {
    // Ramp 1.0 -> 6.3 -> 1.0 m/s
    const u = n < 180 ? n / 180 : (360 - n) / 180
    const speed = 1.0 + u * 5.3
    a.vx = speed; a.vy = 0; a.svx = speed; a.svy = 0
    x += speed * dt
    const stepDist = x - a.x
    a.x = x
    locomotion(a, dt, stepDist, n === 0, profile)
    if (n > 0) {
      const dPhase = ((a.phase - prevPhase + 1.5) % 1) - 0.5
      expect(dPhase).toBeGreaterThanOrEqual(-1e-6)
      expect(dPhase).toBeLessThan(0.08)
      expect(Math.abs(a.legYaw - prevLegYaw)).toBeLessThan(0.05)
    }
    if (a.motion.run > 0.35 && a.motion.run < 0.65) {
      midTransitionBobMax = Math.max(midTransitionBobMax, Math.abs(a.motion.bob.x))
    }
    const pelvis = yawFrame(pelvisPoint(a), a.motion.pelvis.x + a.motion.twist.x)
    const torso = profileTorso(yawFrame(at(pelvis, 0, RIG.waist, 0), 0), profile)
    const hands = unarmedHands(a, torso, n * dt * 2)
    expect(hands[0].every(Number.isFinite)).toBe(true)
    expect(hands[1].every(Number.isFinite)).toBe(true)
    prevPhase = a.phase; prevLegYaw = a.legYaw
  }
  // Phase-shifted harmonic avoids destructive cancellation at gait.run ~ 0.5
  expect(midTransitionBobMax).toBeGreaterThan(0.008)
  expect(Math.abs(a.motion.arms[0].x)).toBeGreaterThan(0.01)
  expect(Math.sign(a.motion.arms[0].x)).toBe(-Math.sign(a.motion.arms[1].x))
})

test("steady walk, run and sprint maintain L/R step symmetry within 3%, bounded cadence variance, smooth COM jerk at touchdown and near-zero contact foot speed", () => {
  const dt = 1 / 60
  for (const [speed, maxTouchdownJerk, maxContactSpeed] of [
    [1.4, 95, 0.08],
    [4.2, 540, 0.15],
    [6.3, 880, 0.24],
  ] as const) {
    const a = actor(), profile = humanProfiles.soldier
    let x = 0
    let prevPlanted: [boolean, boolean] = [true, true]
    let prevAnkles: [V3, V3] | null = null
    const touchdowns: { foot: 0 | 1; t: number; frame: number; x: number; contactSpeed: number }[] = []
    const pelY: number[] = []
    const warmup = 180, count = 480

    for (let n = 0; n < warmup + count; n++) {
      const t = n * dt
      a.vx = speed; a.vy = 0; a.svx = speed; a.svy = 0
      x += speed * dt
      const distStep = x - a.x
      a.x = x
      locomotion(a, dt, distStep, n === 0, profile)
      const pelvis = yawFrame(pelvisPoint(a), a.motion.pelvis.x + a.motion.twist.x)
      const legs = poseLegs(a, pelvis)
      const ankles: [V3, V3] = [[...legs.ft[0].p], [...legs.ft[1].p]]

      if (n >= warmup) {
        const relFrame = n - warmup
        const relT = relFrame * dt
        pelY.push(pelvis.p[1])
        for (const foot of [0, 1] as const) {
          if (!prevPlanted[foot] && a.feet[foot]!.planted) {
            const cSpeed = prevAnkles ? len([
              (ankles[foot]![0] - prevAnkles[foot]![0]) / dt,
              (ankles[foot]![1] - prevAnkles[foot]![1]) / dt,
              (ankles[foot]![2] - prevAnkles[foot]![2]) / dt,
            ]) : 0
            touchdowns.push({ foot, t: relT, frame: relFrame, x: a.feet[foot]!.p[0], contactSpeed: cSpeed })
          }
        }
      }
      prevPlanted = [a.feet[0].planted, a.feet[1].planted]
      prevAnkles = ankles
    }

    const stepDursL: number[] = [], stepDursR: number[] = []
    for (let i = 1; i < touchdowns.length; i++) {
      const prev = touchdowns[i - 1]!, cur = touchdowns[i]!
      expect(cur.foot).toBe((1 - prev.foot) as 0 | 1)
      const dur = cur.t - prev.t
      if (cur.foot === 0) stepDursL.push(dur)
      else stepDursR.push(dur)
    }
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length
    const meanL = avg(stepDursL), meanR = avg(stepDursR)
    const ratioLR = Math.max(meanL, meanR) / Math.min(meanL, meanR)
    const allDurs = [...stepDursL, ...stepDursR]
    const meanAll = avg(allDurs)
    const cv = Math.sqrt(allDurs.reduce((s, v) => s + (v - meanAll) ** 2, 0) / allDurs.length) / meanAll

    const vy = pelY.map((y, i) => (i === 0 ? (pelY[1]! - y) / dt : (y - pelY[i - 1]!) / dt))
    const ay = vy.map((v, i) => (i <= 1 ? (vy[2]! - vy[1]!) / dt : (v - vy[i - 1]!) / dt))
    const jy = ay.map((acc, i) => (i <= 2 ? 0 : (acc - ay[i - 1]!) / dt))
    const tdJerk = Math.max(...touchdowns.map(td => Math.max(Math.abs(jy[td.frame] ?? 0), Math.abs(jy[td.frame + 1] ?? 0))))
    const meanContactSpeed = avg(touchdowns.map(td => td.contactSpeed))
    const maxObservedContactSpeed = Math.max(...touchdowns.map(td => td.contactSpeed))

    // 1. L/R step duration ratio within 3%
    expect(ratioLR).toBeLessThan(1.03)
    // 2. Cadence coefficient of variation bounded (< 4.5%)
    expect(cv).toBeLessThan(0.045)
    // 3. Smooth COM jerk at touchdown (no impulse "boom")
    expect(tdJerk).toBeLessThan(maxTouchdownJerk)
    // 4. Contact foot speed ~ 0
    expect(meanContactSpeed).toBeLessThan(0.065)
    expect(maxObservedContactSpeed).toBeLessThan(maxContactSpeed)
  }
})
