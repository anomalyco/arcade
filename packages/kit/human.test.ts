import { expect, test } from "bun:test"
import { locomotion, newMotion, pelvisPoint, type Locomotion, type Foot } from "./human-locomotion"
import { humanProfiles, profileHands, profileTorso } from "./human-profile"
import { attachment, bodyBones, boneVisible, detach, frameMotion, limbIds, pointVelocity, poseArms, poseLegs, poseUnarmedArms, unarmedHands, type BoneId } from "./human-pose"
import { buildCycleFromJointFrames, buildWilliamsReferenceCycle, compareCycles, computePoseAngles, extractBodyJoints, jointsFromAngles, normalizeJoints, projectOrtho } from "./pose-diff"
import { buildCrouchRunReferenceCycle, buildShambleReferenceCycle, resolveDragFoot, resolveZombieVariant, shambleHandsFK, shambleTorsoModulation, ZOMBIE_VARIANTS } from "./shamble-crouch"
import { at, len, moved, pitch, roll, scale, spring, turn, yawFrame, RIG, type V3 } from "./rig"

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
        const ball = legs.toe[i]!.p
        ball.forEach((v, j) => expect(v).toBeCloseTo(toes[i]![j]!, 12))
        const toeTip = at(legs.toe[i]!, RIG.toe, 0, 0)
        expect(toeTip[1]).toBeCloseTo(0, 12)
        contacts++
      }
      expect(a.motion.durations[i]!).toBeGreaterThanOrEqual(0.077)
      expect(a.motion.durations[i]!).toBeLessThanOrEqual(0.48)
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
    "left.shin": 9, "right.shin": 10, "left.foot": 11, "right.foot": 12,
    "left.toe": 13, "right.toe": 14 })
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

