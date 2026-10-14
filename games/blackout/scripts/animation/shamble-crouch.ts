import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { animate, newAvatar } from "../../src/game/anim"
import { GUNPTS } from "../../src/render/person"
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"
import {
  buildCycleFromJointFrames,
  compareCycles,
  extractBodyJoints,
  extractBonePoseJoints,
  parseBvh,
  POSE_JOINTS,
  RIG_SEGMENTS,
  type CycleComparison,
  type CycleData,
  type RigJointMap,
} from "@arcade/kit/pose-diff"
import {
  buildCrouchRunReferenceCycle,
  buildShambleReferenceCycle,
  extractAsymmetricBvhCycle,
} from "@arcade/kit/shamble-crouch"
import { at, HIP, RIG } from "@arcade/kit/rig"
import { createAIAgent } from "@arcade/kit/sim/ai"
import { Survivor as OutbreakSurvivor } from "../../../outbreak/src/survivor"
import { ZombieCrowdRenderer } from "../../../outbreak/src/zombies"
import { zombieProfile, zombieTuning } from "../../../outbreak/src/zombie-profile"
import { fixturesDir, loadMocap, parseArgs } from "./common"

const dt = 1 / 60
const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000

export type GaitAuditMetrics = {
  name: string
  speed: number
  cadenceStepsPerMin: number
  stepDurationLMean: number
  stepDurationRMean: number
  stepDurationRatioLR: number
  stepLengthLMean: number
  stepLengthRMean: number
  stepLengthRatioLR: number
  footLiftLMaxCm: number
  footLiftRMaxCm: number
  footDragRatioRL: number
  trunkPitchMeanDeg: number
  trunkPitchRangeDeg: number
  shoulderRollRangeDeg: number
  pelvisRollRangeDeg: number
  crouchDropCm: number
  pelvisAmpCm: number
  headAmpCm: number
  stanceKneeMinDeg: number
  stanceKneeMaxDeg: number
  swingKneeMaxDeg: number
  hipFlexMinDeg: number
  hipFlexMaxDeg: number
  armFlexRangeLDeg: number
  armFlexRangeRDeg: number
  touchdownMaxJerk: number
  contactFootSpeedMean: number
  contactFootSpeedMax: number
  maxToeSlipMm: number
}

