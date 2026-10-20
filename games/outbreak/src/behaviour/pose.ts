import { angleDiff } from "@arcade/kit/sim/geom"
import type { AIAgent } from "../../shared/ai"
import {
  ACT_CLIMB_CAR,
  ACT_CLIMB_FENCE,
  ACT_FEED,
  ACT_FLINCH,
  ACT_FREEZE,
  ACT_GIVE_UP,
  ACT_JOSTLED,
  ACT_LISTEN,
  ACT_NONE,
  ACT_PAUSE,
  ACT_PEER,
  ACT_REST_SIT,
  ACT_REST_SLUMP,
  ACT_REST_STAND,
  ACT_SNAGGED,
  ACT_SNIFF,
} from "../../shared/behaviour/activities"
import { zombiePersonality, type ZombiePersonality } from "../../shared/behaviour/personality"
import { DEFAULT_BEHAVIOUR_TUNING, type BehaviourTuning } from "../../shared/behaviour/tuning"

/**
 * How one zombie's personality and what it is doing bend its walk this frame (presentation only). The crowd
 * renderer (`src/zombies.ts`) asks for this once per drawn zombie and adds it to its own shamble: a longer, slower
 * stride (the 100STYLE zombie walks ~86 steps a minute where the shamble took ~114), a hunch and lean, a limp, arms
 * held out, a head that turns to what it noticed and to the torch, and the poses of each activity (sitting, slumped,
 * feeding, sniffing, peering in, flinching, frozen by lightning, climbing). Activity poses ease in and out on springs
 * so a zombie that gets up does so over a beat.
 */
export type ZombieBehaviourPose = {
  /** Multiplies the stride length (so cadence falls at the same speed). */
  strideMul: number
  /** Extra forward pitch of the torso and the pelvis, radians. */
  torsoPitch: number
  pelvisPitch: number
  /** Sideways roll of the torso, radians. */
  torsoRoll: number
  /** Metres the pelvis sinks (crouch, sit, slump). */
  pelvisDrop: number
  /** Metres the rest feet sit ahead of the hips (sitting with the knees up). */
  feetForward: number
  /** Head yaw relative to where the body faces, and extra pitch (+ up) and roll, radians. */
  headYaw: number
  headPitch: number
  headRoll: number
  /** 0..1 how far the hands are held out in front, toward the ground, and up before the face. */
  handsOut: number
  handsGround: number
  handsFace: number
  /** Limp: −1 left, 1 right, and how much (0..1). */
  limpSide: number
  limp: number
  /** Multiplies the clamber hop (fences and bonnets are higher than a sill). */
  liftMul: number
  /** Multiplies how high a swinging foot clears the ground (shufflers barely lift theirs). */
  footLift: number
}

const ZERO: ZombieBehaviourPose = {
  strideMul: 1,
  torsoPitch: 0,
  pelvisPitch: 0,
  torsoRoll: 0,
  pelvisDrop: 0,
  feetForward: 0,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  handsOut: 0,
  handsGround: 0,
  handsFace: 0,
  limpSide: 0,
  limp: 0,
  liftMul: 1,
  footLift: 1,
}

/** What the poser needs to know about the world this frame. */
export type PoseWorld = {
  /** The zombie's behaviour activity (an `ACT_*` code). */
  activity: (id: number) => number
  /** Survivors it may look at, with their torches. */
  survivors: readonly { x: number; y: number; aim: number; flashlightOn: boolean }[]
}

const SPRINGS = 8
const S_SIT = 0
const S_SLUMP = 1
const S_CROUCH = 2
const S_GROUND = 3
const S_FACE = 4
const S_LOOK = 5
const S_UP = 6
const S_STILL = 7

export class BehaviourPoser {
  tuning: BehaviourTuning = DEFAULT_BEHAVIOUR_TUNING
  world: PoseWorld | null = null
  /** Overrides every zombie's personality (the reference-clip tooling uses an average one). */
  personalityOverride: ZombiePersonality | null = null
  private readonly slot = new Map<number, number>()
  private x = new Float32Array(64 * SPRINGS)
  private v = new Float32Array(64 * SPRINGS)
  private readonly p: ZombiePersonality = zombiePersonality(0)
  private readonly out: ZombieBehaviourPose = { ...ZERO }

