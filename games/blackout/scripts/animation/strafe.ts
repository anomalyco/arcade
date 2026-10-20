import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { humanProfiles } from "@arcade/kit/human-profile"
import { extractBodyJoints, extractBonePoseJoints, parseBvh, retargetBvhFrame, POSE_JOINTS, type RigJointMap } from "@arcade/kit/pose-diff"
import { at, dot, HIP, type Frame, type V3 } from "@arcade/kit/rig"
import { animate, newAvatar } from "../../src/game/anim"
import { Survivor as OutbreakSurvivor } from "../../../outbreak/src/survivor"
import { fixturesDir, loadMocap, parseArgs } from "./common"
import { load100Style, parse100Style } from "./open-mocap"
import { buildCrossoverRunReference, buildSideStepReference } from "./strafe-reference"

// Strafe audit: feet, pelvis, torso, knees and arms while travel and aim disagree.
// Usage: bun games/blackout/scripts/animation/strafe.ts --tag before|after [--out dir] [--bvh-dir dir] [--no-render]
const { tag, out: OUT_DIR, values, flags } = parseArgs(process.argv.slice(2), { tag: "before", out: "strafe" })
const bvhDir = values["bvh-dir"] ? resolve(values["bvh-dir"]) : fixturesDir

const dt = 1 / 60
const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000
const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
const yawOf = (f: Frame) => Math.atan2(f.x[2], f.x[0])
const mean = (xs: number[]) => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
const maxAbs = (xs: number[]) => xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const pct = (xs: boolean[]) => xs.length ? 100 * xs.filter(Boolean).length / xs.length : 0
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

export type Sample = {
  t: number
  aim: number
  travel: number
  speed: number
  joints: RigJointMap
  planted: [boolean, boolean]
  pelvisYaw: number
  torsoYaw: number
  footYaw: [number, number]
}

type Actor = { name: string; step(t: number, x: number, y: number, vx: number, vy: number, aim: number): Sample }
type ActorKind = "survivor" | "soldier" | "outbreak-aim"

function makeActor(kind: ActorKind): Actor {
  if (kind === "outbreak-aim") {
    const s = new OutbreakSurvivor({ addModel: () => 0 })
    s.profile = { ...humanProfiles.soldier, stepVariation: 0 }
    const feet = (s as unknown as { feet: { planted: boolean }[] }).feet
    return {
      name: kind,
      step(t, x, y, vx, vy, aim) {
        s.draw({ x, y, vx, vy, aim, equippedItem: "pistol", aiming: true }, dt, t, () => 0)
        const joints = extractBonePoseJoints(s.bones)
        if (s.gun) {
          joints.gunGrip = [...s.gun.p] as V3
          joints.gunMuzzle = at(s.gun, 0.2, 0.03, 0)
        }
        const b = s.bones
        return {
          t, aim, travel: Math.atan2(vy, vx), speed: Math.hypot(vx, vy), joints,
          planted: [feet[0]!.planted, feet[1]!.planted],
          pelvisYaw: yawOf(b.pelvis!), torsoYaw: yawOf(b.torso!),
          footYaw: [yawOf(b["left.foot"]!), yawOf(b["right.foot"]!)],
        }
      },
    }
  }
  const a = newAvatar(kind, 0, 0, 0, "rifle")
  a.profile = { ...humanProfiles.soldier, stepVariation: 0 }
  a.unarmed = kind === "survivor"
  return {
    name: kind,
    step(t, x, y, vx, vy, aim) {
      animate(a, dt, t, x, y, vx, vy, aim, false)
      const b = a.body!
      const joints = extractBodyJoints(b, a.unarmed ? null : b.gun)
      return {
        t, aim, travel: Math.atan2(vy, vx), speed: Math.hypot(vx, vy), joints,
        planted: [a.feet[0].planted, a.feet[1].planted],
        pelvisYaw: yawOf(b.pelvis), torsoYaw: yawOf(b.torso),
        footYaw: [yawOf(b.ft[0]), yawOf(b.ft[1])],
      }
    },
  }
}

