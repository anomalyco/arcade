// STUB — owned by the Combat agent. Signatures are the contract; replace implementations.
import type { Flare, GameEvent, Missile, Projectile, SeatIndex, SeatInput, VehicleEntity, VehicleKind, WeaponRuntime } from "./types"

export interface CombatState {
  projectiles: Projectile[]
  missiles: Missile[]
  flares: Flare[]
  nextId: number
}

export function createCombatState(): CombatState {
  return { projectiles: [], missiles: [], flares: [], nextId: 1 }
}

/** Fresh weapon runtime arrays for a new vehicle of this kind. */
export function createWeapons(kind: VehicleKind): [WeaponRuntime[], WeaponRuntime[]] {
  return [[], []]
}

/**
 * Apply one seat's weapon input for this tick: fire guns/rockets/missiles, flares, abilities,
 * update missile lock progress. `now` is room time in seconds. Pushes events.
 */
export function applySeatInput(
  cs: CombatState, vehicle: VehicleEntity, seat: SeatIndex, input: SeatInput,
  vehicles: VehicleEntity[], now: number, events: GameEvent[],
): void {}

/**
 * Advance projectiles, missiles and flares one tick; detect hits against living vehicles and the ground,
 * apply damage (respecting safe zones), mark vehicles dead (alive=false) and push hit/kill/explosion events.
 */
export function stepCombat(cs: CombatState, vehicles: VehicleEntity[], dt: number, now: number, events: GameEvent[]): void {}
