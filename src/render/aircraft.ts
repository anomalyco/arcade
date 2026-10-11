// STUB — owned by the Aircraft Rendering agent. Signatures are the contract; replace implementations.
import { Group, type Camera, type Object3D } from "three"
import type { PlayerInfo, Quality, TeamId, VehicleEntity, VehicleKind } from "../sim/types"

export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"] as const

export interface AircraftView {
  root: Object3D
  /** Called every render frame with the interpolated entity. Animates rotors/props/turrets/gear/afterburners. */
  update(vehicle: VehicleEntity, players: PlayerInfo[], dt: number, camera: Camera): void
  dispose(): void
}

/** Start loading all aircraft GLBs (non-blocking). Resolves when all are ready. */
export function preloadAircraft(baseUrl: string): Promise<void> {
  return Promise.resolve()
}

export function aircraftReady(kind: VehicleKind): boolean {
  return false
}

export function createAircraftView(kind: VehicleKind, team: TeamId, quality: Quality): AircraftView {
  const root = new Group()
  return { root, update() {}, dispose() {} }
}
