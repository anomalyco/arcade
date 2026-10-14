import { existsSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { animate, newAvatar } from "../../src/game/anim"
import { GUNPTS } from "../../src/render/person"
import { humanProfiles } from "@arcade/kit/human-profile"
import { poseLegs, poseUnarmedArms, unarmedHands } from "@arcade/kit/human-pose"
import { at, RIG } from "@arcade/kit/rig"
import {
  buildCycleFromJointFrames,
  buildWilliamsReferenceCycle,
  compareCycles,
  extractBodyJoints,
  extractBonePoseJoints,
  extractBvhCycle,
  parseBvh,
  RIG_SEGMENTS,
  POSE_JOINTS,
  type CycleComparison,
  type CycleData,
  type RigJointMap,
} from "@arcade/kit/pose-diff"
import { Survivor as OutbreakSurvivor } from "../../../outbreak/src/survivor"
import { fixturesDir, loadMocap, parseArgs } from "./common"

type PoseHooks = {
  animateFn: typeof animate
  newAvatarFn: typeof newAvatar
  poseLegsFn: typeof poseLegs
  unarmedHandsFn: typeof unarmedHands
  poseUnarmedArmsFn: typeof poseUnarmedArms
  OutbreakSurvivorCls: typeof OutbreakSurvivor
  stepVariationDefault: number
  legacyUnarmedPelvis?: boolean
}

function sampleBlackoutCycle(
  name: string,
  mode: "walk" | "run",
  speed: number,
  unarmed: boolean,
  hooks: PoseHooks,
): CycleData {
  const a = hooks.newAvatarFn(name, 0, 0, 0, "rifle")
  a.profile = { ...humanProfiles.soldier, stepVariation: 0 }
  a.unarmed = unarmed

  const dt = 1 / 60
  const totalFrames = 420
  const warmupFrames = 180
  let x = 0, y = 0
  let prevPlantedL = true
  const touchdownsL: number[] = []
  const jointHistory: RigJointMap[] = []

  for (let n = 0; n < totalFrames; n++) {
    const t = n * dt
    x += speed * dt
    hooks.animateFn(a, dt, t, x, y, speed, 0, 0, false)
    const b = a.body!
    if (unarmed && hooks.legacyUnarmedPelvis) {
      b.pelvis = { ...b.pelvis, p: [b.pelvis.p[0], b.pelvis.p[1] - (0.026 + 0.032 * a.motion.run) * a.gait, b.pelvis.p[2]] }
    }
    const legs = hooks.poseLegsFn(a as any, b.pelvis)
    b.th = legs.th
    b.sh = legs.sh
    b.ft = legs.ft
    if (unarmed) {
      const [hL, hR] = hooks.unarmedHandsFn(a, b.torso, t * 2)
      const arms = hooks.poseUnarmedArmsFn(b.torso, hL, hR)
      b.ua = arms.ua
      b.fa = arms.fa
      b.gun = null
      b.mag = null
      b.pump = null
    }
    if (n >= warmupFrames && !prevPlantedL && a.feet[0].planted) {
      touchdownsL.push(n)
    }
    prevPlantedL = a.feet[0].planted
    jointHistory.push(extractBodyJoints(b, b.gun, GUNPTS.rifle.muzzle))
  }

  const fStart = touchdownsL[1] ?? touchdownsL[0] ?? warmupFrames
  const fEnd = touchdownsL[2] ?? touchdownsL[1] ?? fStart + (mode === "walk" ? 48 : 30)
  const cycleSlice = jointHistory.slice(fStart, Math.max(fStart + 8, fEnd))
  const dur = cycleSlice.length * dt
  return buildCycleFromJointFrames(name, mode, speed, dur, cycleSlice, 0)
}

function sampleOutbreakCycle(name: string, mode: "walk" | "run", speed: number, hooks: PoseHooks): CycleData {
  const s = new hooks.OutbreakSurvivorCls({ addModel: () => 0 })
  s.profile = { ...humanProfiles.soldier, stepVariation: 0 }
  const dt = 1 / 60
  const totalFrames = 420
  const warmupFrames = 180
  let x = 0, y = 0
  let prevPlantedL = true
  const touchdownsL: number[] = []
  const jointHistory: RigJointMap[] = []

  for (let n = 0; n < totalFrames; n++) {
    const t = n * dt
    x += speed * dt
    s.draw({ x, y, vx: speed, vy: 0, aim: 0 }, dt, t, () => 0)
    const joints = extractBonePoseJoints(s.bones)
    const plantedL = joints.ankleL[1] <= 0.085 + 1e-4
    if (n >= warmupFrames && !prevPlantedL && plantedL) {
      touchdownsL.push(n)
    }
    prevPlantedL = plantedL
    jointHistory.push(joints)
  }

  const fStart = touchdownsL[1] ?? touchdownsL[0] ?? warmupFrames
  const fEnd = touchdownsL[2] ?? touchdownsL[1] ?? fStart + (mode === "walk" ? 48 : 30)
  const cycleSlice = jointHistory.slice(fStart, Math.max(fStart + 8, fEnd))
  const dur = cycleSlice.length * dt
  return buildCycleFromJointFrames(name, mode, speed, dur, cycleSlice, 0)
}

export type StepVariationStats = {
  speed: number
  stepsMeasured: number
  stepDurationMeanMs: number
  stepDurationStdMs: number
  stepDurationCVPct: number
  stepDurationRatioLR: number
  strideLengthMeanCm: number
  strideLengthStdCm: number
  strideLengthCVPct: number
  strideLengthRangePct: number
  swingPeakLiftMeanCm: number
  swingPeakLiftStdCm: number
  swingPeakLiftRangeCm: number
  footLateralStdCm: number
  footToeYawStdDeg: number
  armPeakStdDeg: number
  maxPlantedToeSlipM: number
  crowdPhaseSpreadDeg: number
  stepSeries: {
    step: number
    foot: "L" | "R"
    durationMs: number
    strideCm: number
    peakLiftCm: number
    lateralCm: number
    toeYawDeg: number
    armPeakDeg: number
  }[]
}

function measure20StepVariation(speed: number, hooks: PoseHooks): StepVariationStats {
  const a = hooks.newAvatarFn(`var-${speed}`, 0, 0, 0, "rifle")
  a.profile = { ...humanProfiles.soldier, stepVariation: hooks.stepVariationDefault }
  a.unarmed = true
  const dt = 1 / 60
  let x = 0
  const warmup = 120
  let prevPlanted: [boolean, boolean] = [true, true]
  let prevToes: [[number, number, number], [number, number, number]] | null = null
  let maxPlantedToeSlipM = 0

  const stepRecords: StepVariationStats["stepSeries"] = []
  let lastTouchdownT: number | null = null
  let lastTouchdownX: [number | null, number | null] = [null, null]
  let curPeakLiftCm: [number, number] = [0, 0]
  let curPeakArmDeg = 0

  for (let n = 0; n < 1800 && stepRecords.length < 22; n++) {
    const t = n * dt
    x += speed * dt
    hooks.animateFn(a, dt, t, x, 0, speed, 0, 0, false)
    const b = a.body!
    const legs = hooks.poseLegsFn(a as any, b.pelvis)
    b.th = legs.th; b.sh = legs.sh; b.ft = legs.ft
    const [hL, hR] = hooks.unarmedHandsFn(a, b.torso, t * 2)
    const arms = hooks.poseUnarmedArmsFn(b.torso, hL, hR)
    b.ua = arms.ua; b.fa = arms.fa; b.gun = null

    const toes: [[number, number, number], [number, number, number]] = [
      at(b.ft[0], 0.19, -RIG.ankle, 0),
      at(b.ft[1], 0.19, -RIG.ankle, 0),
    ]
    if (n >= warmup) {
      for (const i of [0, 1] as const) {
        if (prevPlanted[i] && a.feet[i].planted && prevToes) {
          const slip = Math.hypot(
            toes[i][0] - prevToes[i][0],
            toes[i][1] - prevToes[i][1],
            toes[i][2] - prevToes[i][2],
          )
          maxPlantedToeSlipM = Math.max(maxPlantedToeSlipM, slip)
        }
        const liftCm = Math.max(0, (b.ft[i].p[1] - RIG.ankle) * 100)
        if (!a.feet[i].planted) curPeakLiftCm[i] = Math.max(curPeakLiftCm[i], liftCm)
      }
      const elL = b.fa[0].p, shL = b.ua[0].p
      const shDeg = Math.abs(Math.atan2(elL[0] - shL[0], -(elL[1] - shL[1])) * 180 / Math.PI)
      curPeakArmDeg = Math.max(curPeakArmDeg, shDeg)

      for (const i of [0, 1] as const) {
        if (!prevPlanted[i] && a.feet[i].planted) {
          const durMs = lastTouchdownT !== null ? (t - lastTouchdownT) * 1000 : 0
          const strideCm = lastTouchdownX[i] !== null ? (a.feet[i].p[0] - lastTouchdownX[i]!) * 100 : 0
          const side = i === 0 ? -1 : 1
          const latCm = (a.feet[i].p[2] - side * 0.145) * 100
          const toeDeg = (a.feet[i].yaw - side * 0.06) * 180 / Math.PI
          if (lastTouchdownT !== null && lastTouchdownX[i] !== null) {
            stepRecords.push({
              step: stepRecords.length + 1,
              foot: i === 0 ? "L" : "R",
              durationMs: +durMs.toFixed(2),
              strideCm: +strideCm.toFixed(2),
              peakLiftCm: +curPeakLiftCm[i].toFixed(2),
              lateralCm: +latCm.toFixed(2),
              toeYawDeg: +toeDeg.toFixed(2),
              armPeakDeg: +curPeakArmDeg.toFixed(2),
            })
          }
          lastTouchdownT = t
          lastTouchdownX[i] = a.feet[i].p[0]
          curPeakLiftCm[i] = 0
          curPeakArmDeg = 0
        }
      }
    }
    prevPlanted = [a.feet[0].planted, a.feet[1].planted]
    prevToes = toes
  }

  const series = stepRecords.slice(0, 20)
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length)
  const std = (arr: number[]) => {
    const m = avg(arr)
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, arr.length))
  }

  const durs = series.map(s => s.durationMs)
  const dursL = series.filter(s => s.foot === "L").map(s => s.durationMs)
  const dursR = series.filter(s => s.foot === "R").map(s => s.durationMs)
  const strides = series.map(s => s.strideCm)
  const lifts = series.map(s => s.peakLiftCm)
  const lats = series.map(s => s.lateralCm)
  const toesDeg = series.map(s => s.toeYawDeg)
  const armsDeg = series.map(s => s.armPeakDeg)

  // Measure 5-actor crowd phase spread after 6 seconds at the same speed
  const crowdActors = ["crowd-1", "crowd-2", "crowd-3", "crowd-4", "crowd-5"].map(id => {
    const act = hooks.newAvatarFn(id, 0, 0, 0, "rifle")
    act.profile = { ...humanProfiles.soldier, stepVariation: hooks.stepVariationDefault }
    act.unarmed = true
    return act
  })
  let cx = 0
  for (let n = 0; n < 360; n++) {
    cx += speed * dt
    for (const act of crowdActors) hooks.animateFn(act, dt, n * dt, cx, 0, speed, 0, 0, false)
  }
  const phases = crowdActors.map(act => act.phase * 360)
  const crowdPhaseSpreadDeg = +(Math.max(...phases) - Math.min(...phases)).toFixed(2)

  const meanDur = avg(durs)
  const meanStride = avg(strides)
  return {
    speed,
    stepsMeasured: series.length,
    stepDurationMeanMs: +meanDur.toFixed(2),
    stepDurationStdMs: +std(durs).toFixed(2),
    stepDurationCVPct: +((std(durs) / Math.max(1, meanDur)) * 100).toFixed(2),
    stepDurationRatioLR: +(Math.max(avg(dursL), avg(dursR)) / Math.max(1, Math.min(avg(dursL), avg(dursR)))).toFixed(4),
    strideLengthMeanCm: +meanStride.toFixed(2),
    strideLengthStdCm: +std(strides).toFixed(2),
    strideLengthCVPct: +((std(strides) / Math.max(1, meanStride)) * 100).toFixed(2),
    strideLengthRangePct: +(((Math.max(...strides) - Math.min(...strides)) / Math.max(1, meanStride)) * 100).toFixed(2),
    swingPeakLiftMeanCm: +avg(lifts).toFixed(2),
    swingPeakLiftStdCm: +std(lifts).toFixed(2),
    swingPeakLiftRangeCm: +(Math.max(...lifts) - Math.min(...lifts)).toFixed(2),
    footLateralStdCm: +std(lats).toFixed(2),
    footToeYawStdDeg: +std(toesDeg).toFixed(2),
    armPeakStdDeg: +std(armsDeg).toFixed(2),
    maxPlantedToeSlipM,
    crowdPhaseSpreadDeg,
    stepSeries: series,
  }
}

