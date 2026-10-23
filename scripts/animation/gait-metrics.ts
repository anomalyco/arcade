import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { humanProfiles } from "@arcade/kit/human-profile"
import { poseUnarmedArms, unarmedHands } from "@arcade/kit/human-pose"
import { parseBvh } from "@arcade/kit/pose-diff"
import { at, RIG } from "@arcade/kit/rig"
import { animate, newAvatar } from "../../games/blackout/src/game/anim"
import { Survivor as OutbreakSurvivor } from "../../games/outbreak/src/survivor"
import { fixturesDir, loadMocap, parseArgs, type MOCAP } from "../../games/blackout/scripts/animation/common"

// Gait metrics for Blackout survivor/soldier and Outbreak survivor at fixed speeds, plus mocap reference curves.
// Usage: bun scripts/animation/gait-metrics.ts --tag before|after [--out dir] [--bvh-dir dir] [--no-plot]
const { tag, out: OUT_DIR, values, flags } = parseArgs(process.argv.slice(2), { tag: "before", out: "gait" })
const bvhDir = values["bvh-dir"] ? resolve(values["bvh-dir"]) : fixturesDir

type TimeSample = {
  t: number
  pelvisYCm: number
  pelvisAy: number
  pelvisJy: number
  headYCm: number
  footLYCm: number
  footRYCm: number
  footLSpeed: number
  footRSpeed: number
  plantedL: number
  plantedR: number
  legLFwdCm: number
  legRFwdCm: number
  handLFwdCm: number
  handRFwdCm: number
  phase: number
}

type RawSample = Omit<TimeSample, "pelvisYCm" | "pelvisAy" | "pelvisJy" | "headYCm"> & { pelvisY: number; headY: number }

type CycleSummary = {
  name: string
  profile: string
  speed: number
  cadenceStepsPerMin: number
  stepDurationLMean: number
  stepDurationRMean: number
  stepDurationRatioLR: number
  stepDurationStdMs: number
  stepDurationCVPct: number
  stepLengthLMean: number
  stepLengthRMean: number
  stepLengthRatioLR: number
  stanceDurationLMean: number
  stanceDurationRMean: number
  swingDurationLMean: number
  swingDurationRMean: number
  doubleSupportPct: number
  flightPct: number
  pelvisAmpCm: number
  headAmpCm: number
  pelvisMaxAy: number
  pelvisMaxJerk: number
  touchdownMaxJerk: number
  contactFootSpeedMean: number
  contactFootSpeedMax: number
  harmonicSubRatio: number
  harmonicHighRatio: number
  armOppositeLegCorr: number
  armPhaseLagDeg: number
  samples3Cycles: TimeSample[]
}

function dftAmp(signal: number[], freqHz: number, dt: number): number {
  const n = signal.length
  if (n === 0) return 0
  const mean = signal.reduce((s, v) => s + v, 0) / n
  let re = 0, im = 0
  for (let k = 0; k < n; k++) {
    const v = signal[k]! - mean
    const ang = -2 * Math.PI * freqHz * (k * dt)
    re += v * Math.cos(ang)
    im += v * Math.sin(ang)
  }
  return (2 / n) * Math.hypot(re, im)
}