/** Constant velocity at `rel` radians from a fixed aim of 0 (+X); +90° travels toward the actor's right (+Z). */
function runCase(kind: ActorKind, speed: number, rel: number, seconds = 9): Sample[] {
  const actor = makeActor(kind)
  const vx = speed * Math.cos(rel), vy = speed * Math.sin(rel)
  const out: Sample[] = []
  let x = 0, y = 0
  for (let n = 0; n < Math.round(seconds / dt); n++) {
    x += vx * dt; y += vy * dt
    out.push(actor.step(n * dt, x, y, vx, vy, 0))
  }
  return out.slice(Math.round(3 / dt))
}

/** Travel fixed along +X while the aim turns once around, so travel-vs-aim sweeps 0 → 360°. */
function runSweep(kind: ActorKind, speed: number, seconds = 24): Sample[] {
  const actor = makeActor(kind)
  const out: Sample[] = []
  let x = 0
  const settle = 2
  for (let n = 0; n < Math.round((seconds + settle) / dt); n++) {
    const t = n * dt
    x += speed * dt
    const aim = -TAU * Math.max(0, t - settle) / seconds
    out.push(actor.step(t, x, 0, speed, 0, aim))
  }
  return out.slice(Math.round(settle / dt))
}

/** Circle-strafe around the origin, always aiming at it. */
function runCircle(kind: ActorKind, speed: number, radius = 3, seconds = 12): Sample[] {
  const actor = makeActor(kind)
  const w = speed / radius
  const out: Sample[] = []
  for (let n = 0; n < Math.round(seconds / dt); n++) {
    const t = n * dt
    const th = w * t
    const x = radius * Math.cos(th), y = radius * Math.sin(th)
    const vx = -radius * w * Math.sin(th), vy = radius * w * Math.cos(th)
    out.push(actor.step(t, x, y, vx, vy, th + Math.PI))
  }
  return out.slice(Math.round(3 / dt))
}
const TAU = Math.PI * 2

function segDist(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]] as V3
  const d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]] as V3
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]] as V3
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r)
  let s = 0, t = 0
  const c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b
  s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0
  t = (b * s + f) / e
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)) } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)) }
  const dx = r[0] + d1[0] * s - d2[0] * t, dy = r[1] + d1[1] * s - d2[1] * t, dz = r[2] + d1[2] * s - d2[2] * t
  return Math.hypot(dx, dy, dz)
}

const heelOf = (ankle: V3, toe: V3): V3 => {
  const fx = toe[0] - ankle[0], fz = toe[2] - ankle[2], l = Math.hypot(fx, fz) || 1
  return [ankle[0] - fx / l * 0.07, toe[1], ankle[2] - fz / l * 0.07]
}

/** The legs' intended heading: travel, or travel reversed when backpedalling past 115°. */
const legTravel = (s: Sample) => Math.abs(wrap(s.travel - s.aim)) > 2.0 ? wrap(s.travel + Math.PI) : s.travel

