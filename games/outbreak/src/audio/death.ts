import type { LifeState } from "../../shared/death/rules"
import type { SoundEvent } from "./types"

/** What the director reads of `shared/death`: each survivor's life, where they are, and whether the run is over. */
export type DeathSoundWorld = {
  readonly runOver: boolean
  readonly survivors: readonly { index: number; x: number; y: number; state: LifeState; bleed: number; bleedMax: number }[]
}

export const DEATH_SOUND_TUNING = {
  /** A downed survivor's heartbeat carries this far (m); the listener's own is always heard. */
  heartbeatHearing: 7,
  /** Seconds between beats with a full bleed-out left, and with none. */
  heartbeatSlow: 1.05,
  heartbeatFast: 0.48,
}

type Memory = { state: LifeState; nextBeat: number }

/**
 * Sounds for going down, the heartbeat while down, a revive, death and the run's end, from the death state alone (no
 * wire fields), so co-op peers hear the same. Uses the dedicated `body.heartbeat` cue while bleeding out.
 */
export class DeathSounds {
  readonly tuning = { ...DEATH_SOUND_TUNING }
  private readonly memory = new Map<number, Memory>()
  private wasOver = false

  reset(): void {
    this.memory.clear()
    this.wasOver = false
  }

  observe(world: DeathSoundWorld | undefined, time: number, listener: { x: number; y: number }, emit: (e: SoundEvent) => void): void {
    if (!world) return
    const t = this.tuning
    const seen = new Set<number>()
    for (const s of world.survivors) {
      seen.add(s.index)
      const prev = this.memory.get(s.index)
      const m: Memory = prev ?? { state: s.state, nextBeat: time }
      this.memory.set(s.index, m)
      const at = { x: s.x, y: s.y, source: "death" }
      const d = Math.hypot(s.x - listener.x, s.y - listener.y)
      if (prev && prev.state !== s.state) {
        if (s.state === "down") {
          emit({ id: "body.hurt", ...at, rate: 0.88, gain: 1.15 })
          emit({ id: "melee.shove", ...at, rate: 0.84, gain: 0.9, cutoffHz: 1100, delay: 0.14 })
          m.nextBeat = time + 0.6
        } else if (s.state === "dead") {
          // Heard wherever the listener is: a bite, the last cry, then a dark low thud.
          const here = { x: listener.x, y: listener.y, source: "death" }
          emit({ id: "zombie.attack", ...at, rate: 0.9, gain: 1.1 })
          emit({ id: "body.hurt", ...here, rate: 0.82, gain: 1.0, delay: 0.16 })
          emit({ id: "door.bash", ...here, rate: 0.78, gain: 1.05, cutoffHz: 420, delay: 0.38 })
        } else if (prev.state === "down") {
          emit({ id: "body.breath.exhausted", ...at, gain: 0.9 })
        }
        m.state = s.state
      }
      if (s.state === "down" && time >= m.nextBeat) {
        const left = s.bleedMax > 0 ? Math.max(0, Math.min(1, s.bleed / s.bleedMax)) : 0
        const gap = t.heartbeatFast + (t.heartbeatSlow - t.heartbeatFast) * left
        m.nextBeat = time + gap
        if (d <= t.heartbeatHearing) {
          const gain = d < 0.5 ? 1.0 : 0.85 - (d / t.heartbeatHearing) * 0.55
          const rate = Number((1.08 - left * 0.12).toFixed(3))
          emit({ id: "body.heartbeat", ...at, rate, gain, cutoffHz: 480 })
        }
      }
    }
    for (const index of this.memory.keys()) if (!seen.has(index)) this.memory.delete(index)
    if (world.runOver && !this.wasOver) {
      const here = { x: listener.x, y: listener.y, source: "death" }
      emit({ id: "door.bash", ...here, rate: 0.74, gain: 1.0, cutoffHz: 360, delay: 1.2 })
      emit({ id: "zombie.groan.idle", ...here, rate: 0.84, gain: 0.8, delay: 1.6 })
    }
    this.wasOver = world.runOver
  }
}
