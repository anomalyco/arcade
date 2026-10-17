import { locomotion, newMotion, pelvisPoint, type Foot, type Locomotion } from "@arcade/kit/human-locomotion"
import { poseLegs, poseUnarmedArms, unarmedHands } from "@arcade/kit/human-pose"
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"
import { at, clamp, pitch, roll, spring, stepSpring, yawFrame, type Frame, type V3 } from "@arcade/kit/rig"

// Adapter over the arcade kit's procedural human (packages/kit/human-locomotion.ts, human-pose.ts): world-locked foot
// contacts, toe roll, strafe/backpedal stance, turn-in-place steps, pelvis bob/sway/drop and unarmed arm swing. The kit
// is renderer-agnostic and works in its own proportions (RIG, flat floor at y = 0, plan x/z); this file runs it in
// "kit space" (world metres divided by the body's scale) and returns its frames. body.ts maps them onto the skinned
// skeleton, adds the real floor height per foot and re-solves the limbs with the mesh's own bone lengths.

/** A night janitor: upright, no weapon, unhurried; the soldier preset's crouch-run posture taken out. */
export const JANITOR: HumanProfile = {
  ...humanProfiles.soldier,
  runPosture: 0.12,
  crouchDepth: 0,
  leanScale: 0.85,
  swayScale: 1.2,
  twistScale: 1.2,
  hipDrop: 0.08,
  armSwing: 0.85,
  stepVariation: 0.4,
}

