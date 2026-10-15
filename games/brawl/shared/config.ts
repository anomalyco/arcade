/** The game's name, in one place: the route id, Worker, storage keys and the title on screen all come from here. */
export const GAME = { id: "brawl", title: "BRAWL" } as const

export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 20

/** Humans per room; bots top a room up to BOT_FILL. */
export const MAX_PLAYERS = 8
export const BOT_FILL = 4

export const PLAYER_RADIUS = 0.36
export const ACCEL = 24

/** Stocks per round; a round lasts at most ROUND_SECONDS. */
export const STOCKS = 3
export const SELECT_SECONDS = 15
export const COUNTDOWN_SECONDS = 1.8
export const ROUND_SECONDS = 90
export const RESULTS_SECONDS = 5
export const RESPAWN_SECONDS = 1.1
export const INVULN_SECONDS = 1.0
/** How long a fighter falls past the edge before the knock-out counts. */
export const FALL_SECONDS = 0.45

/**
 * Knockback grows with damage like a platform fighter: speed = knock × (1 + damage / KNOCK_GROWTH) / weight.
 * Faster than ROPE_BREAK and you fly over the ropes and off the stage.
 */
export const KNOCK_GROWTH = 38
export const ROPE_BREAK = 11.4
/** Friction while flying (m/s²); walls bounce you back at WALL_BOUNCE of your speed. */
export const LAUNCH_FRICTION = 8.0
export const WALL_BOUNCE = 0.65
/** Seconds into a round when Sudden Death Overcharge begins ramping up knockback so rounds never drag. */
export const OVERCHARGE_SECONDS = 45
/** A knock-out within this many seconds of a hit credits the hitter. */
export const CREDIT_SECONDS = 6

export type FeelSettings = {
  moveScale: number
  accel: number
  knockGrowth: number
  ropeBreak: number
  launchFriction: number
  wallBounce: number
  overchargeAt: number
  hitStopScale: number
  shakeScale: number
  camTightness: number
}

export const DEFAULT_FEEL: Readonly<FeelSettings> = {
  moveScale: 1,
  accel: ACCEL,
  knockGrowth: KNOCK_GROWTH,
  ropeBreak: ROPE_BREAK,
  launchFriction: LAUNCH_FRICTION,
  wallBounce: WALL_BOUNCE,
  overchargeAt: OVERCHARGE_SECONDS,
  hitStopScale: 1,
  shakeScale: 1,
  camTightness: 1.18,
}

/** Live tunable feel parameters bound to the shared LabPanel. */
export const FEEL: FeelSettings = { ...DEFAULT_FEEL }
