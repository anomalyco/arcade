import {
  BOLT_REACH,
  BREAKER_RING,
  DEATH_RING,
  DECOY_FLIGHT,
  DECOY_PINGS,
  DOOR_RING,
  DT,
  EMP_RADIUS,
  EMP_SECONDS,
  ENCROACH_INTERVAL,
  ENCROACH_START,
  FLARE_FLIGHT,
  FLARE_LIFE,
  GADGETS,
  GLASS_RING,
  HIT_RADIUS,
  LAMP_FAIL_SECONDS,
  LAMP_HIT_RADIUS,
  LAMP_RING,
  LIT_THRESHOLD,
  LOADOUT_SECONDS,
  MATCH_OVER_SECONDS,
  MIN_FILL,
  MINE_ARM,
  MINE_EXPOSE,
  MINE_RADIUS,
  MINE_RING,
  MINE_TRIGGERS,
  NOISY_MUL,
  PLAYER_RADIUS,
  ROUND_OVER_SECONDS,
  ROUND_SECONDS,
  RUN_EXPOSE,
  SHARD_RING,
  SONAR_INTERVAL,
  SONAR_RING,
  SONAR_START,
  SPEED,
  STEP_INTERVAL,
  STEP_RING,
  THROW_RANGE,
  VIEW_RANGE,
  WEAPONS,
  WINDUP_SPEED,
  type Gadget,
  type Mode,
  type Stance,
  type Weapon,
} from "../config"
import { clearLine, distToRect, inRect, raycast, rayRect, rectCenter } from "../geom"
import { type MapDef, getMap } from "../maps"
import { Rng } from "../rng"
import { BotBrain } from "./bots"
import { Level } from "./level"
import { type Light, flareLight, flarePower, lampPower, lightAt } from "./light"
import { stepBody } from "./move"

export type Phase = "lobby" | "loadout" | "live" | "over" | "match"

/** One tick of input. fire, reload, gadget and use are presses: set on exactly one intent. */
export type Intent = {
  mx: number
  my: number
  stance: Stance
  aim: number
  fire: boolean
  reload: boolean
  /** Gadget slot pressed this tick, or -1. */
  gadget: -1 | 0 | 1
  /** Throw target for gadgets. */
  tx: number
  ty: number
  use: boolean
}

export const NO_INTENT: Intent = { mx: 0, my: 0, stance: "walk", aim: 0, fire: false, reload: false, gadget: -1, tx: 0, ty: 0, use: false }

export type Loadout = { weapon: Weapon; gadgets: [Gadget, Gadget]; look: number }
export const DEFAULT_LOADOUT: Loadout = { weapon: "pistol", gadgets: ["flare", "decoy"], look: 0 }

export type Stats = {
  kills: number
  deaths: number
  shots: number
  lampsOut: number
  flares: number
  ripples: number
  /** Times an enemy went from not seeing you to seeing you. */
  sightings: number
  stillMax: number
  longest: number
  survived: number
}

const newStats = (): Stats => ({ kills: 0, deaths: 0, shots: 0, lampsOut: 0, flares: 0, ripples: 0, sightings: 0, stillMax: 0, longest: 0, survived: 0 })

export interface Brain {
  think(world: World, p: Player): Intent
}

export type Noise = "silent" | "soft" | "loud" | "gun"

export type Player = {
  id: string
  name: string
  human: boolean
  connected: boolean
  brain: Brain | null
  team: number
  loadout: Loadout
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  stance: Stance
  alive: boolean
  /** Took part in the current round (spawned at its start). */
  inRound: boolean
  mag: number
  reserve: number
  gadgets: [number, number]
  reloadUntil: number
  windupUntil: number
  cooldownUntil: number
  exposedUntil: number
  lastShotAt: number
  lastStepAt: number
  stillFor: number
  queue: { seq: number; intent: Intent }[]
  ack: number
  lit: boolean
  exposed: boolean
  seen: boolean
  noise: Noise
  stats: Stats
}

export type Thing = {
  id: number
  kind: "flare" | "decoy" | "mine"
  owner: string
  key: string
  sx: number
  sy: number
  x: number
  y: number
  thrownAt: number
  landAt: number
  endAt: number
  count: number
  nextAt: number
  disabledUntil: number
}

export type Corpse = { id: string; x: number; y: number; team: number; key: string; aim: number }

export type RingKind = "step" | "run" | "splash" | "crunch" | "shot" | "shotgun" | "reload" | "dry" | "glass" | "lamp" | "door" | "breaker" | "flare" | "emp" | "alarm" | "thud" | "death" | "ping"

export type KillWeapon = Weapon | "left"

export type Award = { kind: "ghost" | "predator" | "lights" | "loudest" | "patience" | "marksman"; id: string; name: string; value: string }

