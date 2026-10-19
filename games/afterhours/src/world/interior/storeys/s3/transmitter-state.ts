// The 3-08 transmitter's story state, shared by the world (storeys/s3/listening.ts builds and drives the rack) and the
// game (game/objectives.ts). No three.js here: the objectives import it cheaply.
//   "on"        still broadcasting the carrier on a loop (the signal the town picked up)
//   "off"       TX POWER thrown: lamp dead, static gone, the building silent
//   "aftermath" a few seconds later: one heavy metal crunch outside (the end of the current content)

export type TransmitterPhase = "on" | "off" | "aftermath"

const listeners = new Set<(phase: TransmitterPhase) => void>()
let phase: TransmitterPhase = "on"
let request: (() => void) | null = null

export const transmitter = {
  get phase() {
    return phase
  },
  /** Called on every phase change (and never again for the same phase). Returns an unsubscribe. */
  on(fn: (phase: TransmitterPhase) => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  /** World side: moves the story on. */
  set(next: TransmitterPhase) {
    if (next === phase) return
    phase = next
    for (const l of listeners) l(next)
  },
  /** World side: what throwing the switch does (the rack registers it once built). */
  bind(fn: () => void) {
    request = fn
  },
  /** Automation / debug: throw the switch as if the player pressed E on it. */
  cut() {
    request?.()
  },
}
;(globalThis as { __ashwoodTransmitter?: typeof transmitter }).__ashwoodTransmitter = transmitter
