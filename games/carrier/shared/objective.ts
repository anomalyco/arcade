// The objective: claim zones on the sea. Pure and deterministic (no DOM, no Worker APIs): the room (server/core.ts)
// runs the one authoritative `Objective` and broadcasts it (`packObjective`); offline the client runs its own.
//
// The rules:
// - Zones are big circles of open water (`radius`, 650 m: a 330 m carrier fits with room to manoeuvre), clear of
//   islands and well away from every spawn. Each drifts slowly on a gently curving path (`drift` m/s, turning
//   `turn` °/s), so the holder keeps sailing to stay in it.
// - Every `cycle` seconds the zones relocate; a round's first zones last `opening` seconds instead, since every carrier
//   sails in from the 4.8 km spawn ring first. `warning` seconds before a relocation the next spots appear (the HUD
//   counts down and the sea shows them as ghost rings) so ships can start sailing. A round's first zones sit near the
//   middle, the same distance from every spawn; later ones go anywhere in the open-water play area, 1.3-2.8 km from
//   their predecessor (reachable at full speed within the warning plus about a minute).
// - How many: fewer than `twoZonesAt` (4) active carriers → one zone, that many or more → two. Decided at the round's
//   start and each time the next spots are revealed. Active = crewed (anyone aboard, bots included) and not sinking;
//   only active carriers capture, contest or score.
// - Capture: a carrier whose hull centre is inside a zone with no other carrier inside fills it for its side over
//   `capture` seconds; a zone held by someone else drains to neutral first. Two or more carriers inside: contested,
//   progress frozen. A zone nobody is in falls back to its holder (or to neutral) slowly. A zone stays its holder's
//   after they leave, but only scores while they are inside it alone: `rate` points per second per zone.
// - A round ends when a side reaches `target` points or after `roundTime` seconds (the highest score wins; a tie is a
//   draw), shows the result for `intermission` seconds, then a new round starts with the scores reset.
//
// Every time is sea time (seconds). Zone placement is a pure function of (world seed, round, cycle, zone, the previous
// zones), so tests can replay it; the room still sends the zones, since the zone count depends on who is aboard.

import { CREW } from "./crew"
import { type Archipelago, terrainHeight } from "./islands"
import { hash3 } from "./rng"
import { fleetSpawn } from "./spawn"

/** Every tunable of the objective (shared/objective.ts header). Units: metres, seconds, points. */
export type ObjectiveRules = {
  /** Zone radius (m). */
  radius: number
  /** Seconds between relocations. */
  cycle: number
  /** A round's first zones last this long instead (s): every carrier sails in from the spawn ring first. */
  opening: number
  /** The next zones appear this long before a relocation (s). */
  warning: number
  /** Zone drift speed (m/s). */
  drift: number
  /** How fast a zone's drift path turns (°/s). */
  turn: number
  /** Seconds to capture an uncontested zone from neutral (draining a held one takes as long again). */
  capture: number
  /** Points per second for each zone a side holds while it is inside alone. */
  rate: number
  /** Points that win the round. */
  target: number
  /** Round time limit (s). */
  roundTime: number
  /** The result shows this long before the next round (s). */
  intermission: number
  /** Active carriers that make two zones (fewer: one). */
  twoZonesAt: number
}

export const OBJECTIVE_DEFAULTS: Readonly<ObjectiveRules> = {
  radius: 650,
  cycle: 150,
  opening: 240,
  warning: 30,
  drift: 3,
  turn: 0.4,
  capture: 10,
  rate: 2,
  target: 500,
  roundTime: 900,
  intermission: 15,
  twoZonesAt: 4,
}

/** Clamps for the rules (a room takes rules from a dev client only within these). */
export const OBJECTIVE_RANGES: Readonly<Record<keyof ObjectiveRules, readonly [min: number, max: number]>> = {
  radius: [250, 1200],
  cycle: [45, 600],
  opening: [45, 900],
  warning: [5, 90],
  drift: [0, 12],
  turn: [0, 3],
  capture: [2, 60],
  rate: [0.5, 20],
  target: [50, 5000],
  roundTime: [120, 3600],
  intermission: [5, 60],
  twoZonesAt: [2, 5],
}

const RULE_KEYS = Object.keys(OBJECTIVE_DEFAULTS) as (keyof ObjectiveRules)[]

