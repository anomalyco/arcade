import { DT, HEALTH, MATCH_SECONDS } from "../config"
import { type Vec, clearLine } from "../geom"
import type { Rng } from "../rng"
import { placesFor } from "./places"
import type { Intent, Player, World } from "./world"

export type ModeId = "ffa" | "tdm" | "dom" | "snd"
export const MODE_IDS: readonly ModeId[] = ["ffa", "tdm", "dom", "snd"]

export const MODES: Record<ModeId, { label: string; short: string; blurb: string; teams: boolean }> = {
  ffa: { label: "Free for all", short: "FFA", blurb: "Everyone for themselves. Most kills wins.", teams: false },
  tdm: { label: "Team deathmatch", short: "TDM", blurb: "Orange vs cyan. First team to the kill target.", teams: true },
  dom: { label: "Domination", short: "DOM", blurb: "Hold A, B and C. Each point held scores.", teams: true },
  snd: { label: "Search & destroy", short: "S&D", blurb: "One life a round. Plant or defuse the bomb.", teams: true },
}

export const modeOf = (v: unknown): ModeId | null => ((MODE_IDS as readonly unknown[]).includes(v) ? (v as ModeId) : null)

export const TEAM_NAMES = ["ORANGE", "CYAN"] as const

/** Domination: point radius, seconds to capture alone, score per point per second, and the score that wins. */
export const DOM = { radius: 3, capture: 5, target: 200 }
/** Search and destroy: round length, plant and defuse holds, bomb fuse, the pause after a round, rounds to win. */
export const SND = { round: 120, plant: 3, defuse: 5, fuse: 35, post: 5, wins: 4, siteRadius: 2.6, defuseRange: 1.3, pickup: 1, blast: 9, lateJoin: 15 }

/** Kills that win team deathmatch: 20 for a few players, rising to 50 for a full room of 12. */
export const tdmTarget = (players: number) => Math.min(50, Math.max(20, Math.round((players * 50) / 12 / 5) * 5))

export type PointView = { name: string; x: number; y: number; r: number; owner: number; capper: number; progress: number; contested: boolean }
export type BombView = { state: "carried" | "dropped" | "planted" | "defused" | "exploded" | "none"; x: number; y: number; carrier: string; site: string; fuse: number; progress: number; actor: string }
export type ModeView = {
  id: ModeId
  /** Team scores: kills (TDM), points (DOM) or rounds (S&D). */
  score: [number, number]
  target: number
  /** Winning team once the match is over, -1 for none or a draw. */
  winner: number
  points: PointView[]
  sites: { name: string; x: number; y: number; r: number }[]
  bomb: BombView | null
  /** S&D: round number, attacking team, alive per team, and the last round's winner while it's being shown. */
  round: { n: number; attack: number; alive: [number, number]; post: boolean; won: number; why: string } | null
  /** End screen: votes per mode and yours. */
  votes: { counts: Record<ModeId, number>; mine: ModeId | "" } | null
}

/** A free-for-all view with nothing going on, for dev pages that fake a snapshot. */
export const IDLE_VIEW: ModeView = { id: "ffa", score: [0, 0], target: 0, winner: -1, points: [], sites: [], bomb: null, round: null, votes: null }

/** Something for a bot to do when nobody's in sight: walk to (x, y), and hold use once there. */
export type Goal = { x: number; y: number; use: boolean }

/**
 * The next mode from the end-screen votes: the most votes wins, a tie is broken at random, and nobody voting keeps the
 * current mode.
 */
export function tally(votes: Iterable<ModeId>, current: ModeId, rng: Rng): ModeId {
  const counts = new Map<ModeId, number>()
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1)
  if (!counts.size) return current
  const top = Math.max(...counts.values())
  const best = MODE_IDS.filter((m) => counts.get(m) === top)
  return best.length === 1 ? best[0]! : rng.pick(best)
}

export function createMode(id: ModeId): Mode {
  if (id === "tdm") return new TeamDeathmatch()
  if (id === "dom") return new Domination()
  if (id === "snd") return new SearchAndDestroy()
  return new Mode()
}