const angleDiff = (a: number, b: number) => {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

export type GaitPose = {
  pelvis: Frame
  torso: Frame
  head: Frame
  th: [Frame, Frame]
  sh: [Frame, Frame]
  ft: [Frame, Frame]
  toe: [Frame, Frame]
  /** Shoulder, elbow, hand (kit space) per side: left, right. */
  arms: [[V3, V3, V3], [V3, V3, V3]]
  feet: [Foot, Foot]
  /** Swing progress per foot (0..1, 0 while planted). */
  swing: [number, number]
  /** Where each swinging foot will land (kit plan [x, 0, z]). */
  targets: [V3, V3]
  run: number
}

export class Gait {
  readonly a: Locomotion & { unarmed: boolean }
  private chest = spring()
  private head = spring()
  private t = 0
  private fresh = true

  constructor(public profile: HumanProfile = JANITOR) {
    const foot = (side: number): Foot => {
      const p: V3 = [Math.cos(side * 1.2) * 0.15, 0, Math.sin(side * 1.2) * 0.15]
      return { p, yaw: 0, pitch: 0, planted: true, lift: [...p], liftYaw: 0 }
    }
    this.a = {
      x: 0, y: 0, vx: 0, vy: 0, aim: 0, svx: 0, svy: 0, acx: 0, acy: 0,
      legYaw: 0, gait: 0, duty: 0.6, phase: 0, back: false, turning: false, unarmed: true, seed: 41.7,
      feet: [foot(-1), foot(1)], motion: newMotion(0, 0, 0),
      leanX: spring(), leanY: spring(), dip: spring(), hitX: spring(), hitY: spring(),
    }
  }

  /** Forces the next step to re-seat both feet under the body (spawn, teleport, leaving fly mode). */
  reset() {
    this.fresh = true
  }

  /**
   * Advances one frame. `x`, `z` and `aim` are kit-space root position and facing (aim = atan2(forward z, forward x));
   * `lookPitch` is the view pitch (radians, up positive).
   */
  step(dt: number, x: number, z: number, aim: number, lookPitch: number): GaitPose {
    const a = this.a
    const p = this.profile
    dt = Math.max(dt, 1e-3)
    this.t += dt
    const teleport = this.fresh || Math.hypot(x - a.x, z - a.y) > 2.5
    const distance = teleport ? 0 : Math.hypot(x - a.x, z - a.y)
    const vx = teleport ? 0 : (x - a.x) / dt
    const vy = teleport ? 0 : (z - a.y) / dt
    a.x = x
    a.y = z
    // Position-derived velocity carries frame-time jitter; a light filter keeps the kit's own smoothing honest.
    const kRaw = 1 - Math.exp(-dt * 30)
    a.vx += (vx - a.vx) * kRaw
    a.vy += (vy - a.vy) * kRaw
    a.aim = aim
    if (teleport) {
      a.svx = a.svy = a.acx = a.acy = 0
      a.legYaw = aim
      a.gait = 0
      a.motion.enabled = false
      this.chest.x = this.head.x = aim
      this.chest.v = this.head.v = 0
    }
    const kv = 1 - Math.exp(-dt * 14)
    const nvx = a.svx + (a.vx - a.svx) * kv
    const nvy = a.svy + (a.vy - a.svy) * kv
    const ka = 1 - Math.exp(-dt * 10)
    a.acx += ((nvx - a.svx) / dt - a.acx) * ka
    a.acy += ((nvy - a.svy) / dt - a.acy) * ka
    a.svx = nvx
    a.svy = nvy
    const sp = Math.hypot(nvx, nvy)
    a.gait += ((sp > 0.35 ? 1 : 0) - a.gait) * Math.min(1, dt * 6)
    locomotion(a, dt, distance, teleport, p)
    this.fresh = false

    const m = a.motion
    // Chest lags the view a little (a 5 Hz spring) and counters the hips' twist; the head follows the view.
    this.chest.x = a.aim + angleDiff(this.chest.x, a.aim)
    stepSpring(this.chest, (p.chestHz * Math.PI * 2) ** 2, 1, dt, a.aim - m.twist.x * 0.65)
    this.chest.x = a.aim + clamp(angleDiff(this.chest.x, a.aim), -0.6, 0.6)
    this.head.x = a.aim

    let pelvis = yawFrame(pelvisPoint(a), a.aim + clamp(angleDiff(m.pelvis.x + m.twist.x, a.aim), -1.05, 1.05))
    pelvis = roll(pelvis, m.drop.x + m.bank.x * 0.5)
    pelvis = pitch(pelvis, -0.65 * m.posture.x)
    const legs = poseLegs(a, pelvis)

    const ca = Math.cos(a.aim)
    const sa = Math.sin(a.aim)
    const leanFwd = a.leanX.x * ca + a.leanY.x * sa
    const leanSide = -a.leanX.x * sa + a.leanY.x * ca
    const torsoYaw = this.chest.x
    const tb = torsoYaw - a.aim
    const breath = Math.sin(this.t * 1.7) * 0.012 * (1 - a.gait)
    // Looking down curls the upper back a little; looking up straightens it.
    const fwd = 0.045 + 0.025 * m.run + leanFwd + breath - lookPitch * 0.12 + m.posture.x * 0.5
    let torso = yawFrame(at(pelvis, 0, 0.1, 0), torsoYaw)
    torso = pitch(torso, -(fwd * Math.cos(tb) + leanSide * Math.sin(tb)))
    torso = roll(torso, leanSide * Math.cos(tb) + m.bank.x - fwd * Math.sin(tb) * 0.85)
    const head = pitch(yawFrame(at(torso, 0.02, 0.5, 0), this.head.x), lookPitch)

    const [handL, handR] = unarmedHands(a, torso, this.t * 2)
    const { ua, fa } = poseUnarmedArms(torso, handL, handR)
    const arm = (i: 0 | 1, hand: V3): [V3, V3, V3] => [ua[i].p, fa[i].p, hand]

    return {
      pelvis,
      torso,
      head,
      th: legs.th,
      sh: legs.sh,
      ft: legs.ft,
      toe: legs.toe,
      arms: [arm(0, handL), arm(1, handR)],
      feet: a.feet,
      swing: [a.feet[0].planted ? 0 : m.swings[0]!, a.feet[1].planted ? 0 : m.swings[1]!],
      targets: m.targets,
      run: m.run * a.gait,
    }
  }
}
