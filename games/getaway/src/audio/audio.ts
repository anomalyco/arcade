import { AudioEngine } from "./engine"

export * from "./engine"

/** The game's page-wide engine: unlocks on the first gesture, `M` mutes. */
export const audio = new AudioEngine()
