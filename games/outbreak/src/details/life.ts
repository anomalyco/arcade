import { Rng } from "@arcade/kit/sim/rng"
import type { OutbreakDetailSettings } from "./settings"

const fract = (v: number) => v - Math.floor(v)
const noise = (i: number, seed: number) => fract(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453)
const smooth = (t: number, seed: number) => {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return noise(i, seed) * (1 - u) + noise(i + 1, seed) * u
}

/**
 * Brightness (0..1) of a television's light at `time`: a programme's scenes, each its own level, cut every few
 * seconds, with a smooth shimmer inside a scene (never a frame-to-frame strobe). Deterministic in time and `phase`.
 */
export function tvLevel(phase: number, time: number): number {
  const len = 1.6 + phase * 2.4
  const scene = Math.floor(time / len + phase * 13)
  const base = 0.35 + 0.6 * noise(scene, phase * 31 + 3)
  const shimmer = 0.82 + 0.18 * smooth(time * 6 + phase * 50, phase * 17 + 1)
  return Math.min(1, base * shimmer)
}

export type LifeSound = { id: string; x: number; y: number; delay?: number; gain?: number; rate?: number; source: string }

/**
 * Dogs barking somewhere out of sight at night: every 25–70 s, a bark or two 26–36 m from the listener in a random
 * direction, sometimes answered from another. Each client's own (not seeded per town): it is the world's room tone.
 */
export class DistantLife {
  private next = -1
  private readonly rng = new Rng(0x2b3c4d5e)
  /** Barks played so far (harness readout). */
  barks = 0

  reset(): void {
    this.next = -1
  }

  step(time: number, s: Pick<OutbreakDetailSettings, "worldDetails" | "dtDistantDogs">, night: number, listener: { x: number; y: number }, play: (e: LifeSound) => void): void {
    if (this.next < 0 || this.next > time + 120) this.next = time + 10 + this.rng.next() * 20
    if (time < this.next) return
    this.next = time + 25 + this.rng.next() * 45
    if (!s.worldDetails || !s.dtDistantDogs || night < 0.55) return
    const bark = (a: number, delay: number) => {
      const d = 26 + this.rng.next() * 10
      const x = listener.x + Math.cos(a) * d
      const y = listener.y + Math.sin(a) * d
      const n = 1 + Math.floor(this.rng.next() * 3)
      for (let i = 0; i < n; i++) play({ id: "dog.bark", x, y, delay: delay + i * (0.45 + this.rng.next() * 0.3), gain: 0.45, rate: 0.9 + this.rng.next() * 0.15, source: "life" })
      this.barks++
    }
    const a = this.rng.next() * Math.PI * 2
    bark(a, 0)
    if (this.rng.next() < 0.4) bark(a + Math.PI * (0.5 + this.rng.next()), 1.4 + this.rng.next() * 1.6)
  }
}
