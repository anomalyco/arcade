import {
  DECOY_FLIGHT,
  DOOR_REACH,
  DT,
  EMP_RADIUS,
  EMP_SECONDS,
  ENCROACH_INTERVAL,
  ENCROACH_START,
  FLARE_FLIGHT,
  FLARE_LIFE,
  FLARE_POWER,
  FOOT_INTERVAL,
  FOOT_RING,
  FIRE_EXPOSE_SECONDS,
  GADGETS,
  HIT_RADIUS,
  LAMP_HIT_RADIUS,
  LOADOUT_SECONDS,
  MATCH_OVER_SECONDS,
  MIN_FILL,
  MINE_ARM,
  MINE_KILL,
  MINE_TRIGGER,
  MODES,
  NOISY_SURFACE_MUL,
  PICKUP_REACH,
  PLAYER_RADIUS,
  ROUND_OVER_SECONDS,
  ROUND_SECONDS,
  RUN_EXPOSE_SECONDS,
  THROW_RANGE,
  VIEW_RANGE,
  WEAPONS,
  type Gadget,
  type Mode,
  type Stance,
  type Weapon,
  LIT_THRESHOLD,
} from "../config"
import { type Rect, clearLine, raycast } from "../geom"
import { type MapDef, getMap } from "../maps"
import { Rng } from "../rng"
import { BotBrain } from "./bots"
import { type Light, lightAt } from "./light"
import { stepBody } from "./move"

export type Phase = "lobby" | "loadout" | "live" | "over" | "match"

/** One tick of player input. Fire, reload, gadget and use are edge events: each is set on exactly one intent. */
export type Intent = {
  mx: number
  my: number
  stance: Stance
  aim: number
  fire: boolean
  reload: boolean
  /** Gadget slot pressed this tick, or -1. */
  gadget: -1 | 0 | 1
  tx: number
  ty: number
  use: boolean
}

export const NO_INTENT: Intent = { mx: 0, my: 0, stance: "walk", aim: 0, fire: false, reload: false, gadget: -1, tx: 0, ty: 0, use: false }

export type Loadout = { weapon: Weapon; gadgets: [Gadget, Gadget] }

export type Stats = {
  kills: number
  deaths: number
  shots: number
  lampsOut: number
  flares: number
  ripples: number
  /** How many times an enemy went from unable to see you to able to see you. */
  sightings: number
  stillMax: number
}

export type Brain = { think(world: World, p: Player): Intent }

export type Player = {
  id: string
  name: string
  team: number
  human: boolean
  connected: boolean
  brain: Brain | null
  loadout: Loadout
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  stance: Stance
  alive: boolean
  inRound: boolean
  spectator: boolean
  mag: number
  reserve: number
  gadgets: [number, number]
  reloadUntil: number
  windup: { until: number; aim: number } | null
  cooldownUntil: number
  lastRunAt: number
  lastFireAt: number
  nextStepAt: number
  stillRun: number
  queue: { seq: number; intent: Intent }[]
  ack: number
  seen: boolean
  stats: Stats
  killedBy: string
  /** Lit by a light source this tick. */
  lit: boolean
  exposed: boolean
  /** Noise this tick, for the HUD label. */
  noise: "silent" | "soft" | "loud" | "gun"
}

export type Lamp = {
  id: number
  x: number
  y: number
  radius: number
  power: number
  color: readonly [number, number, number]
  broken: boolean
  shot: boolean
  dimUntil: number
  failAt: number
}

export type DoorState = { id: number; rect: Rect; open: boolean }

export type Thing = {
  id: number
  kind: "flare" | "decoy" | "mine"
  owner: string
  team: string
  sx: number
  sy: number
  x: number
  y: number
  landAt: number
  endAt: number
  pings: number
  disabledUntil: number
}

export type Bolt = { id: number; x: number; y: number; owner: string }

export type Ripple = { x: number; y: number; r: number; t: number }

export type SimEvent =
  | { k: "ripple"; x: number; y: number; r: number; kind: RippleKind; t: number }
  | { k: "shot"; x0: number; y0: number; x1: number; y1: number; hit: boolean; to: string[] }
  | { k: "kill"; killer: string; victim: string; weapon: Weapon | "mine" | "lamp"; dist: number }
  | { k: "killcam"; killer: string; victim: string; x0: number; y0: number; x1: number; y1: number; weapon: Weapon | "mine"; dist: number; to: string[] }
  | { k: "lamp"; id: number; x: number; y: number; by: string }
  | { k: "toast"; text: string; to: string[] }
  | { k: "round"; winner: string | null; label: string; round: number }
  | { k: "match"; winner: string | null; label: string }
  | { k: "door"; id: number; open: boolean }

