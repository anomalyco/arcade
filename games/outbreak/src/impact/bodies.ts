import {
  blastRagdoll,
  createBoneRagdoll,
  impulseRagdoll,
  ragdollHips,
  RAGDOLL_BONES,
  ragdollSpeed,
  stepBoneRagdoll,
  sweepRagdoll,
  writeRagdollBones,
  type BoneRagdoll,
  type RagdollImpulse,
  type SweepBox,
} from "@arcade/kit/avatar/bone-ragdoll"
import { HitReactions, type HitImpulse } from "@arcade/kit/avatar/hit-reaction"
import type { Rect } from "@arcade/kit/sim/geom"
import type { AIAgent } from "../../shared/ai"
import type { ZombieBodyPhysics, ZombieHitPose } from "../zombies"
import { fallBlow, scaled } from "./causes"
import { DEFAULT_IMPACT_SETTINGS, impactOn, type OutbreakImpactSettings } from "./settings"

type Body = { r: BoneRagdoll; seen: number; landed: boolean; still: Float32Array | null }
type Pending = { imp: RagdollImpulse; at: number }

/** A body hitting the floor hard enough to hear (plan x, y; speed m/s just before it settled into the floor). */
export type BodyLanding = { x: number; y: number; speed: number }

/**
 * The zombie renderer's body physics (`ZombieCrowdRenderer.physics`): directional hit reactions on the living and a
 * ragdoll for each of the dead, started from the exact pose it died in and pushed by the blow that killed it.
 * Blasts and cars push bodies already down. Ragdolls sleep once settled (a sleeping body costs a copy of 180 floats a
 * frame), at most `impactMaxAwake` move at once and `impactMaxBodies` are remembered.
 */
export class ImpactBodies implements ZombieBodyPhysics {
  readonly reactions = new HitReactions()
  private readonly bodies = new Map<number, Body>()
  /** Zombies whose death we could not start from a fresh pose: they keep today's canned collapse. */
  private readonly canned = new Set<number>()
  private readonly pending = new Map<number, Pending>()
  private readonly yaws = new Map<number, number>()
  private frame = 0
  private clock = 0
  settings: OutbreakImpactSettings = DEFAULT_IMPACT_SETTINGS
  /** Walls and solid props the dead collide with (refreshed by the caller when the topology changes). */
  solids: readonly Rect[] = []
  /** Called when a body slams into the floor (for a thud). */
  onLanding: ((l: BodyLanding) => void) | null = null
  readonly stats = { awake: 0, bodies: 0, spawned: 0, canned: 0, stepMs: 0 }

  get cannedStagger(): number {
    return impactOn(this.settings) ? this.settings.impactCannedStagger : 1
  }

  reset(): void {
    this.reactions.clear()
    this.bodies.clear()
    this.canned.clear()
    this.pending.clear()
    this.yaws.clear()
    this.stats.spawned = this.stats.canned = 0
  }

  begin(dt: number): void {
    this.frame++
    this.clock += dt
    if (impactOn(this.settings)) this.reactions.step(dt)
    else if (this.reactions.size) this.reactions.clear()
    for (const [id, p] of this.pending) if (this.clock - p.at > 1) this.pending.delete(id)
    // Too many falling at once: the oldest settles where it is.
    let awake = 0
    let oldest: Body | null = null
    for (const b of this.bodies.values()) {
      if (b.r.asleep) continue
      awake++
      if (!oldest || b.r.age > oldest.r.age) oldest = b
    }
    if (oldest && awake > Math.max(1, this.settings.impactMaxAwake)) {
      oldest.r.asleep = true
      oldest.r.prev.set(oldest.r.pos)
    }
    this.stats.awake = awake
    this.stats.bodies = this.bodies.size
  }

  react(agentId: number, yaw: number): ZombieHitPose | null {
    this.yaws.set(agentId, yaw)
    if (!impactOn(this.settings) || this.settings.impactReactions <= 0) return null
    return this.reactions.sample(agentId)
  }

  /** A blow to a living zombie: rocks it (scaled by Lab › Physics › Hit reactions). */
  hitLiving(agent: Pick<AIAgent, "id" | "aim">, imp: HitImpulse): void {
    const k = this.settings.impactReactions
    if (!impactOn(this.settings) || k <= 0) return
    const yaw = this.yaws.get(agent.id) ?? agent.aim
    this.reactions.hit(agent.id, yaw, { ...imp, strength: imp.strength * k, buckle: (imp.buckle ?? imp.strength * 0.06) * k })
  }

  /** The blow that killed a zombie: pushes its ragdoll (now, or as it starts this frame). */
  killed(id: number, imp: RagdollImpulse): void {
    const s = scaled(imp, this.settings.impactDeathPush)
    const body = this.bodies.get(id)
    if (body && body.r.age < 0.3) impulseRagdoll(body.r, s)
    else if (!body) this.pending.set(id, { imp: s, at: this.clock })
  }