export function strafeMetrics(samples: Sample[]) {
  const n = samples.length
  const crossAim: boolean[] = [], crossPelvis: boolean[] = [], footHit: boolean[] = [], kneeHit: boolean[] = []
  const footGap: number[] = [], kneeGap: number[] = [], shinGap: number[] = []
  const pelvisVsAim: number[] = [], pelvisVsTravel: number[] = [], torsoVsPelvis: number[] = [], torsoVsAim: number[] = []
  const kneeErr: number[] = [], footVsPelvis: number[] = [], footVsTravel: number[] = []
  const armRange = [[Infinity, -Infinity], [Infinity, -Infinity]]
  const touchdowns: { foot: 0 | 1; t: number; p: V3; latAim: number; latPelvis: number; stepWidth: number }[] = []
  const liftoffs: { foot: 0 | 1; t: number; p: V3 }[] = []
  const stepDirErr: number[] = []
  const slip: number[] = []
  const lock: (V3 | null)[] = [null, null]
  const pelvisYawRate: number[] = []
  const swingAccel: number[] = []
  const prevAnk: V3[][] = []
  for (let k = 0; k < n; k++) {
    const s = samples[k]!, j = s.joints
    const ra = [-Math.sin(s.aim), Math.cos(s.aim)]
    const rp = [-Math.sin(s.pelvisYaw), Math.cos(s.pelvisYaw)]
    const dLR = [j.ankleR[0] - j.ankleL[0], j.ankleR[2] - j.ankleL[2]]
    const latA = dLR[0]! * ra[0]! + dLR[1]! * ra[1]!
    const latP = dLR[0]! * rp[0]! + dLR[1]! * rp[1]!
    crossAim.push(latA < 0)
    crossPelvis.push(latP < 0)
    const hL = heelOf(j.ankleL, j.toeL), hR = heelOf(j.ankleR, j.toeR)
    const g = segDist(hL, j.toeL, hR, j.toeR)
    footGap.push(g); footHit.push(g < 0.11)
    const kg = Math.hypot(j.kneeR[0] - j.kneeL[0], j.kneeR[1] - j.kneeL[1], j.kneeR[2] - j.kneeL[2])
    kneeGap.push(kg); kneeHit.push(kg < 0.11)
    shinGap.push(segDist(j.kneeL, j.ankleL, j.kneeR, j.ankleR))
    const lt = legTravel(s)
    pelvisVsAim.push(wrap(s.pelvisYaw - s.aim) * DEG)
    pelvisVsTravel.push(wrap(s.pelvisYaw - lt) * DEG)
    torsoVsPelvis.push(wrap(s.torsoYaw - s.pelvisYaw) * DEG)
    torsoVsAim.push(wrap(s.torsoYaw - s.aim) * DEG)
    for (const i of [0, 1] as const) {
      const hip = i ? j.hipR : j.hipL, knee = i ? j.kneeR : j.kneeL, ank = i ? j.ankleR : j.ankleL
      const ax = ank[0] - hip[0], ay = ank[1] - hip[1], az = ank[2] - hip[2]
      const l2 = ax * ax + ay * ay + az * az || 1
      const u = ((knee[0] - hip[0]) * ax + (knee[1] - hip[1]) * ay + (knee[2] - hip[2]) * az) / l2
      const ox = knee[0] - (hip[0] + ax * u), oz = knee[2] - (hip[2] + az * u)
      if (s.planted[i] && Math.hypot(ox, oz) > 0.03) kneeErr.push(Math.abs(wrap(Math.atan2(oz, ox) - s.footYaw[i])) * DEG)
      if (s.planted[i]) {
        footVsPelvis.push(Math.abs(wrap(s.footYaw[i] - s.pelvisYaw)) * DEG)
        footVsTravel.push(Math.abs(wrap(s.footYaw[i] - lt)) * DEG)
      }
      const wrist = i ? j.wristR : j.wristL
      const fwd = (wrist[0] - j.chest[0]) * Math.cos(s.torsoYaw) + (wrist[2] - j.chest[2]) * Math.sin(s.torsoYaw)
      armRange[i]![0] = Math.min(armRange[i]![0]!, fwd); armRange[i]![1] = Math.max(armRange[i]![1]!, fwd)
      const toe = i ? j.toeR : j.toeL
      const was = k > 0 ? samples[k - 1]!.planted[i] : s.planted[i]
      if (s.planted[i] && !was) {
        const o = i ? j.ankleL : j.ankleR
        const tv = [Math.cos(s.travel), Math.sin(s.travel)]
        const sw = Math.abs((ank[0] - o[0]) * -tv[1]! + (ank[2] - o[2]) * tv[0]!)
        touchdowns.push({ foot: i, t: s.t, p: [...ank] as V3, latAim: Math.abs(latA), latPelvis: Math.abs(latP), stepWidth: sw })
        const lo = [...liftoffs].reverse().find(l => l.foot === i)
        if (lo) {
          const d = [ank[0] - lo.p[0], ank[2] - lo.p[2]]
          if (Math.hypot(d[0]!, d[1]!) > 0.08) stepDirErr.push(Math.abs(wrap(Math.atan2(d[1]!, d[0]!) - s.travel)) * DEG)
        }
        lock[i] = [...toe] as V3
      }
      if (!s.planted[i] && was) { liftoffs.push({ foot: i, t: s.t, p: [...ank] as V3 }); lock[i] = null }
      if (s.planted[i]) {
        if (!lock[i]) lock[i] = [...toe] as V3
        slip.push(Math.hypot(toe[0] - lock[i]![0], toe[2] - lock[i]![2]))
      } else if (k >= 2) {
        const p1 = prevAnk[k - 1]![i]!, p2 = prevAnk[k - 2]![i]!
        swingAccel.push(Math.hypot(ank[0] - 2 * p1[0] + p2[0], ank[1] - 2 * p1[1] + p2[1], ank[2] - 2 * p1[2] + p2[2]) / (dt * dt))
      }
    }
    prevAnk.push([[...j.ankleL] as V3, [...j.ankleR] as V3])
    if (k > 0) pelvisYawRate.push(wrap(s.pelvisYaw - samples[k - 1]!.pelvisYaw) / dt * DEG)
  }
  const steps = touchdowns.length
  const span = steps > 1 ? touchdowns[steps - 1]!.t - touchdowns[0]!.t : 1
  return {
    cadence: r1(steps > 1 ? (steps - 1) / span * 60 : 0),
    crossAimPct: r1(pct(crossAim)),
    crossPelvisPct: r1(pct(crossPelvis)),
    footCollisionPct: r1(pct(footHit)),
    minFootGapCm: r1(Math.min(...footGap) * 100),
    kneeCollisionPct: r1(pct(kneeHit)),
    minKneeGapCm: r1(Math.min(...kneeGap) * 100),
    minShinGapCm: r1(Math.min(...shinGap) * 100),
    touchdownWidthAimCm: r1(mean(touchdowns.map(t => t.latAim)) * 100),
    touchdownWidthPelvisCm: r1(mean(touchdowns.map(t => t.latPelvis)) * 100),
    minTouchdownWidthPelvisCm: r1(Math.min(...touchdowns.map(t => t.latPelvis), 9) * 100),
    stepWidthCm: r1(mean(touchdowns.map(t => t.stepWidth)) * 100),
    stepDirErrDeg: r1(mean(stepDirErr)),
    stepDirErrP90Deg: r1(quantile(stepDirErr, 0.9)),
    pelvisVsAimDeg: r1(mean(pelvisVsAim)),
    pelvisVsTravelDeg: r1(mean(pelvisVsTravel)),
    pelvisYawRangeDeg: r1(Math.max(...pelvisVsAim) - Math.min(...pelvisVsAim)),
    torsoVsPelvisDeg: r1(mean(torsoVsPelvis)),
    torsoVsAimDeg: r1(mean(torsoVsAim)),
    torsoVsAimMaxDeg: r1(maxAbs(torsoVsAim)),
    kneeVsFootDeg: r1(mean(kneeErr)),
    kneeVsFootP90Deg: r1(quantile(kneeErr, 0.9)),
    footVsPelvisDeg: r1(mean(footVsPelvis)),
    footVsTravelDeg: r1(mean(footVsTravel)),
    plantedSlipMm: r2(Math.max(0, ...slip) * 1000),
    armSwingLCm: r1((armRange[0]![1]! - armRange[0]![0]!) * 100),
    armSwingRCm: r1((armRange[1]![1]! - armRange[1]![0]!) * 100),
    maxPelvisYawRateDps: r1(maxAbs(pelvisYawRate)),
    maxSwingAnkleAccel: r1(Math.max(0, ...swingAccel)),
    p99SwingAnkleAccel: r1(quantile(swingAccel, 0.99)),
  }
}
export type StrafeMetrics = ReturnType<typeof strafeMetrics>