function measureBlackoutActor(name: string, profileName: "survivor" | "soldier", speed: number, aimSway = false): CycleSummary {
  const a = newAvatar(name, 0, 0, 0, "rifle")
  a.profile = { ...humanProfiles.soldier }
  const isUnarmed = profileName === "survivor"
  a.unarmed = isUnarmed

  const dt = 1 / 60
  const warmupFrames = 180 // 3.0s warmup
  const measureFrames = 480 // 8.0s steady state
  let x = 0, y = 0

  let prevPlanted: [boolean, boolean] = [true, true]
  let prevAnkles: [[number, number, number], [number, number, number]] | null = null
  const touchdowns: { foot: 0 | 1; t: number; frame: number; x: number; contactSpeed: number }[] = []
  const liftoffs: { foot: 0 | 1; t: number; frame: number; x: number }[] = []
  const rawSamples: RawSample[] = []

  for (let n = 0; n < warmupFrames + measureFrames; n++) {
    const t = n * dt
    const vx = speed, vy = 0
    x += vx * dt
    const aim = aimSway ? Math.sin(t * 1.8) * 0.14 : 0
    animate(a, dt, t, x, y, vx, vy, aim, false)
    const b = a.body!
    if (isUnarmed) {
      const [hL, hR] = unarmedHands(a, b.torso, t * 2)
      const arms = poseUnarmedArms(b.torso, hL, hR)
      b.ua = arms.ua
      b.fa = arms.fa
      b.gun = null
    }
    const ankL: [number, number, number] = [...b.ft[0].p]
    const ankR: [number, number, number] = [...b.ft[1].p]
    const handL = at(b.fa[0], 0, -RIG.fore, 0)
    const handR = at(b.fa[1], 0, -RIG.fore, 0)

    if (n >= warmupFrames) {
      const relT = (n - warmupFrames) * dt
      const speedL = prevAnkles
        ? Math.hypot((ankL[0] - prevAnkles[0][0]) / dt, (ankL[1] - prevAnkles[0][1]) / dt, (ankL[2] - prevAnkles[0][2]) / dt)
        : 0
      const speedR = prevAnkles
        ? Math.hypot((ankR[0] - prevAnkles[1][0]) / dt, (ankR[1] - prevAnkles[1][1]) / dt, (ankR[2] - prevAnkles[1][2]) / dt)
        : 0

      for (const foot of [0, 1] as const) {
        const nowP = a.feet[foot].planted
        const wasP = prevPlanted[foot]
        if (!wasP && nowP) {
          // Foot contact speed: speed on the touchdown transition frame
          const cSpeed = foot === 0 ? speedL : speedR
          touchdowns.push({ foot, t: relT, frame: n - warmupFrames, x: a.feet[foot].p[0], contactSpeed: cSpeed })
        }
        if (wasP && !nowP) {
          liftoffs.push({ foot, t: relT, frame: n - warmupFrames, x: a.feet[foot].p[0] })
        }
      }

      rawSamples.push({
        t: relT,
        pelvisY: b.pelvis.p[1],
        headY: b.head.p[1],
        footLYCm: (ankL[1] - RIG.ankle) * 100,
        footRYCm: (ankR[1] - RIG.ankle) * 100,
        footLSpeed: speedL,
        footRSpeed: speedR,
        plantedL: a.feet[0].planted ? 1 : 0,
        plantedR: a.feet[1].planted ? 1 : 0,
        legLFwdCm: (ankL[0] - b.pelvis.p[0]) * 100,
        legRFwdCm: (ankR[0] - b.pelvis.p[0]) * 100,
        handLFwdCm: (handL[0] - b.torso.p[0]) * 100,
        handRFwdCm: (handR[0] - b.torso.p[0]) * 100,
        phase: a.phase,
      })
    }
    prevPlanted = [a.feet[0].planted, a.feet[1].planted]
    prevAnkles = [ankL, ankR]
  }

  return summarizeSamples(name, profileName, speed, dt, rawSamples, touchdowns, liftoffs)
}

