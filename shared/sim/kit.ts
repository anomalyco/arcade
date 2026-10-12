import { type Equip, GUNS, type Gun, SPEED, SPRINT_SPEED } from "../config"

/**
 * What a player fights with this life, set by the mode (Mode.loadout) at spawn and whenever the mode re-arms them
 * (gun game promotions, turning infected). The World and client prediction both read only this, so the server's rules
 * and your own predicted shots, swings and steps agree.
 */
export type Kit = {
  /** Changes whenever the kit does, so client prediction knows to swap. */
  id: string
  /** For the HUD: what you're holding. */
  label: string
  /** The gun, or null for bare hands, where the trigger swings a melee attack. */
  gun: Gun | null
  /** Rounds in a full magazine, and on spawn. */
  mag: number
  /** False: no reloading; only the mode refills the magazine (one in the chamber). */
  reload: boolean
  auto: boolean
  /** Seconds between shots. */
  cooldown: number
  /** Damage per bullet or pellet. */
  damage: number
  /** V swings a one-hit melee attack (bare hands always can, with the trigger too). */
  melee: boolean
  equip: Equip | null
  equipCount: number
  /** Walk and sprint speeds, m/s. */
  walk: number
  run: number
  /** Health comes back out of combat. */
  regen: boolean
}

/** The usual loadout: the gun and equipment you picked. */
export function gunKit(gun: Gun, equip: Equip | null = null, over: Partial<Kit> = {}): Kit {
  const g = GUNS[gun]
  return { id: gun, label: g.label.toUpperCase(), gun, mag: g.mag, reload: true, auto: g.auto, cooldown: g.cooldown, damage: g.damage, melee: false, equip, equipCount: equip ? 1 : 0, walk: SPEED, run: SPRINT_SPEED, regen: true, ...over }
}

/** Bare hands: no gun, the trigger swings. */
export function bareKit(over: Partial<Kit> = {}): Kit {
  return { id: "bare", label: "MELEE", gun: null, mag: 0, reload: false, auto: false, cooldown: 0, damage: 0, melee: true, equip: null, equipCount: 0, walk: SPEED, run: SPRINT_SPEED, regen: true, ...over }
}

/** Sprinting needs Shift and movement; with a gun, pulling the trigger cancels it (bare hands swing on the run). */
export const kitSprints = (i: { mx: number; my: number; fire: boolean; sprint: boolean }, kit: Kit): boolean => i.sprint && (!i.fire || !kit.gun) && Math.hypot(i.mx, i.my) > 0.1
