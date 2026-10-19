import type { AIState } from "../../shared/ai"
import type { CombatMeleeEvent, CombatShotEvent } from "../../shared/combat"
import type { Town } from "../../shared/map"
import {
  DEFAULT_SPECIALS_TUNING,
  hitFromFront,
  specialKindOf,
  SPECIAL_BLOATER,
  SPECIAL_BRUTE,
  SPECIAL_LURKER,
  SPECIAL_NONE,
  SPECIAL_RIOT,
  SPECIAL_SCREAMER,
} from "../../shared/specials/kinds"
import { surfaceAt, zombieStepEvent } from "./space"
import type { SoundEvent } from "./types"

export type SpecialSoundZombie = { id: number; x: number; y: number; state: AIState; seed?: number; aim?: number }

export const SPECIAL_SOUND_TUNING = {
  /** A shriek carries this far (m); the rest of the specials' sounds stop at `hearing`. */
  shriekHearing: 60,
  hearing: 22,
  /** Seconds between a Bloater's gurgles, and between a walking Brute's footfalls. */
  gurgleEvery: 3.2,
  bruteStep: 0.62,
}

type Memory = { state: AIState; x: number; y: number; next: number }

/**
 * Sounds for special zombies, from state changes only (no wire fields), so co-op peers hear the same: the Screamer's
 * shriek (its alert is always a shriek), a Bloater's gurgle and wet burst, a Brute's heavy footfalls, a sleeping
 * Lurker's hiss as it wakes, and bullets or blows ringing off a Riot cop's shield. Library samples, re-pitched.
 */
export class SpecialSounds {
  readonly tuning = { ...SPECIAL_SOUND_TUNING }
  private readonly memory = new Map<number, Memory>()
  private readonly heardShots = new Set<number>()
  private readonly heardHits = new Set<string>()
  private lastTime = 0

  reset(): void {
    this.memory.clear()
    this.heardShots.clear()
    this.heardHits.clear()
    this.lastTime = 0
  }

  observe(
    zombies: readonly SpecialSoundZombie[],
    shots: readonly CombatShotEvent[],
    meleeSwings: readonly CombatMeleeEvent[] | undefined,
    time: number,
    listener: { x: number; y: number },
    emit: (e: SoundEvent) => void,
    rng: () => number,
    town?: Town,
  ): void {
    const t = this.tuning
    const dt = Math.max(0, Math.min(0.25, time - this.lastTime))
    this.lastTime = time
    const dist = (x: number, y: number) => Math.hypot(x - listener.x, y - listener.y)
    const seen = new Set<number>()
    const byId = new Map<number, SpecialSoundZombie>()
    for (const z of zombies) {
      const kind = specialKindOf(z.seed ?? 0)
      if (kind === SPECIAL_NONE) continue
      seen.add(z.id)
      byId.set(z.id, z)
      const prev = this.memory.get(z.id)
      const m: Memory = prev ?? { state: z.state, x: z.x, y: z.y, next: time + rng() * 2 }
      const d = dist(z.x, z.y)
      const at = { x: z.x, y: z.y, source: "zombie" }
      if (prev && prev.state !== z.state) {
        if (kind === SPECIAL_SCREAMER && z.state === "alert" && d <= t.shriekHearing) {
          emit({ id: "zombie.alert", ...at, rate: 1.55, gain: 1.15, cutoffHz: 4200, priority: 92 })
          emit({ id: "zombie.alert", ...at, rate: 1.36, gain: 0.85, cutoffHz: 3600, delay: 0.26, priority: 90 })
          emit({ id: "zombie.alert", ...at, rate: 1.22, gain: 0.72, cutoffHz: 3200, delay: 0.56, priority: 88 })
        } else if (kind === SPECIAL_BLOATER && z.state === "dead" && d <= t.shriekHearing) {
          emit({ id: "zombie.hit", ...at, rate: 0.5, gain: 1.15, cutoffHz: 1800, priority: 88 })
          emit({ id: "zombie.death", ...at, rate: 0.78, gain: 0.95, delay: 0.04, priority: 85 })
          emit({ id: "melee.hit.blade", ...at, rate: 0.84, gain: 0.85, delay: 0.09, priority: 85 })
        } else if (kind === SPECIAL_LURKER && prev.state === "wander" && z.state !== "dead" && d <= t.hearing) {
          emit({ id: "zombie.alert", ...at, rate: 0.84, gain: 1.1, priority: 85 })
        }
      }
      if (z.state !== "dead" && d <= t.hearing) {
        if (kind === SPECIAL_BLOATER && time >= m.next) {
          m.next = time + t.gurgleEvery * (0.75 + rng() * 0.5)
          emit({ id: "zombie.groan.idle", ...at, rate: 0.76 + rng() * 0.06, gain: 0.72, cutoffHz: 1400 })
        } else if (kind === SPECIAL_BRUTE && dt > 0) {
          const speed = Math.hypot(z.x - m.x, z.y - m.y) / dt
          if (speed > 0.35 && time >= m.next) {
            m.next = time + t.bruteStep * Math.max(0.6, Math.min(1.4, 1.6 / Math.max(0.6, speed)))
            const surf = town ? surfaceAt(town, z.x, z.y) : "concrete"
            emit(zombieStepEvent(surf, "brute", z.x, z.y, speed, rng))
          }
        }
      }
      m.state = z.state
      m.x = z.x
      m.y = z.y
      this.memory.set(z.id, m)
    }
    for (const id of this.memory.keys()) if (!seen.has(id)) this.memory.delete(id)

    // Bullets and blows that land on a Riot cop's shield ring off it.
    const arc = DEFAULT_SPECIALS_TUNING.riotArc
    for (const shot of shots) {
      if (this.heardShots.has(shot.id) || shot.hitZombieId === null) continue
      this.heardShots.add(shot.id)
      const z = byId.get(shot.hitZombieId)
      if (!z || specialKindOf(z.seed ?? 0) !== SPECIAL_RIOT || z.aim === undefined) continue
      if (hitFromFront(z.x, z.y, z.aim, shot.fromX, shot.fromY, arc)) emit({ id: "impact.bullet.metal", x: shot.toX, y: shot.toY, gain: 1.15, source: "shot" })
    }
    if (this.heardShots.size > 128) this.heardShots.clear()
    for (const m of meleeSwings ?? []) {
      for (const h of m.hits) {
        const key = `${m.id}:${h.zombieId}`
        if (this.heardHits.has(key)) continue
        this.heardHits.add(key)
        const z = byId.get(h.zombieId)
        if (!z || specialKindOf(z.seed ?? 0) !== SPECIAL_RIOT || z.aim === undefined) continue
        if (hitFromFront(z.x, z.y, z.aim, m.x, m.y, arc)) emit({ id: "melee.hit.metal", x: h.x, y: h.y, gain: 1.1, rate: 0.85, source: m.attackerId })
      }
    }
    if (this.heardHits.size > 256) this.heardHits.clear()
  }
}