const alivePlayers = (w: World) => [...w.players.values()].filter((p) => p.alive)

/**
 * The rules of a mode, called by the World at its hooks. The base is free for all: no teams, spawn far from everyone,
 * most kills when the clock runs out wins.
 */
export class Mode {
  readonly id: ModeId = "ffa"
  get teams(): boolean {
    return MODES[this.id].teams
  }
  /** Team scores. */
  score: [number, number] = [0, 0]
  /** How long a match runs at most. */
  get seconds(): number {
    return MATCH_SECONDS
  }

  /** A new match: sort out teams, then everyone spawns. */
  start(w: World): void {
    this.score = [0, 0]
    this.balance(w)
    for (const p of w.players.values()) w.spawn(p)
  }

  /** Someone joins mid-match: put them on a team. Returns whether they spawn now. */
  join(w: World, p: Player): boolean {
    p.team = this.teams ? this.smaller(w, p) : -1
    return true
  }

  leave(_w: World, _p: Player): void {}

  /** Where a player spawns, or null for the spawn farthest from everyone alive. */
  spawnAt(_w: World, _p: Player): Vec | null {
    return null
  }

  /** The intent as the mode allows it (S&D roots you while planting). */
  intent(_w: World, _p: Player, i: Intent): Intent {
    return i
  }

  killed(_w: World, _victim: Player, _killer: Player): void {}

  /** Objectives, once a tick during play. Calls w.endMatch() when the match is won. */
  step(_w: World): void {}

  /** Seconds to show on the clock during play, or null for the match clock. */
  left(_w: World): number | null {
    return null
  }

  /** Who won: a player id in free for all, a team otherwise (-1 for a draw). */
  result(w: World): { winner: string; team: number } {
    if (this.teams) {
      const team = this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1
      return { winner: "", team }
    }
    const ranked = [...w.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    return { winner: ranked[0]?.id ?? "", team: -1 }
  }

  target(_w: World): number {
    return 0
  }

  botGoal(_w: World, _p: Player): Goal | null {
    return null
  }

  view(w: World, viewer: string): ModeView {
    const counts = { ffa: 0, tdm: 0, dom: 0, snd: 0 }
    for (const v of w.votes.values()) counts[v]++
    return {
      id: this.id,
      score: [Math.floor(this.score[0]), Math.floor(this.score[1])],
      target: this.target(w),
      winner: w.phase === "end" ? this.result(w).team : -1,
      points: [],
      sites: [],
      bomb: null,
      round: null,
      votes: w.phase === "end" ? { counts, mine: w.votes.get(viewer) ?? "" } : null,
    }
  }

  /** Players on a team. */
  members(w: World, team: number): Player[] {
    return [...w.players.values()].filter((p) => p.team === team)
  }

  /** The team with fewer players (not counting `p`), the one behind on a tie, else whichever. */
  protected smaller(w: World, p: Player): number {
    const n = [0, 1].map((t) => this.members(w, t).filter((q) => q !== p).length)
    if (n[0] !== n[1]) return n[0]! < n[1]! ? 0 : 1
    if (this.score[0] !== this.score[1]) return this.score[0] < this.score[1] ? 0 : 1
    return w.rng.int(2)
  }

  /** Team modes: everyone without a team joins the smaller one, then bots, then humans, move until within one. */
  protected balance(w: World): void {
    if (!this.teams) {
      for (const p of w.players.values()) p.team = -1
      return
    }
    for (const p of w.players.values()) if (p.team !== 0 && p.team !== 1) p.team = this.smaller(w, p)
    for (;;) {
      const a = this.members(w, 0)
      const b = this.members(w, 1)
      if (Math.abs(a.length - b.length) <= 1) return
      const big = a.length > b.length ? a : b
      const mover = big.find((p) => !p.human) ?? big[big.length - 1]!
      mover.team = big === a ? 1 : 0
    }
  }

  /** Team spawn at the start of a match: spread around the team's end. */
  protected endSlot(w: World, p: Player, end: number): Vec {
    const slots = placesFor(w.map).slots[end]!
    const i = this.members(w, p.team).indexOf(p)
    return slots[Math.max(0, i) % slots.length]!
  }
}

export class TeamDeathmatch extends Mode {
  override readonly id: ModeId = "tdm"
  private fresh = true

