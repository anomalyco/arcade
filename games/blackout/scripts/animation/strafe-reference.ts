import type { RigJointMap } from "@arcade/kit/pose-diff"
import { HIP, ik, RIG, smooth, smoother, type V3 } from "@arcade/kit/rig"
import type { CycleFrames, Sample } from "./strafe"

const RAD = Math.PI / 180
const dt = 1 / 60
const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Authored strafe key poses, aim fixed along +X and travel toward the right (+Z).
 *
 * Side-step walk (0.8 m/s, 240 steps/min), the low-speed rule: the lead foot opens, the follower closes beside it and
 * never passes it. Keys, from the follower's touchdown:
 *   0/8 Close contact: feet 0.22 m apart, both planted, pelvis lowest.
 *   1/8 Load: weight over the follower, lead heel unweights.
 *   2/8 Lead lift: lead foot rises and opens 25° toward travel.
 *   3/8 Lead reach: lead foot at its highest, knee over the toes.
 *   4/8 Open contact: lead lands 0.62 m from the follower, pelvis low between the feet.
 *   5/8 Shift: weight crosses onto the lead foot.
 *   6/8 Follow lift: follower rises, stays on its own side.
 *   7/8 Follow reach: follower swings in, still 0.22 m short of the lead.
 *
 * Crossover run (4.2 m/s, 238 steps/min), the run-speed rule: hips turn 60° toward travel and the legs run along the
 * travel line while the chest keeps the aim. Feet land on either side of the travel line (±7 cm), so the left foot
 * crosses in front of the right in aim space without the boots touching. Keys follow the Williams run: Contact, Down,
 * Push-off, Flight, then the same for the other foot.
 */
type Gait = {
  speed: number
  /** Seconds per full cycle (two steps). */
  cycle: number
  duty: number
  pelvisYaw: number
  /** Foot yaw for the foot on the travel side (lead) and the other foot. */
  leadYaw: number
  followYaw: number
  /** Planted offsets from the travel line: along travel and across it, per foot [left, right]. */
  along: [number, number]
  across: [number, number]
  lift: number
  heelKick: number
  bob: number
  drop: number
  /** Seconds into the cycle at which each foot touches down [left, right]. */
  touchdown: [number, number]
}

