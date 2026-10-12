export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 20

export const MAX_PLAYERS = 12

/** GPU sizing for the renderer. */
/** Lights shaded per frame (the culled set near the view), occluders across their shadow casts, and lights per map. */
export const MAX_LIGHTS = 64
export const MAX_OCCLUDERS = 16384
export const MAX_MAP_LIGHTS = 2048
export const POLAR_RAYS = 1024

export const PLAYER_RADIUS = 0.32
export const SPEED = 4.2
/** Holding Shift while moving: faster, but the gun is down. Firing cancels it and the first shot waits SPRINT_TO_FIRE. */
export const SPRINT_SPEED = 6.3
export const SPRINT_TO_FIRE = 0.18
export const ACCEL = 22

export const HIT_RADIUS = 0.38
export const HEALTH = 100

export type Gun = "rifle" | "shotgun" | "sniper"

export type GunSpec = {
  label: string
  blurb: string
  /** Seconds between shots; the rifle fires while the trigger is held. */
  cooldown: number
  auto: boolean
  damage: number
  pellets: number
  /** Half-angle of the pellet spread or random inaccuracy, radians. */
  spread: number
  mag: number
  reload: number
  range: number
  /** How hard the gun kicks, for the client's recoil and camera shake. */
  kick: number
}

export const GUNS: Record<Gun, GunSpec> = {
  rifle: { label: "Rifle", blurb: "Full auto. Four hits.", cooldown: 0.095, auto: true, damage: 25, pellets: 1, spread: 0.02, mag: 30, reload: 1.9, range: 30, kick: 0.35 },
  shotgun: { label: "Shotgun", blurb: "One pump up close.", cooldown: 0.8, auto: false, damage: 20, pellets: 8, spread: 0.14, mag: 6, reload: 2.4, range: 11, kick: 1 },
  sniper: { label: "Sniper", blurb: "One shot, one kill.", cooldown: 1.2, auto: false, damage: 100, pellets: 1, spread: 0, mag: 5, reload: 2.6, range: 45, kick: 1.3 },
}
export const GUN_IDS = Object.keys(GUNS) as Gun[]
/** Health comes back after this long without taking damage. */
export const REGEN_DELAY = 4
export const REGEN_RATE = 40

export const RESPAWN_SECONDS = 3
export const MATCH_SECONDS = 300
export const END_SECONDS = 12