  override start(w: World): void {
    this.fresh = true
    super.start(w)
    this.fresh = false
  }

  /** The opening spawn is at the team's end; after that, the map spawn farthest from enemies, nearer to friends. */
  override spawnAt(w: World, p: Player): Vec | null {
    if (this.fresh) return this.endSlot(w, p, p.team)
    const enemies = alivePlayers(w).filter((q) => q.team !== p.team)
    const friends = alivePlayers(w).filter((q) => q.team === p.team && q !== p)
    let best: Vec | null = null
    let bs = -Infinity
    for (const s of w.map.spawns) {
      const e = enemies.length ? Math.min(...enemies.map((q) => Math.hypot(q.x - s.x, q.y - s.y))) : 20
      const f = friends.length ? Math.min(...friends.map((q) => Math.hypot(q.x - s.x, q.y - s.y))) : 0
      const sc = Math.min(e, 18) - f * 0.12 + w.rng.next()
      if (sc > bs) {
        bs = sc
        best = s
      }
    }
    return best
  }

  override killed(w: World, victim: Player, killer: Player): void {
    if (killer === victim || killer.team === victim.team) return
    this.score[killer.team]!++
    if (this.score[killer.team]! >= this.target(w)) w.endMatch()
  }

  override target(w: World): number {
    return tdmTarget(w.players.size)
  }
}

type Point = { name: string; x: number; y: number; owner: number; capper: number; progress: number; contested: boolean }

export class Domination extends Mode {
  override readonly id: ModeId = "dom"
  points: Point[] = []
  private acc = 0
  private fresh = true

  override start(w: World): void {
    const pl = placesFor(w.map)
    this.points = pl.points.map((v, i) => ({ name: "ABC"[i]!, x: v.x, y: v.y, owner: -1, capper: -1, progress: 0, contested: false }))
    this.acc = 0
    this.fresh = true
    super.start(w)
    this.fresh = false
  }

  /** Team 0 starts and respawns on the A half, team 1 on the C half, at the spawn farthest from enemies. */
  override spawnAt(w: World, p: Player): Vec | null {
    if (this.fresh) return this.endSlot(w, p, p.team)
    const half = placesFor(w.map).halves[p.team === 1 ? 1 : 0]
    const enemies = alivePlayers(w).filter((q) => q.team !== p.team)
    let best: Vec | null = null
    let bs = -Infinity
    for (const s of half) {
      const e = enemies.length ? Math.min(...enemies.map((q) => Math.hypot(q.x - s.x, q.y - s.y))) : 20
      const sc = Math.min(e, 15) + w.rng.next()
      if (sc > bs) {
        bs = sc
        best = s
      }
    }
    return best
  }

  /** Who's on each point decides its capture; every second each owned point scores one for its team. */
  override step(w: World): void {
    for (const pt of this.points) {
      const on = [0, 0]
      const there: Player[] = []
      for (const p of w.players.values()) {
        if (!p.alive || p.team < 0 || Math.hypot(p.x - pt.x, p.y - pt.y) > DOM.radius) continue
        if (!clearLine(pt.x, pt.y, p.x, p.y, w.blockers)) continue
        on[p.team]!++
        there.push(p)
      }
      pt.contested = on[0]! > 0 && on[1]! > 0
      if (pt.contested) continue
      const t = on[0]! > 0 ? 0 : on[1]! > 0 ? 1 : -1
      if (t < 0 || t === pt.owner) {
        // Unattended, or held by its owner: any half-done capture drains away.
        pt.progress = Math.max(0, pt.progress - (t < 0 ? 0.1 : 0.4) * DT)
        if (pt.progress === 0) pt.capper = -1
        continue
      }
      const rate = Math.min(2, 1 + 0.5 * (on[t]! - 1)) / DOM.capture
      if (pt.capper !== t && pt.progress > 0) {
        pt.progress = Math.max(0, pt.progress - rate * DT)
        continue
      }
      pt.capper = t
      pt.progress += rate * DT
      if (pt.progress >= 1) {
        pt.owner = t
        pt.progress = 0
        pt.capper = -1
        for (const p of there) p.caps++
        w.events.push({ k: "cap", team: t, point: pt.name })
      }
    }
    this.acc += DT
    while (this.acc >= 1) {
      this.acc -= 1
      for (const pt of this.points) if (pt.owner >= 0) this.score[pt.owner]!++
    }
    if (Math.max(...this.score) >= DOM.target) w.endMatch()
  }