function summarizeSamples(
  name: string,
  profile: string,
  speed: number,
  dt: number,
  rawSamples: RawSample[],
  touchdowns: { foot: 0 | 1; t: number; frame: number; x: number; contactSpeed: number }[],
  liftoffs: { foot: 0 | 1; t: number; frame: number; x: number }[],
): CycleSummary {
  const n = rawSamples.length
  const meanPelY = rawSamples.reduce((s, r) => s + r.pelvisY, 0) / n
  const meanHeadY = rawSamples.reduce((s, r) => s + r.headY, 0) / n

  const pelY = rawSamples.map(r => r.pelvisY)
  const vy = pelY.map((y, i) => (i === 0 ? (pelY[1]! - y) / dt : (y - pelY[i - 1]!) / dt))
  const ay = vy.map((v, i) => (i <= 1 ? (vy[2]! - vy[1]!) / dt : (v - vy[i - 1]!) / dt))
  const jy = ay.map((a, i) => (i <= 2 ? 0 : (a - ay[i - 1]!) / dt))

  const fullSamples: TimeSample[] = rawSamples.map((r, i) => ({
    t: r.t,
    pelvisYCm: (r.pelvisY - meanPelY) * 100,
    pelvisAy: ay[i]!,
    pelvisJy: jy[i]!,
    headYCm: (r.headY - meanHeadY) * 100,
    footLYCm: r.footLYCm,
    footRYCm: r.footRYCm,
    footLSpeed: r.footLSpeed,
    footRSpeed: r.footRSpeed,
    plantedL: r.plantedL,
    plantedR: r.plantedR,
    legLFwdCm: r.legLFwdCm,
    legRFwdCm: r.legRFwdCm,
    handLFwdCm: r.handLFwdCm,
    handRFwdCm: r.handRFwdCm,
    phase: r.phase,
  }))

  // Step intervals between alternating touchdowns
  const stepIntervalsL: number[] = [] // R->L (ending on L)
  const stepIntervalsR: number[] = [] // L->R (ending on R)
  const stepLengthsL: number[] = []
  const stepLengthsR: number[] = []
  for (let i = 1; i < touchdowns.length; i++) {
    const prev = touchdowns[i - 1]!, cur = touchdowns[i]!
    if (prev.foot !== cur.foot) {
      const dur = cur.t - prev.t
      const len = cur.x - prev.x
      if (cur.foot === 0) {
        stepIntervalsL.push(dur)
        stepLengthsL.push(len)
      } else {
        stepIntervalsR.push(dur)
        stepLengthsR.push(len)
      }
    }
  }
  const allSteps = [...stepIntervalsL, ...stepIntervalsR]
  const meanStep = allSteps.reduce((s, v) => s + v, 0) / Math.max(1, allSteps.length)
  const stdStep = Math.sqrt(allSteps.reduce((s, v) => s + (v - meanStep) ** 2, 0) / Math.max(1, allSteps.length))
  const meanL = stepIntervalsL.reduce((s, v) => s + v, 0) / Math.max(1, stepIntervalsL.length)
  const meanR = stepIntervalsR.reduce((s, v) => s + v, 0) / Math.max(1, stepIntervalsR.length)
  const lenL = stepLengthsL.reduce((s, v) => s + v, 0) / Math.max(1, stepLengthsL.length)
  const lenR = stepLengthsR.reduce((s, v) => s + v, 0) / Math.max(1, stepLengthsR.length)

  // Stance & swing durations per foot
  const stanceDurs: [number[], number[]] = [[], []]
  const swingDurs: [number[], number[]] = [[], []]
  for (const foot of [0, 1] as const) {
    const tds = touchdowns.filter(x => x.foot === foot)
    const los = liftoffs.filter(x => x.foot === foot)
    for (const td of tds) {
      const nextLo = los.find(lo => lo.t > td.t)
      if (nextLo) stanceDurs[foot].push(nextLo.t - td.t)
    }
    for (const lo of los) {
      const nextTd = tds.find(td => td.t > lo.t)
      if (nextTd) swingDurs[foot].push(nextTd.t - lo.t)
    }
  }
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length)

  const dsFrames = fullSamples.filter(s => s.plantedL === 1 && s.plantedR === 1).length
  const flFrames = fullSamples.filter(s => s.plantedL === 0 && s.plantedR === 0).length

  const pelCmArr = fullSamples.map(s => s.pelvisYCm)
  const headCmArr = fullSamples.map(s => s.headYCm)
  const pelvisAmpCm = Math.max(...pelCmArr) - Math.min(...pelCmArr)
  const headAmpCm = Math.max(...headCmArr) - Math.min(...headCmArr)

  const tdJerks = touchdowns.map(td => {
    const idx = td.frame
    return Math.max(
      Math.abs(jy[idx] ?? 0),
      Math.abs(jy[idx + 1] ?? 0),
    )
  })

  const stepFreq = 1 / Math.max(0.1, meanStep)
  const strideFreq = stepFreq * 0.5
  const aStep = dftAmp(pelCmArr, stepFreq, dt)
  const aSub = dftAmp(pelCmArr, strideFreq, dt)
  const aHigh = Math.hypot(dftAmp(pelCmArr, stepFreq * 2, dt), dftAmp(pelCmArr, stepFreq * 3, dt))

  // Correlation between Left Hand forward and Right Leg forward
  const hL = fullSamples.map(s => s.handLFwdCm)
  const lR = fullSamples.map(s => s.legRFwdCm)
  const mhL = avg(hL), mlR = avg(lR)
  let cov = 0, vhL = 0, vlR = 0
  for (let i = 0; i < n; i++) {
    const dh = hL[i]! - mhL, dl = lR[i]! - mlR
    cov += dh * dl
    vhL += dh * dh
    vlR += dl * dl
  }
  const corr = cov / Math.max(1e-9, Math.sqrt(vhL * vlR))

  // Phase lag via cross-correlation peak within +-30 frames
  let bestLag = 0, bestDot = -Infinity
  for (let lag = -25; lag <= 25; lag++) {
    let dot = 0
    for (let i = 25; i < n - 25; i++) {
      dot += (hL[i + lag]! - mhL) * (lR[i]! - mlR)
    }
    if (dot > bestDot) {
      bestDot = dot
      bestLag = lag
    }
  }
  const cyclePeriod = 2 * meanStep
  const armPhaseLagDeg = (bestLag * dt / Math.max(0.1, cyclePeriod)) * 360

  // Extract 3 cycles starting at first Left touchdown after t = 0.2s
  const startTd = touchdowns.find(td => td.foot === 0 && td.t >= 0.2) ?? touchdowns[0]
  const startFrame = startTd ? startTd.frame : 0
  const duration3Cycles = Math.min(n - startFrame, Math.round((3 * 2 * meanStep) / dt))
  const samples3Cycles = fullSamples.slice(startFrame, startFrame + Math.max(60, duration3Cycles)).map(s => ({
    ...s,
    t: +(s.t - (fullSamples[startFrame]?.t ?? 0)).toFixed(4),
  }))

  const cSpeeds = touchdowns.map(td => td.contactSpeed)

  return {
    name,
    profile,
    speed,
    cadenceStepsPerMin: +(60 / meanStep).toFixed(1),
    stepDurationLMean: +meanL.toFixed(4),
    stepDurationRMean: +meanR.toFixed(4),
    stepDurationRatioLR: +(Math.max(meanL, meanR) / Math.max(1e-6, Math.min(meanL, meanR))).toFixed(4),
    stepDurationStdMs: +(stdStep * 1000).toFixed(2),
    stepDurationCVPct: +((stdStep / meanStep) * 100).toFixed(2),
    stepLengthLMean: +lenL.toFixed(4),
    stepLengthRMean: +lenR.toFixed(4),
    stepLengthRatioLR: +(Math.max(lenL, lenR) / Math.max(1e-6, Math.min(lenL, lenR))).toFixed(4),
    stanceDurationLMean: +avg(stanceDurs[0]).toFixed(4),
    stanceDurationRMean: +avg(stanceDurs[1]).toFixed(4),
    swingDurationLMean: +avg(swingDurs[0]).toFixed(4),
    swingDurationRMean: +avg(swingDurs[1]).toFixed(4),
    doubleSupportPct: +((dsFrames / n) * 100).toFixed(1),
    flightPct: +((flFrames / n) * 100).toFixed(1),
    pelvisAmpCm: +pelvisAmpCm.toFixed(2),
    headAmpCm: +headAmpCm.toFixed(2),
    pelvisMaxAy: +Math.max(...ay.map(Math.abs)).toFixed(2),
    pelvisMaxJerk: +Math.max(...jy.map(Math.abs)).toFixed(1),
    touchdownMaxJerk: +Math.max(0, ...tdJerks).toFixed(1),
    contactFootSpeedMean: +avg(cSpeeds).toFixed(3),
    contactFootSpeedMax: +Math.max(0, ...cSpeeds).toFixed(3),
    harmonicSubRatio: +(aSub / Math.max(1e-6, aStep)).toFixed(3),
    harmonicHighRatio: +(aHigh / Math.max(1e-6, aStep)).toFixed(3),
    armOppositeLegCorr: +corr.toFixed(3),
    armPhaseLagDeg: +armPhaseLagDeg.toFixed(1),
    samples3Cycles,
  }
}

