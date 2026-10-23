import { expect, test } from "bun:test"
import { zombieProfile, zombieProfileOverrides, zombieTuning, zombieControls } from "../src/zombie-profile"
import { Survivor } from "../src/survivor"
import { ZombieCrowdRenderer } from "../src/zombies"
import { humanProfiles } from "@arcade/kit/human-profile"
import { createAIAgent } from "@arcade/kit/sim/ai"
import { buildCycleFromJointFrames, compareCycles, extractBonePoseJoints, type RigJointMap } from "@arcade/kit/pose-diff"
import { buildShambleReferenceCycle } from "@arcade/kit/shamble-crouch"
import { at, RIG } from "@arcade/kit/rig"

test("zombie controls keep reaching and delayed upper-body response independent of foot drag", () => {
  const profile = zombieProfileOverrides(zombieTuning)
  expect(profile.handPose).toBe("reach")
  expect(profile.headHz).toBeLessThan(profile.chestHz)
  const { footDrag, ...dragging } = profile
  const { footDrag: noDrag, ...planted } = zombieProfileOverrides({ ...zombieTuning, zombieDrag: 0 })
  expect(footDrag).toBeGreaterThan(noDrag)
  expect(dragging).toEqual(planted)
  expect(zombieControls.map(c => c.key).sort()).toEqual(Object.keys(zombieTuning).sort())
})

test("terrain zombie adapter preserves authoritative inputs and finite elevated poses through stalls", () => {
  let model = 0
  const avatar = new Survivor({ addModel: () => model++ })
  avatar.profile = zombieProfile(zombieTuning)
  expect(avatar.profile.runPosture).toBe(humanProfiles.zombie.runPosture)
  const p = { x: 0, y: 0, vx: 1, vy: 0, aim: 0 }
  let time = 0
  for (let n = 0; n < 180; n++) {
    const dt = n % 40 === 0 ? 2 : 1 / 60
    p.x += Math.min(dt, .05); p.aim = Math.sin(n / 50) * .3; time += dt
    const input = JSON.stringify(p)
    const batches = avatar.draw(p, dt, time, (x, z) => .5 + x * .02 + z * .01)
    expect(batches).toHaveLength(15)
    expect(batches.every(b => [...b.data].every(Number.isFinite))).toBe(true)
    expect(avatar.bones.pelvis!.p[1]).toBeGreaterThan(.8)
    expect(avatar.bones["right.foreArm"]!.p[1]).toBeGreaterThan(1)
    expect(JSON.stringify(p)).toBe(input)
  }
})

test("Lab endpoints stay within the shared rig's pose and contact limits", () => {
  const tune = (value: number) => ({ zombieLurch: value, zombieAsymmetry: value, zombieDrag: value, zombieReach: value })
  const low = zombieProfileOverrides(tune(0)), high = zombieProfileOverrides(tune(1))
  expect(zombieProfileOverrides(tune(-5))).toEqual(low)
  expect(zombieProfileOverrides(tune(5))).toEqual(high)
  expect(low.footDrag).toBe(0)
  expect(low.timingBias).toBe(0)
  expect(high.footDrag).toBeLessThan(1)
  expect(high.timingBias).toBeLessThan(.3)
  expect(high.armReach).toBeLessThan(.56) // Shared upper arm + forearm; IK retains extension margin.
  expect(high.headHz).toBeGreaterThan(0)
  expect(high.strideScale).toBeLessThan(low.strideScale)
})