  override target(): number {
    return DOM.target
  }

  /** The nearest point the team doesn't own, or a contested one; else hold the nearest. */
  override botGoal(_w: World, p: Player): Goal | null {
    const want = this.points.filter((pt) => pt.owner !== p.team || pt.contested || (pt.capper >= 0 && pt.capper !== p.team))
    const list = want.length ? want : this.points
    let best: Point | null = null
    let bd = Infinity
    for (const pt of list) {
      const d = Math.hypot(pt.x - p.x, pt.y - p.y)
      if (d < bd) {
        bd = d
        best = pt
      }
    }
    return best ? { x: best.x, y: best.y, use: false } : null
  }

  override view(w: World, viewer: string): ModeView {
    return { ...super.view(w, viewer), points: this.points.map((pt) => ({ ...pt, r: DOM.radius })) }
  }
}

type Bomb = { state: BombView["state"]; x: number; y: number; carrier: string; site: string; fuseAt: number; progress: number; actor: string; planter: string }

export class SearchAndDestroy extends Mode {
  override readonly id: ModeId = "snd"
  round = 0
  attack = 0
  post = false
  private roundEnd = 0
  private postUntil = 0
  private roundStart = 0
  won = -1
  why = ""
  private beepAt = 0
  bomb: Bomb = { state: "none", x: 0, y: 0, carrier: "", site: "", fuseAt: 0, progress: 0, actor: "", planter: "" }

  /** Seven rounds at most; the World's match clock is only a backstop. */
  override get seconds(): number {
    return (SND.round + SND.fuse + SND.post + 5) * (SND.wins * 2 - 1)
  }

  get defend(): number {
    return 1 - this.attack
  }

  override start(w: World): void {
    this.score = [0, 0]
    this.round = 0
    this.balance(w)
    this.newRound(w)
  }

  /** Everyone back at their end, alive; one attacker carries the bomb. Sides swap after the first half. */
  private newRound(w: World): void {
    this.round++
    this.attack = this.round <= SND.wins - 1 ? 0 : 1
    this.post = false
    this.won = -1
    this.why = ""
    this.roundStart = w.time
    this.roundEnd = w.time + SND.round
    w.grenades = []
    w.claymores = []
    if (this.round === SND.wins) this.balance(w)
    for (const p of w.players.values()) {
      p.alive = false
      w.spawn(p)
    }
    const attackers = this.members(w, this.attack)
    this.bomb = { state: "none", x: 0, y: 0, carrier: "", site: "", fuseAt: 0, progress: 0, actor: "", planter: "" }
    if (attackers.length) this.give(w.rng.pick(attackers))
  }

  private give(p: Player): void {
    this.bomb.state = "carried"
    this.bomb.carrier = p.id
    this.bomb.x = p.x
    this.bomb.y = p.y
    this.bomb.progress = 0
  }

  /** Attackers spawn at the low end, defenders at the high end, where the sites are. */
  override spawnAt(w: World, p: Player): Vec | null {
    return this.endSlot(w, p, p.team === this.attack ? 0 : 1)
  }

