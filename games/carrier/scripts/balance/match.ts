// One headless match: a dev RoomCore with no sockets, opened on a seed and filled with match bots (shared/bots.ts
// MATCH_CREW, server/bot-match.ts), its clock driven directly in the room's own 50 ms steps as fast as the CPU goes,
// until a side reaches the objective's target or the time cap. Everything it measures comes from the room's own
// events (RoomOptions.onEvent), so the numbers are what a real room would have decided. Deterministic per seed.

import { type RoomEvent, RoomCore } from "../../server/core"
import { BOT_DEFAULTS, type BotSettings, matchBehavior } from "../../shared/bots"
import { WEAPON_MOUNTS } from "../../shared/carrier-spec"
import { type Crew, playerOf, shipOf } from "../../shared/crew"
import { OBJECTIVE_DEFAULTS, type ObjectiveRules } from "../../shared/objective"
import { opById } from "../../shared/ops"
import { type KillerType, type MatchResult, type ShipSource, type UnitType, KILLER_TYPES, KILL_WEAPONS, SHIP_SOURCES, TIMELINE_STEP, UNIT_TYPES, counts } from "./metrics"
import { type Override, applyOverrides } from "./tunables"

/** The knobs a side's bots get (BotSettings ranges, 0..1). */
export type SideSettings = Partial<Pick<BotSettings, "skill" | "aggression" | "accuracy">>

export type MatchSpec = {
  seed: number
  variant: string
  /** Carriers crewed (2..4), each by `crew` (operation ids, at most CREW.capacity). */
  ships: number
  crew: readonly string[]
  /** Time cap (simulated minutes). */
  minutes: number
  /** Every side's bots, then per team, then per operation (role) on top. */
  base: SideSettings
  sides: readonly SideSettings[]
  roles?: Readonly<Record<string, SideSettings>>
  overrides: readonly Override[]
  rules?: Partial<ObjectiveRules>
}

const EPOCH = 1_000_000
const STEP_MS = 50

export function runMatch(spec: MatchSpec): MatchResult {
  const restore = applyOverrides(spec.overrides)
  try {
    return play(spec)
  } finally {
    restore()
  }
}

