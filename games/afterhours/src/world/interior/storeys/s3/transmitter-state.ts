// The 3-08 radio-room beat's story state, shared by the world (storeys/s3/transmitter.ts builds and drives it) and the
// game (game/objectives.ts, game/checkpoint.ts, game/hunter). No three.js here: the game imports it cheaply.
//
// The station's radio went silent two days ago; the player is sent to find out why. In 3-08:
//   "off"           on arrival: TX-1 switched off (lamp dark, needle at rest, no carrier, no static)
//   "warming"       TX POWER thrown on: clunk, ~2 s warm-up hum
//   "on"            ON AIR lit, needle up: the desk mic can key a call
//   "transmitting"  the player's report and County's crackled reply (subtitles)
//   "transmitted"   call over                                       → onTransmitted()
//   "revealed"      the operator pushed off the desk: the warning on the blotter under him
//                   (TRANSMITTING WAKES IT …)                        → onReveal(); the Wendigo comes from here
//   "aftermath"     the turn outside has begun (the car destroyed)

export type TransmitterPhase = "off" | "warming" | "on" | "transmitting" | "transmitted" | "revealed" | "aftermath"
const ORDER: readonly TransmitterPhase[] = ["off", "warming", "on", "transmitting", "transmitted", "revealed", "aftermath"]

const listeners = new Set<(phase: TransmitterPhase) => void>()
let phase: TransmitterPhase = "off"
const actions: Partial<Record<"switchOn" | "transmit" | "reveal", () => void>> = {}

export const transmitter = {
  get phase() {
    return phase
  },
  /** True once the story is at or past `p`. */
  reached(p: TransmitterPhase) {
    return ORDER.indexOf(phase) >= ORDER.indexOf(p)
  },
  /** Called on every phase change (each phase once, in order). Returns an unsubscribe. */
  on(fn: (phase: TransmitterPhase) => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  /** World side: moves the story on (never backwards). */
  set(next: TransmitterPhase) {
    if (ORDER.indexOf(next) <= ORDER.indexOf(phase)) return
    phase = next
    for (const l of listeners) l(next)
  },
  /** World side: what each interaction does (the room registers them once built). */
  bind(name: "switchOn" | "transmit" | "reveal", fn: () => void) {
    actions[name] = fn
  },
  /** Automation / debug: the player's three interactions, as if E were pressed on the switch, the mic, the body. */
  switchOn: () => actions.switchOn?.(),
  transmit: () => actions.transmit?.(),
  reveal: () => actions.reveal?.(),
}

/** The call to County is over (the player's report and the reply). Fires at once if it already has. */
export function onTransmitted(fn: () => void) {
  if (transmitter.reached("transmitted")) fn()
  return transmitter.on((p) => p === "transmitted" && fn())
}

/** The warning under the operator has been seen: the turn starts (the hunter's entry). Fires at once if it already has. */
export function onReveal(fn: () => void) {
  if (transmitter.reached("revealed")) fn()
  return transmitter.on((p) => p === "revealed" && fn())
}

;(globalThis as { __ashwoodTransmitter?: typeof transmitter }).__ashwoodTransmitter = transmitter