function measureOutbreakSurvivor(name: string, speed: number): CycleSummary {
  const s = new OutbreakSurvivor({ addModel: () => 0 })
  s.profile = { ...humanProfiles.soldier }
  const dt = 1 / 60
  const warmupFrames = 180
  const measureFrames = 480
  let x = 0, y = 0
  let prevAnkles: [[number, number, number], [number, number, number]] | null = null
  let prevPlanted: [boolean, boolean] = [true, true]
  const touchdowns: { foot: 0 | 1; t: number; frame: number; x: number; contactSpeed: number }[] = []
  const liftoffs: { foot: 0 | 1; t: number; frame: number; x: number }[] = []
  const rawSamples: RawSample[] = []

  for (let n = 0; n < warmupFrames + measureFrames; n++) {
    const t = n * dt
    x += speed * dt
    s.draw({ x, y, vx: speed, vy: 0, aim: 0 }, dt, t, () => 0)
    const pel = s.bones.pelvis!, torso = s.bones.torso!, head = s.bones.head!
    const ftL = s.bones["left.foot"]!, ftR = s.bones["right.foot"]!
    const faL = s.bones["left.foreArm"]!, faR = s.bones["right.foreArm"]!
    const ankL: [number, number, number] = [...ftL.p]
    const ankR: [number, number, number] = [...ftR.p]
    const handL = at(faL, 0, -RIG.fore, 0)
    const handR = at(faR, 0, -RIG.fore, 0)
    const fts = (s as unknown as { feet: { planted: boolean }[] }).feet
    const plantedL = fts[0]!.planted
    const plantedR = fts[1]!.planted

    if (n >= warmupFrames) {
      const relT = (n - warmupFrames) * dt
      const speedL = prevAnkles ? Math.hypot((ankL[0] - prevAnkles[0][0]) / dt, (ankL[1] - prevAnkles[0][1]) / dt, (ankL[2] - prevAnkles[0][2]) / dt) : 0
      const speedR = prevAnkles ? Math.hypot((ankR[0] - prevAnkles[1][0]) / dt, (ankR[1] - prevAnkles[1][1]) / dt, (ankR[2] - prevAnkles[1][2]) / dt) : 0
      if (!prevPlanted[0] && plantedL) touchdowns.push({ foot: 0, t: relT, frame: n - warmupFrames, x: ankL[0], contactSpeed: speedL })
      if (!prevPlanted[1] && plantedR) touchdowns.push({ foot: 1, t: relT, frame: n - warmupFrames, x: ankR[0], contactSpeed: speedR })
      if (prevPlanted[0] && !plantedL) liftoffs.push({ foot: 0, t: relT, frame: n - warmupFrames, x: ankL[0] })
      if (prevPlanted[1] && !plantedR) liftoffs.push({ foot: 1, t: relT, frame: n - warmupFrames, x: ankR[0] })

      rawSamples.push({
        t: relT,
        pelvisY: pel.p[1],
        headY: head.p[1],
        footLYCm: (ankL[1] - RIG.ankle) * 100,
        footRYCm: (ankR[1] - RIG.ankle) * 100,
        footLSpeed: speedL,
        footRSpeed: speedR,
        plantedL: plantedL ? 1 : 0,
        plantedR: plantedR ? 1 : 0,
        legLFwdCm: (ankL[0] - pel.p[0]) * 100,
        legRFwdCm: (ankR[0] - pel.p[0]) * 100,
        handLFwdCm: (handL[0] - torso.p[0]) * 100,
        handRFwdCm: (handR[0] - torso.p[0]) * 100,
        phase: 0,
      })
    }
    prevPlanted = [plantedL, plantedR]
    prevAnkles = [ankL, ankR]
  }
  return summarizeSamples(name, "outbreak-survivor", speed, dt, rawSamples, touchdowns, liftoffs)
}