test("pose-diff normalization, FK angle synthesis and unarmed walk/run arm kinematics match biomechanical bounds", () => {
  // 1. Verify FK -> angle extraction round-trip and pelvis-origin normalization
  const synth = jointsFromAngles({
    trunkPitchDeg: 5,
    pelvisBobCm: 0,
    shoulderFlexL: 20,
    shoulderFlexR: -24,
    shoulderAbdL: 12,
    shoulderAbdR: 12,
    elbowFlexL: 32,
    elbowFlexR: 10,
    forearmInwardL: 0,
    forearmInwardR: 0,
    hipFlexL: 28,
    hipFlexR: -14,
    kneeFlexL: 10,
    kneeFlexR: 26,
    anklePitchL: 8,
    anklePitchR: -12,
  })
  const normPose = normalizeJoints(synth, 0)
  expect(normPose.pelvisOriginJoints.pelvis).toEqual([0, 0, 0])
  expect(normPose.groundY).toBeCloseTo(-1, 4)
  const side2D = projectOrtho(normPose, "side", true)
  expect(side2D.points.pelvis).toEqual([0, 0])
  const extracted = computePoseAngles(synth, 0)
  expect(extracted.shoulderFlexL).toBeCloseTo(20, -1)
  expect(extracted.shoulderFlexR).toBeCloseTo(-24, -1)
  expect(extracted.elbowFlexL).toBeCloseTo(32, -1)
  expect(extracted.elbowFlexR).toBeCloseTo(10, -1)

  // 2. Measure steady unarmed walk (1.4 m/s) and run (4.2 m/s) through pose-diff
  const dt = 1 / 60
  const measureUnarmedMode = (mode: "walk" | "run", speed: number) => {
    const a = actor()
    a.unarmed = true
    const profile = humanProfiles.soldier
    let x = 0, prevPlantedL = true
    const tdsL: number[] = []
    const frames: ReturnType<typeof extractBodyJoints>[] = []

    for (let n = 0; n < 420; n++) {
      const t = n * dt
      a.vx = speed; a.vy = 0; a.svx = speed; a.svy = 0
      x += speed * dt
      const distStep = x - a.x
      a.x = x
      locomotion(a, dt, distStep, n === 0, profile)
      const m = a.motion
      let pelvis = yawFrame(pelvisPoint(a), m.pelvis.x + m.twist.x)
      pelvis = roll(pelvis, m.drop.x)
      pelvis = pitch(pelvis, -0.65 * m.posture.x)
      const baseFwd = 0.045 + 0.025 * m.run
      let torso = yawFrame(at(pelvis, 0, RIG.waist, 0), -m.twist.x * 0.65)
      torso = pitch(torso, -(baseFwd + a.leanX.x + m.posture.x))
      torso = profileTorso(torso, profile)
      const head = yawFrame(at(torso, 0.02, RIG.neckY, 0), 0)
      const [hL, hR] = unarmedHands(a, torso, t * 2)
      const arms = poseUnarmedArms(torso, hL, hR)
      const legs = poseLegs(a, pelvis)
      if (n >= 180 && !prevPlantedL && a.feet[0].planted) tdsL.push(n)
      prevPlantedL = a.feet[0].planted
      frames.push(extractBodyJoints({ pelvis, torso, head, ...arms, ...legs }))
    }

    const f0 = tdsL[1]!, f1 = tdsL[2]!
    const cyc = buildCycleFromJointFrames(`unarmed-${mode}`, mode, speed, (f1 - f0) * dt, frames.slice(f0, f1), 0)
    const ref = buildWilliamsReferenceCycle(mode)
    return { cyc, comp: compareCycles(cyc, ref) }
  }

  const walkRes = measureUnarmedMode("walk", 1.4)
  const wk = walkRes.comp.kinematics.ours
  expect(wk.shoulderFlexMinDeg).toBeLessThan(-24)
  expect(wk.shoulderFlexMaxDeg).toBeGreaterThan(15)
  expect(wk.shoulderFlexP2PDeg).toBeGreaterThan(42)
  expect(wk.shoulderFlexP2PDeg).toBeLessThan(56)
  expect(wk.elbowFlexMinDeg).toBeGreaterThan(4)
  expect(wk.elbowFlexMinDeg).toBeLessThan(12)
  expect(wk.elbowFlexMaxDeg).toBeGreaterThan(28)
  expect(wk.elbowFlexMaxDeg).toBeLessThan(40)
  expect(wk.wristRelHipXMinCm).toBeLessThan(-18)
  expect(wk.wristRelHipXMaxCm).toBeGreaterThan(26)
  expect(wk.wristRelHipYMaxCm - wk.wristRelHipYMinCm).toBeGreaterThan(10)
  expect(wk.armOppositeLegCorr).toBeGreaterThan(0.88)
  expect(wk.armPhaseLagDeg).toBeGreaterThanOrEqual(5)
  expect(wk.armPhaseLagDeg).toBeLessThanOrEqual(24)
  expect(walkRes.comp.angleRmseDeg.meanArmAngleRmse).toBeLessThan(7.5)

  const runRes = measureUnarmedMode("run", 4.2)
  const rk = runRes.comp.kinematics.ours
  expect(rk.shoulderFlexMinDeg).toBeLessThan(-48)
  expect(rk.shoulderFlexMaxDeg).toBeGreaterThan(20)
  expect(rk.shoulderFlexP2PDeg).toBeGreaterThan(74)
  // Elbow stays flexed throughout the entire run cycle (never unbending at peak reach or backswing)
  expect(rk.elbowFlexMinDeg).toBeGreaterThan(70)
  expect(rk.elbowFlexMaxDeg).toBeGreaterThan(105)
  expect(rk.elbowFlexMaxDeg).toBeLessThan(124)
  // Forearm stays angled forward/upward on backswing (> +20 deg from vertical down) and pumps upward (> +115 deg) on frontswing
  expect(rk.forearmPitchMinDeg).toBeGreaterThan(20)
  expect(rk.forearmPitchMaxDeg).toBeGreaterThan(115)
  expect(rk.elbowRelTorsoXMinCm).toBeLessThan(-9)
  expect(rk.elbowRelTorsoXMaxCm).toBeGreaterThan(18)
  expect(rk.armOppositeLegCorr).toBeGreaterThan(0.84)
  expect(Math.abs(rk.armPhaseLagDeg)).toBeLessThanOrEqual(18)
  expect(runRes.comp.angleRmseDeg.meanArmAngleRmse).toBeLessThan(6.5)
  // Running heel kick-up (> 34 cm lift, > 110 deg knee flexion) and high knee drive (> 50 deg hip flexion)
  expect(rk.footLiftMaxCm).toBeGreaterThan(34)
  expect(rk.kneeFlexMaxDeg).toBeGreaterThan(110)
  expect(rk.hipFlexMaxDeg).toBeGreaterThan(50)
  expect(wk.kneeFlexMaxDeg).toBeGreaterThan(64)
  expect(wk.kneeFlexMaxDeg).toBeLessThan(76)
  // Toe (ball-of-foot) joint dorsiflexion during push-off (> 20 deg in walk, > 24 deg in run) and lengthened walk stride
  expect(RIG.foot + RIG.toe).toBeCloseTo(0.19, 10)
  expect(wk.toePitchMaxDeg).toBeGreaterThan(20)
  expect(rk.toePitchMaxDeg).toBeGreaterThan(24)
  expect(walkRes.cyc.cadenceStepsPerMin).toBeGreaterThan(115)
  expect(walkRes.cyc.cadenceStepsPerMin).toBeLessThan(132)
  expect(walkRes.comp.angleRmseDeg.meanLegAngleRmse).toBeLessThan(9.0)
  expect(runRes.comp.angleRmseDeg.meanLegAngleRmse).toBeLessThan(14.0)
})