  /**
   * Late joiners wait for the next round, unless the round has only just started, nobody is playing, or they're the
   * first on their side. With even teams, a joiner attacks, so a lone player has a bomb to plant.
   */
  override join(w: World, p: Player): boolean {
    p.team = this.members(w, 0).length === this.members(w, 1).length ? this.attack : this.smaller(w, p)
    const early = !this.post && w.time - this.roundStart < SND.lateJoin
    const ok = early || !alivePlayers(w).some((q) => q !== p) || this.members(w, p.team).length === 1
    if (!ok) p.respawnAt = Infinity
    return ok
  }

  override leave(_w: World, p: Player): void {
    if (this.bomb.carrier === p.id) this.drop(p)
  }

  override killed(_w: World, victim: Player): void {
    victim.respawnAt = Infinity
    if (this.bomb.carrier === victim.id) this.drop(victim)
  }

  private drop(p: Player): void {
    if (this.bomb.state !== "carried") return
    this.bomb.state = "dropped"
    this.bomb.carrier = ""
    this.bomb.x = p.x
    this.bomb.y = p.y
    this.bomb.progress = 0
  }

  /** The site the bomb carrier stands in, if any. */
  private siteOf(w: World, p: Player): number {
    const sites = placesFor(w.map).sites
    return sites.findIndex((s) => Math.hypot(s.x - p.x, s.y - p.y) <= SND.siteRadius)
  }

  canPlant(w: World, p: Player): boolean {
    return !this.post && p.alive && this.bomb.state === "carried" && this.bomb.carrier === p.id && this.siteOf(w, p) >= 0
  }

  canDefuse(p: Player): boolean {
    return !this.post && p.alive && p.team === this.defend && this.bomb.state === "planted" && Math.hypot(this.bomb.x - p.x, this.bomb.y - p.y) <= SND.defuseRange
  }

  /** Planting and defusing hold you still with the gun down. */
  override intent(w: World, p: Player, i: Intent): Intent {
    return i.use && (this.canPlant(w, p) || this.canDefuse(p)) ? { ...i, mx: 0, my: 0, sprint: false, fire: false } : i
  }

  override step(w: World): void {
    if (this.post) {
      if (w.time < this.postUntil) return
      if (Math.max(...this.score) >= SND.wins) w.endMatch()
      else this.newRound(w)
      return
    }
    const b = this.bomb
    const carrier = b.carrier ? w.players.get(b.carrier) : undefined
    if (b.state === "carried" && (!carrier || !carrier.alive)) {
      b.state = "dropped"
      b.carrier = ""
    }
    if (b.state === "none") {
      const first = this.members(w, this.attack).find((p) => p.alive)
      if (first) this.give(first)
    }
    if (b.state === "dropped") {
      const taker = this.members(w, this.attack).find((p) => p.alive && Math.hypot(p.x - b.x, p.y - b.y) <= SND.pickup)
      if (taker) this.give(taker)
    }
    if (b.state === "carried") {
      const c = w.players.get(b.carrier)!
      b.x = c.x
      b.y = c.y
      if (c.using && this.canPlant(w, c)) {
        b.progress += DT / SND.plant
        b.actor = c.id
        if (b.progress >= 1) {
          b.state = "planted"
          b.site = "AB"[this.siteOf(w, c)]!
          b.carrier = ""
          b.fuseAt = w.time + SND.fuse
          b.progress = 0
          b.actor = ""
          b.planter = c.id
          c.plants++
          this.beepAt = w.time + 1
          w.events.push({ k: "bomb", what: "plant", by: c.id, x: b.x, y: b.y })
          w.events.push({ k: "plant", by: c.id, id: -1, x: b.x, y: b.y, aim: c.aim })
        }
      } else {
        b.progress = 0
        b.actor = ""
      }
    } else if (b.state === "planted") {
      const actor = b.actor ? w.players.get(b.actor) : undefined
      const d = actor && actor.using && this.canDefuse(actor) ? actor : this.members(w, this.defend).find((p) => p.using && this.canDefuse(p))
      if (d) {
        if (b.actor !== d.id) b.progress = 0
        b.actor = d.id
        b.progress += DT / SND.defuse
        if (b.progress >= 1) {
          b.state = "defused"
          b.progress = 0
          d.defuses++
          w.events.push({ k: "bomb", what: "defuse", by: d.id, x: b.x, y: b.y })
          return this.win(w, this.defend, "defused")
        }
      } else {
        b.progress = 0
        b.actor = ""
      }
      if (w.time >= b.fuseAt) return this.detonate(w)
      // The bomb beeps, faster as it runs down.
      if (w.time >= this.beepAt) {
        const left = b.fuseAt - w.time
        this.beepAt = w.time + (left > 10 ? 1 : left > 4 ? 0.5 : 0.22)
        w.events.push({ k: "beep", id: -1, x: b.x, y: b.y })
      }
    }
    const att = this.members(w, this.attack)
    const def = this.members(w, this.defend)
    if (def.length && !def.some((p) => p.alive)) return this.win(w, this.attack, "eliminated")
    if (att.length && !att.some((p) => p.alive) && b.state !== "planted") return this.win(w, this.defend, "eliminated")
    if (b.state !== "planted" && w.time >= this.roundEnd) return this.win(w, this.defend, "time")
  }

