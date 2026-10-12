// Carrier strike groups (team home bases). Orchestrator-owned contract; dependency-free.
// Ships orbit the map center (see shipPose) and are destructible objectives. Positions are world space, meters, Y up.
// Ship local frame: bow = -Z, starboard = +X, up = +Y, origin at the waterline center.
import type { TeamId, Vec3 } from "./types"

export type ShipKind = "carrier" | "destroyer"
export type TurretKind = "ciws" | "gun"

export interface ShipTurret {
  id: string
  kind: TurretKind
  /** Players may take control of this turret (mouse aims, LMB fires). */
  mannable?: boolean
  /** Mount position in ship-local coordinates. */
  offset: Vec3
}

export interface ShipSpec {
  kind: ShipKind
  /** Hit points (ships are destructible objectives). */
  maxHp: number
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
    kind: "carrier", maxHp: 8000, halfLength: 166, halfWidth: 38, deckHeight: 20, model: "models/carrier.glb",
    island: { center: [30, 38, 20], half: [8, 18, 22] },
    turrets: [
      { id: "ciws_bow_port", kind: "ciws", mannable: true, offset: [-36, 18, -150] },
      { id: "ciws_bow_stbd", kind: "ciws", mannable: true, offset: [36, 18, -140] },
      { id: "ciws_aft_port", kind: "ciws", mannable: true, offset: [-36, 18, 150] },
      { id: "ciws_island", kind: "ciws", mannable: true, offset: [38, 58, 10] },
    ],
  },
  destroyer: {
    kind: "destroyer", maxHp: 3000, halfLength: 78, halfWidth: 10, deckHeight: 9, model: "models/destroyer.glb",
    island: { center: [0, 22, -10], half: [8, 13, 16] },
    turrets: [
      { id: "gun_fwd", kind: "gun", mannable: true, offset: [0, 11, -52] },
      { id: "ciws_fwd", kind: "ciws", mannable: true, offset: [0, 30, -24] },
      { id: "ciws_aft", kind: "ciws", mannable: true, offset: [0, 18, 34] },
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
export const AA_RANGE = 1200

// ── Objective ────────────────────────────────────────────────────────────────
// A team loses when all of its carriers are sunk. Destroyers are optional targets (they carry AA).
// Ships take damage from missiles, rockets and guns; damage is shown progressively (fires, smoke,
// list/sink) and turrets can be knocked out individually.
/** Turret hit points (knocked out at 0; repaired never during a match). */
export const TURRET_HP = 600
/** Per-weapon damage multiplier against ships (hulls are tough; missiles/rockets are the anti-ship tools). */
export const SHIP_DAMAGE_SCALE: Record<string, number> = { gun: 0.15, rockets: 1.6, missile_lock: 3, missile_scanner: 3.5, aa: 0 }
/** Seconds of spawn protection after spawning (replaces the old safe-zone domes). */
export const SPAWN_PROTECTION = 6

// ── Fleet layout & movement ──────────────────────────────────────────────────
// Every strike group steams counter-clockwise around the map center on one shared circle, keeping
// its angular spacing (teams stay opposite each other). The whole picture is a rigid rotation of
// the t=0 layout about the origin, so pose is a pure function of match time (server/clients agree).
export const FLEET_ORBIT_RADIUS = 3200
/** Seconds per full lap (≈13 m/s at the carrier). */
export const FLEET_LAP_TIME = 1500
export const FLEET_ANGULAR_SPEED = (2 * Math.PI) / FLEET_LAP_TIME
/** @deprecated kept for compatibility: fleets no longer approach; they orbit at FLEET_ORBIT_RADIUS. */
export const FLEET_START_DISTANCE = FLEET_ORBIT_RADIUS
/** @deprecated see FLEET_START_DISTANCE. */
export const FLEET_END_DISTANCE = FLEET_ORBIT_RADIUS
/** @deprecated */
export const FLEET_APPROACH_TIME = 600

/** Formation offsets (group-local, bow = -Z). Two carriers abreast + three destroyer escorts. */
const CARRIERS: Array<{ dx: number; dz: number }> = [{ dx: -260, dz: 0 }, { dx: 260, dz: 120 }]
const ESCORTS: Array<{ dx: number; dz: number }> = [
  { dx: -600, dz: -500 }, { dx: 600, dz: -500 }, { dx: 0, dz: 750 },
]

/** t=0 layout. Group center angle θ (position = R·(sin θ, cos θ)); bow points along the direction of travel. */
export const FLEET: Ship[] = ([0, 1, 2, 3] as TeamId[]).flatMap(team => {
  const theta = [0, Math.PI, -Math.PI / 2, Math.PI / 2][team]
  const cx = FLEET_ORBIT_RADIUS * Math.sin(theta), cz = FLEET_ORBIT_RADIUS * Math.cos(theta)
  const heading = theta - Math.PI / 2 // bow (-Z) along the counter-clockwise tangent
  const c = Math.cos(heading), s = Math.sin(heading)
  const local = (dx: number, dz: number): Vec3 => [cx + dx * c + dz * s, 0, cz - dx * s + dz * c]
  return [
    ...CARRIERS.map((o, i) => ({ id: i === 0 ? `t${team}-carrier` : `t${team}-carrier${i + 1}`, team, kind: "carrier" as const, position: local(o.dx, o.dz), heading })),
    ...ESCORTS.map((e, i) => ({ id: `t${team}-dd${i + 1}`, team, kind: "destroyer" as const, position: local(e.dx, e.dz), heading })),
  ]
})

export interface ShipPose {
  position: Vec3
  heading: number
  /** World velocity m/s (for carrying aircraft parked on deck, wakes, lead aiming). */
  velocity: Vec3
  /** Yaw rate rad/s (the formation turns as it orbits). */
  yawRate?: number
}

/** Current pose of a ship `t` seconds into the match: the t=0 pose rotated about the origin by ω·t. */
export function shipPose(ship: Ship, t: number, out?: ShipPose): ShipPose {
  const phi = FLEET_ANGULAR_SPEED * Math.max(0, t)
  const c = Math.cos(phi), s = Math.sin(phi)
  const x0 = ship.position[0], z0 = ship.position[2]
  const o = out ?? { position: [0, 0, 0], heading: 0, velocity: [0, 0, 0], yawRate: 0 }
  const x = x0 * c + z0 * s, z = -x0 * s + z0 * c
  o.position[0] = x
  o.position[1] = 0
  o.position[2] = z
  o.heading = ship.heading + phi
  // Rigid rotation about the origin: v = ω · (z, -x).
  o.velocity[0] = FLEET_ANGULAR_SPEED * z
  o.velocity[1] = 0
  o.velocity[2] = -FLEET_ANGULAR_SPEED * x
  o.yawRate = FLEET_ANGULAR_SPEED
  return o
}

/** Ship-local → world at match time t. */
export function shipToWorldAt(ship: Ship, t: number, local: Vec3): Vec3 {
  const p = shipPose(ship, t)
  const c = Math.cos(p.heading), s = Math.sin(p.heading)
  return [p.position[0] + local[0] * c + local[2] * s, local[1], p.position[2] - local[0] * s + local[2] * c]
}

/** World → ship-local at match time t. */
export function worldToShipAt(ship: Ship, t: number, w: Vec3): Vec3 {
  const p = shipPose(ship, t)
  const dx = w[0] - p.position[0], dz = w[2] - p.position[2]
  const c = Math.cos(p.heading), s = Math.sin(p.heading)
  return [dx * c - dz * s, w[1], dx * s + dz * c]
}

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