export type RippleKind = "step" | "shot" | "reload" | "glass" | "slam" | "creak" | "flare" | "decoy" | "emp" | "mine" | "thud"

export type Award = { kind: "ghost" | "lights" | "loudest" | "patience"; id: string; name: string; value: string }

const BOT_NAMES = ["kade", "rei", "mako", "dev_sam", "lexx", "juno", "ryn", "zen", "lee", "nox"]

/** Authoritative match state. Transport-agnostic: the Durable Object feeds it intents and calls step() at TICK_HZ. */
export class World {
  readonly map: MapDef
  readonly rng: Rng
  mode: Mode = "tdm"
  rounds = 5
  time = 0
  tick = 0
  phase: Phase = "lobby"
  phaseEnd = 0
  roundNo = 0
  roundEnd = 0
  roundStart = 0
  roundsPlayed = 0
  wins: Record<string, number> = {}
  lastWinner: string | null = null
  players = new Map<string, Player>()
  order: string[] = []
  lamps: Lamp[] = []
  doors: DoorState[] = []
  things: Thing[] = []
  bolts: Bolt[] = []
  walls: Rect[] = []
  events: SimEvent[] = []
  heard: (Ripple & { owner: string })[] = []
  encroachAt = 0
  nextThingId = 1
  private botCount = 0

  constructor(seed: number, mode: Mode = "tdm", rounds = 5, mapId = "warehouse") {
    this.map = getMap(mapId)
    this.rng = new Rng(seed)
    this.mode = MODES.includes(mode) ? mode : "tdm"
    this.rounds = rounds
    this.lamps = this.map.lamps.map((l) => ({ id: l.id, x: l.x, y: l.y, radius: l.radius, power: l.power, color: l.color, broken: false, shot: false, dimUntil: 0, failAt: 0 }))
    this.doors = this.map.doors.map((d) => ({ id: d.id, rect: d.rect, open: false }))
    this.rebuildWalls()
  }

  // Players ----------------------------------------------------------------------------------------------------------

  addHuman(id: string, name: string): Player {
    const existing = this.players.get(id)
    if (existing) {
      existing.connected = true
      return existing
    }
    const p = this.newPlayer(id, name, true, null)
    p.team = this.smallerTeam()
    p.spectator = this.phase === "live"
    const spawn = this.map.spawns[0]!
    p.x = spawn.x
    p.y = spawn.y
    this.players.set(id, p)
    this.order.push(id)
    return p
  }

  /** Connection dropped. A seat in a live round is forfeited; the seat itself stays for a reconnect in the same match. */
  disconnect(id: string): void {
    const p = this.players.get(id)
    if (!p) return
    p.connected = false
    if (p.inRound && this.phase === "live") {
      p.alive = false
      p.inRound = false
    }
    if (this.phase === "lobby") this.removePlayer(id)
  }

  removePlayer(id: string): void {
    this.players.delete(id)
    this.order = this.order.filter((x) => x !== id)
  }

  setLoadout(id: string, loadout: Loadout): void {
    const p = this.players.get(id)
    if (p) p.loadout = loadout
  }

  /** Humans in join order, then bots. */
  get humans(): Player[] {
    return this.order.map((id) => this.players.get(id)!).filter((p) => p.human && p.connected)
  }

  get host(): string {
    return this.humans[0]?.id ?? ""
  }

  /** Who a player's enemies are. In FFA everyone is their own team. */
  teamKey(p: Player): string {
    return this.mode === "ffa" ? p.id : String(p.team)
  }

  enemy(a: Player, b: Player): boolean {
    return a.id !== b.id && this.teamKey(a) !== this.teamKey(b)
  }

  label(key: string): string {
    if (this.mode === "ffa") return this.players.get(key)?.name ?? "?"
    return key === "0" ? "Red" : "Blue"
  }