test("seeded per-step variation, crowd personality desync, start/stop weight shift and secondary lag preserve zero toe slip", () => {
  const dt = 1 / 60
  const a = actor()
  a.unarmed = true
  a.seed = 42.125
  const profile = { ...humanProfiles.soldier, stepVariation: 0.35 }
  let x = 0
  let prevPlanted: [boolean, boolean] = [true, true]
  let prevToes: [V3, V3] | null = null
  let lastTdT: number | null = null
  const lastTdX: [number | null, number | null] = [null, null]
  const curLift: [number, number] = [0, 0]
  const steps: { foot: 0 | 1; durMs: number; strideCm: number; liftCm: number; latCm: number; toeDeg: number }[] = []

  for (let n = 0; n < 1200 && steps.length < 20; n++) {
    const t = n * dt
    a.vx = 4.2; a.vy = 0; a.svx = 4.2; a.svy = 0
    x += 4.2 * dt
    const distStep = x - a.x
    a.x = x
    locomotion(a, dt, distStep, n === 0, profile)
    const pelvis = yawFrame(pelvisPoint(a), a.motion.pelvis.x + a.motion.twist.x)
    const legs = poseLegs(a, pelvis)
    const toes: [V3, V3] = [legs.toe[0].p, legs.toe[1].p]

    if (n === 0) {
      // Start anticipation triggers lateral weight-shift velocity and crouch dip
      expect(Math.abs(a.motion.sway.v)).toBeGreaterThan(0.02)
      expect(a.dip.v).toBeLessThan(-0.05)
    }

    if (n >= 120) {
      for (const i of [0, 1] as const) {
        if (prevPlanted[i] && a.feet[i]!.planted && prevToes) {
          expect(len([toes[i]![0] - prevToes[i]![0], toes[i]![1] - prevToes[i]![1], toes[i]![2] - prevToes[i]![2]])).toBeLessThan(1e-12)
        }
        if (!a.feet[i]!.planted) {
          curLift[i] = Math.max(curLift[i], (legs.ft[i]!.p[1] - RIG.ankle) * 100)
        }
        if (!prevPlanted[i] && a.feet[i]!.planted) {
          if (lastTdT !== null && lastTdX[i] !== null) {
            const side = i === 0 ? -1 : 1
            steps.push({
              foot: i,
              durMs: (t - lastTdT) * 1000,
              strideCm: (a.feet[i]!.p[0] - lastTdX[i]!) * 100,
              liftCm: curLift[i],
              latCm: (a.feet[i]!.p[2] - side * 0.145) * 100,
              toeDeg: (a.feet[i]!.yaw - side * 0.06) * 180 / Math.PI,
            })
          }
          lastTdT = t
          lastTdX[i] = a.feet[i]!.p[0]
          curLift[i] = 0
        }
      }
    }
    prevPlanted = [a.feet[0].planted, a.feet[1].planted]
    prevToes = toes
  }

  expect(steps.length).toBe(20)
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length
  const std = (arr: number[]) => {
    const m = avg(arr)
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
  }
  const strides = steps.map(s => s.strideCm)
  const lifts = steps.map(s => s.liftCm)
  const lats = steps.map(s => s.latCm)
  const toesDeg = steps.map(s => s.toeDeg)
  const dursL = steps.filter(s => s.foot === 0).map(s => s.durMs)
  const dursR = steps.filter(s => s.foot === 1).map(s => s.durMs)

  // Genuine per-step variation in stride, lift, lateral placement, and toe-out angle
  expect(std(strides) / avg(strides)).toBeGreaterThan(0.005)
  expect(std(strides) / avg(strides)).toBeLessThan(0.04)
  expect(std(lifts)).toBeGreaterThan(0.5)
  expect(std(lats)).toBeGreaterThan(0.2)
  expect(std(toesDeg)).toBeGreaterThan(0.4)
  // Same-foot high-pass blue noise preserves long-run L/R symmetry
  expect(Math.max(avg(dursL), avg(dursR)) / Math.min(avg(dursL), avg(dursR))).toBeLessThan(1.03)
  // Secondary motion spring tracks vertical bob with phase lag
  expect(Math.abs(a.motion.secondary.x)).toBeGreaterThan(0.001)

  // Crowd of 5 seeded actors desynchronizes instead of marching in lockstep
  const crowd = [11, 29, 47, 73, 97].map(seed => {
    const c = actor()
    c.seed = seed
    return c
  })
  let cx = 0
  for (let n = 0; n < 300; n++) {
    cx += 4.2 * dt
    for (const c of crowd) {
      c.vx = 4.2; c.svx = 4.2; c.x = cx
      locomotion(c, dt, 4.2 * dt, n === 0, profile)
    }
  }
  const phases = crowd.map(c => c.phase * 360)
  expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThan(20)
})