/** Joints in the aim frame (aim faces +X, right +Z), pelvis at the origin horizontally, height over the floor kept. */
function toAimFrame(j: RigJointMap, aim: number, origin: V3): RigJointMap {
  const c = Math.cos(-aim), s = Math.sin(-aim)
  const out = {} as RigJointMap
  const xf = (p: V3): V3 => {
    const dx = p[0] - origin[0], dz = p[2] - origin[2]
    return [r3(dx * c - dz * s), r3(p[1]), r3(dx * s + dz * c)]
  }
  for (const id of POSE_JOINTS) out[id] = xf(j[id])
  if (j.gunGrip && j.gunMuzzle) { out.gunGrip = xf(j.gunGrip); out.gunMuzzle = xf(j.gunMuzzle) }
  return out
}

export type CycleFrames = { phases: number; durationSec: number; frames: { joints: RigJointMap; planted: [boolean, boolean]; travel: number }[] }

/** 16 evenly spaced frames from a left touchdown to the next. */
function extractCycle(samples: Sample[], count = 16): CycleFrames | null {
  const tds: number[] = []
  for (let k = 1; k < samples.length; k++) if (samples[k]!.planted[0] && !samples[k - 1]!.planted[0]) tds.push(k)
  const pick = tds.findIndex(k => samples[k]!.t - samples[0]!.t > 1)
  if (pick < 0 || pick + 1 >= tds.length) return null
  const a = tds[pick]!, b = tds[pick + 1]!
  const frames = Array.from({ length: count }, (_, q) => {
    const s = samples[Math.round(a + (b - a) * q / count)]!
    return { joints: toAimFrame(s.joints, s.aim, s.joints.pelvis), planted: s.planted, travel: r3(wrap(s.travel - s.aim)) }
  })
  return { phases: count, durationSec: r3((b - a) * dt), frames }
}

