// Read-only game hook on the lift (src/world/interior/lift.ts): its public state and two events, for story beats
// (src/game/encounters). No three.js; the lift fills `state` in when it's built.
//   "depart"  the doors have shut and the car starts for `storey` (its destination)
//   "arrive"  the car has levelled at `storey` and its doors start to open

export type LiftEvent = "depart" | "arrive"
export type LiftState = { phase: string; cur: number; target: number; pos: number; doorT: number; inCar: boolean }

const listeners = new Set<(e: LiftEvent, storey: number) => void>()

export const liftEvents = {
  /** Set by the lift once built; null before (or in modules without the interior). */
  state: null as (() => LiftState) | null,
  on(fn: (e: LiftEvent, storey: number) => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
  emit(e: LiftEvent, storey: number) {
    for (const l of listeners) l(e, storey)
  },
}