  reset(): void {
    this.slot.clear()
  }

  private index(id: number): number {
    let s = this.slot.get(id)
    if (s === undefined) {
      s = this.slot.size
      if ((s + 1) * SPRINGS > this.x.length) {
        const nx = new Float32Array(this.x.length * 2)
        nx.set(this.x)
        this.x = nx
        const nv = new Float32Array(this.v.length * 2)
        nv.set(this.v)
        this.v = nv
      }
      this.x.fill(0, s * SPRINGS, (s + 1) * SPRINGS)
      this.v.fill(0, s * SPRINGS, (s + 1) * SPRINGS)
      this.slot.set(id, s)
    }
    return s
  }

  /** Critically damped spring toward `goal` at `hz`; returns the new value. */
  private spring(base: number, k: number, goal: number, hz: number, dt: number): number {
    const i = base + k
    const w = hz * Math.PI * 2
    let x = this.x[i]!
    let v = this.v[i]!
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    for (let n = 0; n < steps; n++) {
      v += (-(x - goal) * w * w - v * 2 * w) * h
      x += v * h
    }
    this.x[i] = x
    this.v[i] = v
    return x
  }

  pose(a: AIAgent, dt: number, time: number): ZombieBehaviourPose {
    const t = this.tuning
    const out = this.out
    Object.assign(out, ZERO)
    if (t.zbMode < 1) return out
    const p = this.personalityOverride ?? zombiePersonality(a.seed, this.p)
    const act = this.world?.activity(a.id) ?? ACT_NONE
    const base = this.index(a.id) * SPRINGS
    const gait = Math.max(0, t.zbGait)
    const speed = Math.hypot(a.vx, a.vy)
    const hunting = a.state === "chase" || a.state === "alert" || a.state === "bash"
    const walking = !hunting && a.state !== "stagger" && a.state !== "knockdown"

    // ── The walk from its personality ──
    if (gait > 0) {
      // 100STYLE's zombie: ~86 steps/min at 0.8 m/s, so a longer stride than the shamble's at the same speed.
      const longer = Math.min(1.45, Math.max(1, 116 / p.cadence)) * (0.92 + 0.16 * p.stride)
      out.strideMul = 1 + (longer - 1) * Math.min(1, gait) * (hunting ? 0.5 : 1)
      // The shamble already hunches ~17°; the 100STYLE zombie stands at ~9°, so an average one straightens a little
      // and only the long dead hunch further.
      out.torsoPitch = (p.hunch - 0.36) * 0.75 * gait
      out.pelvisPitch = (p.hunch - 0.36) * 0.25 * gait
      out.footLift = 1 - 0.4 * p.shuffle * Math.min(1, gait)
      out.torsoRoll = p.lean * gait
      out.limpSide = p.limpSide
      out.limp = p.limpSide ? 0.55 * Math.min(1, gait) : 0
      // Arms out (the reference holds them level); chasers reach harder.
      out.handsOut = Math.min(1, p.armsOut * (walking ? 1.15 : 1.3) * Math.min(1.3, gait))
      out.headRoll = Math.sin(time * (0.7 + p.headLoll) + a.seed * 0.001) * 0.12 * p.headLoll * gait
      out.headPitch = -0.12 * p.headLoll * gait
    }

    // ── What it is doing ──
    let sit = 0
    let slump = 0
    let crouch = 0
    let ground = 0
    let face = 0
    let up = 0
    let still = 0
    switch (act) {
      case ACT_REST_SIT:
        sit = 1
        break
      case ACT_REST_SLUMP:
        slump = 1
        break
      case ACT_REST_STAND:
        still = 1
        out.torsoRoll += Math.sin(time * 0.9 + a.id) * 0.06
        out.headPitch -= 0.35
        out.handsOut *= 0.3
        break
      case ACT_FEED:
        crouch = 1
        ground = 0.75 + 0.25 * Math.max(0, Math.sin(time * 5.5 + a.id * 1.3))
        break
      case ACT_SNIFF:
        crouch = 0.35
        ground = 0.25
        out.torsoPitch += 0.45
        out.headPitch -= 0.3 + Math.sin(time * 7 + a.id) * 0.08
        break
      case ACT_PEER:
        out.torsoPitch += 0.22
        face = 0.55
        out.headPitch += 0.05
        break
      case ACT_LISTEN:
        still = 1
        out.headRoll += 0.22 * (a.id % 2 ? 1 : -1)
        out.handsOut *= 0.6
        break
      case ACT_GIVE_UP:
        out.headPitch -= 0.4
        out.handsOut = 0
        out.torsoPitch += 0.12
        break
      case ACT_PAUSE:
        still = 1
        out.torsoRoll += Math.sin(time * 1.3 + a.id) * 0.08
        break
      case ACT_FLINCH:
        face = 1
        out.torsoPitch -= 0.25
        out.headPitch -= 0.25
        break
      case ACT_FREEZE:
        up = 1
        still = 1
        break
      case ACT_JOSTLED:
        out.torsoPitch -= 0.2
        out.torsoRoll += 0.15 * (a.id % 2 ? 1 : -1)
        break
      case ACT_CLIMB_FENCE:
      case ACT_SNAGGED:
        out.liftMul = 1.45
        out.torsoPitch += 0.55
        ground = 0.5
        if (act === ACT_SNAGGED) out.torsoRoll += Math.sin(time * 9 + a.id) * 0.18
        break
      case ACT_CLIMB_CAR:
        out.liftMul = 1.6
        out.torsoPitch += 0.7
        ground = 0.65
        break
    }
    sit = this.spring(base, S_SIT, sit, sit > 0 ? 1.1 : 1.6, dt)
    slump = this.spring(base, S_SLUMP, slump, slump > 0 ? 0.9 : 1.6, dt)
    crouch = this.spring(base, S_CROUCH, crouch, 2.2, dt)
    ground = this.spring(base, S_GROUND, ground, 3, dt)
    face = this.spring(base, S_FACE, face, act === ACT_FLINCH ? 9 : 3, dt)
    up = this.spring(base, S_UP, up, act === ACT_FREEZE ? 7 : 2, dt)
    still = this.spring(base, S_STILL, still, 2.5, dt)

    out.pelvisDrop = 0.5 * sit + 0.58 * slump + 0.34 * crouch
    out.feetForward = 0.42 * sit + 0.5 * slump
    out.torsoPitch += 0.35 * sit - 0.5 * slump + 0.9 * crouch
    out.pelvisPitch += 0.3 * sit - 0.2 * slump + 0.3 * crouch
    out.torsoRoll += 0.22 * slump * (a.id % 2 ? 1 : -1)
    out.headPitch += -0.25 * sit - 0.65 * slump - 0.45 * crouch + 0.55 * up
    out.handsOut *= 1 - Math.max(sit, slump, crouch) * 0.9
    out.handsGround = Math.max(ground, 0.55 * sit + 0.8 * slump)
    out.handsFace = face
    out.handsOut = Math.max(out.handsOut, 0.35 * up)
    out.strideMul *= 1 - 0.3 * still
    if (speed > 0.3) out.feetForward = 0

    // ── Where it looks: what it noticed, and the torch ──
    let yaw = 0
    if (t.zbLook > 0 && this.world) {
      const aware = a.state !== "wander" || act === ACT_LISTEN || act === ACT_PEER
      let best = Infinity
      for (const s of this.world.survivors) {
        const d = Math.hypot(s.x - a.x, s.y - a.y)
        const torchOnIt = s.flashlightOn && d < 14 && Math.abs(angleDiff(Math.atan2(a.y - s.y, a.x - s.x), s.aim)) < 0.35
        if (!(torchOnIt || (aware && d < 16) || d < 4)) continue
        if (d < best) {
          best = d
          yaw = angleDiff(Math.atan2(s.y - a.y, s.x - a.x), a.aim)
        }
      }
      if (best === Infinity && walking && act === ACT_NONE) {
        // Idle glances: a curious one looks about as it shambles.
        yaw = Math.sin(time * (0.35 + 0.3 * p.curiosity) + (a.seed % 997)) * 0.7 * p.curiosity
      }
      yaw = Math.max(-1.15, Math.min(1.15, yaw)) * Math.min(1.5, t.zbLook)
    }
    out.headYaw = this.spring(base, S_LOOK, yaw, 2.6, dt)
    return out
  }
}