function sweepSeries(samples: Sample[]) {
  const every = 4
  const series = samples.filter((_, k) => k % every === 0).map(s => {
    const j = s.joints
    const ra = [-Math.sin(s.aim), Math.cos(s.aim)]
    const latA = (j.ankleR[0] - j.ankleL[0]) * ra[0]! + (j.ankleR[2] - j.ankleL[2]) * ra[1]!
    const g = segDist(heelOf(j.ankleL, j.toeL), j.toeL, heelOf(j.ankleR, j.toeR), j.toeR)
    let rel = wrap(s.travel - s.aim) * DEG
    if (rel < 0) rel += 360
    return {
      rel: r1(rel), pelvisVsAim: r1(wrap(s.pelvisYaw - s.aim) * DEG), torsoVsAim: r1(wrap(s.torsoYaw - s.aim) * DEG),
      latAimCm: r1(latA * 100), footGapCm: r1(g * 100),
    }
  })
  return series
}

// ---------------------------------------------------------------------------------------------------------------
// Mocap references: the dataset's walk-to-the-side clips keep the hips facing travel with the chest turned back
// toward the front, and walk-back is a true backpedal. Both are measured with the same metrics as the rig.

async function mocapSamples(clip: "walkLeft" | "walkRight" | "walkBack" | "walk" | "run", aimMode: "chest" | "hips") {
  const bvh = parseBvh(await loadMocap(clip, bvhDir))
  const frames = bvh.frames
  const minFootY = Math.min(...frames.map(p => Math.min(p.Toes_L![1], p.Toes_R![1], p.Foot_L![1], p.Foot_R![1])))
  const meanY = mean(frames.map(p => p.Hips![1]))
  const yawBar = (l: V3, r: V3) => Math.atan2(-(r[0] - l[0]), r[2] - l[2])
  const out: Sample[] = []
  const footY = (p: Record<string, V3>, s: "L" | "R") => Math.min(p[`Foot_${s}`]![1], p[`Toes_${s}`]![1]) - minFootY
  for (let k = 1; k < frames.length - 1; k++) {
    const p = frames[k]!, prev = frames[k - 1]!, next = frames[k + 1]!
    const local = retargetBvhFrame(p, meanY, minFootY)
    const pelvisYaw = yawBar(p.UpperLeg_L!, p.UpperLeg_R!)
    const chestYaw = yawBar(p.UpperArm_L!, p.UpperArm_R!)
    // Retargeting drops root translation; restore it so footprints are planted in world space.
    const scale = HIP / Math.max(0.4, meanY - minFootY)
    const off: V3 = [p.Hips![0] * scale, 0, p.Hips![2] * scale]
    const joints = {} as RigJointMap
    for (const id of POSE_JOINTS) joints[id] = [local[id][0] + off[0], local[id][1], local[id][2] + off[2]]
    const vx = (next.Hips![0] - prev.Hips![0]) / (2 * bvh.dt), vz = (next.Hips![2] - prev.Hips![2]) / (2 * bvh.dt)
    const footSpeed = (s: "L" | "R") => Math.hypot(next[`Foot_${s}`]![0] - prev[`Foot_${s}`]![0], next[`Foot_${s}`]![2] - prev[`Foot_${s}`]![2]) / (2 * bvh.dt)
    const toeYaw = (s: "L" | "R") => Math.atan2(p[`Toes_${s}`]![2] - p[`Foot_${s}`]![2], p[`Toes_${s}`]![0] - p[`Foot_${s}`]![0])
    out.push({
      t: k * bvh.dt, aim: aimMode === "chest" ? chestYaw : pelvisYaw, travel: Math.atan2(vz, vx), speed: Math.hypot(vx, vz) * scale, joints,
      planted: [footY(p, "L") < 0.05 && footSpeed("L") < 0.45, footY(p, "R") < 0.05 && footSpeed("R") < 0.45],
      pelvisYaw, torsoYaw: chestYaw, footYaw: [toeYaw("L"), toeYaw("R")],
    })
  }
  return { dt: bvh.dt, samples: out }
}