async function loadReferenceCycles(bvhDir: string) {
  return {
    mocapWalk: extractBvhCycle(parseBvh(await loadMocap("walk", bvhDir)), "walk", 35, 131),
    mocapRun: extractBvhCycle(parseBvh(await loadMocap("run", bvhDir)), "run", 10, 66),
    williamsWalk: buildWilliamsReferenceCycle("walk"),
    williamsRun: buildWilliamsReferenceCycle("run"),
  }
}

function runPass(
  passTag: string,
  outDir: string,
  refs: Awaited<ReturnType<typeof loadReferenceCycles>>,
  hooks: PoseHooks,
  noRender: boolean,
) {
  const cycles = {
    survivorWalk: sampleBlackoutCycle("survivor-walk", "walk", 1.4, true, hooks),
    survivorRun: sampleBlackoutCycle("survivor-run", "run", 4.2, true, hooks),
    survivorSprint: sampleBlackoutCycle("survivor-sprint", "run", 6.3, true, hooks),
    outbreakWalk: sampleOutbreakCycle("outbreak-survivor-walk", "walk", 1.4, hooks),
    outbreakRun: sampleOutbreakCycle("outbreak-survivor-run", "run", 4.2, hooks),
    soldierWalk: sampleBlackoutCycle("soldier-walk", "walk", 1.4, false, hooks),
    soldierRun: sampleBlackoutCycle("soldier-run", "run", 4.2, false, hooks),
    soldierSprint: sampleBlackoutCycle("soldier-sprint", "run", 6.3, false, hooks),
  }

  const comparisons: Record<string, CycleComparison> = {
    survivorWalkVsMocap: compareCycles(cycles.survivorWalk, refs.mocapWalk),
    survivorWalkVsWilliams: compareCycles(cycles.survivorWalk, refs.williamsWalk),
    survivorRunVsMocap: compareCycles(cycles.survivorRun, refs.mocapRun),
    survivorRunVsWilliams: compareCycles(cycles.survivorRun, refs.williamsRun),
    survivorSprintVsMocap: compareCycles(cycles.survivorSprint, refs.mocapRun),
    outbreakWalkVsMocap: compareCycles(cycles.outbreakWalk, refs.mocapWalk),
    outbreakRunVsMocap: compareCycles(cycles.outbreakRun, refs.mocapRun),
    soldierWalkVsMocapLegs: compareCycles(cycles.soldierWalk, refs.mocapWalk),
    soldierRunVsMocapLegs: compareCycles(cycles.soldierRun, refs.mocapRun),
    soldierSprintVsMocapLegs: compareCycles(cycles.soldierSprint, refs.mocapRun),
  }

  const variation = {
    walk: measure20StepVariation(1.4, hooks),
    run: measure20StepVariation(4.2, hooks),
    sprint: measure20StepVariation(6.3, hooks),
  }

  const payload = {
    tag: passTag,
    timestamp: new Date().toISOString(),
    joints: POSE_JOINTS,
    segments: RIG_SEGMENTS,
    references: refs,
    cycles,
    comparisons,
    variation,
  }

  const jsonPath = join(outDir, `pose-diff-${passTag}.json`)
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2))

  console.log(`\n=== Pose-Diff Summary (${passTag}) ===`)
  for (const [key, comp] of Object.entries(comparisons)) {
    const k = comp.kinematics.ours
    console.log(
      `${key}: ArmRMSE=${comp.angleRmseDeg.meanArmAngleRmse}° | LegRMSE=${comp.angleRmseDeg.meanLegAngleRmse}° (hip=${comp.angleRmseDeg.hipFlex}° knee=${comp.angleRmseDeg.kneeFlex}° ank=${comp.angleRmseDeg.anklePitch}°) | LiftMax=${k.footLiftMaxCm}cm (RMSE=${comp.positionRmse.footLiftCm}cm) | Knee=[${k.kneeFlexMinDeg}°..${k.kneeFlexMaxDeg}°] Hip=[${k.hipFlexMinDeg}°..${k.hipFlexMaxDeg}°]`,
    )
  }
  for (const [vKey, v] of Object.entries(variation)) {
    console.log(
      `  variation (${vKey} ${v.speed} m/s): strideCV=${v.strideLengthCVPct}% (range=${v.strideLengthRangePct}%) stepCV=${v.stepDurationCVPct}% (L/R=${v.stepDurationRatioLR}) lift=${v.swingPeakLiftMeanCm}±${v.swingPeakLiftStdCm}cm latStd=${v.footLateralStdCm}cm toeStd=${v.footToeYawStdDeg}° armStd=${v.armPeakStdDeg}° crowdSpread=${v.crowdPhaseSpreadDeg}° maxToeSlip=${v.maxPlantedToeSlipM}`,
    )
  }

  if (!noRender) {
    const renderScript = join(import.meta.dir, "pose-diff-render.py")
    const py = spawnSync("python3", [renderScript, outDir, passTag], { stdio: "inherit" })
    if (py.status !== 0) process.exit(py.status ?? 1)
  }
}

