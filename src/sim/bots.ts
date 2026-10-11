// STUB — owned by the Bots agent. Signatures are the contract; replace implementations.
import type { FlightInput, PlayerInfo, SeatInput, VehicleEntity, VehicleKind } from "./types"
import { NEUTRAL_INPUT } from "./flight"

export interface BotBrain {
  /** Internal per-bot memory (targets, waypoints, timers). */
  memory: Record<string, unknown>
}

export function createBotBrain(seed: number): BotBrain {
  return { memory: {} }
}

/** Vehicle kind a bot picks when spawning. */
export function chooseBotVehicle(bot: PlayerInfo, teammates: PlayerInfo[], vehicles: VehicleEntity[], rng: () => number): VehicleKind {
  return "fighter"
}

/** Compute this tick's input for a bot occupying `vehicle` in its seat. */
export function botInput(
  brain: BotBrain, bot: PlayerInfo, vehicle: VehicleEntity, vehicles: VehicleEntity[], now: number,
): { flight?: FlightInput; seat: SeatInput } {
  return { flight: NEUTRAL_INPUT, seat: { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false } }
}