/**
 * 100STYLE Neutral side-step (SW walk, SR run) and backward (BW, BR) takes (CC BY 4.0): the steadiest stretch whose
 * travel stays within 30° of `target` (chest frame, + = to the right), scaled to metres (hip height = HIP).
 * The subject keeps facing the capture area's front, so the chest is the aim, as in a game strafe.
 */
async function styleSamples(take: string, target: number, minSeconds = 1.6) {
  const clip = parse100Style(await load100Style(take))
  const F = clip.frames
  const minY = Math.min(...F.map(f => Math.min(f.Foot_L![1], f.Foot_R![1], f.Toes_L![1], f.Toes_R![1])))
  const sc = HIP / (mean(F.map(f => f.Hips![1])) - minY)
  const m = F.map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, [v[0] * sc, (v[1] - minY) * sc, v[2] * sc] as V3])) as Record<string, V3>)
  const yawBar = (l: V3, r: V3) => Math.atan2(-(r[0] - l[0]), r[2] - l[2])
  const half = Math.round(0.25 / clip.dt)
  const ok: boolean[] = m.map((_, k) => {
    if (k < half || k >= m.length - half) return false
    const a = m[k - half]!.Hips!, b = m[k + half]!.Hips!
    const v = Math.hypot(b[0] - a[0], b[2] - a[2]) / (2 * half * clip.dt)
    const rel = wrap(Math.atan2(b[2] - a[2], b[0] - a[0]) - yawBar(m[k]!.UpperArm_L!, m[k]!.UpperArm_R!))
    return v > 0.35 && Math.abs(wrap(rel - target)) < 30 * RAD
  })
  let best = { s: 0, e: 0, v: 0 }
  for (let k = 0; k < ok.length;) {
    if (!ok[k]) { k++; continue }
    let e = k
    while (e < ok.length && ok[e]) e++
    if ((e - k) * clip.dt >= minSeconds) {
      const v = Math.hypot(m[e - 1]!.Hips![0] - m[k]!.Hips![0], m[e - 1]!.Hips![2] - m[k]!.Hips![2]) / ((e - 1 - k) * clip.dt)
      if (v > best.v) best = { s: k, e, v }
    }
    k = e
  }
  if (best.e === 0) throw new Error(`${take}: no steady stretch toward ${target * DEG}°`)
  return { dt: clip.dt, speed: r2(best.v), samples: framesToSamples(m.slice(best.s, best.e), clip.dt) }
}