/** Rules from untrusted numbers (a dev client's `objective` message): every key clamped, missing ones defaulted. */
export function rulesOf(v: readonly number[]): ObjectiveRules {
  const out = { ...OBJECTIVE_DEFAULTS }
  RULE_KEYS.forEach((k, i) => {
    const x = v[i]
    if (typeof x !== "number" || !Number.isFinite(x)) return
    const [lo, hi] = OBJECTIVE_RANGES[k]
    out[k] = Math.max(lo, Math.min(hi, x))
  })
  out.warning = Math.min(out.warning, out.cycle - 5, out.opening - 5)
  return out
}

export const packRules = (r: ObjectiveRules): number[] => RULE_KEYS.map((k) => r[k])

/** Placement limits (not tunables: they keep zones fair and in play). */
export const ZONE_AREA = {
  /** A round's first zone: centre within this of the origin (equally far from every spawn); 900 m more for two. */
  firstReach: 1000,
  /** Later zones: centre (and the whole drift path) within this of the origin. */
  reach: 3300,
  /** Zone edge at least this far from every spawn point (m). */
  spawnGap: 1400,
  /** A relocated zone's centre moves at least this far (m)... */
  hop: 1300,
  /** ...and at most this far, so a ship sailing when the next spot appears gets there with time to hold it. */
  maxHop: 2800,
  /** Two zones at once: edges at least this far apart (m). */
  gap: 700,
  /** Water deeper than this (m below sea level) counts as open: a carrier draws ~11 m. */
  depth: -14,
  /** Candidate spots tried per zone. */
  tries: 160,
} as const

/** One zone: where its drift starts and how it moves, plus its capture state. */
export type Zone = {
  /** 0 = A, 1 = B. */
  id: number
  /** Centre at `t0` (m). */
  x: number
  z: number
  /** Drift: compass heading at `t0` (rad; 0 = north, -z), speed (m/s), turn rate (rad/s, signed). Still before t0. */
  heading: number
  speed: number
  turn: number
  t0: number
  r: number
  /** The side that captured it, -1 neutral. */
  holder: number
  /** The side `progress` belongs to (the holder's, or the side capturing it), -1 none. */
  cap: number
  /** 0..1. */
  progress: number
  /** Bit per team: active carriers inside it now. */
  present: number
}

export type ObjectiveState = {
  round: number
  /** Sea time the round started. */
  start: number
  /** Sea time it ended, -1 while it runs. */
  end: number
  /** The winning side once ended, -1 for a draw. */
  winner: number
  cycle: number
  /** Sea time the current zones took over, and when they next relocate. */
  cycleAt: number
  moveAt: number
  zones: Zone[]
  /** The next zones, once revealed (`warning` s before `moveAt`); empty before. */
  next: Zone[]
  /** Points per team (CREW.ships). */
  scores: number[]
  rules: ObjectiveRules
}

/** A carrier as the objective sees it: its side, its hull centre, and whether it counts (crewed, not sinking). */
export type ObjectiveShip = { team: number; x: number; z: number; active: boolean }

/** Zones for this many active carriers. */
export const zoneCount = (active: number, rules: ObjectiveRules = OBJECTIVE_DEFAULTS): number => (active >= rules.twoZonesAt ? 2 : 1)

/** A zone's centre at sea time t (still before its t0). */
export function zoneCentre(z: Pick<Zone, "x" | "z" | "heading" | "speed" | "turn" | "t0">, t: number, out: [number, number] = [0, 0]): [number, number] {
  const tau = Math.max(0, t - z.t0)
  const h = z.heading
  if (Math.abs(z.turn) < 1e-6) {
    out[0] = z.x + Math.sin(h) * z.speed * tau
    out[1] = z.z - Math.cos(h) * z.speed * tau
    return out
  }
  const k = z.speed / z.turn
  const h1 = h + z.turn * tau
  out[0] = z.x + k * (Math.cos(h) - Math.cos(h1))
  out[1] = z.z - k * (Math.sin(h1) - Math.sin(h))
  return out
}

/** Every spawn point of a world (one per team), for placement. */
export const spawnPoints = (arch: Archipelago): { x: number; z: number }[] => Array.from({ length: CREW.ships }, (_, team) => fleetSpawn(arch, team))

const BEARINGS = 16
const RINGS = [0, 0.35, 0.7, 1] as const
/** Path samples checked per zone (fractions of its life). */
const PATH = [0, 0.25, 0.5, 0.75, 1] as const