function summarizeCycleAndGait(
  name: string,
  mode: "walk" | "run",
  speed: number,
  jointHistory: RigJointMap[],
  plantedHistory: [boolean, boolean][],
  warmupFrames = 180,
): { cycle: CycleData; gait: GaitAuditMetrics } {
  const touchdownsL: number[] = []
  const touchdowns: { foot: 0 | 1; frame: number; t: number; x: number; contactSpeed: number }[] = []
  let maxToeSlip = 0

  for (let n = warmupFrames; n < jointHistory.length; n++) {
    const curJ = jointHistory[n]!
    const prevJ = jointHistory[n - 1]!
    const curP = plantedHistory[n]!
    const prevP = plantedHistory[n - 1]!

    if (prevP[0] && curP[0]) {
      maxToeSlip = Math.max(
        maxToeSlip,
        Math.hypot(curJ.toeL[0] - prevJ.toeL[0], curJ.toeL[1] - prevJ.toeL[1], curJ.toeL[2] - prevJ.toeL[2]),
      )
    }
    if (prevP[1] && curP[1]) {
      maxToeSlip = Math.max(
        maxToeSlip,
        Math.hypot(curJ.toeR[0] - prevJ.toeR[0], curJ.toeR[1] - prevJ.toeR[1], curJ.toeR[2] - prevJ.toeR[2]),
      )
    }

    const spL = Math.hypot(
      (curJ.ankleL[0] - prevJ.ankleL[0]) / dt,
      (curJ.ankleL[1] - prevJ.ankleL[1]) / dt,
      (curJ.ankleL[2] - prevJ.ankleL[2]) / dt,
    )
    const spR = Math.hypot(
      (curJ.ankleR[0] - prevJ.ankleR[0]) / dt,
      (curJ.ankleR[1] - prevJ.ankleR[1]) / dt,
      (curJ.ankleR[2] - prevJ.ankleR[2]) / dt,
    )

    if (!prevP[0] && curP[0]) {
      touchdownsL.push(n)
      touchdowns.push({ foot: 0, frame: n - warmupFrames, t: (n - warmupFrames) * dt, x: curJ.ankleL[0], contactSpeed: spL })
    }
    if (!prevP[1] && curP[1]) {
      touchdowns.push({ foot: 1, frame: n - warmupFrames, t: (n - warmupFrames) * dt, x: curJ.ankleR[0], contactSpeed: spR })
    }
  }

  const fStart = touchdownsL[1] ?? touchdownsL[0] ?? warmupFrames
  const fEnd = touchdownsL[2] ?? touchdownsL[1] ?? fStart + (mode === "walk" ? 56 : 30)
  const cycleSlice = jointHistory.slice(fStart, Math.max(fStart + 10, fEnd))
  const cycle = buildCycleFromJointFrames(name, mode, speed, cycleSlice.length * dt, cycleSlice, 0)

  const measureSlice = jointHistory.slice(warmupFrames)
  const pelY = measureSlice.map(j => j.pelvis[1])
  const headY = measureSlice.map(j => j.headTop[1])
  const meanPelY = pelY.reduce((s, v) => s + v, 0) / pelY.length
  const vy = pelY.map((y, i) => (i === 0 ? (pelY[1]! - y) / dt : (y - pelY[i - 1]!) / dt))
  const ay = vy.map((v, i) => (i <= 1 ? (vy[2]! - vy[1]!) / dt : (v - vy[i - 1]!) / dt))
  const jy = ay.map((a, i) => (i <= 2 ? 0 : (a - ay[i - 1]!) / dt))

  const stepDursL: number[] = [], stepDursR: number[] = []
  const stepLensL: number[] = [], stepLensR: number[] = []
  for (let i = 1; i < touchdowns.length; i++) {
    const prev = touchdowns[i - 1]!, cur = touchdowns[i]!
    if (prev.foot !== cur.foot) {
      if (cur.foot === 0) {
        stepDursL.push(cur.t - prev.t)
        stepLensL.push(cur.x - prev.x)
      } else {
        stepDursR.push(cur.t - prev.t)
        stepLensR.push(cur.x - prev.x)
      }
    }
  }
  const avg = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0.4)
  const meanL = avg(stepDursL), meanR = avg(stepDursR)
  const lenL = avg(stepLensL), lenR = avg(stepLensR)

  const d = cycle.denseSamples
  const tr = d.map(s => s.angles.trunkPitchDeg)
  const shR = d.map(s => s.angles.shoulderRollDeg)
  const pelR = d.map(s => s.angles.pelvisRollDeg)
  const liftL = d.map(s => s.angles.footLiftLCm)
  const liftR = d.map(s => s.angles.footLiftRCm)
  const knL = d.map(s => s.angles.kneeFlexL)
  const knR = d.map(s => s.angles.kneeFlexR)
  const hipAll = d.flatMap(s => [s.angles.hipFlexL, s.angles.hipFlexR])
  const shFlexL = d.map(s => s.angles.shoulderFlexL)
  const shFlexR = d.map(s => s.angles.shoulderFlexR)

  // Stance knee range (first 45% of cycle for L foot)
  const stanceKnL = knL.slice(0, Math.floor(knL.length * 0.45))
  const tdJerks = touchdowns.map(td => Math.max(Math.abs(jy[td.frame] ?? 0), Math.abs(jy[td.frame + 1] ?? 0)))
  const cSpeeds = touchdowns.map(td => td.contactSpeed)

  const maxLiftL = Math.max(...liftL)
  const maxLiftR = Math.max(...liftR)

  const gait: GaitAuditMetrics = {
    name,
    speed,
    cadenceStepsPerMin: cycle.cadenceStepsPerMin,
    stepDurationLMean: r3(meanL),
    stepDurationRMean: r3(meanR),
    stepDurationRatioLR: r3(Math.max(meanL, meanR) / Math.max(1e-4, Math.min(meanL, meanR))),
    stepLengthLMean: r3(lenL),
    stepLengthRMean: r3(lenR),
    stepLengthRatioLR: r3(Math.max(lenL, lenR) / Math.max(1e-4, Math.min(lenL, lenR))),
    footLiftLMaxCm: r2(maxLiftL),
    footLiftRMaxCm: r2(maxLiftR),
    footDragRatioRL: r3(maxLiftR / Math.max(0.5, maxLiftL)),
    trunkPitchMeanDeg: r2(avg(tr)),
    trunkPitchRangeDeg: r2(Math.max(...tr) - Math.min(...tr)),
    shoulderRollRangeDeg: r2(Math.max(...shR) - Math.min(...shR)),
    pelvisRollRangeDeg: r2(Math.max(...pelR) - Math.min(...pelR)),
    crouchDropCm: r2((HIP - meanPelY) * 100),
    pelvisAmpCm: r2((Math.max(...pelY) - Math.min(...pelY)) * 100),
    headAmpCm: r2((Math.max(...headY) - Math.min(...headY)) * 100),
    stanceKneeMinDeg: r2(Math.min(...stanceKnL)),
    stanceKneeMaxDeg: r2(Math.max(...stanceKnL)),
    swingKneeMaxDeg: r2(Math.max(...knL, ...knR)),
    hipFlexMinDeg: r2(Math.min(...hipAll)),
    hipFlexMaxDeg: r2(Math.max(...hipAll)),
    armFlexRangeLDeg: r2(Math.max(...shFlexL) - Math.min(...shFlexL)),
    armFlexRangeRDeg: r2(Math.max(...shFlexR) - Math.min(...shFlexR)),
    touchdownMaxJerk: r2(Math.max(0, ...tdJerks)),
    contactFootSpeedMean: r3(avg(cSpeeds)),
    contactFootSpeedMax: r3(Math.max(0, ...cSpeeds)),
    maxToeSlipMm: r3(maxToeSlip * 1000),
  }

  return { cycle, gait }
}

