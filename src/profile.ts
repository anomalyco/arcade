import { GADGETS, LOOKS, WEAPONS, type Gadget, type Weapon } from "../shared/config"
import type { Award, Loadout, Stats } from "../shared/sim/world"

export type Profile = {
  name: string
  xp: number
  matches: number
  wins: number
  kills: number
  deaths: number
  shots: number
  lampsOut: number
  lastLoadout: Loadout
}

const KEY = "blackout.profile"

const DEFAULT: Profile = {
  name: "",
  xp: 0,
  matches: 0,
  wins: 0,
  kills: 0,
  deaths: 0,
  shots: 0,
  lampsOut: 0,
  lastLoadout: { weapon: "pistol", gadgets: ["flare", "decoy"], look: 0 },
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT }
    const v = JSON.parse(raw) as Partial<Profile>
    return { ...DEFAULT, ...v, lastLoadout: { ...DEFAULT.lastLoadout, ...v.lastLoadout } }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {}
}

/** Level n starts at 120·(n−1)² XP. */
export function levelOf(xp: number): { level: number; into: number; span: number } {
  let level = 1
  while (120 * level * level <= xp) level++
  const floor = 120 * (level - 1) * (level - 1)
  const next = 120 * level * level
  return { level, into: xp - floor, span: next - floor }
}

export const weaponUnlocked = (level: number, w: Weapon) => level >= WEAPONS[w].unlock
export const gadgetUnlocked = (level: number, g: Gadget) => level >= GADGETS[g].unlock
export const lookUnlocked = (level: number, look: number) => level >= (LOOKS[look]?.unlock ?? 99)

/** Adds a finished match to the profile: participation, kills, round wins and awards. Returns XP gained and whether the level rose. */
export function recordMatch(p: Profile, me: { id: string; stats: Stats; won: boolean; roundWins: number }, awards: Award[]): { gained: number; levelUp: boolean; level: number } {
  const before = levelOf(p.xp).level
  const mine = awards.filter((a) => a.id === me.id).length
  const gained = 60 + me.stats.kills * 40 + me.roundWins * 50 + (me.won ? 80 : 0) + mine * 20
  p.xp += gained
  p.matches++
  if (me.won) p.wins++
  p.kills += me.stats.kills
  p.deaths += me.stats.deaths
  p.shots += me.stats.shots
  p.lampsOut += me.stats.lampsOut
  saveProfile(p)
  const level = levelOf(p.xp).level
  return { gained, levelUp: level > before, level }
}
