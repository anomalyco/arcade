// STUB — owned by the World agent. Signatures are the contract; replace implementations.
import type { TeamId, Vec3, VehicleKind, WorldQuery } from "./types"

export const WORLD_SIZE = 30_000
export const WORLD_HALF = WORLD_SIZE / 2
export const WATER_LEVEL = 0
export const CEILING = 6_000
export const WORLD_SEED = 0x57494e47 // "WING"

export interface Airbase {
  team: TeamId
  /** Center of the base (runway midpoint), y = runway elevation. */
  center: Vec3
  /** Runway heading as yaw (rad), direction a jet rolls for takeoff, pointing toward the map center. */
  heading: number
  runwayLength: number
  runwayWidth: number
  /** Protected radius around center (no damage taken/dealt by this team's aircraft inside). */
  safeRadius: number
  /** Helipad positions (y = pad elevation). */
  helipads: Vec3[]
}

const BASE_DISTANCE = 12_000
const BASE_ELEVATION = 20

export const AIRBASES: Airbase[] = ([0, 1, 2, 3] as TeamId[]).map(team => {
  // Team 0 south (+Z), 1 north (-Z), 2 west (-X), 3 east (+X); runways point toward the center.
  const dir = [[0, 1], [0, -1], [-1, 0], [1, 0]][team]
  const center: Vec3 = [dir[0] * BASE_DISTANCE, BASE_ELEVATION, dir[1] * BASE_DISTANCE]
  const heading = Math.atan2(dir[0], dir[1]) // yaw so that -Z (nose) faces the center
  return { team, center, heading, runwayLength: 2_400, runwayWidth: 60, safeRadius: 2_200, helipads: [] }
})

export function terrainHeight(x: number, z: number): number {
  return -60
}

export function groundHeight(x: number, z: number): number {
  return Math.max(WATER_LEVEL, terrainHeight(x, z))
}

export function onRunway(x: number, z: number): boolean {
  return false
}

export function inSafeZone(team: TeamId, p: Vec3): boolean {
  const base = AIRBASES[team]
  return Math.hypot(p[0] - base.center[0], p[2] - base.center[2]) < base.safeRadius
}

export interface SpawnPoint {
  position: Vec3
  /** Yaw (rad); 0 = nose toward -Z. */
  yaw: number
  /** True = start on the runway/helipad with gear down; false = air start. */
  onGround: boolean
}

/** Spawn slot for a team's vehicle. index lets multiple vehicles spawn without overlap. */
export function spawnPoint(team: TeamId, kind: VehicleKind, index: number): SpawnPoint {
  const base = AIRBASES[team]
  return { position: [base.center[0], base.center[1] + 2, base.center[2]], yaw: base.heading, onGround: true }
}

/** Fraction [0,1] along segment a→b where it first goes below the ground surface, or null. */
export function segmentHitsGround(a: Vec3, b: Vec3): number | null {
  return null
}

export const worldQuery: WorldQuery = { groundHeight, onRunway, half: WORLD_HALF, ceiling: CEILING }