  private newPlayer(id: string, name: string, human: boolean, brain: Brain | null): Player {
    return {
      id,
      name,
      team: 0,
      human,
      connected: true,
      brain,
      loadout: { weapon: "pistol", gadgets: ["flare", "decoy"] },
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: 0,
      stance: "walk",
      alive: false,
      inRound: false,
      spectator: false,
      mag: WEAPONS.pistol.mag,
      reserve: WEAPONS.pistol.reserve,
      gadgets: [GADGETS.flare.count, GADGETS.decoy.count],
      reloadUntil: 0,
      windup: null,
      cooldownUntil: 0,
      lastRunAt: -10,
      lastFireAt: -10,
      nextStepAt: 0,
      stillRun: 0,
      queue: [],
      ack: 0,
      seen: false,
      stats: { kills: 0, deaths: 0, shots: 0, lampsOut: 0, flares: 0, ripples: 0, sightings: 0, stillMax: 0 },
      killedBy: "",
      lit: false,
      exposed: false,
      noise: "silent",
    }
  }

  private smallerTeam(): number {
    let a = 0
    let b = 0
    for (const p of this.players.values()) {
      if (!p.connected) continue
      if (p.team === 0) a++
      else b++
    }
    return a <= b ? 0 : 1
  }

  /** Brings the room up to MIN_FILL participants with bots, balanced across teams. */
  fillBots(): void {
    const humans = this.humans.length
    const want = Math.max(MIN_FILL, humans)
    for (const id of [...this.players.keys()]) {
      const p = this.players.get(id)!
      if (!p.human) this.removePlayer(id)
    }
    for (let i = humans; i < want; i++) {
      const id = `bot${++this.botCount}`
      const name = BOT_NAMES[(this.botCount - 1) % BOT_NAMES.length]!
      const p = this.newPlayer(id, name, false, null)
      p.brain = new BotBrain(this.rng.next())
      p.team = this.smallerTeam()
      this.players.set(id, p)
      this.order.push(id)
    }
    for (const p of this.players.values()) {
      if (!p.human) p.team = this.smallerTeam()
    }
  }

  // Match flow -------------------------------------------------------------------------------------------------------

  startMatch(mode: Mode, rounds: number): void {
    this.mode = mode
    this.rounds = rounds
    this.wins = {}
    this.roundsPlayed = 0
    this.lastWinner = null
    this.roundNo = 0
    for (const p of this.players.values()) {
      p.stats = { kills: 0, deaths: 0, shots: 0, lampsOut: 0, flares: 0, ripples: 0, sightings: 0, stillMax: 0 }
      p.seen = false
    }
    this.beginLoadout()
  }

