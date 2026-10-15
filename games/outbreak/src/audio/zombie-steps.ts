import type { SfxSurface, ZombieStep } from "@arcade/kit/audio"
import { resolveDragFoot, resolveZombieVariant } from "@arcade/kit/shamble-crouch"
import type { SoundZombie } from "./director"

export const ZOMBIE_STEP_TUNING = {
  /** Zombie feet further than this stay silent (m). */
  hearing: 14,
  /** Only the nearest few moving zombies are heard step by step; the rest of a crowd is the horde bed. */
  voices: 4,
  /** Steps per second across the whole crowd, and the burst allowed above it. */
  rate: 8,
  burst: 4,
  /** The horde bed counts moving zombies within this radius (m), full at this many near ones. */
  hordeRadius: 22,
  hordeFull: 8,
}

/** One zombie footstep to play: a library id at a plan position. */
export type ZombieStepSound = { id: string; x: number; y: number; gain: number }

const MAX_QUEUE = 64
const RIG_FRESH = 0.6

/**
 * Zombie footsteps, so a horde reads as a texture and not a clatter. The crowd rig reports each foot contact
 * (`ZombieCrowdRenderer.onFootfall`); zombies it does not animate (off screen or unseen behind walls) step on a cadence
 * from their speed, with the rig's stride. Only the nearest `voices` moving zombies within `hearing` are heard step by
 * step, at most `rate` steps a second; every other moving zombie nearby raises the horde bed instead. The gait sound
 * follows the shamble variant and foot: the dragged foot scrapes, limpers and lungers stomp, the rest shuffle.
 */
export class ZombieFootsteps {
  readonly tuning = { ...ZOMBIE_STEP_TUNING }
  readonly counts = { contacts: 0, cadence: 0, played: 0, skipped: 0 }
  private qId = new Int32Array(MAX_QUEUE)
  private qX = new Float32Array(MAX_QUEUE)
  private qY = new Float32Array(MAX_QUEUE)
  private qSpeed = new Float32Array(MAX_QUEUE)
  private qDrag = new Float32Array(MAX_QUEUE)
  private qVariant: string[] = new Array(MAX_QUEUE).fill("")
  private queued = 0
  private nearId = new Int32Array(8)
  private nearD = new Float32Array(8)
  private near = 0
  private lastRig = new Map<number, number>()
  private phase = new Map<number, number>()
  private tokens = ZOMBIE_STEP_TUNING.burst
  private readonly out: ZombieStepSound[] = []
  /** The horde bed's level (0..1) and pan toward the crowd. */
  readonly horde = { level: 0, pan: 0 }
  private time = 0

  /** A foot contact from the crowd rig. `drag` is how much this foot drags (0 for the planted one). */
  contact(agentId: number, x: number, y: number, speed: number, drag: number, variant: string): void {
    this.counts.contacts++
    this.lastRig.set(agentId, this.time)
    this.enqueue(agentId, x, y, speed, drag, variant)
  }

  private enqueue(agentId: number, x: number, y: number, speed: number, drag: number, variant: string): void {
    if (this.queued >= MAX_QUEUE) return
    const i = this.queued++
    this.qId[i] = agentId
    this.qX[i] = x
    this.qY[i] = y
    this.qSpeed[i] = speed
    this.qDrag[i] = drag
    this.qVariant[i] = variant
  }

