export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 15

export const MAX_PLAYERS = 12
/** Bots fill a match up to this many players. */
export const MIN_FILL = 4

/** GPU sizing. Static map lights plus live flares must fit in MAX_LIGHTS. */
export const MAX_LIGHTS = 32
export const MAX_OCCLUDERS = 512
export const POLAR_RAYS = 1024

/** A point is lit when the strongest unblocked light reaching it is at least this bright. */
export const LIT_THRESHOLD = 0.3
/** Nobody sees farther than this, even into light. */
export const VIEW_RANGE = 30

export const PLAYER_RADIUS = 0.32
export const SPEED = { sneak: 1.4, walk: 2.6, run: 4.8 } as const
/** Movement speed while winding up a shot: committing to a shot roots you. */
export const WINDUP_SPEED = 0.8
export const ACCEL = 9

export const STEP_INTERVAL = { sneak: 0.65, walk: 0.55, run: 0.34 } as const
export const STEP_RING = { walk: 7, run: 16 } as const
/** Grates and puddles make every step louder. */
export const NOISY_MUL = 1.6
/** Broken glass crunches even when sneaking. */
export const SHARD_RING = 5
export const RUN_EXPOSE = 0.9

export const LOADOUT_SECONDS = 10
export const ROUND_SECONDS = 180
export const ROUND_OVER_SECONDS = 6
export const MATCH_OVER_SECONDS = 16

/** Late-round pressure: lamps start failing at this fraction of the round, one every ENCROACH_INTERVAL seconds. */
export const ENCROACH_START = 0.5
export const ENCROACH_INTERVAL = 15
export const LAMP_FAIL_SECONDS = 1.6
/** In the last SONAR_START seconds every living player gives off a soft ring every SONAR_INTERVAL seconds. */
export const SONAR_START = 45
export const SONAR_INTERVAL = 12
export const SONAR_RING = 8

export const THROW_RANGE = 10
export const FLARE_FLIGHT = 0.6
export const FLARE_LIFE = 8
export const FLARE_RADIUS = 9
export const FLARE_POWER = 1.3
export const DECOY_FLIGHT = 0.5
export const DECOY_PINGS = 3
export const EMP_RADIUS = 9
export const EMP_SECONDS = 12
export const MINE_ARM = 1.5
export const MINE_RADIUS = 3
export const MINE_TRIGGERS = 3
export const MINE_RING = 20
export const MINE_EXPOSE = 1.5

export const USE_REACH = 1.3
export const BOLT_REACH = 0.8
export const HIT_RADIUS = 0.38
export const LAMP_HIT_RADIUS = 0.35
export const GLASS_RING = 26
export const LAMP_RING = 22
export const DOOR_RING = { quiet: 4, loud: 12 } as const
export const BREAKER_RING = 20
export const DEATH_RING = 10

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
  /** Ripple radius of the shot; 0 is silent. */
  noise: number
  reloadNoise: number
  /** Seconds the shooter stays visible after firing (muzzle flash). */
  expose: number
  pellets: number
  spread: number
  /** Bolts stay where they land and can be picked up again. */
  bolts: boolean
  unlock: number
}

export const WEAPONS: Record<Weapon, WeaponSpec> = {
  pistol: { label: "Suppressed pistol", mag: 6, reserve: 12, windup: 0.25, cooldown: 0.5, reload: 1.6, range: 28, noise: 14, reloadNoise: 9, expose: 0.6, pellets: 1, spread: 0, bolts: false, unlock: 1 },
  shotgun: { label: "Shotgun", mag: 2, reserve: 6, windup: 0.45, cooldown: 1, reload: 2, range: 9, noise: 36, reloadNoise: 14, expose: 1.4, pellets: 7, spread: 0.16, bolts: false, unlock: 2 },
  crossbow: { label: "Crossbow", mag: 1, reserve: 4, windup: 0.7, cooldown: 0.3, reload: 1.8, range: 34, noise: 0, reloadNoise: 0, expose: 0, pellets: 1, spread: 0, bolts: true, unlock: 3 },
}

export type GadgetSpec = { label: string; short: string; count: number; unlock: number; blurb: string }
export const GADGETS: Record<Gadget, GadgetSpec> = {
  flare: { label: "Flare", short: "FLARE", count: 2, unlock: 1, blurb: "Lights an area for 8 s." },
  decoy: { label: "Noise decoy", short: "DECOY", count: 2, unlock: 1, blurb: "Three fake gunshots." },
  emp: { label: "Light-breaker EMP", short: "EMP", count: 1, unlock: 4, blurb: "Kills nearby lights for 12 s." },
  mine: { label: "Motion mine", short: "MINE", count: 2, unlock: 5, blurb: "Rings out when an enemy walks by." },
}

export const WEAPON_IDS = Object.keys(WEAPONS) as Weapon[]
export const GADGET_IDS = Object.keys(GADGETS) as Gadget[]
export const MODES: readonly Mode[] = ["tdm", "ffa"]
export const MAP_IDS = ["office", "warehouse"] as const
export type MapId = (typeof MAP_IDS)[number]

/** Cosmetic heads, unlocked by level. Index is sent in the loadout. */
export const LOOKS = [
  { label: "Bare", unlock: 1 },
  { label: "Hood", unlock: 2 },
  { label: "Cap", unlock: 3 },
  { label: "Balaclava", unlock: 5 },
  { label: "Visor", unlock: 7 },
] as const
