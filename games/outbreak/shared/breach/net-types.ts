/** One damaged door or window on the wire. Integrity lives in the AI's portal state; the rest is `PortalWear`. */
export type BreachWire = {
  /** Index into `[...town.doors, ...town.windows]`, like the bash events. */
  portal: number
  integrity: number
  flags: number
  kind: number
  pushers: number
  braced: number
  /** -1, 0 unknown, +1. */
  outside: number
  givingAt: number
  breachAt: number
  debrisX: number
  debrisY: number
}
export type BreachSnapshot = { portals: BreachWire[] }
