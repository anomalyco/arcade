// Vehicle + weapon tuning tables. Owned by the orchestrator; agents may propose numbers.
import type { FlightModel, VehicleKind, WeaponId } from "./types"

/**
 * gun / rockets: fire while held.
 * missile_lock: lock-on by holding the seat's aim (pilot: nose) on a target for `lockTime`; fire-and-forget homing.
 * missile_scanner: operator keeps the scanner reticle on the target; lock builds over `lockTime`; after launch the
 *   missile only homes while the scanner stays within `lockCone` of its target (semi-active guidance). Long range, slow to deliver.
 * pulse: radar pulse ability (spots enemies).
 */
export type WeaponKind = "gun" | "rockets" | "missile_lock" | "missile_scanner" | "pulse"

export interface WeaponSpec {
  id: WeaponId
  name: string
  kind: WeaponKind
  damage: number
  /** Splash radius in meters (0 = direct hit only). */
  splash: number
  /** Shots per second while held (guns/rockets) or shots per second for missiles (reload = 1 / rate). */
  rate: number
  /** Muzzle/launch speed m/s (added to shooter velocity). */
  speed: number
  /** Max flight time seconds. */
  ttl: number
  /** Magazine size. -1 = unlimited (JSON-safe). */
  ammo: number
  /** Seconds to refill a completely empty magazine (ammo regenerates continuously at ammo / refill per second). */
  refill: number
  /** Seconds after the last shot before regeneration starts. */
  refillDelay: number
  /** Max lock/effective range in meters (missiles). */
  range?: number
  /** Missiles: seeker/scanner cone half-angle (rad) and seconds to achieve lock. */
  lockCone?: number
  lockTime?: number
  /** Missiles: max turn rate rad/s. */
  turnRate?: number
  /** Guns: spread in radians. */
  spread?: number
  /** Gunner weapons: true if aimed freely by seat aim (turret / pod / scanner), false if fixed forward. */
  turret?: boolean
}

export interface VehicleSpec {
  kind: VehicleKind
  name: string
  model: string // path under public/models
  flight: FlightModel
  maxHp: number
  /** Bounding sphere radius used for hit detection, meters. */
  radius: number
  cruise: number // m/s
  boost: number // m/s
  /** Takeoff/stall speed for jets (m/s). */
  stall: number
  /** seatWeapons[seat] = [primary, secondary]; null = no weapon in that slot. */
  seatWeapons: [[WeaponId | null, WeaponId | null], [WeaponId | null, WeaponId | null]]
  flares: number
  seatNames: [string, string]
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  cannon20: { id: "cannon20", name: "20mm Vulcan", kind: "gun", damage: 9, splash: 0, rate: 16, speed: 1150, ttl: 1.15, ammo: 600, refill: 15, refillDelay: 2, spread: 0.0025 },
  chaingun30: { id: "chaingun30", name: "30mm Chain Gun", kind: "gun", damage: 16, splash: 4, rate: 10, speed: 900, ttl: 1.5, ammo: 300, refill: 15, refillDelay: 2, spread: 0.004, turret: true },
  gau8: { id: "gau8", name: "GAU-8 Avenger", kind: "gun", damage: 14, splash: 2, rate: 30, speed: 1100, ttl: 1.2, ammo: 1100, refill: 15, refillDelay: 2, spread: 0.005 },
  rockets: { id: "rockets", name: "Hydra 70 Rockets", kind: "rockets", damage: 60, splash: 12, rate: 8, speed: 700, ttl: 4, ammo: 38, refill: 20, refillDelay: 2, spread: 0.015 },
  aim9: { id: "aim9", name: "Heat-Seeker", kind: "missile_lock", damage: 120, splash: 12, rate: 0.25, speed: 280, ttl: 6, ammo: 2, refill: 40, refillDelay: 4, range: 1100, lockCone: 0.08, lockTime: 2.2, turnRate: 1.6 },
  tvmissile: { id: "tvmissile", name: "Radar Missile", kind: "missile_lock", damage: 130, splash: 12, rate: 0.2, speed: 300, ttl: 7, ammo: 2, refill: 40, refillDelay: 4, range: 1500, lockCone: 0.07, lockTime: 2.5, turnRate: 1.5, turret: true },
  hellfire: { id: "hellfire", name: "Hellfire", kind: "missile_lock", damage: 130, splash: 12, rate: 0.25, speed: 260, ttl: 8, ammo: 4, refill: 40, refillDelay: 4, range: 1500, lockCone: 0.07, lockTime: 2.5, turnRate: 1.5, turret: true },
  maverick: { id: "maverick", name: "Maverick", kind: "missile_lock", damage: 150, splash: 14, rate: 0.2, speed: 280, ttl: 8, ammo: 2, refill: 40, refillDelay: 4, range: 1500, lockCone: 0.07, lockTime: 2.5, turnRate: 1.4, turret: true },
  aim47: { id: "aim47", name: "Long-Range Interceptor", kind: "missile_scanner", damage: 160, splash: 16, rate: 0.2, speed: 450, ttl: 22, ammo: 3, refill: 50, refillDelay: 5, range: 8000, lockCone: 0.08, lockTime: 3, turnRate: 1.3, turret: true },
  radarpulse: { id: "radarpulse", name: "Radar Pulse", kind: "pulse", damage: 0, splash: 4000, rate: 1 / 20, speed: 0, ttl: 8, ammo: -1, refill: 0, refillDelay: 0, turret: true },
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  fighter: {
    kind: "fighter", name: "F/A-18F Super Hornet", model: "models/fa18.glb", flight: "jet",
    maxHp: 450, radius: 8, cruise: 135, boost: 185, stall: 55,
    seatWeapons: [["cannon20", "aim9"], ["tvmissile", null]], flares: 12,
    seatNames: ["Pilot", "Weapons Officer"],
  },
  apache: {
    kind: "apache", name: "AH-64 Apache", model: "models/apache.glb", flight: "heli",
    maxHp: 550, radius: 7.5, cruise: 75, boost: 98, stall: 0,
    seatWeapons: [["rockets", null], ["chaingun30", "hellfire"]], flares: 10,
    seatNames: ["Pilot", "Gunner"],
  },
  warthog: {
    kind: "warthog", name: "A-10 Warthog", model: "models/a10.glb", flight: "jet",
    maxHp: 850, radius: 8.5, cruise: 105, boost: 135, stall: 45,
    seatWeapons: [["gau8", "rockets"], ["maverick", null]], flares: 16,
    seatNames: ["Pilot", "Weapons Officer"],
  },
  blackbird: {
    kind: "blackbird", name: "YF-12 Blackbird", model: "models/yf12.glb", flight: "jet",
    maxHp: 380, radius: 12, cruise: 190, boost: 260, stall: 75,
    seatWeapons: [[null, null], ["aim47", "radarpulse"]], flares: 8,
    seatNames: ["Pilot", "Radar Officer"],
  },
}

export const VEHICLE_KINDS = Object.keys(VEHICLES) as VehicleKind[]
