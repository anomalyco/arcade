/**
 * The training room (AR-89, Kit: "Need a little training room to start in"): your own house, Ash, at dawn on the day
 * the outbreak reaches the street. It runs in its own offline sim, staged here, and is thrown away when you step out
 * of the front door into the real run; nothing here touches a real run or a co-op room unless `stageTraining` is
 * called on it. Every rule is a pure function of the sim, so it snapshots and forks like the rest.
 */
import type { OutbreakSim, Survivor } from "../sim-types"

/** Ash's layout is fixed by the origin block on every seed. */
export const TRAINING_HOUSE = "ash"
/** The hour the room holds while you train: first light, dim enough indoors that the flashlight earns its place. */
export const TRAINING_HOUR = 6.1
/** Where you wake: beside the bed, facing the dresser. */
export const TRAINING_START = { x: 26.6, y: 27.4, aim: -0.35 } as const
/** The dresser you search: two planks for the window and two chemicals the recipe board turns into a bandage. */
export const TRAINING_DRESSER = "loot:1"
export const TRAINING_DRESSER_CONTENTS = [
  { item: "plank", count: 2 },
  { item: "chem", count: 2 },
] as const
/** The window the dead came through in the night (the classic broken-in vignette's): board it up. */
export const TRAINING_WINDOW = "ash-east"
export const TRAINING_ROOM_DOOR = "ash-room"
export const TRAINING_FRONT_DOOR = "ash-front"
export const TRAINING_BENCH = "bench:ash"
/** Broken glass under the east window, where crouching keeps you quiet. */
export const TRAINING_GLASS = { x: 36.0, y: 30.3 } as const
/** The one you put down: chained to the porch rail in the front yard, so it can lunge but never follow. */
export const TRAINING_CHAIN = { x: 31.6, y: 38.9, length: 1.3 } as const
/** Past here (south of the front yard) you have left the house: the run begins. */
export const TRAINING_EXIT_Y = 41.6

export type TrainingState = {
  /** The sim is a training room. */
  active: boolean
  /** The chained zombie's id, -1 once none. */
  chained: number
}

export const createTrainingState = (): TrainingState => ({ active: false, chained: -1 })

/**
 * Turns a fresh offline sim into the training room: dawn held, no crowd, the survivor beside the bed with no planks of
 * their own, the dresser stocked, and one zombie on a chain in the front yard.
 */
export function stageTraining(sim: OutbreakSim, state: TrainingState): void {
  state.active = true
  sim.hour = TRAINING_HOUR
  Object.assign(sim.ai.config, { zombieCount: 0, directorPacing: 0 })
  // Nobody else on the street yet.
  sim.ai.agents.length = 0
  const ledger = sim.progression.ledger
  for (const slot of sim.slots) {
    for (const st of ledger.stores.values()) {
      if (st.id.startsWith(`${slot.id}/`)) ledger.apply({ kind: "drain", store: st.id, item: "plank", count: 99 })
    }
    Object.assign(slot.survivor, { x: TRAINING_START.x, y: TRAINING_START.y, aim: TRAINING_START.aim, vx: 0, vy: 0 })
    slot.survivor.flashlightOn = false
  }
  const dresser = ledger.store(TRAINING_DRESSER)
  if (dresser) {
    dresser.revealed = false
    dresser.slots = Array.from({ length: dresser.size }, (_, i) => {
      const s = TRAINING_DRESSER_CONTENTS[i]
      return s ? { item: s.item, count: s.count } : null
    })
    dresser.rev = ++ledger.rev
  }
  const z = sim.ai.spawnZombie(sim.town, TRAINING_CHAIN.x, TRAINING_CHAIN.y + 0.4, "wander", -Math.PI / 2)
  state.chained = z.id
}

/** Holds the dawn while training. */
export function holdTrainingHour(sim: OutbreakSim, state: TrainingState): void {
  if (state.active) sim.hour = TRAINING_HOUR
}

/** Keeps the chained zombie within its chain of the rail: it strains and lunges but cannot follow. */
export function stepChain(sim: OutbreakSim, state: TrainingState): void {
  if (!state.active) return
  // Nobody else comes up the street while you train (streamed chunks, bodies that rise, the director).
  const agents = sim.ai.agents
  for (let i = agents.length - 1; i >= 0; i--) if (agents[i]!.id !== state.chained) agents.splice(i, 1)
  if (state.chained < 0) return
  const z = agents.find((a) => a.id === state.chained)
  if (!z) return
  const dx = z.x - TRAINING_CHAIN.x
  const dy = z.y - TRAINING_CHAIN.y
  const d = Math.hypot(dx, dy)
  if (d <= TRAINING_CHAIN.length) return
  z.x = TRAINING_CHAIN.x + (dx / d) * TRAINING_CHAIN.length
  z.y = TRAINING_CHAIN.y + (dy / d) * TRAINING_CHAIN.length
  // Pulling against the chain: keep the part of its velocity along it, lose what pulls away.
  const along = (z.vx * dx + z.vy * dy) / d
  if (along > 0) {
    z.vx -= (along * dx) / d
    z.vy -= (along * dy) / d
  }
}

/** Training never kills: hits sting at a quarter and stop at a sliver of health. */
export function trainingDamage(survivor: Pick<Survivor, "health">, damage: number, state: TrainingState): number {
  if (!state.active) return damage
  return Math.max(0, Math.min(damage * 0.25, survivor.health - 20))
}

/** Whether the survivor has left the house for the street, which ends the training room. */
export function leftTheHouse(survivor: Pick<Survivor, "x" | "y">): boolean {
  return survivor.y > TRAINING_EXIT_Y || Math.hypot(survivor.x - 29.5, survivor.y - 30) > 17
}