function play(spec: MatchSpec): MatchResult {
  let now = EPOCH
  const teams = spec.ships
  const r: MatchResult = {
    seed: spec.seed,
    variant: spec.variant,
    ended: false,
    winner: -1,
    length: 0,
    teams,
    scores: Array.from({ length: teams }, () => 0),
    timeline: [],
    zoneHold: Array.from({ length: teams }, () => 0),
    zonePresent: Array.from({ length: teams }, () => 0),
    contested: 0,
    captures: Array.from({ length: teams }, () => 0),
    neutralized: 0,
    shipDamage: counts(SHIP_SOURCES),
    damageTaken: Array.from({ length: teams }, () => 0),
    damageDealt: Array.from({ length: teams }, () => 0),
    sinks: [],
    kills: counts(KILL_WEAPONS),
    deaths: counts(UNIT_TYPES),
    killMatrix: Object.fromEntries(KILLER_TYPES.map((k) => [k, counts(UNIT_TYPES)])) as Record<KillerType, Record<UnitType, number>>,
    teamKills: Array.from({ length: teams }, () => 0),
    teamDeaths: Array.from({ length: teams }, () => 0),
    missiles: { fired: 0, locked: 0, hitJet: 0, hitShip: 0, decoyed: 0, intercepted: 0 },
    sams: { fired: 0, hit: 0, decoyed: 0, intercepted: 0 },
    shells: { fired: 0, hitJet: 0, hitShip: 0 },
    bombs: { released: 0, direct: 0, near: 0, intercepted: 0 },
    flares: 0,
    deckKills: {},
    sorties: counts(UNIT_TYPES),
    landings: counts(UNIT_TYPES),
    losses: counts(UNIT_TYPES),
    sortieTime: counts(UNIT_TYPES),
    boats: { launched: 0, sunk: 0, recovered: 0, kills: 0 },
    intercepts: 0,
  }
  const t = () => (now - EPOCH) / 1000
  const born = new Map<number, number>()
  const shipTeam = new Map<number, number>()
  const lastHit = new Map<number, ShipSource>()
  const out = new Map<number, number>()
  // Stores by "owner:seq": what became of each missile and bomb (each counted once).
  const bombs = new Map<string, "released" | "direct" | "near" | "intercepted">()
  const missiles = new Map<string, "fired" | "hit" | "hitShip" | "decoyed" | "intercepted">()
  const sams = new Map<string, "fired" | "hit" | "decoyed" | "intercepted">()
  const shells = new Map<string, "fired" | "hitJet" | "hitShip">()
  let core: RoomCore | null = null
  const crew = (): Crew => core!.crew!
  const teamOf = (id: number) => (core ? (playerOf(crew(), id)?.team ?? -1) : -1)
  const unitOf = (ship: number, slot: number): UnitType | null => {
    const op = opById(shipOf(crew(), ship)?.aircraft[slot]?.op ?? "")
    return op ? (op.boat ? "boat" : (op.vehicle ?? null)) : null
  }
  const killerOf = (id: number): KillerType | null => {
    const p = playerOf(crew(), id)
    if (!p) return null
    if (p.role === "gunner") return WEAPON_MOUNTS[p.mount]?.kind ?? null
    if (p.plane < 0) return null
    return unitOf(p.ship, p.plane)
  }
  const victimOf = (id: number): UnitType | null => {
    const f = core!.fighters.get(id)
    return f ? (f.boat ? "boat" : f.vehicle) : null
  }
  const sourceOf = (e: Extract<RoomEvent, { k: "shiphit" }>["hit"]): ShipSource => {
    if (e.w === "bomb") return e.near > 0 ? "bomb-near" : "bomb"
    if (e.w === "missile" || e.w === "ram" || e.w === "crash") return e.w
    const p = playerOf(crew(), e.by)
    if (e.w === "shell") return p?.role === "gunner" && WEAPON_MOUNTS[p.mount]?.kind === "sam" ? "sam" : "5in"
    if (p?.role === "gunner") return "ciws"
    if (p && p.plane >= 0 && unitOf(p.ship, p.plane) === "boat") return "boat-cannon"
    return "jet-gun"
  }
  const onEvent = (ev: RoomEvent): void => {
    switch (ev.k) {
      case "crew": {
        const e = ev.e
        if (e.k === "new") {
          born.set(e.ship, t())
          shipTeam.set(e.ship, e.team)
        } else if (e.k === "launch") {
          const u = unitOf(e.ship, e.slot)
          if (u) r.sorties[u]++
          if (u === "boat") r.boats.launched++
          out.set(e.player, t())
        } else if (e.k === "recover") {
          const u = unitOf(e.ship, e.slot)
          if (!u) break
          const from = out.get(e.player)
          if (from !== undefined) r.sortieTime[u] += t() - from
          out.delete(e.player)
          if (e.how === "landed") r.landings[u]++
          else r.losses[u]++
          if (u === "boat") e.how === "landed" ? r.boats.recovered++ : r.boats.sunk++
        }
        break
      }
      case "shiphit": {
        const src = sourceOf(ev.hit)
        r.shipDamage[src] += ev.dmg
        lastHit.set(ev.hit.ship, src)
        const victim = shipTeam.get(ev.hit.ship) ?? -1
        if (victim >= 0 && victim < teams) r.damageTaken[victim]! += ev.dmg
        if (ev.hit.team >= 0 && ev.hit.team < teams) r.damageDealt[ev.hit.team]! += ev.dmg
        break
      }
      case "fleet":
        if (ev.e.k === "sinking") {
          const team = shipTeam.get(ev.e.ship) ?? -1
          r.sinks.push({ team, t: t(), life: t() - (born.get(ev.e.ship) ?? 0), by: lastHit.get(ev.e.ship) ?? "none" })
        }
        break
      case "fire": {
        const key = `${ev.owner}:${ev.seq}`
        if (ev.kind === "bomb") {
          r.bombs.released++
          bombs.set(key, "released")
        } else {
          r.missiles.fired++
          if (ev.target >= 0) r.missiles.locked++
          missiles.set(key, "fired")
        }
        break
      }
      case "gfire":
        if (ev.kind === "sam") {
          r.sams.fired++
          sams.set(`${ev.owner}:${ev.seq}`, "fired")
        } else {
          r.shells.fired++
          shells.set(`${ev.owner}:${ev.seq}`, "fired")
        }
        break
      case "flare":
        r.flares++
        break
      case "combat": {
        const e = ev.e
        if (e.k === "kill") {
          const victim = victimOf(e.on)
          r.kills[e.w === "" ? "crash" : e.w]++
          if (victim) r.deaths[victim]++
          const vt = teamOf(e.on)
          if (vt >= 0 && vt < teams) r.teamDeaths[vt]!++
          if (e.by >= 0 && e.by !== e.on) {
            const killer = killerOf(e.by)
            if (killer && victim) r.killMatrix[killer][victim]++
            if (killer === "boat") r.boats.kills++
            const kt = teamOf(e.by)
            if (kt >= 0 && kt < teams) r.teamKills[kt]!++
          }
        } else if (e.k === "ship") {
          const key = `${e.owner}:${e.seq}`
          if (e.w === "bomb" && bombs.has(key)) {
            if (e.near <= 0) bombs.set(key, "direct")
            else if (bombs.get(key) === "released") bombs.set(key, "near")
          } else if (e.w === "missile" && missiles.has(key)) missiles.set(key, "hitShip")
        } else if (e.k === "decoy") {
          const key = `${e.owner}:${e.seq}`
          if (missiles.get(key) === "fired") missiles.set(key, "decoyed")
        } else if (e.k === "boom") {
          const key = `${e.owner}:${e.seq}`
          if (e.bomb) {
            if (e.intercepted && bombs.get(key) === "released") bombs.set(key, "intercepted")
          } else if (missiles.has(key)) {
            if (e.intercepted) missiles.set(key, "intercepted")
            else if (e.on >= 0) missiles.set(key, "hit")
          }
        }
        break
      }
      case "gunnery": {
        const e = ev.e
        if (e.k === "gboom") {
          const key = `${e.owner}:${e.seq}`
          if (e.kind === "sam" && e.on >= 0 && sams.has(key)) sams.set(key, "hit")
          if (e.kind === "shell" && e.on >= 0 && shells.has(key)) shells.set(key, "hitJet")
          if (e.kind === "shell" && e.surface === "ship" && shells.get(key) === "fired") shells.set(key, "hitShip")
        } else if (e.k === "decoy") {
          const key = `${e.owner}:${e.seq}`
          if (sams.get(key) === "fired") sams.set(key, "decoyed")
        } else if (e.k === "intercept") {
          r.intercepts++
          if (e.store === 1 && sams.has(`${e.owner}:${e.seq}`)) sams.set(`${e.owner}:${e.seq}`, "intercepted")
        }
        break
      }
      case "deckkill":
        r.deckKills[ev.e.w] = (r.deckKills[ev.e.w] ?? 0) + 1
        break
      case "objective":
        if (ev.e.k === "captured" && ev.e.team < teams) r.captures[ev.e.team]!++
        else if (ev.e.k === "neutral") r.neutralized++
        break
    }
  }
  core = new RoomCore(() => now, () => spec.seed >>> 0, { dev: true, botMax: 32, onEvent })
  core.openHeadless(spec.seed, { ...OBJECTIVE_DEFAULTS, ...spec.rules })
  const ships = [...crew().ships].sort((a, b) => a.team - b.team).slice(0, spec.ships)
  for (const ship of ships) {
    const s: BotSettings = { ...BOT_DEFAULTS, ...spec.base, ...spec.sides[ship.team], respawn: true }
    for (const role of spec.crew) {
      const err = core.botCommand({ c: "spawn", role, ship: ship.id, n: 1, start: "deck", rules: true, at: [0, 800, 0, 0], s: { ...s, ...spec.roles?.[role], behavior: matchBehavior(role) } })
      if (err) throw new Error(`spawn ${role} on ship ${ship.id}: ${err}`)
    }
  }
  const cap = spec.minutes * 60
  const dt = STEP_MS / 1000
  const wall = performance.now()
  let nextSample = 0
  while (t() < cap) {
    now += STEP_MS
    core.step(now)
    const o = core.objectiveState!
    for (const z of o.zones) {
      let n = 0
      for (let team = 0; team < teams; team++)
        if (z.present & (1 << team)) {
          n++
          r.zonePresent[team]! += dt
        }
      if (n >= 2) r.contested += dt
      else if (n === 1 && z.holder >= 0 && z.present === 1 << z.holder && z.holder < teams) r.zoneHold[z.holder]! += dt
    }
    if (t() >= nextSample) {
      r.timeline.push(o.scores.slice(0, teams).map((v) => Math.round(v)))
      nextSample += TIMELINE_STEP
    }
    if (o.end >= 0) {
      r.ended = true
      r.winner = o.winner
      r.length = o.end - o.start
      break
    }
  }
  if (!r.ended) r.length = cap
  r.scores = core.objectiveState!.scores.slice(0, teams).map((v) => Math.round(v * 10) / 10)
  r.timeline.push(r.scores.map((v) => Math.round(v)))
  for (const v of missiles.values()) {
    if (v === "hit") r.missiles.hitJet++
    else if (v === "hitShip") r.missiles.hitShip++
    else if (v === "decoyed") r.missiles.decoyed++
    else if (v === "intercepted") r.missiles.intercepted++
  }
  for (const v of sams.values()) {
    if (v === "hit") r.sams.hit++
    else if (v === "decoyed") r.sams.decoyed++
    else if (v === "intercepted") r.sams.intercepted++
  }
  for (const v of shells.values()) {
    if (v === "hitJet") r.shells.hitJet++
    else if (v === "hitShip") r.shells.hitShip++
  }
  for (const v of bombs.values()) {
    if (v === "direct") r.bombs.direct++
    else if (v === "near") r.bombs.near++
    else if (v === "intercepted") r.bombs.intercepted++
  }
  r.speed = t() / ((performance.now() - wall) / 1000)
  return r
}
