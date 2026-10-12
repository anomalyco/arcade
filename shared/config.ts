export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 15

export const MAX_PLAYERS = 12
/** Bots fill a match to at least this many players. */
export const MIN_FILL = 4
export const MAX_ROOM_PLAYERS_HARD = 16

/** Upper bounds the GPU buffers are sized for. */
export const MAX_WALLS = 512
export const MAX_LIGHTS = 24
export const POLAR_RAYS = 720

export const LIT_THRESHOLD = 0.3
export const VIEW_RANGE = 34
export const RUN_EXPOSE_SECONDS = 0.9
export const FIRE_EXPOSE_SECONDS = 1.2

export const PLAYER_RADIUS = 0.34
export const SPEED = { sneak: 1.5, walk: 2.8, run: 5.6 } as const
export const ACCEL = 10

export const FOOT_INTERVAL = { walk: 0.55, run: 0.33 } as const
export const FOOT_RING = { walk: 8, run: 18 } as const
export const NOISY_SURFACE_MUL = 1.5

export const LOADOUT_SECONDS = 8
export const ROUND_SECONDS = 180
export const ROUND_OVER_SECONDS = 5
export const MATCH_OVER_SECONDS = 14
export const KILLCAM_SECONDS = 4
/** Fraction of the round after which lamps start to fail. */
export const ENCROACH_START = 0.5
export const ENCROACH_INTERVAL = 14
export const FLARE_LIFE = 7.5
export const FLARE_RADIUS = 10
export const FLARE_POWER = 1.1
export const THROW_RANGE = 9
export const FLARE_FLIGHT = 0.6
export const DECOY_FLIGHT = 0.5
export const EMP_RADIUS = 9
export const EMP_SECONDS = 12
export const MINE_ARM = 1.2
export const MINE_TRIGGER = 1.6
export const MINE_KILL = 2
export const DOOR_REACH = 1.3
export const PICKUP_REACH = 0.9
export const HIT_RADIUS = 0.36
export const LAMP_HIT_RADIUS = 0.45
export const FREEZE_SECONDS = 0.25

export type Stance = "sneak" | "walk" | "run"
export type Weapon = "pistol" | "shotgun" | "crossbow"
export type Gadget = "flare" | "decoy" | "emp" | "mine"
export type Mode = "tdm" | "ffa"

export type WeaponSpec = {
  label: string
  mag: number
  reserve: number
  windup: number
  cooldown: number
  reload: number
  range: number
  /** Ripple radius of the shot, 0 for silent. */
  noise: number
  /** Ripple radius of the reload clack, 0 for silent. */
  reloadNoise: number
  pellets: number
  spread: number
  /** Crossbow bolts stay where they land and must be picked up. */
  retrievable: boolean
}

export const WEAPONS: Record<Weapon, WeaponSpec> = {
  pistol: { label: "Suppressed pistol", mag: 6, reserve: 18, windup: 0.2, cooldown: 0.45, reload: 1.5, range: 30, noise: 14, reloadNoise: 18, pellets: 1, spread: 0, retrievable: false },
  shotgun: { label: "Shotgun", mag: 2, reserve: 8, windup: 0.45, cooldown: 1, reload: 1.6, range: 10, noise: 40, reloadNoise: 22, pellets: 9, spread: 0.2, retrievable: false },
  crossbow: { label: "Crossbow", mag: 1, reserve: 0, windup: 0.7, cooldown: 0.8, reload: 2.4, range: 36, noise: 0, reloadNoise: 0, pellets: 1, spread: 0, retrievable: true },
}

export type GadgetSpec = { label: string; count: number; unlock: number }
export const GADGETS: Record<Gadget, GadgetSpec> = {
  flare: { label: "Flare", count: 2, unlock: 1 },
  decoy: { label: "Noise decoy", count: 2, unlock: 1 },
  emp: { label: "Light-breaker EMP", count: 1, unlock: 4 },
  mine: { label: "Motion mine", count: 2, unlock: 5 },
}

export const WEAPON_UNLOCK: Record<Weapon, number> = { pistol: 1, shotgun: 2, crossbow: 3 }

export const MODES: Mode[] = ["tdm", "ffa"]
export const ROUND_CHOICES = [3, 5] as const
export const MAPS = ["warehouse"] as const
export type MapId = (typeof MAPS)[number]