/** Share of a disc of radius r at (x, z) that is open water (0..1); the inner 70% must be wholly open or it scores 0. */
function openShare(arch: Archipelago, x: number, z: number, r: number): number {
  let open = 0
  let n = 0
  for (const f of RINGS) {
    const count = f === 0 ? 1 : BEARINGS
    for (let i = 0; i < count; i++) {
      const a = (i / BEARINGS) * Math.PI * 2 + f
      const wet = terrainHeight(arch, x + Math.cos(a) * r * f, z + Math.sin(a) * r * f) < ZONE_AREA.depth
      if (!wet && f < 1) return 0
      if (wet) open++
      n++
    }
  }
  return open / n
}

/**
 * The zones of one cycle: `count` zones, each the best of up to ZONE_AREA.tries seeded candidates (open water over
 * its whole drift path, clear of spawns and of each other, a real hop from the previous cycle's zone). Pure: the same
 * arguments always give the same zones.
 */
export function placeZones(
  arch: Archipelago,
  spawns: readonly { x: number; z: number }[],
  round: number,
  cycle: number,
  count: number,
  prev: readonly Zone[],
  t0: number,
  rules: ObjectiveRules,
): Zone[] {
  const out: Zone[] = []
  const r = rules.radius
  const first = cycle === 0
  const life = first ? rules.opening : rules.cycle
  const p: [number, number] = [0, 0]
  // Two first zones need more room than one; if nothing passes, widen the area, then drop the hop rule.
  const passes = [
    { reach: first ? ZONE_AREA.firstReach + (count - 1) * 900 : ZONE_AREA.reach, hop: !first },
    { reach: ZONE_AREA.reach, hop: !first },
    { reach: ZONE_AREA.reach, hop: false },
  ]
  for (let id = 0; id < count; id++) {
    let best: Zone | null = null
    let bestScore = -Infinity
    const salt = (round * 7919 + cycle * 131 + id * 17) | 0
    for (const [pass, { reach, hop }] of passes.entries()) {
      for (let k = 0; k < ZONE_AREA.tries; k++) {
        const h = (j: number) => hash3(salt, (pass * ZONE_AREA.tries + k) * 8 + j, arch.seed ^ 0x2073e5)
        // Uniform over the disc of `reach`.
        const rad = Math.sqrt(h(0)) * reach
        const ang = h(1) * Math.PI * 2
        const z: Zone = {
          id,
          x: Math.cos(ang) * rad,
          z: Math.sin(ang) * rad,
          heading: h(2) * Math.PI * 2,
          speed: rules.drift,
          turn: ((h(3) < 0.5 ? -1 : 1) * rules.turn * Math.PI) / 180,
          t0,
          r,
          holder: -1,
          cap: -1,
          progress: 0,
          present: 0,
        }
        // Cheap rules first: the path stays in the play area, clear of spawns, apart from the other zone, a real hop.
        let ok = true
        let spawnRoom = Infinity
        for (const f of PATH) {
          zoneCentre(z, t0 + f * life, p)
          if (Math.hypot(p[0], p[1]) > ZONE_AREA.reach) ok = false
          for (const s of spawns) spawnRoom = Math.min(spawnRoom, Math.hypot(p[0] - s.x, p[1] - s.z) - r)
        }
        if (!ok || spawnRoom < ZONE_AREA.spawnGap) continue
        if (out.some((o) => Math.hypot(o.x - z.x, o.z - z.z) < o.r + r + ZONE_AREA.gap)) continue
        const before = prev.find((o) => o.id === id) ?? prev[0]
        if (before && hop) {
          const c = zoneCentre(before, t0)
          const d = Math.hypot(c[0] - z.x, c[1] - z.z)
          if (d < ZONE_AREA.hop || d > ZONE_AREA.maxHop) continue
        }
        // Open water along the whole drift path; the worst sample decides.
        let open = 1
        for (const f of PATH) {
          zoneCentre(z, t0 + f * life, p)
          open = Math.min(open, openShare(arch, p[0], p[1], r))
          if (open <= bestScore) break
        }
        if (open > bestScore) {
          best = z
          bestScore = open
          if (open >= 1) break
        }
      }
      if (best && bestScore > 0) break
    }
    // Nothing passed even the loosest rules (a huge radius): the middle, still.
    out.push(best ?? { id, x: 0, z: 0, heading: 0, speed: 0, turn: 0, t0, r, holder: -1, cap: -1, progress: 0, present: 0 })
  }
  return out
}