function generate(g: Gait, cycles = 6): Sample[] {
  const travel = 90 * RAD
  const tv: V3 = [Math.cos(travel), 0, Math.sin(travel)]
  const tp: V3 = [-tv[2], 0, tv[0]]
  const D = g.speed * g.cycle
  const stance = g.duty * g.cycle
  const out: Sample[] = []
  const foot = (i: 0 | 1, t: number): { p: V3; planted: boolean; u: number } => {
    // Footprint k is planted from touchdown k until liftoff (touchdown + stance), then swings to footprint k + 1.
    const t0 = g.touchdown[i]
    const k = Math.floor((t - t0) / g.cycle)
    const local = t - t0 - k * g.cycle
    const print = (n: number): V3 => {
      const s = n * D + g.along[i]
      return [tv[0] * s + tp[0] * g.across[i], 0, tv[2] * s + tp[2] * g.across[i]]
    }
    if (local < stance) return { p: print(k), planted: true, u: 0 }
    const u = (local - stance) / (g.cycle - stance)
    const a = print(k), b = print(k + 1), e = smoother(u)
    return { p: [a[0] + (b[0] - a[0]) * e, g.lift * 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u), a[2] + (b[2] - a[2]) * e], planted: false, u }
  }
  // Pelvis rides over the mean footprint, travelling at constant speed.
  let centre = 0
  const probe = Math.round(g.cycle / dt)
  for (let n = 0; n < probe; n++) for (const i of [0, 1] as const) {
    const p = foot(i, g.cycle * 3 + n * dt).p
    centre += (p[0] * tv[0] + p[2] * tv[2] - g.speed * (g.cycle * 3 + n * dt)) / (2 * probe)
  }
  const across = (g.across[0] + g.across[1]) / 2
  for (let n = 0; n < Math.round(cycles * g.cycle / dt); n++) {
    const t = n * dt
    const s = g.speed * t + centre
    const phase = (t / g.cycle) % 1
    const py = HIP - g.drop - g.bob * Math.cos(4 * Math.PI * (phase - g.touchdown[0] / g.cycle - 0.07))
    const pelvis: V3 = [tv[0] * s + tp[0] * across, py, tv[2] * s + tp[2] * across]
    const cy = Math.cos(g.pelvisYaw), sy = Math.sin(g.pelvisYaw)
    const right: V3 = [-sy, 0, cy]
    const hips: [V3, V3] = [[pelvis[0] - right[0] * RIG.hipW, py, pelvis[2] - right[2] * RIG.hipW], [pelvis[0] + right[0] * RIG.hipW, py, pelvis[2] + right[2] * RIG.hipW]]
    const legs = ([0, 1] as const).map(i => {
      const f = foot(i, t)
      const yaw = i === 1 ? g.leadYaw : g.followYaw
      const fd: V3 = [Math.cos(yaw), 0, Math.sin(yaw)]
      const kick = g.heelKick * Math.sin(Math.PI * f.u) ** 2 * (1 - smooth((f.u - 0.7) / 0.25))
      const ankle: V3 = [f.p[0] - fd[0] * kick * 0.8, f.p[1] + RIG.ankle + kick, f.p[2] - fd[2] * kick * 0.8]
      const pole: V3 = [fd[0], 0.25, fd[2]]
      const [knee, end] = ik(hips[i], ankle, RIG.thigh, RIG.shin, pole)
      const ball: V3 = [end[0] + fd[0] * RIG.foot, end[1] - RIG.ankle, end[2] + fd[2] * RIG.foot]
      const toe: V3 = [ball[0] + fd[0] * RIG.toe, ball[1], ball[2] + fd[2] * RIG.toe]
      return { knee, ankle: end, ball, toe, planted: f.planted, yaw }
    })
    const up = (h: number): V3 => [pelvis[0], py + h, pelvis[2]]
    const waist = up(RIG.waist), chest = up(RIG.waist + RIG.shoulderY), neck = up(RIG.waist + RIG.neckY), headTop = up(RIG.waist + RIG.neckY + 0.26)
    const torsoYaw = 13.5 * RAD
    const tr: V3 = [-Math.sin(torsoYaw), 0, Math.cos(torsoYaw)]
    const shoulderL: V3 = [chest[0] - tr[0] * RIG.shoulderW, chest[1], chest[2] - tr[2] * RIG.shoulderW]
    const shoulderR: V3 = [chest[0] + tr[0] * RIG.shoulderW, chest[1], chest[2] + tr[2] * RIG.shoulderW]
    const grip: V3 = [chest[0] + 0.375, chest[1] - 0.05, chest[2] + 0.04]
    const [elbowL, wristL] = ik(shoulderL, [grip[0] + 0.02, grip[1] - 0.03, grip[2] - 0.02], RIG.upper, RIG.fore, [-0.15, -1, -1.1])
    const [elbowR, wristR] = ik(shoulderR, grip, RIG.upper, RIG.fore, [-0.5, -1, 0.8])
    const joints: RigJointMap = {
      pelvis, waist, chest, neck, headTop, shoulderL, elbowL, wristL, shoulderR, elbowR, wristR,
      hipL: hips[0], kneeL: legs[0]!.knee, ankleL: legs[0]!.ankle, ballL: legs[0]!.ball, toeL: legs[0]!.toe,
      hipR: hips[1], kneeR: legs[1]!.knee, ankleR: legs[1]!.ankle, ballR: legs[1]!.ball, toeR: legs[1]!.toe,
      gunGrip: grip, gunMuzzle: [grip[0] + 0.2, grip[1] + 0.03, grip[2]],
    }
    out.push({
      t, aim: 0, travel, speed: g.speed, joints, planted: [legs[0]!.planted, legs[1]!.planted],
      pelvisYaw: g.pelvisYaw, torsoYaw, footYaw: [legs[0]!.yaw, legs[1]!.yaw],
    })
  }
  return out
}

function cycleOf(samples: Sample[], g: Gait, count = 16): CycleFrames {
  const start = Math.round((g.cycle * 2 + g.touchdown[0]) / dt)
  const len = Math.round(g.cycle / dt)
  const frames = Array.from({ length: count }, (_, q) => {
    const s = samples[start + Math.round(len * q / count)]!
    const o = s.joints.pelvis
    const joints = {} as RigJointMap
    for (const [k, p] of Object.entries(s.joints) as [keyof RigJointMap, V3][]) joints[k] = [r3(p[0] - o[0]), r3(p[1]), r3(p[2] - o[2])]
    return { joints, planted: s.planted, travel: r3(s.travel) }
  })
  return { phases: count, durationSec: g.cycle, frames }
}

export function buildSideStepReference() {
  const cycle = 0.5, duty = 0.62
  const g: Gait = {
    speed: 0.8, cycle, duty, pelvisYaw: 15 * RAD, leadYaw: 25 * RAD, followYaw: 5 * RAD,
    // Follower (left) lands 0.22 m short of the lead's last footprint; the lead opens 0.40 m beyond it.
    along: [0, 0.62], across: [0, 0],
    lift: 0.07, heelKick: 0.01, bob: 0.012, drop: 0.03,
    touchdown: [0, cycle / 2],
  }
  const samples = generate(g)
  return { samples, cycle: cycleOf(samples, g), note: "Authored side-step walk 0.8 m/s: lead opens 0.40 m, follower closes to 0.22 m, never crossing" }
}

export function buildCrossoverRunReference() {
  const cycle = 120 / 238, duty = 0.32
  const g: Gait = {
    speed: 4.2, cycle, duty, pelvisYaw: 60 * RAD, leadYaw: 72 * RAD, followYaw: 72 * RAD,
    along: [0, 4.2 * cycle / 2], across: [-0.07, 0.07],
    lift: 0.2, heelKick: 0.2, bob: 0.03, drop: 0.07,
    touchdown: [0, cycle / 2],
  }
  const samples = generate(g)
  return { samples, cycle: cycleOf(samples, g), note: "Authored crossover run 4.2 m/s: hips 60° toward travel, chest on aim, left crosses in front of right with clearance" }
}