const { tag, out: outDir, values, flags } = parseArgs(process.argv.slice(2), { tag: "after", out: "pose-diff" })
const noRender = flags.has("no-render")
const refs = await loadReferenceCycles(values["bvh-dir"] ? resolve(values["bvh-dir"]) : fixturesDir)
const baselineDir = values.baseline ? resolve(values.baseline) : null

// With --baseline <checkout>, also sample that checkout's arm and Outbreak code as the "before" pass.
if (baselineDir) {
  if (!existsSync(join(baselineDir, "packages/kit/human-pose.ts"))) throw new Error(`${baselineDir} is not an arcade checkout`)
  const basePose = (await import(join(baselineDir, "packages/kit/human-pose.ts"))) as typeof import("@arcade/kit/human-pose")
  const baseSurvivor = (await import(join(baselineDir, "games/outbreak/src/survivor.ts"))) as typeof import("../../../outbreak/src/survivor")
  runPass(
    "before",
    outDir,
    refs,
    {
      animateFn: animate,
      newAvatarFn: newAvatar,
      poseLegsFn: basePose.poseLegs,
      unarmedHandsFn: basePose.unarmedHands,
      poseUnarmedArmsFn: basePose.poseUnarmedArms,
      OutbreakSurvivorCls: baseSurvivor.Survivor,
      stepVariationDefault: 0,
      legacyUnarmedPelvis: true,
    },
    noRender,
  )
}

runPass(
  tag,
  outDir,
  refs,
  {
    animateFn: animate,
    newAvatarFn: newAvatar,
    poseLegsFn: poseLegs,
    unarmedHandsFn: unarmedHands,
    poseUnarmedArmsFn: poseUnarmedArms,
    OutbreakSurvivorCls: OutbreakSurvivor,
    stepVariationDefault: humanProfiles.soldier.stepVariation,
  },
  noRender,
)