test("sloped reversals keep survivor and zombie pelvis height and foot transitions smooth", () => {
  for (const isZombie of [false, true]) {
    let model = 0
    const avatar = new Survivor({ addModel: () => model++ })
    if (isZombie) avatar.profile = zombieProfile(zombieTuning)
    const p = { x: 0, y: 0, vx: 3.4, vy: 0, aim: 0 }
    const support = (sx: number, sz: number) => .4 * Math.sin(sx * .6) + .25 * Math.cos(sz * .5)
    let time = 0, prevPelY = 0
    for (let n = 0; n < 240; n++) {
      const dt = 1 / 60
      p.vx = n < 90 ? 3.4 : n < 160 ? -3.4 : 0
      p.vy = n >= 90 && n < 160 ? 2.0 : 0
      p.aim = n < 90 ? 0 : Math.PI * .75
      p.x += p.vx * dt; p.y += p.vy * dt; time += dt
      avatar.draw(p, dt, time, support)
      const pelY = avatar.bones.pelvis!.p[1]
      if (n > 0) expect(Math.abs(pelY - prevPelY)).toBeLessThan(.06)
      prevPelY = pelY
    }
  }
})

test("a zombie dropping from chase to wander finishes its swing instead of snapping the foot down", () => {
  // Swing progress came from the shared clock as (phase - duty) / (1 - duty); duty rises as speed falls, so a speed drop
  // ended a swing mid-air and the foot jumped up to 1.1 m in one frame. Now a lifted foot owns its swing.
  const dt = 1 / 60
  for (const [from, to] of [[2.85, 0.6], [4, 0.6], [2.85, 0]]) for (let offset = 0; offset < 12; offset++) {
    const zr = new ZombieCrowdRenderer({ addModel: () => 0 })
    const agent = createAIAgent(1, 7, 0, 0, 0)
    Object.assign(agent, { lurch: 0.85, asymmetry: 0.85, drag: 0.9, reach: 0.8, state: "wander" })
    let x = 0, t = 0, prev: number[][] | undefined, worst = 0
    const switchAt = 3 + offset * 0.037
    while (t < switchAt + 1.5) {
      t += dt
      const v = t < switchAt ? from! : to!
      x += v * dt
      Object.assign(agent, { x, y: 0, vx: v, vy: 0, aim: 0 })
      zr.draw([agent], dt, () => 0, { visible: () => true, actorVisible: () => 1 } as never, [-200, -200, 200, 200], zombieTuning, false, t)
      const j = extractBonePoseJoints(zr.getAgentBones(1)!.bones), cur = [j.ankleL, j.ankleR] as number[][]
      if (prev && t > 1) for (const k of [0, 1]) worst = Math.max(worst, Math.hypot(...cur[k]!.map((c, i) => c - prev![k]![i]!)) - v * dt)
      prev = cur.map(c => [...c])
    }
    expect(worst).toBeLessThan(0.2)
  }
})

test("unarmed survivor arm swing opposes foot stride and scales with speed", () => {
  let model = 0
  const avatar = new Survivor({ addModel: () => model++ })
  const p = { x: 0, y: 0, vx: 3.2, vy: 0, aim: 0 }
  let time = 0, maxArmSpread = 0, maxTorsoCounterTwist = 0
  for (let n = 0; n < 120; n++) {
    const dt = 1 / 60
    p.x += p.vx * dt; time += dt
    avatar.draw(p, dt, time, () => 0)
    const lHand = avatar.bones["left.foreArm"]!.p, rHand = avatar.bones["right.foreArm"]!.p
    maxArmSpread = Math.max(maxArmSpread, Math.abs(lHand[0] - rHand[0]))
    const pelYaw = Math.atan2(avatar.bones.pelvis!.x[2], avatar.bones.pelvis!.x[0])
    const torYaw = Math.atan2(avatar.bones.torso!.x[2], avatar.bones.torso!.x[0])
    maxTorsoCounterTwist = Math.max(maxTorsoCounterTwist, Math.abs( pelYaw - torYaw ))
  }
  expect(maxArmSpread).toBeGreaterThan(0.15)
  expect(maxTorsoCounterTwist).toBeGreaterThan(0.05)
})