  /** A blast: every body within `radius` thrown outward (plan x, y; strength m/s at the centre). */
  blast(x: number, y: number, groundY: number, strength: number, radius: number): number {
    const k = this.settings.impactCorpsePush
    if (k <= 0) return 0
    let n = 0
    for (const b of this.bodies.values()) {
      const h = ragdollHips(b.r)
      if (Math.hypot(h.x - x, h.z - y) > radius + 1) continue
      if (blastRagdoll(b.r, x, groundY + 0.2, y, strength * k, radius, 0.55)) {
        b.landed = false
        b.still = null
        n++
      }
    }
    return n
  }

  /** A car sweeping through: bodies under it are thrown and tumble. */
  sweep(box: SweepBox, vx: number, vz: number, groundY: number): number {
    const k = this.settings.impactCorpsePush
    const speed = Math.hypot(vx, vz)
    if (k <= 0 || speed < 1.5) return 0
    let n = 0
    for (const b of this.bodies.values()) {
      const h = ragdollHips(b.r)
      if (Math.hypot(h.x - box.x, h.z - box.z) > box.halfLength + 1.2) continue
      if (sweepRagdoll(b.r, box, groundY + 0.9, vx * k, vz * k, Math.min(4, speed * 0.28) * k) > 0) {
        b.landed = false
        b.still = null
        n++
      }
    }
    return n
  }

  /** Where a body lies now (plan), for anything that follows it. */
  bodyAt(id: number): { x: number; y: number } | null {
    const b = this.bodies.get(id)
    if (!b) return null
    const h = ragdollHips(b.r)
    return { x: h.x, y: h.z }
  }

  corpse(agent: AIAgent, bones: Float32Array, prevBones: Float32Array, off: number, dt: number, support: (x: number, z: number) => number): boolean {
    if (!impactOn(this.settings) || !this.settings.impactRagdolls) return false
    let body = this.bodies.get(agent.id)
    if (!body) {
      if (this.canned.has(agent.id)) return false
      // Start only from a pose drawn last frame where the zombie is now; anything else keeps today's collapse.
      const px = prevBones[off]!
      const py = prevBones[off + 1]!
      const pz = prevBones[off + 2]!
      const fresh =
        (px !== 0 || py !== 0 || pz !== 0) &&
        Math.hypot(px - agent.x, pz - agent.y) < 1.4 &&
        Math.hypot(bones[off]! - px, bones[off + 2]! - pz) < 1.5
      if (!fresh) {
        this.canned.add(agent.id)
        this.stats.canned++
        return false
      }
      const r = createBoneRagdoll({
        bones: prevBones,
        off,
        prevBones: bones,
        prevOff: off,
        dt,
        seed: (agent.seed ^ Math.imul(agent.id + 1, 0x9e3779b1)) >>> 0,
        rects: this.solids.filter((w) => px > w[0] - 3 && px < w[2] + 3 && pz > w[1] - 3 && pz < w[3] + 3),
      })
      const p = this.pending.get(agent.id)
      this.pending.delete(agent.id)
      impulseRagdoll(r, p ? p.imp : scaled(fallBlow(agent.staggerVx, agent.staggerVy, agent.aim, agent.id), this.settings.impactDeathPush))
      body = { r, seen: this.frame, landed: false, still: null }
      this.bodies.set(agent.id, body)
      this.reactions.forget(agent.id)
      this.stats.spawned++
      this.evict()
    }
    body.seen = this.frame
    const r = body.r
    // A settled body is a copy of its last frames.
    if (r.asleep && body.still) {
      bones.set(body.still, off)
      return true
    }
    if (!r.asleep) {
      const t0 = performance.now()
      const before = ragdollSpeed(r)
      stepBoneRagdoll(r, dt, support)
      if (!body.landed && r.age > 0.12 && before > 2.2 && ragdollSpeed(r) < before * 0.45) {
        body.landed = true
        const h = ragdollHips(r)
        this.onLanding?.({ x: h.x, y: h.z, speed: before })
      }
      this.stats.stepMs += performance.now() - t0
    }
    writeRagdollBones(r, bones, off)
    if (r.asleep) body.still = bones.slice(off, off + RAGDOLL_BONES * 12)
    return true
  }

  private evict(): void {
    const max = Math.max(8, this.settings.impactMaxBodies)
    while (this.bodies.size > max) {
      let worstId = -1
      let worst = Infinity
      for (const [id, b] of this.bodies) {
        if (b.seen < worst) {
          worst = b.seen
          worstId = id
        }
      }
      if (worstId < 0) return
      this.bodies.delete(worstId)
      this.canned.add(worstId)
    }
  }

  /** Forgets bodies of zombies no longer dead (risen) or gone from the crowd, and facings of the gone. */
  prune(isDead: (id: number) => boolean, exists: (id: number) => boolean): void {
    for (const id of this.bodies.keys()) if (!isDead(id)) this.bodies.delete(id)
    for (const id of this.canned) if (!isDead(id)) this.canned.delete(id)
    for (const id of this.yaws.keys()) if (!exists(id)) this.yaws.delete(id)
  }
}