/** Events carry `to` when only some viewers may receive them. */
export type SimEvent =
  | { k: "ring"; x: number; y: number; r: number; kind: RingKind }
  | { k: "shot"; x0: number; y0: number; x1: number; y1: number; weapon: Weapon; to: string[] }
  | { k: "kill"; killer: string; victim: string; weapon: KillWeapon; dist: number }
  | { k: "killcam"; killer: string; weapon: KillWeapon; dist: number; dx: number; dy: number; to: string[] }
  | { k: "lamp"; id: number }
  | { k: "glass"; id: number }
  | { k: "toast"; text: string; to: string[] }
  | { k: "round"; winner: string | null; label: string; round: number }
  | { k: "match"; winner: string | null; label: string; awards: Award[] }

const BOT_NAMES = ["kade", "rei", "mako", "juno", "lexx", "ryn", "zen", "lee", "nox", "ivo", "sable", "wren"]

/** The authoritative match. Transport-agnostic: the room feeds it intents and calls step() at TICK_HZ. */
export class World {
  map: MapDef
  level: Level
  readonly rng: Rng
  mode: Mode = "tdm"
  rounds = 5
  time = 0
  tick = 0
  phase: Phase = "lobby"
  phaseEnd = 0
  roundNo = 0
  roundEnd = 0
  roundsPlayed = 0
  wins: Record<string, number> = {}
  lastWinner: string | null = null
  awards: Award[] = []
  players = new Map<string, Player>()
  order: string[] = []
  things: Thing[] = []
  bolts: { id: number; x: number; y: number }[] = []
  corpses: Corpse[] = []
  events: SimEvent[] = []
  /** Rings in the last few seconds, for bots to hear. */
  heard: { x: number; y: number; r: number; t: number; owner: string; kind: RingKind }[] = []
  private nextId = 1
  private botCount = 0
  private encroachAt = 0
  private sonarAt = 0
  private lightsNow: Light[] = []

  constructor(seed: number, mapId = "office") {
    this.map = getMap(mapId)
    this.level = new Level(this.map)
    this.rng = new Rng(seed)
  }

  // Players ----------------------------------------------------------------------------------------------------------

  /** Adds (or reconnects) a human. Joining mid-match means watching until the next round. */
  addHuman(id: string, name: string, loadout: Loadout = DEFAULT_LOADOUT): Player {
    const existing = this.players.get(id)
    if (existing) {
      existing.connected = true
      existing.name = name
      return existing
    }
    const p = this.newPlayer(id, name, true, null)
    p.loadout = loadout
    p.team = this.smallerTeam()
    const s = this.map.spawns[this.order.length % this.map.spawns.length]!
    p.x = s.x
    p.y = s.y
    this.players.set(id, p)
    this.order.push(id)
    return p
  }

  /** A dropped human forfeits a live round; in the lobby their seat goes away. */
  disconnect(id: string): void {
    const p = this.players.get(id)
    if (!p) return
    p.connected = false
    p.queue = []
    if (this.phase === "lobby") return this.remove(id)
    if (p.alive && this.phase === "live") this.kill(p, null, "left")
    else p.alive = false
  }

  remove(id: string): void {
    this.players.delete(id)
    this.order = this.order.filter((x) => x !== id)
  }

  setLoadout(id: string, loadout: Loadout): void {
    const p = this.players.get(id)
    if (!p) return
    p.loadout = loadout
    // Changing kit during the loadout phase re-arms you with it.
    if (this.phase === "loadout" && p.inRound) this.arm(p)
  }

  get humans(): Player[] {
    return this.order.map((id) => this.players.get(id)!).filter((p) => p.human && p.connected)
  }

  get host(): string {
    return this.humans[0]?.id ?? ""
  }

  /** Whose side a player is on. In free-for-all everyone is their own side. */
  keyOf(p: Player): string {
    return this.mode === "ffa" ? p.id : String(p.team)
  }

  enemy(a: Player, b: Player): boolean {
    return a.id !== b.id && this.keyOf(a) !== this.keyOf(b)
  }

  label(key: string): string {
    if (this.mode === "ffa") return this.players.get(key)?.name ?? "?"
    return key === "0" ? "Red" : "Blue"
  }

  private newPlayer(id: string, name: string, human: boolean, brain: Brain | null): Player {
    return {
      id,
      name,
      human,
      connected: true,
      brain,
      team: 0,
      loadout: DEFAULT_LOADOUT,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: 0,
      stance: "walk",
      alive: false,
      inRound: false,
      mag: 0,
      reserve: 0,
      gadgets: [0, 0],
      reloadUntil: 0,
      windupUntil: 0,
      cooldownUntil: 0,
      exposedUntil: 0,
      lastShotAt: -10,
      lastStepAt: 0,
      stillFor: 0,
      queue: [],
      ack: 0,
      lit: false,
      exposed: false,
      seen: false,
      noise: "silent",
      stats: newStats(),
    }
  }

  private smallerTeam(): number {
    let red = 0
    let blue = 0
    for (const p of this.players.values()) {
      if (!p.connected) continue
      if (p.team === 0) red++
      else blue++
    }
    return red <= blue ? 0 : 1
  }