test("zombie shamble and crouch-run reference cycles, FK shamble arms, variants and crouch-run leg kinematics stay within biomechanical bounds", () => {
  const dt = 1 / 60
  const shambleRef = buildShambleReferenceCycle()
  const crouchRef = buildCrouchRunReferenceCycle()
  expect(shambleRef.phases8).toHaveLength(8)
  expect(crouchRef.phases8).toHaveLength(8)

  // Verify all 4 zombie variants produce distinct, finite FK arm poses and torso modulation
  const pelvis = yawFrame([0, 0.84, 0], 0)
  const torso = profileTorso(yawFrame(at(pelvis, 0, RIG.waist, 0), 0), humanProfiles.zombie)
  const variantHands = ZOMBIE_VARIANTS.map(v => {
    const prof = { ...humanProfiles.zombie, zombieVariant: v }
    const [hL, hR] = shambleHandsFK(torso, 0.25, 1, 0, prof, 0)
    const mod = shambleTorsoModulation(0.125, 1, prof, 0)
    expect(hL.every(Number.isFinite)).toBe(true)
    expect(hR.every(Number.isFinite)).toBe(true)
    expect(Math.abs(mod.torsoPitchAdd)).toBeGreaterThan(0.01)
    expect(Math.abs(mod.torsoRollAdd)).toBeGreaterThan(0.01)
    return hL[0]
  })
  // Reacher and lunger reach further forward than limper
  expect(variantHands[2]!).toBeGreaterThan(variantHands[0]!)
  expect(variantHands[3]!).toBeGreaterThan(variantHands[0]!)

  // Seeded crowd resolves all 4 variants and both left and right drag feet
  const resolvedVariants = new Set(Array.from({ length: 32 }, (_, i) => resolveZombieVariant("auto", i + 1)))
  const resolvedFeet = new Set(Array.from({ length: 32 }, (_, i) => resolveDragFoot(i + 1)))
  expect(resolvedVariants.size).toBe(4)
  expect(resolvedFeet.size).toBe(2)

  // Measure unarmed crouch-run against buildCrouchRunReferenceCycle
  const a = actor()
  a.unarmed = true
  ;(a as { crouchRun?: boolean }).crouchRun = true
  const crouchProfile = { ...humanProfiles.soldier, runPosture: 0.34, crouchDepth: 0.09 }
  let x = 0, prevPlantedL = true
  const tdsL: number[] = []
  const frames: ReturnType<typeof extractBodyJoints>[] = []
  for (let n = 0; n < 420; n++) {
    const t = n * dt
    a.vx = 4.2; a.vy = 0; a.svx = 4.2; a.svy = 0
    x += 4.2 * dt
    const stepDist = x - a.x
    a.x = x
    locomotion(a, dt, stepDist, n === 0, crouchProfile)
    const m = a.motion
    let pel = yawFrame(pelvisPoint(a), m.pelvis.x + m.twist.x)
    pel = roll(pel, m.drop.x)
    pel = pitch(pel, -0.65 * m.posture.x)
    const baseFwd = 0.045 + 0.025 * m.run
    let tor = yawFrame(at(pel, 0, RIG.waist, 0), -m.twist.x * 0.65)
    tor = pitch(tor, -(baseFwd + a.leanX.x + m.posture.x))
    tor = profileTorso(tor, crouchProfile)
    const head = yawFrame(at(tor, 0.02, RIG.neckY, 0), 0)
    const [hL, hR] = unarmedHands(a, tor, t * 2)
    const arms = poseUnarmedArms(tor, hL, hR)
    const legs = poseLegs(a, pel)
    if (n >= 180 && !prevPlantedL && a.feet[0].planted) tdsL.push(n)
    prevPlantedL = a.feet[0].planted
    frames.push(extractBodyJoints({ pelvis: pel, torso: tor, head, ...arms, ...legs }))
  }
  const f0 = tdsL[1]!, f1 = tdsL[2]!
  const crouchCyc = buildCycleFromJointFrames("crouch-run", "run", 4.2, (f1 - f0) * dt, frames.slice(f0, f1), 0)
  const comp = compareCycles(crouchCyc, crouchRef)
  expect(comp.angleRmseDeg.overallAngleRmse).toBeLessThan(8.5)
  expect(comp.angleRmseDeg.meanArmAngleRmse).toBeLessThan(7.5)
  expect(comp.angleRmseDeg.meanLegAngleRmse).toBeLessThan(11.0)
})