// Mocap reference curves. parseBvh converts to +X forward, +Y up.
async function extractMocap(name: string, clip: keyof typeof MOCAP, startFrame: number, endFrame: number) {
  const bvh = parseBvh(await loadMocap(clip, bvhDir))
  const dt = bvh.dt
  const poses = bvh.frames.slice(startFrame, Math.min(endFrame, bvh.frames.length))

  const minFootY = Math.min(...poses.map(p => Math.min(p.Foot_L![1]!, p.Foot_R![1]!)))
  const meanPelY = poses.reduce((s, p) => s + p.Hips![1]!, 0) / poses.length
  const meanHeadY = poses.reduce((s, p) => s + p.Head![1]!, 0) / poses.length
  const pelY = poses.map(p => p.Hips![1]!)
  const vy = pelY.map((y, idx) => (idx === 0 ? (pelY[1]! - y) / dt : (y - pelY[idx - 1]!) / dt))
  const ay = vy.map((v, idx) => (idx === 0 ? 0 : (v - vy[idx - 1]!) / dt))
  const jy = ay.map((a, idx) => (idx <= 1 ? 0 : (a - ay[idx - 1]!) / dt))

  const samples: TimeSample[] = poses.map((p, idx) => {
    const prev = poses[Math.max(0, idx - 1)]!
    const fL = p.Foot_L!, fR = p.Foot_R!
    const pfL = prev.Foot_L!, pfR = prev.Foot_R!
    const spL = idx === 0 ? 0 : Math.hypot(fL[0] - pfL[0], fL[1] - pfL[1], fL[2] - pfL[2]) / dt
    const spR = idx === 0 ? 0 : Math.hypot(fR[0] - pfR[0], fR[1] - pfR[1], fR[2] - pfR[2]) / dt
    const yL = (fL[1] - minFootY) * 100
    const yR = (fR[1] - minFootY) * 100
    return {
      t: +(idx * dt).toFixed(4),
      pelvisYCm: +((p.Hips![1]! - meanPelY) * 100).toFixed(3),
      pelvisAy: +ay[idx]!.toFixed(3),
      pelvisJy: +jy[idx]!.toFixed(1),
      headYCm: +((p.Head![1]! - meanHeadY) * 100).toFixed(3),
      footLYCm: +yL.toFixed(3),
      footRYCm: +yR.toFixed(3),
      footLSpeed: +spL.toFixed(3),
      footRSpeed: +spR.toFixed(3),
      plantedL: yL < 2.2 && spL < 0.8 ? 1 : 0,
      plantedR: yR < 2.2 && spR < 0.8 ? 1 : 0,
      legLFwdCm: +((fL[0] - p.Hips![0]!) * 100).toFixed(2),
      legRFwdCm: +((fR[0] - p.Hips![0]!) * 100).toFixed(2),
      handLFwdCm: +((p.Hand_L![0]! - p.Chest![0]!) * 100).toFixed(2),
      handRFwdCm: +((p.Hand_R![0]! - p.Chest![0]!) * 100).toFixed(2),
      phase: (idx / poses.length) % 1,
    }
  })

  return { name, dt, samples }
}