  /** Tops the match up with bots to MIN_FILL (and even teams in team mode). */
  private fillBots(): void {
    for (const p of [...this.players.values()]) if (!p.human) this.remove(p.id)
    const humans = this.humans
    for (const h of humans) h.team = 0
    humans.forEach((h, i) => (h.team = i % 2))
    let want = Math.max(MIN_FILL, humans.length)
    if (this.mode === "tdm" && want % 2) want++
    for (let i = humans.length; i < want; i++) {
      const name = BOT_NAMES[this.botCount % BOT_NAMES.length]!
      const id = `bot${++this.botCount}`
      const p = this.newPlayer(id, name, false, new BotBrain(this.rng.next() * 1e9))
      p.loadout = { weapon: this.rng.next() < 0.75 ? "pistol" : this.rng.pick(["shotgun", "crossbow"] as const), gadgets: ["flare", "decoy"], look: this.rng.int(5) }
      p.team = this.smallerTeam()
      this.players.set(id, p)
      this.order.push(id)
    }
  }

  // Match flow -------------------------------------------------------------------------------------------------------

  /** Host action: start a match (or a rematch) from the lobby or the scoreboard. */
  start(mode: Mode, rounds: number, mapId = this.map.id): boolean {
    if (this.phase !== "lobby" && this.phase !== "match") return false
    if (mapId !== this.map.id) {
      this.map = getMap(mapId)
      this.level = new Level(this.map)
    }
    this.mode = mode
    this.rounds = rounds
    this.wins = {}
    this.roundsPlayed = 0
    this.roundNo = 0
    this.lastWinner = null
    this.awards = []
    for (const p of this.players.values()) p.stats = newStats()
    this.fillBots()
    this.beginLoadout()
    return true
  }

  private beginLoadout(): void {
    this.phase = "loadout"
    this.phaseEnd = this.time + LOADOUT_SECONDS
    this.roundNo++
    this.things = []
    this.bolts = []
    this.corpses = []
    this.level.reset()
    const spawns = this.spawnOrder()
    let s = 0
    for (const id of this.order) {
      const p = this.players.get(id)!
      p.inRound = p.connected
      p.alive = p.connected
      if (!p.alive) continue
      const sp = spawns[s++ % spawns.length]!
      p.x = sp.x
      p.y = sp.y
      p.vx = 0
      p.vy = 0
      p.stance = "walk"
      p.queue = []
      p.exposedUntil = 0
      p.stillFor = 0
      p.seen = false
      this.arm(p)
    }
  }

