import type { StoreState } from "@arcade/kit/sim/ledger"

/**
 * Road flares (AR-56, D-37 pick 4): a flare thrown like a bottle burns for half a minute where it lands, harsh red
 * light and smoke, and the dead who can see it go to it and stand in its glow. A lure of light, not noise: walls and
 * shut doors hide it where they would only muffle a sound, and it pulls hardest at night. Colour only in light: the
 * flare is the one red thing on a dark street.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `flare:<n>` | `t`, `until` (deciseconds) | lit at `t`, burns out at `until` |
 *
 * A flare's store goes when it has burnt out.
 */

export type FlareTuning = {
  /** How far a flare can be thrown, in metres. */
  flareThrow: number
  /** Seconds a flare burns. */
  flareSeconds: number
  /** How far away the dead see a flare at night and go to it, in metres (daylight shortens it). */
  flareReach: number
  /** Seconds between the flare's pulls on the dead who can see it. */
  flareBeat: number
}

export const DEFAULT_FLARE_TUNING: FlareTuning = {
  flareThrow: 11,
  flareSeconds: 30,
  flareReach: 16,
  flareBeat: 0.5,
}

/** Lab controls for road flares (Backquote › Flares); the values live in the Discovery settings. */
export const flareControls = [
  { key: "flareThrow", label: "Flare throw", group: "Flares", min: 2, max: 20, step: 0.5, unit: "m" },
  { key: "flareSeconds", label: "Flare burns for", group: "Flares", min: 3, max: 90, step: 1, unit: "s" },
  { key: "flareReach", label: "Dead see a flare within", group: "Flares", min: 2, max: 40, step: 1, unit: "m" },
  { key: "flareBeat", label: "Flare pulls every", group: "Flares", min: 0.2, max: 3, step: 0.1, unit: "s" },
] as const

/** How far the hiss of a flare striking carries: barely past the thrower. */
export const FLARE_STRIKE_NOISE = 2.5

export const isFlareStore = (id: string) => id.startsWith("flare:")

/** Whether a flare's store says it is burning at `time`. */
export function flareBurning(st: StoreState | undefined, time: number): boolean {
  return Boolean(st) && Math.round(time * 10) < (st!.counts.until ?? 0)
}

/** How far through its burn a flare is at `time`, 0 lit .. 1 out. */
export function flareAge(st: StoreState, time: number): number {
  const t = (st.counts.t ?? 0) / 10
  const until = (st.counts.until ?? 0) / 10
  return Math.max(0, Math.min(1, (time - t) / Math.max(0.1, until - t)))
}
