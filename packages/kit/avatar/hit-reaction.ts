/**
 * Directional hit reactions layered on a living figure's procedural pose: an impulse rocks the trunk away from the
 * blow, twists the shoulders when it lands off-centre, whips the head and buckles the knees, all on underdamped springs
 * so the body overshoots and recovers with weight instead of fading linearly. Presentation only; the game owns
 * knockback and stagger.
 *
 * Angles are radians and follow the bone-frame rotations Outbreak and Blackout use: `pitch` > 0 leans the trunk back
 * (away from its facing), `roll` > 0 leans it toward the figure's +z side (`[-sin yaw, 0, cos yaw]`), `twist` > 0 turns
 * the shoulders toward +yaw. `drop` is metres the pelvis sinks.
 */

export type HitReactionPose = {
  pitch: number
  roll: number
  twist: number
  headPitch: number
  headRoll: number
  headYaw: number
  drop: number
}

export type HitReactionTuning = {
  /** Trunk spring frequency (Hz) and damping ratio. */
  trunkHz: number
  trunkDamping: number
  /** Head spring frequency (Hz) and damping ratio: faster and looser than the trunk, so it whips. */
  headHz: number
  headDamping: number
  /** Knee buckle spring frequency (Hz) and damping ratio. */
  buckleHz: number
  buckleDamping: number
  /** Largest trunk lean (rad), head angle (rad) and pelvis drop (m). */
  maxLean: number
  maxHead: number
  maxDrop: number
}

export const DEFAULT_HIT_REACTION_TUNING: HitReactionTuning = {
  trunkHz: 2.3,
  trunkDamping: 0.42,
  headHz: 3.6,
  headDamping: 0.34,
  buckleHz: 2.1,
  buckleDamping: 0.62,
  maxLean: 0.62,
  maxHead: 0.75,
  maxDrop: 0.2,
}

/**
 * One blow. `dirX`/`dirZ` is the plan direction it pushes (from attacker to victim), `strength` its angular kick in
 * rad/s at the trunk (a pistol round ≈ 4, a heavy axe ≈ 8), `offset` −1..1 where it landed across the body (twists
 * the shoulders), `head` how much of it lands on the head (a headshot ≈ 1), `buckle` m/s down at the knees.
 */
export type HitImpulse = { dirX: number; dirZ: number; strength: number; offset?: number; head?: number; buckle?: number }

// Per actor: pitch x, v; roll x, v; twist x, v; head pitch x, v; head roll x, v; head yaw x, v; drop x, v.
const STRIDE = 14

export class HitReactions {
  private readonly state = new Map<number, Float32Array>()
  private readonly pose: HitReactionPose = { pitch: 0, roll: 0, twist: 0, headPitch: 0, headRoll: 0, headYaw: 0, drop: 0 }
  tuning: HitReactionTuning

  constructor(tuning: HitReactionTuning = DEFAULT_HIT_REACTION_TUNING) {
    this.tuning = tuning
  }

  get size(): number {
    return this.state.size
  }

  clear(): void {
    this.state.clear()
  }

  forget(id: number): void {
    this.state.delete(id)
  }

  /** Kicks actor `id`, facing plan angle `yaw`, with a blow. Impulses add, so a burst of hits stacks into a stagger. */
  hit(id: number, yaw: number, imp: HitImpulse): void {
    let s = this.state.get(id)
    if (!s) {
      s = new Float32Array(STRIDE)
      this.state.set(id, s)
    }
    const l = Math.hypot(imp.dirX, imp.dirZ) || 1
    const dx = imp.dirX / l
    const dz = imp.dirZ / l
    const fwd = dx * Math.cos(yaw) + dz * Math.sin(yaw)
    const side = -dx * Math.sin(yaw) + dz * Math.cos(yaw)
    const k = imp.strength
    const head = imp.head ?? 0.35
    const offset = imp.offset ?? 0
    // Pushed along the facing (hit from behind) leans it forward: negative pitch.
    s[1] = s[1]! - fwd * k
    s[3] = s[3]! + side * k
    s[5] = s[5]! + offset * k * 0.9
    s[7] = s[7]! - fwd * k * (0.6 + 1.2 * head)
    s[9] = s[9]! + side * k * (0.5 + head)
    s[11] = s[11]! + offset * k * (0.4 + 0.8 * head)
    s[13] = s[13]! + (imp.buckle ?? k * 0.06)
  }

  /** Advances every reaction by `dt` (substepped at 240 Hz) and forgets the ones that have settled. */
  step(dt: number): void {
    if (dt <= 0 || this.state.size === 0) return
    const t = this.tuning
    const n = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / n
    const wT = t.trunkHz * Math.PI * 2
    const wH = t.headHz * Math.PI * 2
    const wB = t.buckleHz * Math.PI * 2
    for (const [id, s] of this.state) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 7; j++) {
          const w = j < 3 ? wT : j < 6 ? wH : wB
          const z = j < 3 ? t.trunkDamping : j < 6 ? t.headDamping : t.buckleDamping
          const x = s[j * 2]!
          const v = s[j * 2 + 1]! + (-w * w * x - 2 * z * w * s[j * 2 + 1]!) * h
          s[j * 2 + 1] = v
          s[j * 2] = x + v * h
        }
      }
      let energy = 0
      for (let j = 0; j < STRIDE; j++) energy += Math.abs(s[j]!)
      if (energy < 1e-3) this.state.delete(id)
    }
  }

  /** The reaction to layer on actor `id` this frame, or null when it is at rest. The object is reused. */
  sample(id: number): HitReactionPose | null {
    const s = this.state.get(id)
    if (!s) return null
    const t = this.tuning
    const lim = (v: number, m: number) => (v > m ? m : v < -m ? -m : v)
    const p = this.pose
    p.pitch = lim(s[0]!, t.maxLean)
    p.roll = lim(s[2]!, t.maxLean)
    p.twist = lim(s[4]!, t.maxLean)
    p.headPitch = lim(s[6]!, t.maxHead)
    p.headRoll = lim(s[8]!, t.maxHead)
    p.headYaw = lim(s[10]!, t.maxHead)
    p.drop = Math.max(0, Math.min(t.maxDrop, s[12]!))
    return p
  }
}
