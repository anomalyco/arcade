// Vehicle + weapon tuning tables. Owned by the orchestrator; agents may propose numbers.
import type { FlightModel, VehicleKind, WeaponId } from "./types"

export type WeaponKind = "gun" | "rockets" | "missile_ir" | "missile_steered" | "missile_long" | "pulse"

export interface WeaponSpec {
  id: WeaponId
  name: string
  kind: WeaponKind
  damage: number
  /** Splash radius in meters (0 = direct hit only). */
  splash: number
  /** Shots per second while held (guns/rockets) or reload seconds between shots (missiles: 1 / rate). */
  rate: number
  /** Muzzle/launch speed m/s (added to shooter velocity). */
  speed: number
  /** Max flight time seconds. */
  ttl: number
  ammo: number
  /** Missiles: seeker cone half-angle (rad) and seconds to achieve lock. */
  lockCone?: number
  lockTime?: number
  /** Missiles: max turn rate rad/s. */
  turnRate?: number
  /** Guns: spread in radians. */
  spread?: number
  /** Gunner weapons: true if aimed freely by seat aim (turret / pod), false if fixed forward. */
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
  /** seatWeapons[seat] = [primary, secondary] */
  seatWeapons: [[WeaponId, WeaponId], [WeaponId, WeaponId]]
  flares: number
  seatNames: [string, string]
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  cannon20: { id: "cannon20", name: "20mm Vulcan", kind: "gun", damage: 9, splash: 0, rate: 16, speed: 1000, ttl: 2.2, ammo: 600, spread: 0.004 },
  chaingun30: { id: "chaingun30", name: "30mm Chain Gun", kind: "gun", damage: 16, splash: 4, rate: 10, speed: 800, ttl: 2.6, ammo: 300, spread: 0.006, turret: true },
  gau8: { id: "gau8", name: "GAU-8 Avenger", kind: "gun", damage: 14, splash: 2, rate: 30, speed: 1000, ttl: 2.2, ammo: 1100, spread: 0.008 },
  rockets: { id: "rockets", name: "Hydra 70 Rockets", kind: "rockets", damage: 60, splash: 12, rate: 8, speed: 700, ttl: 4, ammo: 38, spread: 0.015 },
  aim9: { id: "aim9", name: "Heat-Seeker", kind: "missile_ir", damage: 260, splash: 10, rate: 0.5, speed: 300, ttl: 8, ammo: 4, lockCone: 0.35, lockTime: 1.2, turnRate: 2.4 },
  tvmissile: { id: "tvmissile", name: "TV-Guided Missile", kind: "missile_steered", damage: 300, splash: 14, rate: 0.25, speed: 260, ttl: 12, ammo: 2, turnRate: 1.6, turret: true },
  hellfire: { id: "hellfire", name: "Hellfire", kind: "missile_steered", damage: 280, splash: 12, rate: 0.4, speed: 240, ttl: 10, ammo: 8, turnRate: 1.8, turret: true },
  maverick: { id: "maverick", name: "Maverick", kind: "missile_steered", damage: 340, splash: 16, rate: 0.3, speed: 250, ttl: 12, ammo: 2, turnRate: 1.5, turret: true },
  aim47: { id: "aim47", name: "Long-Range Interceptor", kind: "missile_long", damage: 320, splash: 14, rate: 0.2, speed: 450, ttl: 16, ammo: 3, lockCone: 0.18, lockTime: 2.5, turnRate: 1.2 },
  radarpulse: { id: "radarpulse", name: "Radar Pulse", kind: "pulse", damage: 0, splash: 4000, rate: 1 / 20, speed: 0, ttl: 8, ammo: Infinity, turret: true },
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  fighter: {
    kind: "fighter", name: "F/A-18F Super Hornet", model: "models/fa18.glb", flight: "jet",
    maxHp: 450, radius: 8, cruise: 135, boost: 185, stall: 55,
    seatWeapons: [["cannon20", "aim9"], ["tvmissile", "tvmissile"]], flares: 12,
    seatNames: ["Pilot", "Weapons Officer"],
  },
  apache: {
    kind: "apache", name: "AH-64 Apache", model: "models/apache.glb", flight: "heli",
    maxHp: 550, radius: 7.5, cruise: 75, boost: 98, stall: 0,
    seatWeapons: [["rockets", "rockets"], ["chaingun30", "hellfire"]], flares: 10,
    seatNames: ["Pilot", "Gunner"],
  },
  warthog: {
    kind: "warthog", name: "A-10 Warthog", model: "models/a10.glb", flight: "jet",
    maxHp: 850, radius: 8.5, cruise: 105, boost: 135, stall: 45,
    seatWeapons: [["gau8", "rockets"], ["maverick", "maverick"]], flares: 16,
    seatNames: ["Pilot", "Weapons Officer"],
  },
  blackbird: {
    kind: "blackbird", name: "YF-12 Blackbird", model: "models/yf12.glb", flight: "jet",
    maxHp: 380, radius: 12, cruise: 190, boost: 260, stall: 75,
    seatWeapons: [["aim47", "aim47"], ["radarpulse", "radarpulse"]], flares: 8,
    seatNames: ["Pilot", "Radar Officer"],
  },
}

export const VEHICLE_KINDS = Object.keys(VEHICLES) as VehicleKind[]
