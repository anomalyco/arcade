// STUB — owned by the Flight agent. Signatures are the contract; replace implementations.
import type { FlightInput, FlightState, Quat, Vec3, VehicleKind, WorldQuery } from "./types"
import type { SpawnPoint } from "./geography"

export const NEUTRAL_INPUT: FlightInput = { aim: null, throttle: 0, roll: 0, yaw: 0, pitch: 0, boost: false, brake: false }

export function createFlightState(kind: VehicleKind, spawn: SpawnPoint): FlightState {
  const half = spawn.yaw / 2
  return {
    kind,
    position: [...spawn.position],
    velocity: [0, 0, 0],
    orientation: [0, Math.sin(half), 0, Math.cos(half)],
    angularVelocity: [0, 0, 0],
    throttle: 0,
    onGround: spawn.onGround,
    gearDown: spawn.onGround,
    crashed: null,
    tick: 0,
  }
}

/** Advance one fixed tick (dt = TICK_DT). Mutates state. Must be deterministic. */
export function stepFlight(state: FlightState, input: FlightInput, dt: number, world: WorldQuery): void {
  state.tick++
}

/** Deep copy (JSON-safe). */
export function cloneFlight(state: FlightState): FlightState {
  return structuredClone(state)
}

/** World-space nose direction (unit vector, body -Z). */
export function forward(q: Quat): Vec3 {
  const [x, y, z, w] = q
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))]
}

/** Readout for HUD: speed m/s, altitude m, heading deg, pitch deg, roll deg, throttle 0..1. */
export function flightReadout(state: FlightState) {
  const v = state.velocity
  return { speed: Math.hypot(v[0], v[1], v[2]), altitude: state.position[1], heading: 0, pitch: 0, roll: 0, throttle: state.throttle }
}
