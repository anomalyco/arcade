// What one simulated match measured (`MatchResult`, filled by match.ts from the room's events) and the aggregate over
// many (`summarize`): means with 95% confidence intervals across matches, pooled rates with Wilson intervals.

/** Where a carrier's damage came from. */
export const SHIP_SOURCES = ["bomb", "bomb-near", "missile", "jet-gun", "boat-cannon", "ciws", "sam", "5in", "ram", "crash"] as const
export type ShipSource = (typeof SHIP_SOURCES)[number]

/** What killed a jet or boat ("crash": flew into something with nobody to credit). */
export const KILL_WEAPONS = ["gun", "missile", "bomb", "ciws", "sam", "shell", "cannon", "crash"] as const
export type KillKey = (typeof KILL_WEAPONS)[number]

/** Who flies or drives what. */
export const UNIT_TYPES = ["hornet", "f35", "boat"] as const
export type UnitType = (typeof UNIT_TYPES)[number]

/** Killers (a unit type, or a ship's gun mount). */
export const KILLER_TYPES = ["hornet", "f35", "boat", "ciws", "sam", "gun"] as const
export type KillerType = (typeof KILLER_TYPES)[number]

export type Counts<K extends string> = Record<K, number>
export const counts = <K extends string>(keys: readonly K[]): Counts<K> => Object.fromEntries(keys.map((k) => [k, 0])) as Counts<K>

export type SinkRecord = { team: number; t: number; life: number; by: ShipSource | "none" }

export type MatchResult = {
  seed: number
  variant: string
  /** Reached the target before the time cap. */
  ended: boolean
  /** Winning team, -1 none (cap reached or a draw). */
  winner: number
  /** Seconds to the end, or the cap. */
  length: number
  teams: number
  scores: number[]
  /** Scores per team every `timelineStep` seconds from the start. */
  timeline: number[][]
  /** Seconds each team scored (held a zone alone), had its carrier in a zone, and zone-seconds contested (2+ inside). */
  zoneHold: number[]
  zonePresent: number[]
  contested: number
  captures: number[]
  neutralized: number
  /** Carrier damage taken, by source, and per team. */
  shipDamage: Counts<ShipSource>
  damageTaken: number[]
  damageDealt: number[]
  sinks: SinkRecord[]
  /** Jets and boats destroyed, by weapon; deaths by unit type; killer type → victim type. */
  kills: Counts<KillKey>
  deaths: Counts<UnitType>
  killMatrix: Record<KillerType, Counts<UnitType>>
  teamKills: number[]
  teamDeaths: number[]
  missiles: { fired: number; locked: number; hitJet: number; hitShip: number; decoyed: number; intercepted: number }
  sams: { fired: number; hit: number; decoyed: number; intercepted: number }
  shells: { fired: number; hitJet: number; hitShip: number }
  bombs: { released: number; direct: number; near: number; intercepted: number }
  flares: number
  /** Parked jets destroyed, by weapon. */
  deckKills: Record<string, number>
  /** Sorties, landings and losses per operation (hornet, f35, boat). */
  sorties: Counts<UnitType>
  landings: Counts<UnitType>
  losses: Counts<UnitType>
  /** Seconds out per finished sortie (catapult or crane to landing, recovery or loss), summed per type. */
  sortieTime: Counts<UnitType>
  boats: { launched: number; sunk: number; recovered: number; kills: number }
  intercepts: number
  /** Simulated seconds per wall second (not part of the deterministic result). */
  speed?: number
}

export const TIMELINE_STEP = 30

// ---- statistics ---------------------------------------------------------------------------------------------------

/** Two-sided 95% Student t quantiles for 1..30 degrees of freedom (1.96 beyond). */
const T95 = [12.71, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042]

export type Stat = { n: number; mean: number; sd: number; ci: number; min: number; max: number; median: number }

/** Mean, standard deviation, 95% half-interval of the mean, range and median. */
export function stat(xs: readonly number[]): Stat {
  const n = xs.length
  if (!n) return { n: 0, mean: NaN, sd: NaN, ci: NaN, min: NaN, max: NaN, median: NaN }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const t = n > 1 ? (T95[n - 2] ?? 1.96) : NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
  return { n, mean, sd, ci: n > 1 ? (t * sd) / Math.sqrt(n) : NaN, min: sorted[0]!, max: sorted[n - 1]!, median }
}

export type Rate = { k: number; n: number; p: number; lo: number; hi: number }

/** A pooled rate k / n with its 95% Wilson interval. */
export function rate(k: number, n: number): Rate {
  if (n <= 0) return { k, n, p: NaN, lo: NaN, hi: NaN }
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return { k, n, p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) }
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const quantile = (sorted: readonly number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN)

