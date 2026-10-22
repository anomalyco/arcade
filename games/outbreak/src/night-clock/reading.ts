import { dayCycle, wrapHour } from "../../shared/day-cycle"

/** Where darkness crosses one half (the way-out countdown's "dark"), found by bisection between two hours. */
function crossing(from: number, to: number, rising: boolean): number {
  let a = from
  let b = to
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2
    if (dayCycle(m).darkness >= 0.5 === rising) b = m
    else a = m
  }
  return wrapHour((a + b) / 2)
}

/** Clock hour it gets dark (darkness reaches 0.5, about 17:00) and light again (about 07:00). */
export const DUSK_HOUR = crossing(12, 23.99, true)
export const DAWN_HOUR = crossing(0.01, 12, false)
/** Game hours of dark in one night. */
export const NIGHT_HOURS = wrapHour(DAWN_HOUR - DUSK_HOUR)

export type NightClockReading =
  | { mode: "night"; seconds: number; left: number }
  | { mode: "dusk"; seconds: number }
  | null

/**
 * What the night clock shows at `hour`: at night the real seconds until dawn and the fraction of the night left;
 * in the last `warnSeconds` of daylight the real seconds until dark; otherwise nothing. `timeScale` is game seconds per
 * real second; a stopped clock (0) still reads which part of the night it is.
 */
export function nightClockReading(hour: number, timeScale: number, warnSeconds: number): NightClockReading {
  const h = wrapHour(hour)
  const scale = Math.max(0, timeScale)
  const toSeconds = (hours: number) => (scale > 0 ? (hours * 3600) / scale : Infinity)
  if (dayCycle(h).darkness >= 0.5) {
    const toDawn = wrapHour(DAWN_HOUR - h)
    return { mode: "night", seconds: toSeconds(toDawn), left: Math.min(1, toDawn / NIGHT_HOURS) }
  }
  const toDusk = toSeconds(wrapHour(DUSK_HOUR - h))
  return warnSeconds > 0 && toDusk <= warnSeconds ? { mode: "dusk", seconds: toDusk } : null
}

/** "4:05", or "–:––" for a stopped clock. */
export function countdownText(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–:––"
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
