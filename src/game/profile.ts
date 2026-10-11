import { VEHICLES, type Role, type Vehicle } from "../../shared/config"

const KEY = "getaway.profile"

export type Profile = {
  xp: number
  stats: { rounds: number; escapes: number; busts: number; bestDrift: number; nearMisses: number }
}

export type RoundOutcome = {
  role: Role
  /** The robber escaped. */
  escaped: boolean
  /** This player's car contributed to the bust. */
  madeBust: boolean
  drift: number
  nearMisses: number
  loot: number
  /** Seconds survived in the chase (robber) or spent in pursuit (cop). */
  chaseSeconds: number
}

export type XpLine = { label: string; xp: number }

export type XpAward = {
  lines: XpLine[]
  total: number
  before: LevelInfo
  after: LevelInfo
  unlocked: Vehicle[]
}

export type LevelInfo = { level: number; into: number; need: number; xp: number }

const EMPTY: Profile = { xp: 0, stats: { rounds: 0, escapes: 0, busts: 0, bestDrift: 0, nearMisses: 0 } }

/** XP needed to go from `level` to `level + 1`: 1000, 1250, 1500, ... */
export const xpForLevel = (level: number) => 1000 + (level - 1) * 250

export function levelOf(xp: number): LevelInfo {
  let level = 1
  let left = Math.max(0, Math.floor(xp))
  while (left >= xpForLevel(level)) {
    left -= xpForLevel(level)
    level++
  }
  return { level, into: left, need: xpForLevel(level), xp }
}

/** Vehicle tier unlocked at a level: tier 0 at 1, tier 1 at 2, tier 2 at 4. */
export const tierUnlocked = (level: number) => (level >= 4 ? 2 : level >= 2 ? 1 : 0)
export const levelForTier = (tier: number) => (tier >= 2 ? 4 : tier === 1 ? 2 : 1)
export const isUnlocked = (v: Vehicle, level: number) => v.tier <= tierUnlocked(level)

export function loadProfile(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Profile> | null
    if (!raw || typeof raw.xp !== "number") return structuredClone(EMPTY)
    return { xp: raw.xp, stats: { ...EMPTY.stats, ...raw.stats } }
  } catch {
    return structuredClone(EMPTY)
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {}
}

export function xpLines(o: RoundOutcome): XpLine[] {
  const lines: XpLine[] = []
  if (o.role === "robber") {
    if (o.escaped) {
      lines.push({ label: "Clean getaway", xp: 500 })
      lines.push({ label: "Take", xp: Math.round(o.loot / 2000) })
    } else lines.push({ label: "Time on the run", xp: Math.min(300, Math.round(o.chaseSeconds * 2)) })
  } else {
    lines.push({ label: "Pursuit", xp: Math.min(200, 50 + Math.round(o.chaseSeconds)) })
    if (!o.escaped) lines.push({ label: "Suspect stopped", xp: 250 })
    if (o.madeBust) lines.push({ label: "Bust credit", xp: 400 })
  }
  if (o.drift > 0) lines.push({ label: "Drift", xp: Math.min(400, Math.round(o.drift / 25)) })
  if (o.nearMisses > 0) lines.push({ label: `Near misses ×${o.nearMisses}`, xp: o.nearMisses * 50 })
  return lines.filter((l) => l.xp > 0)
}

/** Applies one round to the stored profile and returns what changed. */
export function awardRound(o: RoundOutcome): XpAward {
  const p = loadProfile()
  const before = levelOf(p.xp)
  const lines = xpLines(o)
  const total = lines.reduce((s, l) => s + l.xp, 0)
  p.xp += total
  p.stats.rounds++
  if (o.role === "robber" && o.escaped) p.stats.escapes++
  if (o.madeBust) p.stats.busts++
  p.stats.bestDrift = Math.max(p.stats.bestDrift, Math.round(o.drift))
  p.stats.nearMisses += o.nearMisses
  saveProfile(p)
  const after = levelOf(p.xp)
  const unlocked = VEHICLES.filter((v) => !isUnlocked(v, before.level) && isUnlocked(v, after.level))
  return { lines, total, before, after, unlocked }
}