/** Something that changed in one step, for logs and tests (the HUD reads state changes off the wire instead). */
export type ObjectiveEvent =
  | { k: "round"; round: number }
  | { k: "captured"; zone: number; team: number }
  | { k: "neutral"; zone: number; team: number }
  | { k: "reveal"; count: number }
  | { k: "moved"; count: number }
  | { k: "end"; winner: number }

/**
 * The authoritative objective of one world. `step(t, ships)` advances it to sea time t against the carriers as they
 * are now; it changes `state` in place and returns what happened.
 */
export class Objective {
  state: ObjectiveState
  private spawns: { x: number; z: number }[]
  private last: number
  private active = 0

  constructor(
    private arch: Archipelago,
    t: number,
    rules: ObjectiveRules = OBJECTIVE_DEFAULTS,
    active = 1,
  ) {
    this.spawns = spawnPoints(arch)
    this.last = t
    this.active = active
    this.state = this.fresh(0, t, { ...rules })
  }

  /** New rules: the round restarts with them (a dev tool). */
  setRules(rules: ObjectiveRules, t: number): void {
    this.state = this.fresh(this.state.round + 1, t, { ...rules })
    this.last = t
  }

  private fresh(round: number, t: number, rules: ObjectiveRules): ObjectiveState {
    return {
      round,
      start: t,
      end: -1,
      winner: -1,
      cycle: 0,
      cycleAt: t,
      moveAt: t + rules.opening,
      zones: placeZones(this.arch, this.spawns, round, 0, zoneCount(this.active, rules), [], t, rules),
      next: [],
      scores: Array.from({ length: CREW.ships }, () => 0),
      rules,
    }
  }

  step(t: number, ships: readonly ObjectiveShip[]): ObjectiveEvent[] {
    const ev: ObjectiveEvent[] = []
    const s = this.state
    const rules = s.rules
    this.active = ships.reduce((n, x) => n + (x.active ? 1 : 0), 0)
    const dt = Math.max(0, Math.min(1, t - this.last))
    this.last = Math.max(this.last, t)
    if (s.end >= 0) {
      if (t >= s.end + rules.intermission) {
        this.state = this.fresh(s.round + 1, t, rules)
        ev.push({ k: "round", round: this.state.round })
      }
      return ev
    }
    // A long stall (an evicted isolate) skips whole cycles rather than replaying them.
    if (t - s.moveAt > rules.cycle) {
      const skip = Math.floor((t - s.moveAt) / rules.cycle)
      s.cycle += skip
      s.moveAt += skip * rules.cycle
      s.next = []
    }
    if (!s.next.length && t >= s.moveAt - rules.warning) {
      s.next = placeZones(this.arch, this.spawns, s.round, s.cycle + 1, zoneCount(this.active, rules), s.zones, s.moveAt, rules)
      ev.push({ k: "reveal", count: s.next.length })
    }
    if (t >= s.moveAt) {
      s.zones = s.next.length ? s.next : placeZones(this.arch, this.spawns, s.round, s.cycle + 1, zoneCount(this.active, rules), s.zones, s.moveAt, rules)
      s.next = []
      s.cycle++
      s.cycleAt = s.moveAt
      s.moveAt += rules.cycle
      ev.push({ k: "moved", count: s.zones.length })
    }
    const fill = dt / rules.capture
    const c: [number, number] = [0, 0]
    for (const z of s.zones) {
      zoneCentre(z, t, c)
      let present = 0
      for (const sh of ships) if (sh.active && Math.hypot(sh.x - c[0], sh.z - c[1]) <= z.r) present |= 1 << sh.team
      z.present = present
      const n = bits(present)
      if (n >= 2) continue
      if (n === 0) {
        // Left alone: a held zone refills to its holder, a half-captured one empties.
        if (z.holder >= 0) z.progress = Math.min(1, z.progress + fill * 0.5)
        else if (z.cap >= 0) {
          z.progress = Math.max(0, z.progress - fill * 0.5)
          if (z.progress === 0) z.cap = -1
        }
        continue
      }
      const team = Math.log2(present)
      if (z.holder === team) {
        z.progress = Math.min(1, z.progress + fill)
        s.scores[team] = (s.scores[team] ?? 0) + rules.rate * dt
        continue
      }
      if (z.cap === team || z.cap < 0) {
        z.cap = team
        z.progress = Math.min(1, z.progress + fill)
        if (z.progress >= 1) {
          z.holder = team
          ev.push({ k: "captured", zone: z.id, team })
        }
        continue
      }
      // Someone else's progress (or zone): drain it first.
      z.progress = Math.max(0, z.progress - fill)
      if (z.progress === 0) {
        if (z.holder >= 0) ev.push({ k: "neutral", zone: z.id, team: z.holder })
        z.holder = -1
        z.cap = team
      }
    }
    const top = Math.max(...s.scores)
    if (top >= rules.target || t >= s.start + rules.roundTime) {
      const leaders = s.scores.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0)
      s.end = t
      s.winner = top > 0 && leaders.length === 1 ? leaders[0]! : -1
      ev.push({ k: "end", winner: s.winner })
    }
    return ev
  }
}

