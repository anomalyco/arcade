/** The game's name, in one place: the route id, Worker, storage keys and the title on screen all come from here. */
export const GAME = { id: "archers", title: "ARCHERS" } as const

/** Platformers need a fine fixed step: the sim, bots and online rollback all run at this rate. */
export const TICK_HZ = 60
export const DT = 1 / TICK_HZ

export const MAX_PLAYERS = 4

/** Arrows each archer spawns with, and the most a quiver holds. */
export const START_ARROWS = 3
export const MAX_ARROWS = 6

/** Round wins that take the match. */
export const WINS_TO_MATCH = 5
export const COUNTDOWN_SECONDS = 1.2
/** After the last kill: the slow-motion finish and the round card. */
export const ROUND_OVER_SECONDS = 2.4
export const MATCH_OVER_SECONDS = 5

/** Chests: the first one after this long, then one every CHEST_EVERY seconds, at most CHEST_MAX on the map. */
export const CHEST_FIRST = 5
export const CHEST_EVERY = 9
export const CHEST_MAX = 2
