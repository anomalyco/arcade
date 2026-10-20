import { SECRETS, secretRoll, secretToggleKey, type SecretId, type SecretSeeds, type SecretsTuning } from "./catalog"

/**
 * A run's secrets: which ones it has and the three numbers behind the cellar. A pure function of the town's seeds and
 * the Secrets tuning, so the room, every client and the Lab agree without sending anything.
 */
export type SecretRun = {
  readonly seed: number
  readonly houseSeed: number
  readonly picked: ReadonlySet<SecretId>
  /** The hour (1–9) every clock in town stopped at, and the minute. */
  readonly hour: number
  readonly minute: number
  /** The day (1–9) circled on every calendar, and the weekday (0 Sunday) the month began on. */
  readonly day: number
  readonly firstWeekday: number
  /** How many pulses the radio man's set repeats (1–9). */
  readonly pulses: number
  /** The cellar's combination: hour, day, pulses. */
  readonly code: readonly [number, number, number]
}

const digit = (seeds: SecretSeeds, key: string) => 1 + Math.floor(secretRoll(seeds, key) * 9)

/** Is `id` in a run with this tuning (before the topping up)? Its roll against its chance. */
function rolled(seeds: SecretSeeds, id: SecretId, chance: number, scale: number): { hit: boolean; margin: number } {
  if (chance >= 1) return { hit: true, margin: 0 }
  const roll = secretRoll(seeds, `pick:${id}`)
  const p = Math.min(1, chance * scale)
  return { hit: roll < p, margin: roll / Math.max(1e-6, chance) }
}

export function secretRun(seeds: SecretSeeds, tuning: SecretsTuning): SecretRun {
  const picked = new Set<SecretId>()
  const on = tuning.secrets > 0
  const allowed = (id: SecretId) => on && (tuning[secretToggleKey(id)] ?? 1) > 0
  const misses: { id: SecretId; margin: number }[] = []
  let strange = 0
  for (const s of SECRETS) {
    if (!allowed(s.id)) continue
    const r = rolled(seeds, s.id, s.chance, s.tier === "subtle" ? 1 : tuning.secretRarity)
    if (r.hit) {
      picked.add(s.id)
      if (s.tier === "strange") strange++
    } else if (s.tier === "strange") misses.push({ id: s.id, margin: r.margin })
  }
  // A run always has a few: top the strange ones up from the nearest misses.
  misses.sort((a, b) => a.margin - b.margin || (a.id < b.id ? -1 : 1))
  for (const m of misses) {
    if (strange >= tuning.secretMinStrange) break
    picked.add(m.id)
    strange++
  }
  const forced = SECRETS[tuning.secretForce]
  if (on && forced) picked.add(forced.id)
  const hour = digit(seeds, "hour")
  const day = digit(seeds, "day")
  const pulses = digit(seeds, "pulses")
  return {
    seed: seeds.seed,
    houseSeed: seeds.houseSeed,
    picked,
    hour,
    minute: Math.floor(secretRoll(seeds, "minute") * 60),
    day,
    firstWeekday: Math.floor(secretRoll(seeds, "weekday") * 7),
    pulses,
    code: [hour, day, pulses],
  }
}

/** Seconds per pulse of the radio man's set, and the pause after a group. */
export const PULSE_ON = 0.38
export const PULSE_GAP = 0.42
export const PULSE_PAUSE = 2.6

/** Whether the set's dial is lit at `time` (seconds) for a run's pulse count. */
export function pulseLit(pulses: number, time: number): boolean {
  const period = pulses * (PULSE_ON + PULSE_GAP) + PULSE_PAUSE
  const t = ((time % period) + period) % period
  if (t >= pulses * (PULSE_ON + PULSE_GAP)) return false
  return t % (PULSE_ON + PULSE_GAP) < PULSE_ON
}