  /** The bomb goes off: everyone in the blast with a clear line dies, and the attackers take the round. */
  private detonate(w: World): void {
    const b = this.bomb
    b.state = "exploded"
    const planter = w.players.get(b.planter)
    w.events.push({ k: "bomb", what: "explode", by: b.planter, x: b.x, y: b.y })
    w.events.push({ k: "explode", kind: "frag", by: b.planter, id: -1, x: b.x, y: b.y, aim: 0 })
    for (const q of alivePlayers(w)) {
      if (Math.hypot(q.x - b.x, q.y - b.y) > SND.blast || !clearLine(b.x, b.y, q.x, q.y, w.blockers)) continue
      // Attackers caught in their own blast die by their own hand.
      w.damage(q, HEALTH * 3, planter && planter.team !== q.team ? planter : q, "frag", b.x, b.y)
    }
    this.win(w, this.attack, "detonated")
  }

  private win(w: World, team: number, why: string): void {
    this.score[team]!++
    this.post = true
    this.postUntil = w.time + SND.post
    this.won = team
    this.why = why
    w.events.push({ k: "round", team, why })
  }

  override left(w: World): number {
    if (this.post) return Math.max(0, this.postUntil - w.time)
    if (this.bomb.state === "planted") return Math.max(0, this.bomb.fuseAt - w.time)
    return Math.max(0, this.roundEnd - w.time)
  }

  override target(): number {
    return SND.wins
  }

  /**
   * Attackers: the carrier walks to a site and plants; the rest go for a dropped bomb, else a site. Defenders: defuse a
   * planted bomb, else hold a site.
   */
  override botGoal(w: World, p: Player): Goal | null {
    const sites = placesFor(w.map).sites
    const b = this.bomb
    const pick = sites[(p.id.length + this.round + (p.id.charCodeAt(p.id.length - 1) || 0)) % 2]!
    if (p.team === this.attack) {
      if (b.carrier === p.id) return { ...pick, use: this.canPlant(w, p) }
      if (b.state === "dropped") return { x: b.x, y: b.y, use: false }
      if (b.state === "planted") return { x: b.x, y: b.y, use: false }
      return { ...pick, use: false }
    }
    if (b.state === "planted") return { x: b.x, y: b.y, use: true }
    return { ...pick, use: false }
  }

  override view(w: World, viewer: string): ModeView {
    const sites = placesFor(w.map).sites
    const b = this.bomb
    const alive = [0, 1].map((t) => this.members(w, t).filter((p) => p.alive).length) as [number, number]
    return {
      ...super.view(w, viewer),
      sites: sites.map((s, i) => ({ name: "AB"[i]!, x: s.x, y: s.y, r: SND.siteRadius })),
      bomb: { state: b.state, x: b.x, y: b.y, carrier: b.carrier, site: b.site, fuse: b.state === "planted" ? Math.max(0, b.fuseAt - w.time) : 0, progress: b.progress, actor: b.actor },
      round: { n: this.round, attack: this.attack, alive, post: this.post, won: this.won, why: this.why },
    }
  }
}
