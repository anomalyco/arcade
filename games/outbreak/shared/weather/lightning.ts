import { weatherHash, weatherLevels, type WeatherTuning } from "./schedule"

/**
 * Lightning (AR-71): a pure schedule of strikes from the town seed and the simulation clock, so every client sees the
 * same flashes at the same moment. Time is cut into half-second slots; a slot strikes with a chance set by the storm
 * strength then. A strike is one or two quick flickers, 0.1–0.3 s in all, from a bearing and distance; thunder
 * follows after distance / speed of sound. Near strikes (under 100 m) can hit something in town.
 */
export const LIGHTNING_SLOT = 0.5
/** Seconds a strike's light lasts at most. */
export const LIGHTNING_LIFE = 0.32
export const SPEED_OF_SOUND = 343

export type LightningStrike = {
  /** Sim seconds of the first flicker. */
  t: number
  /** 0.55..1 */
  power: number
  /** Radians, plan bearing from the listener (0 = +x, π/2 = +y). */
  bearing: number
  /** Metres from the listener. */
  dist: number
  /** Second flicker delay (s), 0 = single flash. */
  reflash: number
  /** Stable id for de-duplication (the slot). */
  id: number
}

/** Share of strikes that land near (20–100 m). */
const NEAR_SHARE = 0.16

const levels: [number, number] = [0, 0]

/** The strike in slot `n`, if the slot strikes, else null. `storm` is the storm strength 0..1 in that slot. */
export function strikeInSlot(
  seed: number,
  n: number,
  perMinuteAtFull: number,
  storm: number,
  out?: LightningStrike,
): LightningStrike | null {
  if (storm <= 0.05 || perMinuteAtFull <= 0) return null
  const p = ((perMinuteAtFull * storm) / 60) * LIGHTNING_SLOT
  if (weatherHash(seed, n, 31) >= p) return null
  const s = out ?? { t: 0, power: 0, bearing: 0, dist: 0, reflash: 0, id: 0 }
  s.id = n
  s.t = (n + 0.1 + 0.8 * weatherHash(seed, n, 32)) * LIGHTNING_SLOT
  s.power = 0.55 + 0.45 * weatherHash(seed, n, 33)
  s.bearing = weatherHash(seed, n, 34) * Math.PI * 2
  const near = weatherHash(seed, n, 35) < NEAR_SHARE
  const d = weatherHash(seed, n, 36)
  s.dist = near ? 20 + 80 * d : 250 + 2750 * d * d
  const two = weatherHash(seed, n, 37)
  s.reflash = two < 0.55 ? 0.08 + 0.12 * (two / 0.55) : 0
  return s
}

/** Light of one strike `dt` seconds after it began: a sharp flash and maybe a dimmer second flicker. */
export function strikeFlash(strike: Readonly<LightningStrike>, dt: number): number {
  if (dt < 0 || dt > LIGHTNING_LIFE) return 0
  const pulse = (x: number) => (x < 0 ? 0 : Math.min(1, x / 0.012) * Math.exp(-x / 0.04))
  let f = pulse(dt)
  if (strike.reflash > 0) f = Math.max(f, 0.75 * pulse(dt - strike.reflash))
  // Near strikes are brighter; a far one is a wash on the clouds.
  const reach = strike.dist < 120 ? 1 : Math.max(0.45, 1 - (strike.dist - 120) / 4000)
  return Math.min(1, f * strike.power * reach)
}

/** Storm strength in slot `n` (sampled at the slot's middle with the current hour). */
function stormInSlot(seed: number, n: number, hour: number, t: WeatherTuning): number {
  return weatherLevels(seed, (n + 0.5) * LIGHTNING_SLOT, hour, t, levels)[1]
}

/** Brightest flash 0..1 at `time`, and the strike making it (into `out`). */
export function lightningAt(seed: number, time: number, hour: number, t: WeatherTuning, out?: LightningStrike): number {
  const last = Math.floor(time / LIGHTNING_SLOT)
  let best = 0
  const scratch: LightningStrike = { t: 0, power: 0, bearing: 0, dist: 0, reflash: 0, id: 0 }
  for (let n = last - 1; n <= last; n++) {
    const s = strikeInSlot(seed, n, t.weatherLightningPerMinute, stormInSlot(seed, n, hour, t), scratch)
    if (!s) continue
    const f = strikeFlash(s, time - s.t)
    if (f > best) {
      best = f
      if (out) Object.assign(out, s)
    }
  }
  return best
}

/** Strikes that began in (t0, t1], oldest first: for thunder and strike effects as the clock passes them. */
export function strikesBetween(seed: number, t0: number, t1: number, hour: number, t: WeatherTuning): LightningStrike[] {
  const out: LightningStrike[] = []
  if (!(t1 > t0)) return out
  // A long jump (a fresh join, a paused tab) skips old strikes instead of replaying a barrage.
  const from = Math.max(t0, t1 - 2)
  for (let n = Math.floor(from / LIGHTNING_SLOT); n <= Math.floor(t1 / LIGHTNING_SLOT); n++) {
    const s = strikeInSlot(seed, n, t.weatherLightningPerMinute, stormInSlot(seed, n, hour, t))
    if (s && s.t > t0 && s.t <= t1) out.push(s)
  }
  return out
}

/** Seconds from flash to thunder for a strike `dist` metres away (`scale` stretches it for the Lab). */
export function thunderDelay(dist: number, scale = 1): number {
  return (Math.max(0, dist) / SPEED_OF_SOUND) * Math.max(0, scale)
}