  /** Spawns shuffled, then ordered so teams start on opposite sides. */
  private spawnOrder() {
    const spawns = this.map.spawns.slice()
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1)
      ;[spawns[i], spawns[j]] = [spawns[j]!, spawns[i]!]
    }
    if (this.mode !== "tdm") return spawns
    const cx = this.map.size[0] / 2
    const west = spawns.filter((s) => s.x < cx)
    const east = spawns.filter((s) => s.x >= cx)
    const flip = this.roundNo % 2 === 0
    const reds = flip ? east : west
    const blues = flip ? west : east
    const out = []
    const order = this.order.map((id) => this.players.get(id)!).filter((p) => p.connected)
    let r = 0
    let b = 0
    for (const p of order) out.push(p.team === 0 ? (reds[r++ % reds.length] ?? spawns[0]!) : (blues[b++ % blues.length] ?? spawns[0]!))
    return out
  }

  private arm(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    p.mag = w.mag
    p.reserve = w.reserve
    p.reloadUntil = 0
    p.windupUntil = 0
    p.cooldownUntil = 0
    p.gadgets = [GADGETS[p.loadout.gadgets[0]].count, GADGETS[p.loadout.gadgets[1]].count]
  }

  private beginLive(): void {
    this.phase = "live"
    this.roundEnd = this.time + ROUND_SECONDS
    this.encroachAt = this.time + ROUND_SECONDS * ENCROACH_START
    this.sonarAt = this.roundEnd - SONAR_START
    for (const p of this.players.values()) p.lastStepAt = this.time
  }

  private endRound(winner: string | null): void {
    this.roundsPlayed++
    if (winner !== null) this.wins[winner] = (this.wins[winner] ?? 0) + 1
    for (const p of this.players.values()) if (p.alive && p.inRound) p.stats.survived++
    this.lastWinner = winner
    this.phase = "over"
    this.phaseEnd = this.time + ROUND_OVER_SECONDS
    this.events.push({ k: "round", winner, label: winner === null ? "Draw" : this.label(winner), round: this.roundNo })
  }

  /** Whether the match is decided, and by whom (null for a draw). */
  result(): { decided: boolean; winner: string | null } {
    const need = Math.floor(this.rounds / 2) + 1
    const ranked = Object.entries(this.wins).sort((a, b) => b[1] - a[1])
    const top = ranked[0]
    if (top && top[1] >= need) return { decided: true, winner: top[0] }
    if (this.roundsPlayed < this.rounds) return { decided: false, winner: null }
    if (!top || (ranked[1] && ranked[1][1] === top[1])) return { decided: true, winner: null }
    return { decided: true, winner: top[0] }
  }

  private endMatch(): void {
    const { winner } = this.result()
    this.phase = "match"
    this.phaseEnd = this.time + MATCH_OVER_SECONDS
    this.awards = this.computeAwards()
    this.events.push({ k: "match", winner, label: winner === null ? "Draw" : this.label(winner), awards: this.awards })
  }

  private toLobby(): void {
    this.phase = "lobby"
    this.phaseEnd = 0
    this.corpses = []
    this.things = []
    this.bolts = []
    this.level.reset()
    for (const p of [...this.players.values()]) {
      p.alive = false
      p.inRound = false
      if (!p.human || !p.connected) this.remove(p.id)
    }
  }

  // Tick -------------------------------------------------------------------------------------------------------------

  push(id: string, seq: number, intent: Intent): void {
    const p = this.players.get(id)
    if (!p || !p.human) return
    const last = p.queue.length ? p.queue[p.queue.length - 1]!.seq : p.ack
    if (seq <= last) return
    p.queue.push({ seq, intent })
    if (p.queue.length > 8) p.queue.splice(0, p.queue.length - 3)
  }

  takeEvents(): SimEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  step(): void {
    this.time += DT
    this.tick++
    this.advancePhase()
    this.updateLamps()
    this.lightsNow = this.lights()
    for (const id of this.order) {
      const p = this.players.get(id)
      if (!p) continue
      let intent = NO_INTENT
      if (p.brain) {
        if (this.phase === "live" && p.alive) intent = p.brain.think(this, p)
      } else {
        const q = p.queue.shift()
        if (q) {
          intent = q.intent
          p.ack = q.seq
        }
      }
      this.apply(p, intent)
    }
    this.updateThings()
    this.lightsNow = this.lights()
    this.updateExposure()
    if (this.phase === "live") this.checkRoundEnd()
    const cutoff = this.time - 3
    while (this.heard.length && this.heard[0]!.t < cutoff) this.heard.shift()
  }

  private advancePhase(): void {
    if (this.phase === "loadout" && this.time >= this.phaseEnd) this.beginLive()
    else if (this.phase === "live" && this.time >= this.roundEnd) this.endRound(this.timeoutWinner())
    else if (this.phase === "over" && this.time >= this.phaseEnd) {
      if (this.result().decided) this.endMatch()
      else this.beginLoadout()
    } else if (this.phase === "match" && this.time >= this.phaseEnd) this.toLobby()
  }

  private aliveBySide(): Map<string, number> {
    const m = new Map<string, number>()
    for (const p of this.players.values()) if (p.inRound && p.alive) m.set(this.keyOf(p), (m.get(this.keyOf(p)) ?? 0) + 1)
    return m
  }

  /** At time-out the side with more players alive wins; level is a draw. */
  private timeoutWinner(): string | null {
    const sides = [...this.aliveBySide().entries()].sort((a, b) => b[1] - a[1])
    if (!sides[0] || (sides[1] && sides[1][1] === sides[0][1])) return null
    return sides[0][0]
  }

  private checkRoundEnd(): void {
    let participants = 0
    for (const p of this.players.values()) if (p.inRound) participants++
    if (participants < 2) return
    const sides = this.aliveBySide()
    if (sides.size === 0) this.endRound(null)
    else if (sides.size === 1) this.endRound([...sides.keys()][0]!)
  }

  private apply(p: Player, i: Intent): void {
    if (this.phase !== "live" || !p.alive) {
      p.vx = 0
      p.vy = 0
      p.noise = "silent"
      if (this.phase === "loadout" && p.alive) p.aim = i.aim
      return
    }
    p.aim = i.aim
    if (p.windupUntil > 0 && this.time >= p.windupUntil) this.fire(p)
    if (p.reloadUntil > 0 && this.time >= p.reloadUntil) this.finishReload(p)
    if (i.reload) this.startReload(p)
    p.stance = i.stance
    const speed = p.windupUntil > 0 ? WINDUP_SPEED : SPEED[i.stance]
    stepBody(p, i.mx, i.my, speed, this.level.solids, DT)
    const v = Math.hypot(p.vx, p.vy)
    if (v < 0.15) p.stillFor += DT
    else p.stillFor = 0
    if (p.stillFor > p.stats.stillMax) p.stats.stillMax = p.stillFor
    if (v > 0.4) {
      const gait: Stance = v > SPEED.walk + 0.4 ? "run" : v > SPEED.sneak + 0.2 ? "walk" : "sneak"
      if (this.time - p.lastStepAt >= STEP_INTERVAL[gait]) this.footstep(p, gait)
    }
    this.pickupBolts(p)
    if (i.use) this.use(p)
    if (i.gadget !== -1) this.gadget(p, i.gadget, i.tx, i.ty)
    if (i.fire) this.trigger(p)
    p.noise = this.time - p.lastShotAt < 1 ? "gun" : v < 0.4 || p.stance === "sneak" ? "silent" : p.stance === "run" ? "loud" : "soft"
  }

  private footstep(p: Player, gait: Stance): void {
    const surface = this.surfaceAt(p.x, p.y)
    p.lastStepAt = this.time
    if (gait === "sneak") {
      if (surface === "shards") this.ring(p.x, p.y, SHARD_RING, "crunch", p.id)
      return
    }
    const mul = surface === "grate" || surface === "puddle" ? NOISY_MUL : 1
    const kind: RingKind = surface === "puddle" ? "splash" : surface === "shards" ? "crunch" : gait === "run" ? "run" : "step"
    this.ring(p.x, p.y, STEP_RING[gait] * mul, kind, p.id)
    if (gait === "run") this.expose(p, RUN_EXPOSE)
  }

  surfaceAt(x: number, y: number): "grate" | "puddle" | "shards" | null {
    for (const g of this.map.glass) if (this.level.glassBroken[g.id] && inRect(x, y, g.rect, 0.9)) return "shards"
    for (const n of this.map.noisy) if (inRect(x, y, n.rect)) return n.kind
    return null
  }

  ring(x: number, y: number, r: number, kind: RingKind, owner = ""): void {
    this.events.push({ k: "ring", x, y, r, kind })
    this.heard.push({ x, y, r, t: this.time, owner, kind })
    const p = owner ? this.players.get(owner) : undefined
    if (p && kind !== "ping" && kind !== "death") p.stats.ripples++
  }

  private expose(p: Player, seconds: number): void {
    p.exposedUntil = Math.max(p.exposedUntil, this.time + seconds)
  }

  // Weapons ----------------------------------------------------------------------------------------------------------

  private startReload(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    if (p.reloadUntil > 0 || p.windupUntil > 0 || p.mag >= w.mag || p.reserve <= 0) return
    p.reloadUntil = this.time + w.reload
    if (w.reloadNoise > 0) this.ring(p.x, p.y, w.reloadNoise, "reload", p.id)
  }

  private finishReload(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    const take = Math.min(w.mag - p.mag, p.reserve)
    p.mag += take
    p.reserve -= take
    p.reloadUntil = 0
  }

  private trigger(p: Player): void {
    if (p.windupUntil > 0 || p.reloadUntil > 0 || this.time < p.cooldownUntil) return
    if (p.mag <= 0) {
      p.cooldownUntil = this.time + 0.4
      this.ring(p.x, p.y, 3, "dry", p.id)
      return
    }
    p.windupUntil = this.time + WEAPONS[p.loadout.weapon].windup
  }

  private fire(p: Player): void {
    const weapon = p.loadout.weapon
    const w = WEAPONS[weapon]
    p.windupUntil = 0
    if (p.mag <= 0) return
    p.mag--
    p.stats.shots++
    p.lastShotAt = this.time
    p.cooldownUntil = this.time + w.cooldown
    if (w.noise > 0) this.ring(p.x, p.y, w.noise, weapon === "shotgun" ? "shotgun" : "shot", p.id)
    this.expose(p, w.expose)
    const killed = new Set<string>()
    const witnesses = [...this.players.values()].filter((q) => q.id === p.id || this.sees(q, p, true)).map((q) => q.id)
    for (let k = 0; k < w.pellets; k++) {
      const a = p.aim + (w.pellets > 1 ? ((k / (w.pellets - 1)) * 2 - 1) * w.spread + this.rng.range(-0.02, 0.02) : 0)
      const end = this.trace(p, a, weapon, killed)
      this.events.push({ k: "shot", x0: p.x, y0: p.y, x1: end.x, y1: end.y, weapon, to: witnesses })
    }
    if (w.bolts && p.mag === 0 && p.reserve > 0) p.reloadUntil = this.time + w.reload
  }

  /** One bullet: shatters glass on the way, stops at the first wall, enemy or lamp. Returns where it stopped. */
  private trace(shooter: Player, a: number, weapon: Weapon, killed: Set<string>): { x: number; y: number } {
    const w = WEAPONS[weapon]
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const wallT = raycast(shooter.x, shooter.y, dx, dy, this.level.blockers, w.range)
    let stop = Math.min(wallT, w.range)
    let victim: Player | null = null
    let lamp = -1
    for (const q of this.players.values()) {
      if (!q.alive || killed.has(q.id) || !this.enemy(shooter, q)) continue
      const t = (q.x - shooter.x) * dx + (q.y - shooter.y) * dy
      const off = Math.abs(-(q.x - shooter.x) * dy + (q.y - shooter.y) * dx)
      if (t > 0 && t < stop && off <= HIT_RADIUS) {
        stop = t
        victim = q
      }
    }
    for (const l of this.map.lights) {
      if (!l.shootable || this.level.lamps[l.id]!.broken) continue
      const t = (l.x - shooter.x) * dx + (l.y - shooter.y) * dy
      const off = Math.abs(-(l.x - shooter.x) * dy + (l.y - shooter.y) * dx)
      if (t > 0.5 && t < stop && off <= LAMP_HIT_RADIUS) {
        stop = t
        lamp = l.id
        victim = null
      }
    }
    for (const g of this.map.glass) {
      if (this.level.glassBroken[g.id]) continue
      const t = rayRect(shooter.x, shooter.y, dx, dy, g.rect, stop)
      if (t < stop) this.breakGlass(g.id, shooter.x + dx * t, shooter.y + dy * t, shooter.id)
    }
    const x = shooter.x + dx * stop
    const y = shooter.y + dy * stop
    if (victim) {
      killed.add(victim.id)
      this.kill(victim, shooter, weapon)
    } else if (lamp >= 0) this.breakLamp(lamp, shooter)
    else if (w.bolts) {
      this.bolts.push({ id: this.nextId++, x: x - dx * 0.25, y: y - dy * 0.25 })
      this.ring(x, y, 6, "thud", shooter.id)
    }
    if (victim && w.bolts) this.bolts.push({ id: this.nextId++, x: victim.x, y: victim.y })
    return { x, y }
  }

  private breakGlass(id: number, x: number, y: number, by: string): void {
    this.level.glassBroken[id] = true
    this.level.rebuild()
    this.ring(x, y, GLASS_RING, "glass", by)
    this.events.push({ k: "glass", id })
  }

  private breakLamp(id: number, by: Player): void {
    const s = this.level.lamps[id]!
    s.broken = true
    s.failAt = 0
    by.stats.lampsOut++
    const l = this.map.lights[id]!
    this.ring(l.x, l.y, LAMP_RING, "lamp", by.id)
    this.events.push({ k: "lamp", id })
    this.events.push({ k: "toast", text: "LIGHT DESTROYED · ZONE DARK", to: [by.id] })
  }

  kill(victim: Player, killer: Player | null, weapon: KillWeapon): void {
    if (!victim.alive) return
    victim.alive = false
    victim.vx = 0
    victim.vy = 0
    victim.windupUntil = 0
    victim.reloadUntil = 0
    victim.stats.deaths++
    const dist = killer ? Math.hypot(killer.x - victim.x, killer.y - victim.y) : 0
    if (killer) {
      killer.stats.kills++
      killer.stats.longest = Math.max(killer.stats.longest, dist)
    }
    this.corpses.push({ id: victim.id, x: victim.x, y: victim.y, team: victim.team, key: this.keyOf(victim), aim: victim.aim })
    if (weapon !== "left") this.ring(victim.x, victim.y, DEATH_RING, "death")
    this.events.push({ k: "kill", killer: killer?.id ?? "", victim: victim.id, weapon, dist })
    if (killer) this.events.push({ k: "killcam", killer: killer.id, weapon, dist, dx: (killer.x - victim.x) / (dist || 1), dy: (killer.y - victim.y) / (dist || 1), to: [victim.id] })
  }

  // Gadgets, doors, breakers, bolts ---------------------------------------------------------------------------------

  /** Where a thrown gadget lands: toward the target, at most THROW_RANGE, short of the first wall. */
  private landing(p: Player, tx: number, ty: number): { x: number; y: number } {
    let dx = tx - p.x
    let dy = ty - p.y
    let d = Math.hypot(dx, dy)
    if (d < 0.5) {
      dx = Math.cos(p.aim)
      dy = Math.sin(p.aim)
      d = 1
    } else {
      dx /= d
      dy /= d
    }
    d = Math.min(Math.max(d, 1), THROW_RANGE)
    const hit = raycast(p.x, p.y, dx, dy, this.level.solids, d)
    if (hit !== Infinity) d = Math.max(0.4, hit - 0.35)
    return { x: p.x + dx * d, y: p.y + dy * d }
  }

  private gadget(p: Player, slot: 0 | 1, tx: number, ty: number): void {
    if (p.gadgets[slot] <= 0) return
    const kind = p.loadout.gadgets[slot]
    p.gadgets[slot]--
    const key = this.keyOf(p)
    const base = { id: this.nextId++, owner: p.id, key, sx: p.x, sy: p.y, thrownAt: this.time, count: 0, nextAt: 0, disabledUntil: 0 }
    if (kind === "emp") {
      this.ring(p.x, p.y, 12, "emp", p.id)
      for (const l of this.map.lights) if (l.kind !== "moon" && Math.hypot(l.x - p.x, l.y - p.y) <= EMP_RADIUS) this.level.lamps[l.id]!.dimUntil = this.time + EMP_SECONDS
      for (const t of this.things) if (t.kind === "mine" && Math.hypot(t.x - p.x, t.y - p.y) <= EMP_RADIUS) t.disabledUntil = this.time + EMP_SECONDS
      return
    }
    if (kind === "mine") {
      const x = p.x + Math.cos(p.aim) * 0.5
      const y = p.y + Math.sin(p.aim) * 0.5
      const spot = this.level.solids.some((r) => inRect(x, y, r, 0.1)) ? { x: p.x, y: p.y } : { x, y }
      this.things.push({ ...base, kind: "mine", ...spot, landAt: this.time + 0.3, endAt: Infinity })
      return
    }
    const at = this.landing(p, tx, ty)
    if (kind === "flare") {
      p.stats.flares++
      this.things.push({ ...base, kind: "flare", ...at, landAt: this.time + FLARE_FLIGHT, endAt: this.time + FLARE_FLIGHT + FLARE_LIFE })
    } else {
      this.things.push({ ...base, kind: "decoy", ...at, landAt: this.time + DECOY_FLIGHT, endAt: this.time + DECOY_FLIGHT + DECOY_PINGS + 1, nextAt: this.time + DECOY_FLIGHT + 0.4 })
    }
  }

  private updateThings(): void {
    for (const t of this.things) {
      if (t.kind === "flare" && t.count === 0 && this.time >= t.landAt) {
        t.count = 1
        this.ring(t.x, t.y, 5, "flare", t.owner)
      }
      // A decoy sounds exactly like a suppressed pistol.
      if (t.kind === "decoy" && t.count < DECOY_PINGS && this.time >= t.nextAt) {
        t.count++
        t.nextAt = this.time + 0.7 + this.rng.next() * 0.9
        this.ring(t.x, t.y, WEAPONS.pistol.noise, "shot", t.owner)
      }
      if (t.kind === "mine" && this.time >= t.landAt + MINE_ARM && this.time >= t.disabledUntil && this.time >= t.nextAt) {
        for (const q of this.players.values()) {
          if (!q.alive || this.keyOf(q) === t.key) continue
          if (Math.hypot(q.x - t.x, q.y - t.y) > MINE_RADIUS || Math.hypot(q.vx, q.vy) <= SPEED.sneak + 0.15) continue
          t.count++
          t.nextAt = this.time + 1.5
          this.ring(q.x, q.y, MINE_RING, "alarm", t.owner)
          this.expose(q, MINE_EXPOSE)
          this.events.push({ k: "toast", text: "MOTION MINE TRIPPED", to: [t.owner] })
          break
        }
      }
    }
    this.things = this.things.filter((t) => (t.kind === "mine" ? t.count < MINE_TRIGGERS : this.time < t.endAt))
  }

  private use(p: Player): void {
    let door = -1
    let best = Infinity
    for (const d of this.map.doors) {
      const dd = distToRect(p.x, p.y, d.rect)
      if (dd < best && dd <= 1.3) {
        best = dd
        door = d.id
      }
    }
    const breaker = this.map.breakers.find((b) => Math.hypot(b.x - p.x, b.y - p.y) <= 1.3 && Math.hypot(b.x - p.x, b.y - p.y) < best)
    if (breaker) {
      const lamps = this.map.lights.filter((l) => l.group === breaker.group)
      const off = !this.level.lamps[lamps[0]!.id]!.off
      for (const l of lamps) this.level.lamps[l.id]!.off = off
      this.ring(breaker.x, breaker.y, BREAKER_RING, "breaker", p.id)
      this.events.push({ k: "toast", text: off ? "BREAKER · CORRIDOR LIGHTS OFF" : "BREAKER · CORRIDOR LIGHTS ON", to: [p.id] })
      return
    }
    if (door < 0) return
    const d = this.map.doors[door]!
    const open = !this.level.doorsOpen[door]
    if (!open && [...this.players.values()].some((q) => q.alive && distToRect(q.x, q.y, d.rect) < PLAYER_RADIUS + 0.02)) return
    this.level.doorsOpen[door] = open
    this.level.rebuild()
    const c = rectCenter(d.rect)
    const quiet = p.stance === "sneak"
    this.ring(c.x, c.y, quiet ? DOOR_RING.quiet : DOOR_RING.loud, "door", p.id)
  }

  private pickupBolts(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    if (!w.bolts || p.mag + p.reserve >= w.mag + w.reserve) return
    const i = this.bolts.findIndex((b) => Math.hypot(b.x - p.x, b.y - p.y) <= BOLT_REACH)
    if (i < 0) return
    this.bolts.splice(i, 1)
    p.reserve++
  }

  // Lamps and late-round pressure ------------------------------------------------------------------------------------

  private updateLamps(): void {
    if (this.phase !== "live") return
    if (this.time >= this.encroachAt) {
      this.encroachAt += ENCROACH_INTERVAL
      const pool = this.map.lights.filter((l) => {
        const s = this.level.lamps[l.id]!
        return l.kind !== "moon" && l.kind !== "exit" && !s.broken && !s.off && s.failAt === 0
      })
      if (pool.length > 2) this.level.lamps[this.rng.pick(pool).id]!.failAt = this.time + LAMP_FAIL_SECONDS
    }
    for (const l of this.map.lights) {
      const s = this.level.lamps[l.id]!
      if (s.failAt > 0 && this.time >= s.failAt) {
        s.failAt = 0
        s.broken = true
        this.ring(l.x, l.y, 10, "lamp")
        this.events.push({ k: "lamp", id: l.id })
      }
    }
    if (this.time >= this.sonarAt) {
      this.sonarAt += SONAR_INTERVAL
      for (const p of this.players.values()) if (p.alive) this.ring(p.x, p.y, SONAR_RING, "ping")
    }
  }

  /** Lights as the rules see them now: lit map lights and burning flares. */
  lights(t = this.time): Light[] {
    const out: Light[] = []
    for (const l of this.map.lights) {
      const power = lampPower(l, this.level.lamps[l.id]!, t)
      if (power > 0) out.push({ x: l.x, y: l.y, r: l.r, power, cone: l.cone })
    }
    for (const th of this.things) {
      if (th.kind !== "flare") continue
      const power = flarePower(t, th.landAt, th.endAt)
      if (power > 0) out.push(flareLight(th.x, th.y, power))
    }
    return out
  }

  // Exposure and visibility ------------------------------------------------------------------------------------------

  litAt(x: number, y: number): boolean {
    return lightAt(x, y, this.lightsNow, this.level.occluders) >= LIT_THRESHOLD
  }

  private updateExposure(): void {
    for (const p of this.players.values()) {
      p.lit = p.alive && this.litAt(p.x, p.y)
      p.exposed = p.alive && (p.lit || this.time < p.exposedUntil)
    }
    for (const t of this.players.values()) {
      if (!t.alive) {
        t.seen = false
        continue
      }
      let seen = false
      for (const v of this.players.values()) {
        if (this.enemy(v, t) && this.sees(v, t, true)) {
          seen = true
          break
        }
      }
      if (seen && !t.seen && this.phase === "live") t.stats.sightings++
      t.seen = seen
    }
  }

  /**
   * The visibility rule, evaluated only on the server. An enemy is visible when they are exposed (lit, ran, fired or
   * tripped a mine), within VIEW_RANGE, and nothing blocks the line between you. Teammates always see each other
   * unless `strict`. The dead see nobody.
   */
  sees(viewer: Player, target: Player, strict = false): boolean {
    if (!viewer.alive || !target.alive || viewer.id === target.id) return false
    if (!strict && !this.enemy(viewer, target)) return true
    if (!target.exposed) return false
    if (Math.hypot(target.x - viewer.x, target.y - viewer.y) > VIEW_RANGE) return false
    return clearLine(viewer.x, viewer.y, target.x, target.y, this.level.occluders)
  }

  /** 0..1 for your own HUD meter. */
  exposureOf(p: Player): number {
    if (!p.alive) return 0
    if (p.lit) return 1
    if (this.time < p.exposedUntil) return 0.75
    const v = Math.hypot(p.vx, p.vy)
    if (v > SPEED.sneak + 0.2) return 0.3
    return 0
  }

  private computeAwards(): Award[] {
    const ps = [...this.players.values()].filter((p) => p.stats.shots + p.stats.deaths + p.stats.kills + p.stats.ripples + p.stats.survived > 0)
    if (!ps.length) return []
    const top = (f: (p: Player) => number) => ps.reduce((a, b) => (f(b) > f(a) ? b : a))
    const out: Award[] = []
    const ghost = ps.reduce((a, b) => (b.stats.sightings < a.stats.sightings || (b.stats.sightings === a.stats.sightings && b.stats.survived > a.stats.survived) ? b : a))
    out.push({ kind: "ghost", id: ghost.id, name: ghost.name, value: ghost.stats.sightings === 0 ? "never seen" : `seen ${ghost.stats.sightings}×` })
    const pred = top((p) => p.stats.kills)
    if (pred.stats.kills > 0) out.push({ kind: "predator", id: pred.id, name: pred.name, value: `${pred.stats.kills} kill${pred.stats.kills === 1 ? "" : "s"}` })
    const lights = top((p) => p.stats.lampsOut)
    if (lights.stats.lampsOut > 0) out.push({ kind: "lights", id: lights.id, name: lights.name, value: `${lights.stats.lampsOut} light${lights.stats.lampsOut === 1 ? "" : "s"} out` })
    const loud = top((p) => p.stats.ripples)
    if (loud.stats.ripples > 0) out.push({ kind: "loudest", id: loud.id, name: loud.name, value: `${loud.stats.ripples} ripples` })
    const still = top((p) => p.stats.stillMax)
    if (still.stats.stillMax >= 3) out.push({ kind: "patience", id: still.id, name: still.name, value: `still for ${Math.round(still.stats.stillMax)} s` })
    const mark = top((p) => p.stats.longest)
    if (mark.stats.longest > 0) out.push({ kind: "marksman", id: mark.id, name: mark.name, value: `${Math.round(mark.stats.longest)} m kill` })
    return out
  }
}