const bits = (m: number): number => {
  let n = 0
  for (let v = m; v; v &= v - 1) n++
  return n
}

// ---- wire --------------------------------------------------------------------------------------------------------

/** Numbers per zone on the wire. */
export const ZONE_FLOATS = 11
/** Header: round, start, end, winner, cycle, cycleAt, moveAt, target, roundTime, warning, intermission, capture. */
const HEAD = 12
const r2 = (v: number) => Math.round(v * 100) / 100

const packZone = (z: Zone): number[] => [
  Math.round(z.x * 10) / 10,
  Math.round(z.z * 10) / 10,
  Math.round(z.heading * 1e5) / 1e5,
  r2(z.speed),
  Math.round(z.turn * 1e6) / 1e6,
  r2(z.t0),
  Math.round(z.r),
  z.holder,
  z.cap,
  Math.round(z.progress * 1000) / 1000,
  z.present,
]

/** The whole objective as one flat array of numbers (`{ type: "obj", o }`). */
export function packObjective(s: ObjectiveState): number[] {
  const r = s.rules
  const out = [s.round, r2(s.start), r2(s.end), s.winner, s.cycle, r2(s.cycleAt), r2(s.moveAt), r.target, r.roundTime, r.warning, r.intermission, r.capture]
  for (let i = 0; i < CREW.ships; i++) out.push(Math.round((s.scores[i] ?? 0) * 10) / 10)
  out.push(s.zones.length)
  for (const z of s.zones) out.push(...packZone(z))
  out.push(s.next.length)
  for (const z of s.next) out.push(...packZone(z))
  return out
}

/** A received objective: the state minus the rules the client never needs. */
export type ObjectiveView = Omit<ObjectiveState, "rules"> & {
  rules: Pick<ObjectiveRules, "target" | "roundTime" | "warning" | "intermission" | "capture">
}

const zoneOf = (o: readonly number[], i: number, id: number): Zone => ({
  id,
  x: o[i]!,
  z: o[i + 1]!,
  heading: o[i + 2]!,
  speed: o[i + 3]!,
  turn: o[i + 4]!,
  t0: o[i + 5]!,
  r: o[i + 6]!,
  holder: o[i + 7]!,
  cap: o[i + 8]!,
  progress: o[i + 9]!,
  present: o[i + 10]!,
})

/** Unpacks `packObjective`; null when malformed (wrong length, bad counts, non-finite numbers). */
export function unpackObjective(o: unknown): ObjectiveView | null {
  if (!Array.isArray(o) || o.length > 256 || !o.every((v) => typeof v === "number" && Number.isFinite(v))) return null
  const v = o as number[]
  let i = HEAD + CREW.ships
  const nz = v[i++]
  if (nz === undefined || !Number.isInteger(nz) || nz < 0 || nz > 4 || v.length < i + nz * ZONE_FLOATS + 1) return null
  const zones = Array.from({ length: nz }, (_, k) => zoneOf(v, i + k * ZONE_FLOATS, k))
  i += nz * ZONE_FLOATS
  const nn = v[i++]!
  if (!Number.isInteger(nn) || nn < 0 || nn > 4 || v.length !== i + nn * ZONE_FLOATS) return null
  const next = Array.from({ length: nn }, (_, k) => zoneOf(v, i + k * ZONE_FLOATS, k))
  return {
    round: v[0]!,
    start: v[1]!,
    end: v[2]!,
    winner: v[3]!,
    cycle: v[4]!,
    cycleAt: v[5]!,
    moveAt: v[6]!,
    rules: { target: v[7]!, roundTime: v[8]!, warning: v[9]!, intermission: v[10]!, capture: v[11]! },
    scores: v.slice(HEAD, HEAD + CREW.ships),
    zones,
    next,
  }
}