export type Summary = {
  variant: string
  matches: number
  teams: number
  ended: Rate
  length: Stat
  /** Win rate per team (of all matches; unfinished ones count for nobody). */
  wins: Rate[]
  scoreTimeline: { t: number[]; mean: number[][] }
  zoneHold: Stat[]
  zonePresent: Stat[]
  contested: Stat
  captures: Stat
  shipDamage: Record<ShipSource, Stat>
  shipDamageShare: Record<ShipSource, number>
  sinksPerMatch: Stat
  /** Seconds from commissioning to sinking, over every sunk carrier. */
  timeToSink: { n: number; mean: number; median: number; p10: number; p90: number; histogram: number[] }
  sinkCause: Record<string, number>
  firstSink: Stat
  kills: Record<KillKey, Stat>
  deaths: Record<UnitType, Stat>
  killMatrix: Record<KillerType, Counts<UnitType>>
  missileHit: Rate
  missileDecoy: Rate
  missileIntercepted: Rate
  samHit: Rate
  samDecoy: Rate
  shellHit: Rate
  bombDirect: Rate
  bombNear: Rate
  bombIntercepted: Rate
  deckKills: Record<string, Stat>
  sorties: Record<UnitType, Stat>
  landings: Record<UnitType, Stat>
  losses: Record<UnitType, Stat>
  /** Losses per sortie, and mean seconds out per finished sortie. */
  attrition: Record<UnitType, Rate>
  sortieLength: Record<UnitType, number>
  boats: { launched: Stat; sunk: Stat; recovered: Stat; kills: Stat }
  intercepts: Stat
  speed: Stat
}

/** One minute per histogram bucket, up to this many. */
const SINK_BUCKETS = 40