  update(zombies: readonly SoundZombie[], listener: { x: number; y: number }, time: number, dt: number, surface: (x: number, y: number) => SfxSurface): readonly ZombieStepSound[] {
    this.time = time
    const t = this.tuning
    const out = this.out
    out.length = 0
    this.tokens = Math.min(t.burst, this.tokens + t.rate * Math.max(0, Math.min(0.25, dt)))

    // The nearest moving zombies in earshot, and everyone else near enough to swell the horde.
    const k = Math.min(this.nearId.length, Math.max(0, Math.round(t.voices)))
    this.near = 0
    const hear2 = t.hearing * t.hearing
    for (const z of zombies) {
      if (z.state === "dead" || Math.hypot(z.vx ?? 0, z.vy ?? 0) < 0.2) continue
      const d2 = (z.x - listener.x) ** 2 + (z.y - listener.y) ** 2
      if (d2 > hear2 || k === 0) continue
      if (this.near < k) {
        this.nearId[this.near] = z.id
        this.nearD[this.near++] = d2
      } else {
        let worst = 0
        for (let i = 1; i < k; i++) if (this.nearD[i]! > this.nearD[worst]!) worst = i
        if (d2 < this.nearD[worst]!) {
          this.nearId[worst] = z.id
          this.nearD[worst] = d2
        }
      }
    }
    const isNear = (id: number) => {
      for (let i = 0; i < this.near; i++) if (this.nearId[i] === id) return true
      return false
    }

    let weight = 0
    let side = 0
    for (const z of zombies) {
      if (z.state === "dead") continue
      const speed = Math.hypot(z.vx ?? 0, z.vy ?? 0)
      if (speed < 0.2) continue
      const dx = z.x - listener.x
      const d = Math.hypot(dx, z.y - listener.y)
      if (isNear(z.id)) {
        // Unanimated zombies step on the rig's cadence: two contacts a stride cycle.
        if (time - (this.lastRig.get(z.id) ?? -Infinity) <= RIG_FRESH) continue
        const stride = 0.28 * speed + 0.55
        const before = this.phase.get(z.id) ?? ((z.id * 0.27) % 1)
        const after = before + Math.max(0.72, speed / stride) * dt
        this.phase.set(z.id, after % 1)
        const steps = Math.floor(after * 2) - Math.floor(before * 2)
        if (steps <= 0) continue
        const foot = Math.floor(after * 2) % 2
        const seed = z.seed ?? 0
        const dragged = resolveDragFoot(seed) === foot ? Math.min(0.95, 0.8 * (z.drag ?? 1)) * (z.state === "chase" ? 0.62 : 1) : 0
        this.counts.cadence++
        this.enqueue(z.id, z.x, z.y, speed, dragged, resolveZombieVariant("auto", seed))
      } else if (d < t.hordeRadius) {
        const w = 1 - d / t.hordeRadius
        weight += w
        side += w * dx
      }
    }
    this.horde.level = Math.max(0, Math.min(1, (weight - 0.5) / Math.max(1, t.hordeFull * 0.5)))
    this.horde.pan = weight > 0 ? Math.max(-0.7, Math.min(0.7, side / weight / 12)) : 0

    for (let i = 0; i < this.queued; i++) {
      const id = this.qId[i]!
      const x = this.qX[i]!
      const y = this.qY[i]!
      if (!isNear(id) || (x - listener.x) ** 2 + (y - listener.y) ** 2 > hear2 || this.tokens < 1) {
        this.counts.skipped++
        continue
      }
      this.tokens--
      const drag = this.qDrag[i]!
      const variant = this.qVariant[i]!
      const kind: ZombieStep = drag >= 0.35 ? "drag" : variant === "limper" || variant === "lunger" ? "step" : "shuffle"
      const speed = this.qSpeed[i]!
      out.push({ id: `zombie.foot.${kind}.${surface(x, y)}`, x, y, gain: kind === "drag" ? 0.9 : 0.75 + 0.25 * Math.min(1, speed / 1.6) })
      this.counts.played++
    }
    this.queued = 0

    if (this.phase.size > 512 || this.lastRig.size > 512) {
      const alive = new Set(zombies.map((z) => z.id))
      for (const id of this.phase.keys()) if (!alive.has(id)) this.phase.delete(id)
      for (const id of this.lastRig.keys()) if (!alive.has(id)) this.lastRig.delete(id)
    }
    return out
  }

  reset(): void {
    this.queued = 0
    this.lastRig.clear()
    this.phase.clear()
    this.horde.level = 0
  }
}