type ShambleHooks = {
  animateFn: typeof animate
  newAvatarFn: typeof newAvatar
  humanProfilesObj: typeof humanProfiles
  ZombieCrowdRendererCls: typeof ZombieCrowdRenderer
  OutbreakSurvivorCls: typeof OutbreakSurvivor
  zombieProfileFn: typeof zombieProfile
  zombieTuningObj: typeof zombieTuning
}

function sampleBlackoutActor(
  name: string,
  mode: "walk" | "run",
  speed: number,
  profile: HumanProfile,
  unarmed: boolean,
  crouchOverride: boolean,
  hooks: ShambleHooks,
) {
  const a = hooks.newAvatarFn(name, 0, 0, 0, "rifle")
  a.profile = { ...profile }
  a.unarmed = unarmed
  if (crouchOverride) {
    ;(a as { crouchRun?: boolean }).crouchRun = true
  }
  const totalFrames = 480
  let x = 0
  const jointHistory: RigJointMap[] = []
  const plantedHistory: [boolean, boolean][] = []

  for (let n = 0; n < totalFrames; n++) {
    const t = n * dt
    x += speed * dt
    hooks.animateFn(a, dt, t, x, 0, speed, 0, 0, false)
    const b = a.body!
    jointHistory.push(extractBodyJoints(b, b.gun, GUNPTS.rifle.muzzle))
    plantedHistory.push([a.feet[0].planted, a.feet[1].planted])
  }
  return summarizeCycleAndGait(name, mode, speed, jointHistory, plantedHistory)
}

function sampleOutbreakZombie(
  name: string,
  mode: "walk" | "run",
  speed: number,
  state: "wander" | "chase",
  hooks: ShambleHooks,
) {
  const zr = new hooks.ZombieCrowdRendererCls({ addModel: () => 0 })
  const ag = createAIAgent(1, 7, 0, 0, 0)
  ag.lurch = 0.85
  ag.asymmetry = 0.85
  ag.drag = 0.9
  ag.reach = 0.8
  ag.state = state
  ag.vx = speed
  ag.vy = 0
  ag.aim = 0

  const totalFrames = 480
  const jointHistory: RigJointMap[] = []
  const plantedHistory: [boolean, boolean][] = []

  for (let n = 0; n < totalFrames; n++) {
    ag.x += speed * dt
    zr.draw(
      [ag],
      dt,
      () => 0,
      { visible: () => true, actorVisible: () => 1 } as never,
      [-200, -200, 200, 200],
      hooks.zombieTuningObj,
      false,
      n * dt,
    )
    const st = zr.getAgentBones(1)!
    const j = extractBonePoseJoints(st.bones)
    jointHistory.push(j)
    plantedHistory.push(st.planted ?? [j.ankleL[1] <= RIG.ankle + 0.004, j.ankleR[1] <= RIG.ankle + 0.004])
  }
  return summarizeCycleAndGait(name, mode, speed, jointHistory, plantedHistory)
}

function sampleOutbreakSurvivor(
  name: string,
  mode: "walk" | "run",
  speed: number,
  profile: HumanProfile,
  hooks: ShambleHooks,
) {
  const s = new hooks.OutbreakSurvivorCls({ addModel: () => 0 })
  s.profile = { ...profile }
  const totalFrames = 480
  let x = 0
  const jointHistory: RigJointMap[] = []
  const plantedHistory: [boolean, boolean][] = []

  for (let n = 0; n < totalFrames; n++) {
    const t = n * dt
    x += speed * dt
    s.draw({ x, y: 0, vx: speed, vy: 0, aim: 0 }, dt, t, () => 0)
    const j = extractBonePoseJoints(s.bones)
    jointHistory.push(j)
    const fts = (s as unknown as { feet: { planted: boolean }[] }).feet
    plantedHistory.push([fts[0]!.planted, fts[1]!.planted])
  }
  return summarizeCycleAndGait(name, mode, speed, jointHistory, plantedHistory)
}

