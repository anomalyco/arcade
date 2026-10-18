import type { Sfx } from "./engine"

// Late-bound links between world modules and the game audio. World modules are built before (and independently of)
// the audio, and the audio never exists in `?shot` mode, so modules call through these and get silence until the
// game audio (src/audio/game.ts) fills them in.

/** The lift's sound interface (src/world/interior/lift.ts calls it; src/audio/lift.ts implements it). */
export type LiftAudio = {
  /** E was pressed (the lift's own key handler): unlock audio. */
  unlock(): void
  /** A mechanical clunk of `strength` (request, depart, stall, resume, level). */
  clunk(strength: number): void
  /** Per frame: the car's phase, speed (m/s), light level and floor height (world y). */
  update(phase: string, vel: number, light: number, carY: number): void
}

export const hooks: { sfx: Sfx | null; lift: LiftAudio | null; paper: (() => void) | null } = { sfx: null, lift: null, paper: null }

/** For the lift: a stable object that forwards to the game's lift sounds once they exist. */
export function liftAudio(): LiftAudio {
  return {
    unlock: () => hooks.lift?.unlock(),
    clunk: (s) => hooks.lift?.clunk(s),
    update: (phase, vel, light, carY) => hooks.lift?.update(phase, vel, light, carY),
  }
}

/** Hook for documents (picking up / reading a paper): a paper rustle at the listener. */
export function paperSound() {
  hooks.paper?.()
}