/** Metre-scale, floor-at-zero mocap frames (retargetBvhFrame's joint names) to strafe samples, aim = chest. */
function framesToSamples(frames: Record<string, V3>[], frameDt: number): Sample[] {
  const meanY = mean(frames.map(p => p.Hips![1]))
  const yawBar = (l: V3, r: V3) => Math.atan2(-(r[0] - l[0]), r[2] - l[2])
  const out: Sample[] = []
  const footY = (p: Record<string, V3>, s: "L" | "R") => Math.min(p[`Foot_${s}`]![1], p[`Toes_${s}`]![1])
  const floor = { L: Math.min(...frames.map(p => footY(p, "L"))), R: Math.min(...frames.map(p => footY(p, "R"))) }
  for (let k = 1; k < frames.length - 1; k++) {
    const p = frames[k]!, prev = frames[k - 1]!, next = frames[k + 1]!
    const local = retargetBvhFrame(p, meanY, 0)
    const pelvisYaw = yawBar(p.UpperLeg_L!, p.UpperLeg_R!)
    const chestYaw = yawBar(p.UpperArm_L!, p.UpperArm_R!)
    const scale = HIP / Math.max(0.4, meanY)
    const off: V3 = [p.Hips![0] * scale, 0, p.Hips![2] * scale]
    const joints = {} as RigJointMap
    for (const id of POSE_JOINTS) joints[id] = [local[id][0] + off[0], local[id][1], local[id][2] + off[2]]
    const vx = (next.Hips![0] - prev.Hips![0]) / (2 * frameDt), vz = (next.Hips![2] - prev.Hips![2]) / (2 * frameDt)
    const footSpeed = (s: "L" | "R") => Math.hypot(next[`Toes_${s}`]![0] - prev[`Toes_${s}`]![0], next[`Toes_${s}`]![2] - prev[`Toes_${s}`]![2]) / (2 * frameDt)
    const toeYaw = (s: "L" | "R") => Math.atan2(p[`Toes_${s}`]![2] - p[`Foot_${s}`]![2], p[`Toes_${s}`]![0] - p[`Foot_${s}`]![0])
    out.push({
      t: k * frameDt, aim: chestYaw, travel: Math.atan2(vz, vx), speed: Math.hypot(vx, vz), joints,
      planted: [footY(p, "L") - floor.L < 0.04 && footSpeed("L") < 0.35, footY(p, "R") - floor.R < 0.04 && footSpeed("R") < 0.35],
      pelvisYaw, torsoYaw: chestYaw, footYaw: [toeYaw("L"), toeYaw("R")],
    })
  }
  return out
}

function mocapCycle(samples: Sample[], frameDt: number, count = 16): CycleFrames | null {
  const tds: number[] = []
  for (let k = 1; k < samples.length; k++) if (samples[k]!.planted[0] && !samples[k - 1]!.planted[0]) tds.push(k)
  if (tds.length < 2) {
    // A single recorded cycle: use the whole clip.
    if (samples.length < 10) return null
    tds.splice(0, tds.length, 0, samples.length - 1)
  }
  const a = tds[0]!, b = tds[1]!
  const frames = Array.from({ length: count }, (_, q) => {
    const s = samples[Math.round(a + (b - a) * q / count)]!
    return { joints: toAimFrame(s.joints, s.aim, s.joints.pelvis), planted: s.planted, travel: r3(wrap(s.travel - s.aim)) }
  })
  return { phases: count, durationSec: r3((b - a) * frameDt), frames }
}

// ---------------------------------------------------------------------------------------------------------------

const ANGLES = [0, 45, 90, 135, 180, -135, -90, -45]
const SPEEDS = { slow: 0.8, walk: 1.4, jog: 3.4, run: 4.2 } as const
const ACTORS: ActorKind[] = ["survivor", "soldier", "outbreak-aim"]
const SHEET_CASES = new Set(["90", "-90", "45", "135", "180"])

const cases: Record<string, { actor: ActorKind; gait: keyof typeof SPEEDS; angle: number; speed: number; metrics: StrafeMetrics; cycle: CycleFrames | null }> = {}
for (const actor of ACTORS) {
  for (const [gaitName, speed] of Object.entries(SPEEDS) as [keyof typeof SPEEDS, number][]) {
    for (const angle of ANGLES) {
      const samples = runCase(actor, speed, angle * RAD)
      const key = `${actor}/${gaitName}/${angle}`
      cases[key] = {
        actor, gait: gaitName, angle, speed,
        metrics: strafeMetrics(samples),
        cycle: SHEET_CASES.has(String(angle)) || angle === 0 ? extractCycle(samples) : null,
      }
    }
  }
}

const sweeps: Record<string, { metrics: StrafeMetrics; series: ReturnType<typeof sweepSeries> }> = {}
for (const actor of ACTORS) {
  for (const gaitName of ["walk", "run"] as const) {
    const samples = runSweep(actor, SPEEDS[gaitName])
    sweeps[`${actor}/${gaitName}`] = { metrics: strafeMetrics(samples), series: sweepSeries(samples) }
  }
}

const circles: Record<string, StrafeMetrics> = {}
for (const actor of ACTORS) for (const gaitName of ["walk", "jog"] as const) circles[`${actor}/${gaitName}`] = strafeMetrics(runCircle(actor, SPEEDS[gaitName]))