export function summarize(variant: string, rs: readonly MatchResult[]): Summary {
  const teams = Math.max(0, ...rs.map((r) => r.teams))
  const per = <T>(f: (r: MatchResult) => T) => rs.map(f)
  const byKey = <K extends string>(keys: readonly K[], f: (r: MatchResult) => Counts<K>): Record<K, Stat> =>
    Object.fromEntries(keys.map((k) => [k, stat(per((r) => f(r)[k]))])) as Record<K, Stat>
  const steps = Math.max(0, ...rs.map((r) => r.timeline.length))
  const scoreTimeline = { t: Array.from({ length: steps }, (_, i) => i * TIMELINE_STEP), mean: Array.from({ length: teams }, (_, team) => Array.from({ length: steps }, (_, i) => stat(rs.map((r) => r.timeline[Math.min(i, r.timeline.length - 1)]?.[team] ?? 0)).mean)) }
  const totalDamage = sum(rs.map((r) => sum(Object.values(r.shipDamage))))
  const sinks = rs.flatMap((r) => r.sinks)
  const lives = sinks.map((s) => s.life).sort((a, b) => a - b)
  const histogram = Array.from({ length: SINK_BUCKETS }, () => 0)
  for (const l of lives) histogram[Math.min(SINK_BUCKETS - 1, Math.floor(l / 60))]!++
  const sinkCause: Record<string, number> = {}
  for (const s of sinks) sinkCause[s.by] = (sinkCause[s.by] ?? 0) + 1
  const killMatrix = Object.fromEntries(KILLER_TYPES.map((k) => [k, counts(UNIT_TYPES)])) as Record<KillerType, Counts<UnitType>>
  for (const r of rs) for (const k of KILLER_TYPES) for (const v of UNIT_TYPES) killMatrix[k][v] += r.killMatrix[k][v]
  const deckKeys = [...new Set(rs.flatMap((r) => Object.keys(r.deckKills)))].sort()
  const m = (f: (r: MatchResult) => number) => sum(rs.map(f))
  return {
    variant,
    matches: rs.length,
    teams,
    ended: rate(rs.filter((r) => r.ended).length, rs.length),
    length: stat(rs.filter((r) => r.ended).map((r) => r.length)),
    wins: Array.from({ length: teams }, (_, t) => rate(rs.filter((r) => r.winner === t).length, rs.length)),
    scoreTimeline,
    zoneHold: Array.from({ length: teams }, (_, t) => stat(per((r) => r.zoneHold[t] ?? 0))),
    zonePresent: Array.from({ length: teams }, (_, t) => stat(per((r) => r.zonePresent[t] ?? 0))),
    contested: stat(per((r) => r.contested)),
    captures: stat(per((r) => sum(r.captures))),
    shipDamage: byKey(SHIP_SOURCES, (r) => r.shipDamage),
    shipDamageShare: Object.fromEntries(SHIP_SOURCES.map((k) => [k, totalDamage > 0 ? m((r) => r.shipDamage[k]) / totalDamage : 0])) as Record<ShipSource, number>,
    sinksPerMatch: stat(per((r) => r.sinks.length)),
    timeToSink: { n: lives.length, mean: lives.length ? sum(lives) / lives.length : NaN, median: quantile(lives, 0.5), p10: quantile(lives, 0.1), p90: quantile(lives, 0.9), histogram },
    sinkCause,
    firstSink: stat(rs.filter((r) => r.sinks.length).map((r) => Math.min(...r.sinks.map((s) => s.t)))),
    kills: byKey(KILL_WEAPONS, (r) => r.kills),
    deaths: byKey(UNIT_TYPES, (r) => r.deaths),
    killMatrix,
    missileHit: rate(m((r) => r.missiles.hitJet + r.missiles.hitShip), m((r) => r.missiles.fired)),
    missileDecoy: rate(m((r) => r.missiles.decoyed), m((r) => r.missiles.locked)),
    missileIntercepted: rate(m((r) => r.missiles.intercepted), m((r) => r.missiles.fired)),
    samHit: rate(m((r) => r.sams.hit), m((r) => r.sams.fired)),
    samDecoy: rate(m((r) => r.sams.decoyed), m((r) => r.sams.fired)),
    shellHit: rate(m((r) => r.shells.hitJet + r.shells.hitShip), m((r) => r.shells.fired)),
    bombDirect: rate(m((r) => r.bombs.direct), m((r) => r.bombs.released)),
    bombNear: rate(m((r) => r.bombs.near), m((r) => r.bombs.released)),
    bombIntercepted: rate(m((r) => r.bombs.intercepted), m((r) => r.bombs.released)),
    deckKills: Object.fromEntries(deckKeys.map((k) => [k, stat(per((r) => r.deckKills[k] ?? 0))])),
    sorties: byKey(UNIT_TYPES, (r) => r.sorties),
    landings: byKey(UNIT_TYPES, (r) => r.landings),
    losses: byKey(UNIT_TYPES, (r) => r.losses),
    attrition: Object.fromEntries(UNIT_TYPES.map((u) => [u, rate(m((r) => r.losses[u]), m((r) => r.sorties[u]))])) as Record<UnitType, Rate>,
    sortieLength: Object.fromEntries(UNIT_TYPES.map((u) => [u, m((r) => r.sortieTime[u]) / Math.max(1, m((r) => r.landings[u] + r.losses[u]))])) as Record<UnitType, number>,
    boats: { launched: stat(per((r) => r.boats.launched)), sunk: stat(per((r) => r.boats.sunk)), recovered: stat(per((r) => r.boats.recovered)), kills: stat(per((r) => r.boats.kills)) },
    intercepts: stat(per((r) => r.intercepts)),
    speed: stat(rs.flatMap((r) => (r.speed === undefined ? [] : [r.speed]))),
  }
}

// ---- degenerate outcomes ------------------------------------------------------------------------------------------

export type AssertLimits = {
  /** Most matches allowed to hit the time cap (share). */
  unfinished: number
  /** Most any team may win (share), checked from `minMatches` matches. */
  dominant: number
  minMatches: number
  /** Carriers that sink must last at least this long on average (s). */
  minSinkLife: number
}

export const ASSERT_DEFAULTS: AssertLimits = { unfinished: 0.1, dominant: 0.9, minMatches: 10, minSinkLife: 300 }

/** The degenerate outcomes in a summary (empty: none). */
export function degenerate(s: Summary, lim: AssertLimits = ASSERT_DEFAULTS): string[] {
  const out: string[] = []
  if (s.ended.n && 1 - s.ended.p > lim.unfinished) out.push(`${Math.round((1 - s.ended.p) * 100)}% of matches never reached the target within the time cap (limit ${Math.round(lim.unfinished * 100)}%)`)
  if (s.matches >= lim.minMatches) s.wins.forEach((w, t) => w.p > lim.dominant && out.push(`team ${t} won ${Math.round(w.p * 100)}% of matches (limit ${Math.round(lim.dominant * 100)}%)`))
  if (s.timeToSink.n && s.timeToSink.mean < lim.minSinkLife) out.push(`carriers that sank lasted ${(s.timeToSink.mean / 60).toFixed(1)} min on average (limit ${(lim.minSinkLife / 60).toFixed(1)} min)`)
  if (s.matches && s.contested.mean === 0) out.push("no zone was ever contested")
  if (s.matches && s.captures.mean === 0) out.push("no zone was ever captured")
  return out
}