  private beginLoadout(): void {
    this.fillBots()
    this.phase = "loadout"
    this.phaseEnd = this.time + LOADOUT_SECONDS
    this.roundNo++
    this.things = []
    this.bolts = []
    this.lamps.forEach((l) => {
      l.broken = false
      l.shot = false
      l.dimUntil = 0
      l.failAt = 0
    })
    this.doors.forEach((d) => (d.open = false))
    this.rebuildWalls()
    const spawns = this.map.spawns.slice()
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1)
      ;[spawns[i], spawns[j]] = [spawns[j]!, spawns[i]!]
    }
    let s = 0
    for (const id of this.order) {
      const p = this.players.get(id)!
      p.inRound = p.connected
      p.alive = p.connected
      p.spectator = false
      if (!p.alive) continue
      const sp = spawns[s++ % spawns.length]!
      p.x = sp.x
      p.y = sp.y
      p.vx = 0
      p.vy = 0
      p.windup = null
      p.stance = "walk"
      const w = WEAPONS[p.loadout.weapon]
      p.mag = w.mag
      p.reserve = w.reserve
      p.reloadUntil = 0
      p.cooldownUntil = 0
      p.gadgets = [GADGETS[p.loadout.gadgets[0]].count, GADGETS[p.loadout.gadgets[1]].count]
      p.queue = []
      p.lastRunAt = -10
      p.lastFireAt = -10
      p.stillRun = 0
      p.killedBy = ""
    }
  }

  private beginLive(): void {
    this.phase = "live"
    this.roundStart = this.time
    this.roundEnd = this.time + ROUND_SECONDS
    this.encroachAt = this.time + ENCROACH_START * ROUND_SECONDS
  }

  private endRound(winner: string | null): void {
    this.roundsPlayed++
    if (winner !== null) this.wins[winner] = (this.wins[winner] ?? 0) + 1
    this.lastWinner = winner
    this.phase = "over"
    this.phaseEnd = this.time + ROUND_OVER_SECONDS
    this.events.push({ k: "round", winner, label: winner === null ? "Draw" : this.label(winner), round: this.roundNo })
  }

  /** Winning team key, or null if the match is still open. */
  matchWinner(): { key: string | null; decided: boolean } {
    const need = Math.floor(this.rounds / 2) + 1
    let best: string | null = null
    let bestWins = 0
    let tied = false
    for (const [k, w] of Object.entries(this.wins)) {
      if (w > bestWins) {
        best = k
        bestWins = w
        tied = false
      } else if (w === bestWins && w > 0) tied = true
    }
    if (bestWins >= need) return { key: best, decided: true }
    if (this.roundsPlayed >= this.rounds) return { key: tied ? null : best, decided: true }
    return { key: null, decided: false }
  }

  private endMatch(): void {
    const { key } = this.matchWinner()
    this.phase = "match"
    this.phaseEnd = this.time + MATCH_OVER_SECONDS
    this.events.push({ k: "match", winner: key, label: key === null ? "Draw" : this.label(key) })
  }

  /** Called by the host to start a match (or a rematch) from the lobby or the scoreboard. */
  requestStart(mode: Mode, rounds: number): boolean {
    if (this.phase !== "lobby" && this.phase !== "match") return false
    this.startMatch(mode, rounds)
    return true
  }

  /** Called from the lobby to return to lobby after the scoreboard. */
  private toLobby(): void {
    this.phase = "lobby"
    this.phaseEnd = 0
    for (const p of this.players.values()) {
      p.alive = false
      p.inRound = false
      if (!p.human) this.removePlayer(p.id)
    }
  }

  // Tick -------------------------------------------------------------------------------------------------------------

  /** Events raised since the last call. The room sends them out, filtered per viewer. */
  takeEvents(): SimEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  /** Queues a human intent. Anything more than a few ticks ahead is dropped by the caller. */
  push(id: string, seq: number, intent: Intent): void {
    const p = this.players.get(id)
    if (!p || !p.human) return
    if (seq <= p.ack) return
    p.queue.push({ seq, intent })
    if (p.queue.length > 10) p.queue.splice(0, p.queue.length - 3)
  }

  step(): void {
    this.time += DT
    this.tick++
    this.phaseTimers()
    this.updateLamps()
    for (const id of this.order) {
      const p = this.players.get(id)!
      let intent: Intent = NO_INTENT
      if (p.brain) {
        intent = this.phase === "live" && p.alive ? p.brain.think(this, p) : NO_INTENT
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
    this.updateExposure()
    if (this.phase === "live") this.checkRoundEnd()
  }

  private phaseTimers(): void {
    if (this.phase === "loadout" && this.time >= this.phaseEnd) this.beginLive()
    else if (this.phase === "over" && this.time >= this.phaseEnd) {
      const { decided } = this.matchWinner()
      if (decided) this.endMatch()
      else this.beginLoadout()
    } else if (this.phase === "match" && this.time >= this.phaseEnd) this.toLobby()
    else if (this.phase === "live" && this.time >= this.roundEnd) this.endRound(null)
  }

  private checkRoundEnd(): void {
    const alive = new Set<string>()
    let participants = 0
    for (const p of this.players.values()) {
      if (!p.inRound) continue
      participants++
      if (p.alive) alive.add(this.teamKey(p))
    }
    if (participants < 2) return
    if (alive.size === 0) this.endRound(null)
    else if (alive.size === 1) this.endRound([...alive][0]!)
  }

  private apply(p: Player, i: Intent): void {
    p.aim = i.aim
    if (!p.alive || this.phase !== "live") {
      const f = Math.pow(0.001, DT * 2)
      p.vx *= f
      p.vy *= f
      p.noise = "silent"
      return
    }
    if (p.windup && this.time >= p.windup.until) this.resolveShot(p)
    if (i.reload) this.startReload(p)
    if (this.time >= p.reloadUntil && p.reloadUntil > 0) this.finishReload(p)
    p.stance = i.stance
    stepBody(p, i.mx, i.my, i.stance, this.walls, DT)
    const speed = Math.hypot(p.vx, p.vy)
    if (speed < 0.1) p.stillRun += DT
    else {
      p.stillRun = 0
    }
    p.stats.stillMax = Math.max(p.stats.stillMax, p.stillRun)
    if (speed > 0.25 && i.stance !== "sneak" && this.time >= p.nextStepAt) this.footstep(p, i.stance)
    if (i.stance === "run" && speed > 0.25) p.lastRunAt = this.time
    this.pickupBolts(p)
    if (i.use) this.useDoor(p)
    if (i.gadget >= 0) this.useGadget(p, i.gadget, i.tx, i.ty)
    if (i.fire) this.trigger(p, i.aim)
    p.noise = this.noiseOf(p, i)
  }

  private noiseOf(p: Player, i: Intent): Player["noise"] {
    if (this.time - p.lastFireAt < FIRE_EXPOSE_SECONDS) return "gun"
    if (Math.hypot(p.vx, p.vy) < 0.25) return "silent"
    if (i.stance === "sneak") return "silent"
    return i.stance === "run" ? "loud" : "soft"
  }

  private footstep(p: Player, stance: "walk" | "run"): void {
    const surface = this.surfaceAt(p.x, p.y)
    const r = FOOT_RING[stance] * (surface ? NOISY_SURFACE_MUL : 1)
    this.ripple(p.x, p.y, r, "step", p.id)
    p.nextStepAt = this.time + FOOT_INTERVAL[stance]
    if (stance === "run") p.lastRunAt = this.time
  }

  surfaceAt(x: number, y: number): "grate" | "puddle" | null {
    for (const n of this.map.noisy) if (x >= n.rect[0] && x <= n.rect[2] && y >= n.rect[1] && y <= n.rect[3]) return n.kind
    return null
  }

  ripple(x: number, y: number, r: number, kind: RippleKind, owner = ""): void {
    if (r <= 0) return
    this.events.push({ k: "ripple", x, y, r, kind, t: this.time })
    this.heard.push({ x, y, r, t: this.time, owner })
    while (this.heard.length && this.time - this.heard[0]!.t > 3) this.heard.shift()
    if (owner) {
      const p = this.players.get(owner)
      if (p) p.stats.ripples++
    }
  }

  // Weapons ----------------------------------------------------------------------------------------------------------

  private startReload(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    if (p.reloadUntil > 0 || p.windup || p.mag >= w.mag || p.reserve <= 0) return
    p.reloadUntil = this.time + w.reload
    if (w.reloadNoise > 0) this.ripple(p.x, p.y, w.reloadNoise, "reload", p.id)
  }

  private finishReload(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    const take = Math.min(w.mag - p.mag, p.reserve)
    p.mag += take
    p.reserve -= take
    p.reloadUntil = 0
  }

  private trigger(p: Player, aim: number): void {
    const w = WEAPONS[p.loadout.weapon]
    if (p.windup || p.reloadUntil > 0 || p.mag <= 0 || this.time < p.cooldownUntil) return
    p.windup = { until: this.time + w.windup, aim }
  }

  private resolveShot(p: Player): void {
    const w = WEAPONS[p.loadout.weapon]
    const aim = p.windup!.aim
    p.windup = null
    if (p.mag <= 0) return
    p.mag--
    p.stats.shots++
    p.lastFireAt = this.time
    p.cooldownUntil = this.time + w.cooldown
    if (w.noise > 0) this.ripple(p.x, p.y, w.noise, "shot", p.id)
    const hitVictims = new Set<string>()
    for (let k = 0; k < w.pellets; k++) {
      const a = aim + (w.pellets > 1 ? this.rng.range(-w.spread, w.spread) : 0)
      this.fire(p, a, p.loadout.weapon, hitVictims)
    }
  }

  private fire(shooter: Player, a: number, weapon: Weapon, hitVictims: Set<string>): void {
    const w = WEAPONS[weapon]
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const wallT = raycast(shooter.x, shooter.y, dx, dy, this.walls, w.range)
    let bestT = Math.min(wallT, w.range)
    let victim: Player | null = null
    let lamp: Lamp | null = null
    for (const q of this.players.values()) {
      if (!q.alive || q.id === shooter.id || !this.enemy(shooter, q) || hitVictims.has(q.id)) continue
      const t = this.along(shooter, q.x, q.y, dx, dy)
      if (t > 0 && t < bestT && Math.abs(this.across(shooter, q.x, q.y, dx, dy)) <= HIT_RADIUS) {
        bestT = t
        victim = q
        lamp = null
      }
    }
    for (const l of this.lamps) {
      if (l.broken) continue
      const t = this.along(shooter, l.x, l.y, dx, dy)
      if (t > 0 && t < bestT && Math.abs(this.across(shooter, l.x, l.y, dx, dy)) <= LAMP_HIT_RADIUS) {
        bestT = t
        lamp = l
        victim = null
      }
    }
    const x1 = shooter.x + dx * bestT
    const y1 = shooter.y + dy * bestT
    const hit = victim !== null || lamp !== null
    this.events.push({ k: "shot", x0: shooter.x, y0: shooter.y, x1, y1, hit, to: [shooter.id] })
    if (victim) {
      hitVictims.add(victim.id)
      this.kill(victim, shooter, weapon, bestT)
    } else if (lamp) {
      this.breakLamp(lamp, shooter)
    } else if (w.retrievable && wallT < w.range) {
      this.bolts.push({ id: this.nextThingId++, x: x1, y: y1, owner: shooter.id })
      this.ripple(x1, y1, 6, "thud", shooter.id)
    }
  }

  /** Signed distance along the shot direction to point (px, py), relative to the shooter. */
  private along(s: Player, px: number, py: number, dx: number, dy: number): number {
    return (px - s.x) * dx + (py - s.y) * dy
  }

  private across(s: Player, px: number, py: number, dx: number, dy: number): number {
    return -(px - s.x) * dy + (py - s.y) * dx
  }

  private breakLamp(l: Lamp, by: Player): void {
    l.broken = true
    l.shot = true
    by.stats.lampsOut++
    this.ripple(l.x, l.y, 30, "glass", by.id)
    this.events.push({ k: "lamp", id: l.id, x: l.x, y: l.y, by: by.id })
    this.events.push({ k: "toast", text: "LIGHT DESTROYED · ZONE DARK", to: [by.id] })
  }

  kill(victim: Player, killer: Player | null, weapon: Weapon | "mine", dist = 0): void {
    if (!victim.alive) return
    victim.alive = false
    victim.vx = 0
    victim.vy = 0
    victim.windup = null
    victim.stats.deaths++
    victim.killedBy = killer?.id ?? ""
    if (killer) killer.stats.kills++
    const from = killer ?? victim
    const path = { x0: from.x, y0: from.y, x1: victim.x, y1: victim.y }
    this.events.push({ k: "kill", killer: killer?.id ?? "", victim: victim.id, weapon, dist })
    this.events.push({ k: "killcam", killer: killer?.id ?? "", victim: victim.id, ...path, weapon, dist, to: [victim.id] })
  }

  // Gadgets, doors and bolts ----------------------------------------------------------------------------------------

  private useGadget(p: Player, slot: number, tx: number, ty: number): void {
    if (p.gadgets[slot as 0 | 1] <= 0) return
    const kind = p.loadout.gadgets[slot as 0 | 1]
    const d = Math.hypot(tx - p.x, ty - p.y)
    const k = d > THROW_RANGE ? THROW_RANGE / d : 1
    const x = p.x + (tx - p.x) * k
    const y = p.y + (ty - p.y) * k
    if (kind === "emp") {
      p.gadgets[slot as 0 | 1]--
      this.ripple(p.x, p.y, 14, "emp", p.id)
      for (const l of this.lamps) if (!l.broken && Math.hypot(l.x - p.x, l.y - p.y) <= EMP_RADIUS) l.dimUntil = this.time + EMP_SECONDS
      for (const t of this.things) if (t.kind === "mine" && Math.hypot(t.x - p.x, t.y - p.y) <= EMP_RADIUS) t.disabledUntil = this.time + 8
      return
    }
    p.gadgets[slot as 0 | 1]--
    if (kind === "flare") {
      p.stats.flares++
      this.things.push(this.thing("flare", p, p.x, p.y, x, y, this.time + FLARE_FLIGHT, this.time + FLARE_FLIGHT + FLARE_LIFE))
    } else if (kind === "decoy") {
      this.things.push(this.thing("decoy", p, p.x, p.y, x, y, this.time + DECOY_FLIGHT, this.time + DECOY_FLIGHT + 3))
    } else {
      this.things.push(this.thing("mine", p, p.x, p.y, x, y, this.time + 0.3, this.time + 0.3 + MINE_ARM + 60))
    }
  }

  private thing(kind: Thing["kind"], owner: Player, sx: number, sy: number, x: number, y: number, landAt: number, endAt: number): Thing {
    return { id: this.nextThingId++, kind, owner: owner.id, team: this.teamKey(owner), sx, sy, x, y, landAt, endAt, pings: 0, disabledUntil: 0 }
  }

  private updateThings(): void {
    for (const t of this.things) {
      if (t.kind === "decoy" && t.pings < 3 && this.time >= t.landAt + t.pings) {
        this.ripple(t.x, t.y, 26, "decoy", t.owner)
        t.pings++
      }
      if (t.kind === "flare" && this.time >= t.landAt && t.pings === 0) {
        this.ripple(t.x, t.y, 6, "flare", t.owner)
        t.pings = 1
      }
      if (t.kind === "mine" && this.time >= t.landAt + MINE_ARM && t.pings === 0 && this.time >= t.disabledUntil) {
        const trigger = [...this.players.values()].find((q) => q.alive && this.mineEnemy(t, q) && Math.hypot(q.x - t.x, q.y - t.y) <= MINE_TRIGGER)
        if (trigger) this.detonate(t)
      }
    }
    this.things = this.things.filter((t) => {
      if (t.kind === "mine") return t.pings === 0
      return this.time < t.endAt
    })
    this.bolts = this.bolts.slice(-40)
  }

  private mineEnemy(t: Thing, q: Player): boolean {
    const owner = this.players.get(t.owner)
    if (!owner) return q.id !== t.owner
    return this.enemy(owner, q)
  }

  private detonate(t: Thing): void {
    t.pings = 1
    const owner = this.players.get(t.owner)
    this.ripple(t.x, t.y, 22, "mine", t.owner)
    for (const q of this.players.values()) {
      if (!q.alive) continue
      if (owner && !this.enemy(owner, q)) continue
      if (!owner && q.id === t.owner) continue
      const d = Math.hypot(q.x - t.x, q.y - t.y)
      if (d <= MINE_KILL) this.kill(q, owner ?? null, "mine", d)
    }
  }

  private useDoor(p: Player): void {
    let best: DoorState | null = null
    let bestD = DOOR_REACH
    for (const d of this.doors) {
      const dd = distToRect(p.x, p.y, d.rect)
      if (dd < bestD) {
        bestD = dd
        best = d
      }
    }
    if (!best) return
    if (best.open) {
      const occupied = [...this.players.values()].some((q) => q.alive && distToRect(q.x, q.y, best!.rect) < PLAYER_RADIUS + 0.05)
      if (occupied) return
      best.open = false
      this.ripple(best.rect[0] + (best.rect[2] - best.rect[0]) / 2, best.rect[1] + (best.rect[3] - best.rect[1]) / 2, 16, "slam", p.id)
    } else {
      best.open = true
      this.ripple(best.rect[0] + (best.rect[2] - best.rect[0]) / 2, best.rect[1] + (best.rect[3] - best.rect[1]) / 2, 5, "creak", p.id)
    }
    this.rebuildWalls()
    this.events.push({ k: "door", id: best.id, open: best.open })
  }

  private pickupBolts(p: Player): void {
    if (WEAPONS[p.loadout.weapon].retrievable === false || p.mag > 0 || p.reloadUntil > 0) return
    const i = this.bolts.findIndex((b) => Math.hypot(b.x - p.x, b.y - p.y) <= PICKUP_REACH)
    if (i < 0) return
    this.bolts.splice(i, 1)
    p.mag = 1
  }

  rebuildWalls(): void {
    const out: Rect[] = [...this.map.walls]
    for (const d of this.doors) if (!d.open) out.push(d.rect)
    this.walls = out
  }

  // Lamps and encroachment -------------------------------------------------------------------------------------------

  private updateLamps(): void {
    if (this.phase === "live" && this.time >= this.encroachAt) {
      this.encroachAt = this.time + ENCROACH_INTERVAL
      const pool = this.lamps.filter((l) => !l.broken && l.failAt === 0)
      if (pool.length > 1) {
        const l = this.rng.pick(pool)
        l.failAt = this.time + 1.4
      }
    }
    for (const l of this.lamps) {
      if (l.failAt > 0 && this.time >= l.failAt) {
        l.broken = true
        l.failAt = 0
      }
    }
  }

  /** Whether a lamp is currently giving light (not broken and not dimmed by an EMP). */
  lampOn(l: Lamp): boolean {
    return !l.broken && this.time >= l.dimUntil
  }

  /** All lights for the renderer and visibility: lamps (power 0 when dark) and flares that have landed. */
  lights(): Light[] {
    const out: Light[] = []
    for (const l of this.lamps) {
      const on = this.lampOn(l)
      const flicker = l.failAt > 0 && Math.sin(this.time * 47) > 0.2 ? 1 : l.failAt > 0 ? 0.25 : 1
      out.push({ id: l.id, kind: "lamp", x: l.x, y: l.y, radius: l.radius, power: on ? l.power * flicker : 0, color: l.color, on })
    }
    for (const t of this.things) {
      if (t.kind !== "flare" || this.time < t.landAt) continue
      const up = Math.min(1, (this.time - t.landAt) / 0.4)
      const down = Math.min(1, Math.max(0, (t.endAt - this.time) / 2))
      out.push({ id: t.id, kind: "flare", x: t.x, y: t.y, radius: 10, power: FLARE_POWER * up * down, color: [1, 0.3, 0.2], on: true })
    }
    return out
  }

  // Exposure and visibility ------------------------------------------------------------------------------------------

  private lightsCache: Light[] = []

  private updateExposure(): void {
    this.lightsCache = this.lights()
    for (const p of this.players.values()) {
      if (!p.alive) {
        p.lit = false
        p.exposed = false
        continue
      }
      p.lit = this.litAt(p.x, p.y)
      p.exposed = p.lit || this.time - p.lastRunAt < RUN_EXPOSE_SECONDS || this.time - p.lastFireAt < FIRE_EXPOSE_SECONDS
    }
    for (const t of this.players.values()) {
      if (!t.alive) continue
      let seenNow = false
      for (const v of this.players.values()) {
        if (v.id !== t.id && this.enemy(v, t) && this.canSee(v, t)) {
          seenNow = true
          break
        }
      }
      if (seenNow && !t.seen) t.stats.sightings++
      t.seen = seenNow
    }
  }

  litAt(x: number, y: number): boolean {
    return lightAt(x, y, this.lightsCache, this.walls) >= LIT_THRESHOLD
  }

  /** The visibility rule. Only the server evaluates this, and only the snapshot filter and bots use it. */
  canSee(viewer: Player, target: Player): boolean {
    if (!viewer.alive || !target.alive || viewer.id === target.id) return false
    if (!target.exposed) return false
    const d = Math.hypot(target.x - viewer.x, target.y - viewer.y)
    if (d > VIEW_RANGE) return false
    return clearLine(viewer.x, viewer.y, target.x, target.y, this.walls)
  }

  /** Exposure level 0..1 for the HUD meter. */
  exposureOf(p: Player): number {
    if (!p.alive) return 0
    if (p.lit) return 1
    if (this.time - p.lastFireAt < FIRE_EXPOSE_SECONDS) return 0.6
    if (this.time - p.lastRunAt < RUN_EXPOSE_SECONDS) return 0.7
    if (Math.hypot(p.vx, p.vy) > 0.3 && p.stance !== "sneak") return 0.25
    return 0
  }

  /** Awards for the scoreboard. Each category needs something to award. */
  awards(): Award[] {
    const ps = [...this.players.values()].filter((p) => p.human || p.stats.deaths + p.stats.kills + p.stats.shots > 0)
    const out: Award[] = []
    if (ps.length === 0) return out
    const best = (f: (p: Player) => number) => ps.reduce((a, b) => (f(b) > f(a) ? b : a))
    const ghost = ps.reduce((a, b) => (b.stats.sightings < a.stats.sightings ? b : a))
    out.push({ kind: "ghost", id: ghost.id, name: ghost.name, value: ghost.stats.sightings === 0 ? "never seen" : `seen ${ghost.stats.sightings}×` })
    const lights = best((p) => p.stats.lampsOut)
    if (lights.stats.lampsOut > 0) out.push({ kind: "lights", id: lights.id, name: lights.name, value: `${lights.stats.lampsOut} lamps out` })
    const loud = best((p) => p.stats.ripples)
    if (loud.stats.ripples > 0) out.push({ kind: "loudest", id: loud.id, name: loud.name, value: `${loud.stats.ripples} ripples` })
    const still = best((p) => p.stats.stillMax)
    if (still.stats.stillMax > 0) out.push({ kind: "patience", id: still.id, name: still.name, value: `still ${still.stats.stillMax.toFixed(1)} s` })
    return out
  }

  /** Recent ripples a bot could hear from `p`. */
  heardBy(p: Player, window = 2): (Ripple & { owner: string })[] {
    return this.heard.filter((r) => this.time - r.t <= window && Math.hypot(r.x - p.x, r.y - p.y) <= r.r + 1)
  }

}

function distToRect(x: number, y: number, r: Rect): number {
  const cx = Math.max(r[0], Math.min(x, r[2]))
  const cy = Math.max(r[1], Math.min(y, r[3]))
  return Math.hypot(x - cx, y - cy)
}

