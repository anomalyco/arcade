/** Reach for pairing a survivor's damage with the zombie that dealt it (m); the same as the sound director's. */
export const STRIKE_REACH = 1.8
/** How long a strike lunge lasts (s): a 70 ms thrust, then an ease back. */
export const STRIKE_TIME = 0.42
const THRUST = 0.07

/**
 * Finds which zombie struck whom by diffing survivors' health, like the sound director and the HUD do, so it works
 * offline and for co-op peers from snapshots with no wire fields. A zombie's strike deals damage on the frame it comes
 * into reach (`packages/kit/sim/ai.ts`), so the lunge plays as the hit lands.
 */
export class StrikeTracker {
  private readonly health = new Map<string, number>()

  reset(): void {
    this.health.clear()
  }

  observe(
    survivors: readonly { id: string; survivor: { x: number; y: number; health: number } }[],
    zombies: readonly { id: number; x: number; y: number; state: string }[],
  ): number[] {
    const struck: number[] = []
    const present = new Set<string>()
    for (const { id, survivor: s } of survivors) {
      present.add(id)
      const prev = this.health.get(id)
      this.health.set(id, s.health)
      if (prev === undefined || s.health >= prev - 0.5) continue
      let best = -1
      let bestD = STRIKE_REACH
      for (const z of zombies) {
        if (z.state === "dead") continue
        const d = Math.hypot(z.x - s.x, z.y - s.y)
        if (d < bestD) {
          bestD = d
          best = z.id
        }
      }
      if (best >= 0 && !struck.includes(best)) struck.push(best)
    }
    for (const id of this.health.keys()) if (!present.has(id)) this.health.delete(id)
    return struck
  }
}

/** The lunge's weight in [0, 1] `age` seconds into a strike: ease-out thrust to full, then a smooth return to 0. */
export function strikeEnvelope(age: number): number {
  if (age < 0 || age >= STRIKE_TIME) return 0
  if (age < THRUST) {
    const t = age / THRUST
    return 1 - (1 - t) * (1 - t)
  }
  const t = (age - THRUST) / (STRIKE_TIME - THRUST)
  return 1 - t * t * (3 - 2 * t)
}
