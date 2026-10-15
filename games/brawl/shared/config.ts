/** The game's name, in one place: the route id, Worker, storage keys and the title on screen all come from here. */
export const GAME = { id: "brawl", title: "BRAWL" } as const

export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 20

/** Humans per room; bots top a room up to BOT_FILL. */
export const MAX_PLAYERS = 8
export const BOT_FILL = 4

export const PLAYER_RADIUS = 0.36
export const ACCEL = 20

/** Stocks per round; a round lasts at most ROUND_SECONDS. */
export const STOCKS = 3
export const SELECT_SECONDS = 25
export const COUNTDOWN_SECONDS = 3
export const ROUND_SECONDS = 180
export const RESULTS_SECONDS = 9
export const RESPAWN_SECONDS = 2
export const INVULN_SECONDS = 1.6
/** How long a fighter falls past the edge before the knock-out counts. */
export const FALL_SECONDS = 0.7

/**
 * Knockback grows with damage like a platform fighter: speed = knock × (1 + damage / KNOCK_GROWTH) / weight.
 * Faster than ROPE_BREAK and you fly over the ropes and off the stage.
 */
export const KNOCK_GROWTH = 70
export const ROPE_BREAK = 10.5
/** Friction while flying (m/s²); walls bounce you back at WALL_BOUNCE of your speed. */
export const LAUNCH_FRICTION = 7
export const WALL_BOUNCE = 0.55
/** A knock-out within this many seconds of a hit credits the hitter. */
export const CREDIT_SECONDS = 6
