import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { animate, newAvatar } from "../src/game/anim"
import { GUNPTS } from "../src/render/person"
import { humanProfiles } from "@arcade/kit/human-profile"
import { poseUnarmedArms, unarmedHands } from "@arcade/kit/human-pose"
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
import { Survivor as OutbreakSurvivor } from "../../outbreak/src/survivor"

function parseArgs(argv: string[]) {
  let tag = "after"
  let outDir = "/Users/kit/code/home/artifacts/2026-10-14-pose-diff"
  let bvhDir = "/Users/kit/code/home/artifacts/2026-10-14-walk-audit/mocap"
  let baselineDir = "/Users/kit/code/open-source/arcade"
  let noRender = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--tag" && argv[i + 1]) tag = argv[++i]!
    else if (a === "--out" && argv[i + 1]) outDir = resolve(argv[++i]!)
    else if (a === "--bvh-dir" && argv[i + 1]) bvhDir = resolve(argv[++i]!)
    else if (a === "--baseline" && argv[i + 1]) baselineDir = resolve(argv[++i]!)
    else if (a === "--no-render") noRender = true
    else if (!a.startsWith("-")) tag = a
  }
  return { tag, outDir, bvhDir, baselineDir, noRender }
}

type PoseHooks = {
  unarmedHandsFn: typeof unarmedHands
  poseUnarmedArmsFn: typeof poseUnarmedArms
  OutbreakSurvivorCls: typeof OutbreakSurvivor
}

function sampleBlackoutCycle(
  name: string,
  mode: "walk" | "run",
  speed: number,
  unarmed: boolean,
  hooks: PoseHooks,
): CycleData {
  const a = newAvatar(name, 0, 0, 0, "rifle")
  a.profile = { ...humanProfiles.soldier }
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
    animate(a, dt, t, x, y, speed, 0, 0, false)
    const b = a.body!
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
  s.profile = { ...humanProfiles.soldier }
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

function loadReferenceCycles(bvhDir: string) {
  const williamsWalk = buildWilliamsReferenceCycle("walk")
  const williamsRun = buildWilliamsReferenceCycle("run")

  const walkBvhPath = join(bvhDir, "walk_normal_001.bvh")
  const runBvhPath = join(bvhDir, "dataset-2_run_normal_001.bvh")

  const mocapWalk = existsSync(walkBvhPath)
    ? extractBvhCycle(parseBvh(readFileSync(walkBvhPath, "utf8")), "walk", 35, 131)
    : williamsWalk
  const mocapRun = existsSync(runBvhPath)
    ? extractBvhCycle(parseBvh(readFileSync(runBvhPath, "utf8")), "run", 10, 66)
    : williamsRun

  return { mocapWalk, mocapRun, williamsWalk, williamsRun }
}

function runPass(
  passTag: string,
  outDir: string,
  refs: ReturnType<typeof loadReferenceCycles>,
  hooks: PoseHooks,
  noRender: boolean,
) {
  const cycles = {
    survivorWalk: sampleBlackoutCycle("survivor-walk", "walk", 1.4, true, hooks),
    survivorRun: sampleBlackoutCycle("survivor-run", "run", 4.2, true, hooks),
    outbreakWalk: sampleOutbreakCycle("outbreak-survivor-walk", "walk", 1.4, hooks),
    outbreakRun: sampleOutbreakCycle("outbreak-survivor-run", "run", 4.2, hooks),
    soldierWalk: sampleBlackoutCycle("soldier-walk", "walk", 1.4, false, hooks),
    soldierRun: sampleBlackoutCycle("soldier-run", "run", 4.2, false, hooks),
  }

  const comparisons: Record<string, CycleComparison> = {
    survivorWalkVsMocap: compareCycles(cycles.survivorWalk, refs.mocapWalk),
    survivorWalkVsWilliams: compareCycles(cycles.survivorWalk, refs.williamsWalk),
    survivorRunVsMocap: compareCycles(cycles.survivorRun, refs.mocapRun),
    survivorRunVsWilliams: compareCycles(cycles.survivorRun, refs.williamsRun),
    outbreakWalkVsMocap: compareCycles(cycles.outbreakWalk, refs.mocapWalk),
    outbreakRunVsMocap: compareCycles(cycles.outbreakRun, refs.mocapRun),
    soldierWalkVsMocapLegs: compareCycles(cycles.soldierWalk, refs.mocapWalk),
    soldierRunVsMocapLegs: compareCycles(cycles.soldierRun, refs.mocapRun),
  }

  const payload = {
    tag: passTag,
    timestamp: new Date().toISOString(),
    joints: POSE_JOINTS,
    segments: RIG_SEGMENTS,
    references: refs,
    cycles,
    comparisons,
  }

  const jsonPath = join(outDir, `pose-diff-${passTag}.json`)
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2))

  console.log(`\n=== Pose-Diff Summary (${passTag}) ===`)
  for (const [key, comp] of Object.entries(comparisons)) {
    console.log(
      `${key}: ArmAngleRMSE=${comp.angleRmseDeg.meanArmAngleRmse}° (shFlex=${comp.angleRmseDeg.shoulderFlex}° elb=${comp.angleRmseDeg.elbowFlex}° fa=${comp.angleRmseDeg.forearmPitch}° abd=${comp.angleRmseDeg.shoulderAbd}°) | LegAngleRMSE=${comp.angleRmseDeg.meanLegAngleRmse}° | Side2DRMSE=${comp.positionRmse.side2DNorm}`,
    )
    const k = comp.kinematics.ours
    console.log(
      `  ours: shFlex=[${k.shoulderFlexMinDeg}°, ${k.shoulderFlexMaxDeg}°] elb=[${k.elbowFlexMinDeg}°, ${k.elbowFlexMaxDeg}°] wrHipX=[${k.wristRelHipXMinCm}, ${k.wristRelHipXMaxCm}]cm wrHipY=[${k.wristRelHipYMinCm}, ${k.wristRelHipYMaxCm}]cm elbTorsoX=[${k.elbowRelTorsoXMinCm}, ${k.elbowRelTorsoXMaxCm}]cm corr=${k.armOppositeLegCorr} lag=${k.armPhaseLagDeg}°`,
    )
  }

  if (!noRender) {
    const renderScript = join(import.meta.dir, "pose-diff-render.py")
    const py = spawnSync("python3", [renderScript, outDir, passTag], { stdio: "inherit" })
    if (py.status !== 0) process.exit(py.status ?? 1)
  }
}

const { tag, outDir, bvhDir, baselineDir, noRender } = parseArgs(process.argv.slice(2))
mkdirSync(outDir, { recursive: true })
const refs = loadReferenceCycles(bvhDir)

if (tag === "after" && existsSync(join(baselineDir, "packages/kit/human-pose.ts"))) {
  const basePose = (await import(join(baselineDir, "packages/kit/human-pose.ts"))) as typeof import("@arcade/kit/human-pose")
  const baseSurvivor = (await import(join(baselineDir, "games/outbreak/src/survivor.ts"))) as typeof import("../../outbreak/src/survivor")
  runPass(
    "before",
    outDir,
    refs,
    {
      unarmedHandsFn: basePose.unarmedHands,
      poseUnarmedArmsFn: basePose.poseUnarmedArms,
      OutbreakSurvivorCls: baseSurvivor.Survivor,
    },
    noRender,
  )
}

runPass(
  tag,
  outDir,
  refs,
  {
    unarmedHandsFn: unarmedHands,
    poseUnarmedArmsFn: poseUnarmedArms,
    OutbreakSurvivorCls: OutbreakSurvivor,
  },
  noRender,
)
