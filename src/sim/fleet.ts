// Carrier strike groups (team home bases). Orchestrator-owned contract; dependency-free.
// Ships are stationary ("dormant") for now. Positions are world space, meters, Y up.
// Ship local frame: bow = -Z, starboard = +X, up = +Y, origin at the waterline center.
import type { TeamId, Vec3 } from "./types"

export type ShipKind = "carrier" | "destroyer"
export type TurretKind = "ciws" | "gun"

export interface ShipTurret {
  id: string
  kind: TurretKind
  /** Mount position in ship-local coordinates. */
  offset: Vec3
}

export interface ShipSpec {
  kind: ShipKind
  /** Half extents of the hull collision box (ship-local, centered at the waterline). */
  halfLength: number
  halfWidth: number
  /** Height of the main/flight deck above the waterline. */
  deckHeight: number
  /** Superstructure (island / bridge) collision box, ship-local center + half extents. */
  island: { center: Vec3; half: Vec3 }
  turrets: ShipTurret[]
  model: string
}

export const SHIP_SPECS: Record<ShipKind, ShipSpec> = {
  carrier: {
    kind: "carrier", halfLength: 166, halfWidth: 38, deckHeight: 20, model: "models/carrier.glb",
    island: { center: [30, 38, 20], half: [8, 18, 22] },
    turrets: [
      { id: "ciws_bow_port", kind: "ciws", offset: [-36, 18, -150] },
      { id: "ciws_bow_stbd", kind: "ciws", offset: [36, 18, -140] },
      { id: "ciws_aft_port", kind: "ciws", offset: [-36, 18, 150] },
      { id: "ciws_island", kind: "ciws", offset: [38, 58, 10] },
    ],
  },
  destroyer: {
    kind: "destroyer", halfLength: 78, halfWidth: 10, deckHeight: 9, model: "models/destroyer.glb",
    island: { center: [0, 22, -10], half: [8, 13, 16] },
    turrets: [
      { id: "gun_fwd", kind: "gun", offset: [0, 11, -52] },
      { id: "ciws_fwd", kind: "ciws", offset: [0, 30, -24] },
      { id: "ciws_aft", kind: "ciws", offset: [0, 18, 34] },
    ],
  },
}

export interface Ship {
  id: string
  team: TeamId
  kind: ShipKind
  position: Vec3 // waterline center, y = 0
  /** Yaw (rad); 0 = bow toward -Z. */
  heading: number
}

/** Anti-air defense: any enemy aircraft inside this range of a turret (with line of sight) is engaged. */
export const AA_RANGE = 2200
/** Seconds of spawn protection after spawning (replaces the old safe-zone domes). */
export const SPAWN_PROTECTION = 6

const GROUP_DISTANCE = 6000
const ESCORTS: Array<{ dx: number; dz: number }> = [
  { dx: -700, dz: -500 }, { dx: 700, dz: -500 }, { dx: 0, dz: 800 },
]

/** One strike group per team: 1 carrier + 3 destroyers. Carrier bow points at the map center. */
export const FLEET: Ship[] = ([0, 1, 2, 3] as TeamId[]).flatMap(team => {
  const dir = [[0, 1], [0, -1], [-1, 0], [1, 0]][team]
  const cx = dir[0] * GROUP_DISTANCE, cz = dir[1] * GROUP_DISTANCE
  const heading = Math.atan2(dir[0], dir[1]) // bow (-Z) faces the center
  const c = Math.cos(heading), s = Math.sin(heading)
  const local = (dx: number, dz: number): Vec3 => [cx + dx * c + dz * s, 0, cz - dx * s + dz * c]
  return [
    { id: `t${team}-carrier`, team, kind: "carrier" as const, position: local(0, 0), heading },
    ...ESCORTS.map((e, i) => ({ id: `t${team}-dd${i + 1}`, team, kind: "destroyer" as const, position: local(e.dx, e.dz), heading })),
  ]
})

/** Ships that exist in a room with `teams` teams (teams 0..teams-1). Inactive teams have no fleet. */
export function activeFleet(teams: number): Ship[] {
  return FLEET.filter(s => s.team < teams)
}

export function shipsForTeam(team: TeamId): Ship[] {
  return FLEET.filter(s => s.team === team)
}

/** Ship-local → world. */
export function shipToWorld(ship: Ship, local: Vec3): Vec3 {
  const c = Math.cos(ship.heading), s = Math.sin(ship.heading)
  return [ship.position[0] + local[0] * c + local[2] * s, ship.position[1] + local[1], ship.position[2] - local[0] * s + local[2] * c]
}

/** World → ship-local. */
export function worldToShip(ship: Ship, p: Vec3): Vec3 {
  const dx = p[0] - ship.position[0], dz = p[2] - ship.position[2]
  const c = Math.cos(ship.heading), s = Math.sin(ship.heading)
  return [dx * c - dz * s, p[1] - ship.position[1], dx * s + dz * c]
}
