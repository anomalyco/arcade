import { DEFAULT_AI_CONFIG } from "./ai"
import { DEFAULT_STAMINA_TUNING } from "./stamina"

export type CoopRoomOptions = {
  seed: number
  houseSeed: number
  terrain: number
  zombieCount: number
  initialPhase?: "lobby" | "running"
}

/** Every co-op room plays the curated neighbourhood the offline game starts in. */
export const DEFAULT_COOP_ROOM: CoopRoomOptions = { seed: 7, houseSeed: 7, terrain: 0.22, zombieCount: DEFAULT_AI_CONFIG.zombieCount }

/** The room and every client's prediction use the same tuning; Lab sliders only affect the offline session. */
// Use the resolver's canonical defaults instead of rebuilding every feature namespace for every tick/replay.
export const COOP_TUNING = DEFAULT_STAMINA_TUNING

export const COOP_TIME_SCALE = 120