const results = {
  tag,
  timestamp: new Date().toISOString(),
  runs: {
    survivorWalk: measureBlackoutActor("survivor-walk", "survivor", 1.4, false),
    survivorWalkStage: measureBlackoutActor("survivor-walk-stage", "survivor", 1.45, true),
    survivorRun: measureBlackoutActor("survivor-run", "survivor", 4.2, false),
    survivorSprint: measureBlackoutActor("survivor-sprint", "survivor", 6.3, false),
    soldierWalk: measureBlackoutActor("soldier-walk", "soldier", 1.4, false),
    soldierRun: measureBlackoutActor("soldier-run", "soldier", 4.2, false),
    soldierSprint: measureBlackoutActor("soldier-sprint", "soldier", 6.3, false),
    outbreakSurvivorWalk: measureOutbreakSurvivor("outbreak-survivor-walk", 1.4),
    outbreakSurvivorRun: measureOutbreakSurvivor("outbreak-survivor-run", 4.2),
  },
  mocap: {
    walk: await extractMocap("mocap-walk", "walk", 35, 131), // 3.2s = 3 full cycles
    run: await extractMocap("mocap-run", "run", 4, 64), // 2.0s = 3 full cycles
  },
}

const outPath = join(OUT_DIR, `${tag}-data.json`)
writeFileSync(outPath, JSON.stringify(results, null, 2))

// Print compact summary table
console.log(`\n=== Gait Audit Summary (${tag}) ===`)
for (const [k, r] of Object.entries(results.runs)) {
  const { samples3Cycles: _, ...summary } = r
  console.log(k, JSON.stringify(summary))
}

console.log(`Saved ${outPath}`)
if (!flags.has("no-plot")) {
  const py = spawnSync("python3", [join(import.meta.dir, "../../games/blackout/scripts/animation/gait-plots.py"), OUT_DIR, tag], { stdio: "inherit" })
  if (py.status !== 0) process.exit(py.status ?? 1)
}