const { tag, out: outDir, values, flags } = parseArgs(process.argv.slice(2), {
  tag: "after",
  out: "shamble-crouch",
})
const bvhDir = values["bvh-dir"] ? resolve(values["bvh-dir"]) : fixturesDir
mkdirSync(outDir, { recursive: true })

const references = {
  williamsShamble: buildShambleReferenceCycle(),
  mocapWalkTired: extractAsymmetricBvhCycle(parseBvh(await loadMocap("walkTired", bvhDir)), "mocap-walk-tired", "walk", 20, 180),
  mocapWalkOld: extractAsymmetricBvhCycle(parseBvh(await loadMocap("walkOld", bvhDir)), "mocap-walk-old", "walk", 20, 200),
  mocapWalkExhausted: extractAsymmetricBvhCycle(parseBvh(await loadMocap("walkExhausted", bvhDir)), "mocap-walk-exhausted", "walk", 20, 200),
  williamsCrouchRun: buildCrouchRunReferenceCycle(),
  mocapRunCrouch: extractAsymmetricBvhCycle(parseBvh(await loadMocap("runCrouch", bvhDir)), "mocap-run-crouch", "run", 10, 90),
  mocapRunTired: extractAsymmetricBvhCycle(parseBvh(await loadMocap("runTired", bvhDir)), "mocap-run-tired", "run", 10, 85),
  mocapRunOld: extractAsymmetricBvhCycle(parseBvh(await loadMocap("runOld", bvhDir)), "mocap-run-old", "run", 10, 95),
}

