import type { Profile } from "./contracts"
import type { ClassId } from "../sim/protocol"
import { CLASSES } from "../sim/classes"

const KEY = "salvo.profile.v1"
const MAX_LEVEL = 50

export interface Cosmetic {
  id: string
  name: string
  kind: "chevron"
  unlock: number
  desc: string
}

export const COSMETICS: Cosmetic[] = [
  { id: "standard", name: "Standard", kind: "chevron", unlock: 1, desc: "Solid chevron in team color." },
  { id: "pulse", name: "Pulse", kind: "chevron", unlock: 3, desc: "Chevron breathes while you aim." },
  { id: "split", name: "Split", kind: "chevron", unlock: 5, desc: "Twin offset chevrons." },
  { id: "halo", name: "Halo", kind: "chevron", unlock: 7, desc: "A thin ring above your unit." },
]

const CLASS_IDS = Object.keys(CLASSES) as ClassId[]

export function defaultProfile(): Profile {
  return { name: "", xp: 0, level: 1, cls: "crawler", cosmetic: "standard", matches: 0, wins: 0, kills: 0 }
}

// Total XP required to reach `level`. Level 1 is free; the first steps take about one
// match each, later ones stretch out.
export function xpForLevel(level: number): number {
  let total = 0
  for (let n = 1; n < Math.min(level, MAX_LEVEL); n++) total += Math.round((250 * Math.pow(n, 1.35)) / 50) * 50
  return total
}

export function levelForXp(xp: number): number {
  let level = 1
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++
  return level
}

// Progress through the current level, 0..1.
export function levelProgress(xp: number): { level: number; into: number; need: number; frac: number } {
  const level = levelForXp(xp)
  const base = xpForLevel(level)
  const need = level >= MAX_LEVEL ? 1 : xpForLevel(level + 1) - base
  const into = level >= MAX_LEVEL ? 1 : xp - base
  return { level, into, need, frac: Math.max(0, Math.min(1, into / need)) }
}

export function unlockedClasses(level: number): ClassId[] {
  return CLASS_IDS.filter((id) => CLASSES[id].unlock <= level)
}

export function unlockedCosmetics(level: number): Cosmetic[] {
  return COSMETICS.filter((c) => c.unlock <= level)
}

// Everything that unlocks when moving from `from` (exclusive) to `to` (inclusive).
export function unlocksBetween(from: number, to: number): { classes: ClassId[]; cosmetics: Cosmetic[] } {
  return {
    classes: CLASS_IDS.filter((id) => CLASSES[id].unlock > from && CLASSES[id].unlock <= to),
    cosmetics: COSMETICS.filter((c) => c.unlock > from && c.unlock <= to),
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

export function loadProfile(): Profile {
  const base = defaultProfile()
  let raw: unknown = null
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null")
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== "object") return base
  const r = raw as Record<string, unknown>
  const xp = Math.max(0, num(r.xp, 0))
  const level = levelForXp(xp)
  const cls = typeof r.cls === "string" && CLASS_IDS.includes(r.cls as ClassId) && CLASSES[r.cls as ClassId].unlock <= level ? (r.cls as ClassId) : base.cls
  const cosmetic = COSMETICS.find((c) => c.id === r.cosmetic && c.unlock <= level)?.id ?? base.cosmetic
  return {
    name: typeof r.name === "string" ? r.name.slice(0, 16) : "",
    xp,
    level,
    cls,
    cosmetic,
    matches: num(r.matches, 0),
    wins: num(r.wins, 0),
    kills: num(r.kills, 0),
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage full or disabled; the profile simply won't persist
  }
}

export function matchXp(stats: { damage: number; kills: number; wins: number; battles: number; won: boolean }): number {
  const raw = 120 + stats.damage * 0.6 + stats.kills * 45 + stats.wins * 70 + stats.battles * 15 + (stats.won ? 160 : 0)
  return Math.max(50, Math.round(raw / 5) * 5)
}

export function awardMatch(
  profile: Profile,
  stats: { damage: number; kills: number; wins: number; battles: number; won: boolean },
): { profile: Profile; gained: number; leveledTo: number | null } {
  const gained = matchXp(stats)
  const xp = profile.xp + gained
  const level = levelForXp(xp)
  return {
    profile: {
      ...profile,
      xp,
      level,
      matches: profile.matches + 1,
      wins: profile.wins + (stats.won ? 1 : 0),
      kills: profile.kills + stats.kills,
    },
    gained,
    leveledTo: level > profile.level ? level : null,
  }
}