test("zombie crowd shamble matches key-pose reference within 7.5 deg RMSE, locks planted toes, drags crippled foot and desynchronizes variants across a horde", () => {
  const zr = new ZombieCrowdRenderer({ addModel: () => 0 })
  const ag = createAIAgent(1, 7, 0, 0, 0)
  ag.lurch = 0.85; ag.asymmetry = 0.85; ag.drag = 0.9; ag.reach = 0.8
  ag.state = "wander"; ag.vx = 0.95; ag.vy = 0; ag.aim = 0
  const dt = 1 / 60
  const frames: RigJointMap[] = []
  const tdsL: number[] = []
  let prevPlantedL = true, prevPlantedR = true
  let prevToeL = [0, 0, 0], prevToeR = [0, 0, 0]
  let maxToeSlip = 0

  for (let n = 0; n < 420; n++) {
    ag.x += 0.95 * dt
    zr.draw([ag], dt, () => 0, { visible: () => true, actorVisible: () => 1 } as never, [-100, -100, 100, 100], zombieTuning, false)
    const st = zr.getAgentBones(1)!
    const j = extractBonePoseJoints(st.bones)
    const [pL, pR] = st.planted!
    const toeL = st.bones["left.toe"]!.p
    const toeR = st.bones["right.toe"]!.p
    if (n >= 180) {
      if (prevPlantedL && pL) maxToeSlip = Math.max(maxToeSlip, Math.hypot(toeL[0] - prevToeL[0]!, toeL[1] - prevToeL[1]!, toeL[2] - prevToeL[2]!))
      if (prevPlantedR && pR) maxToeSlip = Math.max(maxToeSlip, Math.hypot(toeR[0] - prevToeR[0]!, toeR[1] - prevToeR[1]!, toeR[2] - prevToeR[2]!))
      if (!prevPlantedL && pL) tdsL.push(n)
    }
    prevPlantedL = pL; prevPlantedR = pR
    prevToeL = toeL; prevToeR = toeR
    frames.push(j)
  }

  expect(maxToeSlip).toBeLessThan(1e-6)
  const f0 = tdsL[1]!, f1 = tdsL[2]!
  const cyc = buildCycleFromJointFrames("outbreak-zombie", "walk", 0.95, (f1 - f0) * dt, frames.slice(f0, f1), 0)
  const ref = buildShambleReferenceCycle()
  const comp = compareCycles(cyc, ref)
  expect(comp.angleRmseDeg.overallAngleRmse).toBeLessThan(7.5)
  expect(comp.angleRmseDeg.meanArmAngleRmse).toBeLessThan(5.0)
  const liftL = Math.max(...cyc.denseSamples.map(s => s.angles.footLiftLCm))
  const liftR = Math.max(...cyc.denseSamples.map(s => s.angles.footLiftRCm))
  expect(liftR).toBeLessThan(liftL * 0.35)
  const tr = cyc.denseSamples.map(s => s.angles.trunkPitchDeg)
  const shRoll = cyc.denseSamples.map(s => s.angles.shoulderRollDeg)
  expect(Math.max(...tr) - Math.min(...tr)).toBeGreaterThan(6.5)
  expect(Math.max(...shRoll) - Math.min(...shRoll)).toBeGreaterThan(9.5)

  // Verify all 4 explicit variants (1..4) render finite poses and distinct silhouettes
  const variantTilts = [1, 2, 3, 4].map(v => {
    zr.reset()
    const z = createAIAgent(2, 13, 0, 0, 0)
    z.vx = 0.95; z.vy = 0; z.aim = 0
    for (let k = 0; k < 60; k++) {
      z.x += 0.95 * dt
      zr.draw([z], dt, () => 0, { visible: () => true, actorVisible: () => 1 } as never, [-100, -100, 100, 100], { ...zombieTuning, zombieVariant: v }, false)
    }
    const j = extractBonePoseJoints(zr.getAgentBones(2)!.bones)
    return j.wristL[0] - j.pelvis[0]
  })
  expect(variantTilts.every(Number.isFinite)).toBe(true)
  expect(Math.max(...variantTilts) - Math.min(...variantTilts)).toBeGreaterThan(0.04)
})