function runPass(passTag: string, hooks: ShambleHooks, render: boolean) {
  const crouchProfile: HumanProfile = {
    ...hooks.humanProfilesObj.soldier,
    runPosture: 0.34,
    crouchDepth: 0.09,
  }

  const sampled = {
    blackoutZombie: sampleBlackoutActor("blackout-zombie", "walk", 0.95, hooks.humanProfilesObj.zombie, false, false, hooks),
    outbreakZombie: sampleOutbreakZombie("outbreak-zombie", "walk", 0.95, "wander", hooks),
    outbreakZombieChase: sampleOutbreakZombie("outbreak-zombie-chase", "run", 2.4, "chase", hooks),
    outbreakSurvivorZombie: sampleOutbreakSurvivor(
      "outbreak-survivor-zombie",
      "walk",
      0.95,
      hooks.zombieProfileFn(hooks.zombieTuningObj),
      hooks,
    ),
    survivorCrouchRun: sampleBlackoutActor("survivor-crouch-run", "run", 4.2, crouchProfile, true, true, hooks),
    soldierCrouchRun: sampleBlackoutActor("soldier-crouch-run", "run", 4.2, hooks.humanProfilesObj.soldier, false, false, hooks),
    outbreakCrouchRun: sampleOutbreakSurvivor("outbreak-crouch-run", "run", 4.2, crouchProfile, hooks),
  }

  const cycles: Record<string, CycleData> = {}
  const gaitMetrics: Record<string, GaitAuditMetrics> = {}
  for (const [k, v] of Object.entries(sampled)) {
    cycles[k] = v.cycle
    gaitMetrics[k] = v.gait
  }

  const comparisons: Record<string, CycleComparison> = {
    blackoutZombieVsShambleRef: compareCycles(cycles.blackoutZombie!, references.williamsShamble),
    blackoutZombieVsMocapTired: compareCycles(cycles.blackoutZombie!, references.mocapWalkTired),
    outbreakZombieVsShambleRef: compareCycles(cycles.outbreakZombie!, references.williamsShamble),
    outbreakZombieVsMocapTired: compareCycles(cycles.outbreakZombie!, references.mocapWalkTired),
    outbreakZombieVsMocapOld: compareCycles(cycles.outbreakZombie!, references.mocapWalkOld),
    outbreakSurvivorZombieVsShambleRef: compareCycles(cycles.outbreakSurvivorZombie!, references.williamsShamble),
    survivorCrouchRunVsCrouchRef: compareCycles(cycles.survivorCrouchRun!, references.williamsCrouchRun),
    survivorCrouchRunVsMocapCrouch: compareCycles(cycles.survivorCrouchRun!, references.mocapRunCrouch),
    soldierCrouchRunVsCrouchRef: compareCycles(cycles.soldierCrouchRun!, references.williamsCrouchRun),
    soldierCrouchRunVsMocapCrouch: compareCycles(cycles.soldierCrouchRun!, references.mocapRunCrouch),
    outbreakCrouchRunVsCrouchRef: compareCycles(cycles.outbreakCrouchRun!, references.williamsCrouchRun),
  }

  const payload = {
    tag: passTag,
    timestamp: new Date().toISOString(),
    joints: POSE_JOINTS,
    segments: RIG_SEGMENTS,
    references,
    cycles,
    gaitMetrics,
    comparisons,
  }

  const jsonPath = join(outDir, `shamble-crouch-${passTag}.json`)
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2))

  console.log(`\n=== Shamble & Crouch-Run Audit (${passTag}) ===`)
  for (const [k, g] of Object.entries(gaitMetrics)) {
    console.log(
      `${k}: cad=${g.cadenceStepsPerMin}spm stepLR=${g.stepDurationRatioLR} liftL=${g.footLiftLMaxCm}cm liftR=${g.footLiftRMaxCm}cm(dragRatio=${g.footDragRatioRL}) trunk=${g.trunkPitchMeanDeg}°(Δ${g.trunkPitchRangeDeg}°) shRollΔ=${g.shoulderRollRangeDeg}° crouchDrop=${g.crouchDropCm}cm kneeStance=[${g.stanceKneeMinDeg}°..${g.stanceKneeMaxDeg}°] kneeSwingMax=${g.swingKneeMaxDeg}° hip=[${g.hipFlexMinDeg}°..${g.hipFlexMaxDeg}°] armΔ=[L:${g.armFlexRangeLDeg}°,R:${g.armFlexRangeRDeg}°] jerk=${g.touchdownMaxJerk} slip=${g.maxToeSlipMm}mm`,
    )
  }
  for (const [k, c] of Object.entries(comparisons)) {
    console.log(
      `  ${k}: OverallRMSE=${c.angleRmseDeg.overallAngleRmse}° | ArmRMSE=${c.angleRmseDeg.meanArmAngleRmse}° (sh=${c.angleRmseDeg.shoulderFlex}° elb=${c.angleRmseDeg.elbowFlex}°) | LegRMSE=${c.angleRmseDeg.meanLegAngleRmse}° (hip=${c.angleRmseDeg.hipFlex}° knee=${c.angleRmseDeg.kneeFlex}° ank=${c.angleRmseDeg.anklePitch}°) | Side2D=${c.positionRmse.side2DNorm}`,
    )
  }

  if (render && !flags.has("no-render")) {
    const py = spawnSync("python3", [join(import.meta.dir, "shamble-crouch-render.py"), outDir, passTag], {
      stdio: "inherit",
    })
    if (py.status !== 0) process.exit(py.status ?? 1)
  }
}

if (values.baseline) {
  const baseDir = resolve(values.baseline)
  const baseAnim = (await import(join(baseDir, "games/blackout/src/game/anim.ts"))) as typeof import("../../src/game/anim")
  const baseProf = (await import(join(baseDir, "packages/kit/human-profile.ts"))) as typeof import("@arcade/kit/human-profile")
  const baseZombies = (await import(join(baseDir, "games/outbreak/src/zombies.ts"))) as typeof import("../../../outbreak/src/zombies")
  const baseSurvivor = (await import(join(baseDir, "games/outbreak/src/survivor.ts"))) as typeof import("../../../outbreak/src/survivor")
  const baseZProf = (await import(join(baseDir, "games/outbreak/src/zombie-profile.ts"))) as typeof import("../../../outbreak/src/zombie-profile")
  runPass(
    "before",
    {
      animateFn: baseAnim.animate,
      newAvatarFn: baseAnim.newAvatar,
      humanProfilesObj: baseProf.humanProfiles,
      ZombieCrowdRendererCls: baseZombies.ZombieCrowdRenderer,
      OutbreakSurvivorCls: baseSurvivor.Survivor,
      zombieProfileFn: baseZProf.zombieProfile,
      zombieTuningObj: baseZProf.zombieTuning as typeof zombieTuning,
    },
    true,
  )
}

runPass(
  tag,
  {
    animateFn: animate,
    newAvatarFn: newAvatar,
    humanProfilesObj: humanProfiles,
    ZombieCrowdRendererCls: ZombieCrowdRenderer,
    OutbreakSurvivorCls: OutbreakSurvivor,
    zombieProfileFn: zombieProfile,
    zombieTuningObj: zombieTuning,
  },
  true,
)