const mocap: Record<string, { metrics: StrafeMetrics; cycle: CycleFrames | null; note: string }> = {}
for (const [name, clip, note] of [
  ["walk-right", "walkRight", "Walk to the right: hips turn to travel, chest stays toward the front"],
  ["walk-left", "walkLeft", "Walk to the left: hips turn to travel, chest stays toward the front"],
  ["walk-back", "walkBack", "Backpedal walk"],
  ["walk", "walk", "Forward walk"],
  ["run", "run", "Forward run"],
] as const) {
  const m = await mocapSamples(clip, "chest")
  mocap[name] = { metrics: strafeMetrics(m.samples), cycle: mocapCycle(m.samples, m.dt), note }
}

for (const [name, take, target, note] of [
  ["100style side-walk R", "Neutral_SW", 90, "100STYLE side-step walk to the right"],
  ["100style side-walk L", "Neutral_SW", -90, "100STYLE side-step walk to the left"],
  ["100style side-run R", "Neutral_SR", 90, "100STYLE side-step run to the right"],
  ["100style side-run L", "Neutral_SR", -90, "100STYLE side-step run to the left"],
  ["100style back-walk", "Neutral_BW", 180, "100STYLE backward walk"],
  ["100style back-run", "Neutral_BR", 180, "100STYLE backward run"],
] as const) {
  const m = await styleSamples(take, target * RAD)
  mocap[name] = { metrics: strafeMetrics(m.samples), cycle: mocapCycle(m.samples, m.dt), note: `${note} (${m.speed} m/s)` }
}

const authored = {
  sideStepWalk: buildSideStepReference(),
  crossoverRun: buildCrossoverRunReference(),
}
const authoredMetrics = Object.fromEntries(Object.entries(authored).map(([k, v]) => [k, strafeMetrics(v.samples)]))

const result = {
  tag,
  timestamp: new Date().toISOString(),
  speeds: SPEEDS,
  cases,
  sweeps,
  circles,
  mocap,
  authored: Object.fromEntries(Object.entries(authored).map(([k, v]) => [k, { metrics: authoredMetrics[k], cycle: v.cycle, note: v.note }])),
}
const outPath = join(OUT_DIR, `strafe-${tag}.json`)
writeFileSync(outPath, JSON.stringify(result))

const cols = ["crossAimPct", "footCollisionPct", "minFootGapCm", "minKneeGapCm", "touchdownWidthPelvisCm", "stepDirErrDeg", "pelvisVsAimDeg", "pelvisVsTravelDeg", "torsoVsAimDeg", "kneeVsFootDeg", "footVsPelvisDeg", "plantedSlipMm", "cadence"] as const
const row = (label: string, m: StrafeMetrics) => console.log(label.padEnd(26), cols.map(c => String(m[c]).padStart(7)).join(" "))
console.log(`\n=== Strafe audit (${tag}) ===`)
console.log("".padEnd(26), cols.map(c => c.replace(/Pct|Deg|Cm|Mm/, "").slice(0, 7).padStart(7)).join(" "))
for (const [k, c] of Object.entries(cases)) row(k, c.metrics)
console.log("--- sweeps (0→360° travel vs aim)")
for (const [k, s] of Object.entries(sweeps)) {
  row(k, s.metrics)
  console.log("".padEnd(26), `maxPelvisYawRate ${s.metrics.maxPelvisYawRateDps}°/s  p99SwingAccel ${s.metrics.p99SwingAnkleAccel} max ${s.metrics.maxSwingAnkleAccel} m/s²`)
}
console.log("--- circle strafe (r = 3 m, aiming at centre)")
for (const [k, m] of Object.entries(circles)) row(k, m)
console.log("--- references")
for (const [k, r] of Object.entries(mocap)) row(`mocap ${k}`, r.metrics)
for (const [k, m] of Object.entries(authoredMetrics)) row(`authored ${k}`, m)
console.log(`Saved ${outPath}`)

if (!flags.has("no-render")) {
  const py = spawnSync("python3", [join(import.meta.dir, "strafe-render.py"), OUT_DIR, tag], { stdio: "inherit" })
  if (py.status !== 0) process.exit(py.status ?? 1)
}
