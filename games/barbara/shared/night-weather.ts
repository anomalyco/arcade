import { nextRandom } from "./world"

/**
 * The night's weather as plain seeded data, the same on every client: from the night's seed and how far through the
 * search it is, which weather the woods are in and how far into the next. Only + − × ÷ and `nextRandom`, so a server
 * could own it; clients read it from the shared sim clock (`state.t` and the night's start and dawn).
 *
 * A night is a few spells, each lasting a share of it, with a slow change between them (`CHANGE` of the night).
 * Nights are plausible sequences: a clear start, fog settling in the hollows, a storm brewing that may break into
 * rain, and fog again after rain or a clear, starry spell before dawn.
 */
export const NIGHT_WEATHERS = ["clear", "starry", "fog", "brewing", "rain"] as const
export type NightWeather = (typeof NIGHT_WEATHERS)[number]

/** One spell: the weather and where it starts (share of the night, 0..1). */
export type WeatherSpell = { weather: NightWeather; at: number }

/** A change between spells takes this share of the night (18 min nights: ~2 min). */
export const CHANGE = 0.11

/** What may follow each weather, with weights. */
const NEXT: Record<NightWeather, readonly [NightWeather, number][]> = {
  clear: [["fog", 3], ["brewing", 2], ["starry", 1]],
  starry: [["fog", 2], ["clear", 1], ["brewing", 1]],
  fog: [["clear", 2], ["brewing", 2], ["starry", 1]],
  brewing: [["rain", 3], ["clear", 1]],
  rain: [["fog", 3], ["clear", 1]],
}

function pick(rng: { seed: number }, from: readonly [NightWeather, number][]): NightWeather {
  let total = 0
  for (const [, w] of from) total += w
  let r = nextRandom(rng) * total
  for (const [k, w] of from) { r -= w; if (r < 0) return k }
  return from[from.length - 1]![0]
}

/** The night's spells from its seed: three to five, the first clear, each longer than a change (≥ 12% of the night). */
export function nightSpells(seed: number): WeatherSpell[] {
  const rng = { seed: (seed ^ 0x77ea7e) | 0 }
  const count = 3 + Math.floor(nextRandom(rng) * 3)
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i < count; i++) { const l = 1 + nextRandom(rng) * 0.8; lengths.push(l); total += l }
  const spells: WeatherSpell[] = []
  let at = 0, weather: NightWeather = "clear"
  for (let i = 0; i < count; i++) {
    spells.push({ weather, at })
    at += lengths[i]! / total
    weather = pick(rng, NEXT[weather])
  }
  return spells
}

/** The weather `progress` (0 = the search starts, 1 = dawn) into the night: this spell, the next and how far into it. */
export function weatherAt(spells: readonly WeatherSpell[], progress: number): { from: NightWeather; to: NightWeather; mix: number } {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress
  let i = 0
  while (i + 1 < spells.length && spells[i + 1]!.at <= p) i++
  const here = spells[i]!, next = spells[i + 1]
  if (!next) return { from: here.weather, to: here.weather, mix: 0 }
  // The change runs over the last CHANGE of this spell, smoothed at both ends.
  const k = (p - (next.at - CHANGE)) / CHANGE
  const t = k < 0 ? 0 : k > 1 ? 1 : k
  return { from: here.weather, to: next.weather, mix: t * t * (3 - 2 * t) }
}

/** How far into the night (0..1) from the sim clock and the night's start and dawn (0 before the search starts). */
export function nightProgress(t: number, start: number, dawn: number): number {
  if (!(dawn > start) || t <= start) return 0
  const p = (t - start) / (dawn - start)
  return p > 1 ? 1 : p
}
