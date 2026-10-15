import { DEFAULT_AI_CONFIG } from "./ai"
import { DEFAULT_FLASHLIGHT_TUNING } from "./flashlight"
import type { SessionTuning } from "./session"
import { DEFAULT_STAMINA_TUNING } from "./stamina"

export type CoopRoomOptions = { seed: number; houseSeed: number; terrain: number; zombieCount: number }

/** Every co-op room plays the curated neighbourhood the offline game starts in. */
export const DEFAULT_COOP_ROOM: CoopRoomOptions = { seed: 7, houseSeed: 7, terrain: 0.22, zombieCount: DEFAULT_AI_CONFIG.zombieCount }

/** The room and every client's prediction use the same tuning; Lab sliders only affect the offline session. */
export const COOP_TUNING: SessionTuning = { ...DEFAULT_STAMINA_TUNING, ...DEFAULT_FLASHLIGHT_TUNING }

export const COOP_TIME_SCALE = 120
