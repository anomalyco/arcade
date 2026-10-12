// Authoritative game loop shared by the Room Durable Object and the browser's offline/loopback mode.
// Owned by the Server agent. Dependency-free: no DOM, no Date.now/Math.random inside the simulation.
import type { ClientMessage, Crater, RoomConfig, RoomSummary, ServerMessage, ShipState, Snapshot } from "./protocol"
import { DEFAULT_ROOM_CONFIG, RESPAWN_DELAY } from "./protocol"
import type {
  Flare, FlightInput, FlightState, GameEvent, Missile, PlayerInfo, Projectile, Quat, SeatIndex, SeatInput, TeamId, Vec3,
  VehicleEntity, VehicleKind, WeaponId, WeaponRuntime, WorldQuery,
} from "./types"
import { SNAPSHOT_RATE, TICK_DT, TICK_RATE } from "./types"
import { VEHICLES, VEHICLE_KINDS } from "./vehicles"
import { NEUTRAL_INPUT, createFlightState, stepFlight } from "./flight"
import {
  applySeatInput, applyTurretInput, createCombatState, createWeapons, isHiddenStealth, killVehicle, markSpawned, shipRuntime, stepCombat,
  turretOperational,
} from "./combat"
import type { CombatState } from "./combat"
import { carrierOf, deckVelocity, posedFleet, posedShip, setFleetState, setShipStates, spawnPoint, worldQuery as baseWorldQuery } from "./geography"
import { FLEET, SHIP_SPECS, SPAWN_PROTECTION, shipToWorld, worldToShip } from "./fleet"
import { botInput, chooseBotVehicle, createBotBrain } from "./bots"
import type { BotBrain } from "./bots"

export interface RoomEngineHooks {
  /** Send a message to one player (by player id). Snapshots go here as full `Snapshot`s only if `sendText` is absent. */
  send(playerId: string, message: ServerMessage): void
  /**
   * Optional fast path: pre-serialized wire messages (JSON of `WireServerMessage`). When provided, snapshots are
   * serialized once per broadcast and sent here in the compact wire format; decode with `createSnapshotDecoder`.
   */
  sendText?(playerId: string, text: string): void
  /** Optional: called when players join/leave/change team or a match ends (good moment to refresh room listings). */
  onChange?(): void
}

/** Max wall-clock time simulated per advance() call; anything beyond is dropped. */
export const MAX_CATCH_UP = 0.25
const TICKS_PER_SNAPSHOT = Math.round(TICK_RATE / SNAPSHOT_RATE)
/** Dead vehicles stay in snapshots this long (wreck/explosion rendering), then are removed. */
export const WRECK_LINGER = 3
/** Unmanned vehicle away from its own carrier deck is destroyed after this many seconds. */
export const ABANDONED_DESTROY_DELAY = 20
/** Unmanned vehicle parked on its own carrier deck is removed after this many seconds. */
export const PARKED_REMOVE_DELAY = 60
/** Crashes credit the last attacker if it damaged the vehicle within this window. */
export const CRASH_CREDIT_WINDOW = 8
export const MATCH_RESTART_DELAY = 15
/** Hard cap on queued inputs per player; beyond it the oldest is dropped on arrival. */
export const INPUT_QUEUE_MAX = 8
/** Jitter buffer: inputs held before consumption, adapted within [MIN, MAX] from observed underruns/slack. */
export const JITTER_TARGET_INITIAL = 2
export const JITTER_TARGET_MIN = 1
export const JITTER_TARGET_MAX = 4
/** Depth above target + this margin makes a tick consume two inputs to catch up. */
const JITTER_CATCHUP_MARGIN = 2
/** Ticks per adaptation window (target shrinks after a window with no underrun and spare depth). */
const JITTER_WINDOW = 180
/** Max consecutive dry ticks that stand in for the next seq; beyond that the buffer re-primes. */
const JITTER_MAX_SYNTH = 4
/** Contiguous seqs required before dry ticks synthesize stand-ins. */
const JITTER_STREAM_MIN = 10
/** Players list is re-sent at least this often even if unchanged (seconds). */
const PLAYERS_RESEND = 1
/** Human input older than this stops firing (lost connection / tab hidden). */
const STALE_INPUT = 1
const CHAT_MAX = 200
const CHAT_BURST = 4
const CHAT_REFILL = 1.5 // seconds per token
const NAME_MAX = 16
/** An unspotted stealth enemy is sent to a team only within this range of one of its aircraft or ships. */
export const STEALTH_VISUAL_RANGE = 800
/** Cap on client-reported view delay used for lag-compensated hits (seconds). */
export const MAX_VIEW_DELAY = 0.3
const SPAWN_SLOTS = 16

function newJitterBuffer(): JitterBuffer {
  return {
    target: JITTER_TARGET_INITIAL, offset: 0, primed: false, streak: 0, starveRun: 0, windowTicks: 0, windowMinSlack: Infinity, windowUnderruns: 0,
    synthesized: 0, caughtUp: 0, dropped: 0, late: 0,
  }
}

/** Bots take an empty gunner seat in a human pilot's aircraft after it has been empty this long (seconds). */
export const BOT_GUNNER_DELAY = 5
export const BOT_SKILL_DEFAULT = 0.5
/** Bot roster is reconciled at least this often (seconds). */
const BOT_SYNC_INTERVAL = 1
const BOT_NAMES = [
  "Viper", "Maverick", "Iceman", "Goose", "Phoenix", "Hangman", "Rooster", "Payback", "Fanboy", "Jester",
  "Cougar", "Merlin", "Slider", "Hollywood", "Wolfman", "Sundown", "Chipper", "Stinger", "Ghost", "Raven",
  "Talon", "Havoc", "Nomad", "Reaper", "Saber", "Banshee", "Comet", "Falcon", "Outlaw", "Spectre",
]

/**
 * Engine-only config extras (not yet in protocol.ts): `botSkill` 0..1 for bot difficulty, and `botFill` —
 * when set, each team is topped up with bots to `botFill` total while the room has fewer than `botFill` humans
 * (used for quick-play rooms) instead of the fixed `bots` per team.
 */
export interface RoomExtras {
  botSkill?: number
  botFill?: number
}
export type EngineConfig = RoomConfig & RoomExtras

/** World queries for flight/bots, including moving-deck velocity so parked aircraft ride their carrier. */
const worldQuery: WorldQuery = baseWorldQuery.deckVelocity ? baseWorldQuery : { ...baseWorldQuery, deckVelocity }

const NEUTRAL_SEAT: SeatInput = { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }

interface QueuedInput {
  seq: number
  /** Tick at which it arrived. */
  at: number
  flight?: FlightInput
  seat?: SeatInput
}

interface JitterBuffer {
  target: number
  /** Input `seq` is due at tick `seq + offset`. */
  offset: number
  /** False until the first arrival (and again after a long gap). */
  primed: boolean
  /** Consecutive contiguous seqs received (streaming detection). */
  streak: number
  /** Consecutive dry ticks that stood in for the next seq. */
  starveRun: number
  windowTicks: number
  windowMinSlack: number
  windowUnderruns: number
  /** Counters (diagnostics/tests). */
  synthesized: number
  caughtUp: number
  dropped: number
  late: number
}

interface PlayerState {
  info: PlayerInfo
  flight: FlightInput
  seat: SeatInput
  queue: QueuedInput[]
  jitter: JitterBuffer
  /** Highest input seq received. */
  seq: number
  /** Last input seq consumed by a tick (sent as snapshot ack). */
  ack: number
  lastInputAt: number
  chatTokens: number
  chatAt: number
  /** Needs the players list in its next snapshot (just joined). */
  needsPlayers: boolean
  /** Bots only. */
  brain: BotBrain | null
  /** Surplus bot: leaves once out of an aircraft, parked safely, or dead. */
  leaving: boolean
}

interface VehicleMeta {
  /** Room time when the vehicle last became unmanned (null while crewed). */
  emptySince: number | null
  lastHp: number
  lastHitAt: number
  diedAt: number | null
  /** Room time the gunner seat became empty (bot gunner fill). */
  gunnerEmptySince: number
}

export function sanitizeConfig(input: unknown, base: EngineConfig = DEFAULT_ROOM_CONFIG): EngineConfig {
  const c = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const int = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  const name = typeof c.name === "string" ? cleanText(c.name, 32) : ""
  return {
    teams: int(c.teams, 2, 4, base.teams),
    bots: int(c.bots, 0, 10, base.bots),
    maxPerTeam: int(c.maxPerTeam, 1, 16, base.maxPerTeam),
    scoreLimit: int(c.scoreLimit, 1, 1000, base.scoreLimit),
    timeLimit: int(c.timeLimit, 60, 7200, base.timeLimit),
    listed: typeof c.listed === "boolean" ? c.listed : base.listed,
    name: name || base.name,
    ...extras(c, base),
  }
}

function extras(c: Record<string, unknown>, base: RoomExtras): RoomExtras {
  const out: RoomExtras = {}
  const skill = typeof c.botSkill === "number" && Number.isFinite(c.botSkill) ? c.botSkill : base.botSkill
  if (skill !== undefined) out.botSkill = Math.min(1, Math.max(0, skill))
  const fill = typeof c.botFill === "number" && Number.isFinite(c.botFill) ? c.botFill : base.botFill
  if (fill !== undefined) out.botFill = Math.min(16, Math.max(0, Math.round(fill)))
  return out
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function cleanText(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

function isTeam(v: unknown, teams: number): v is TeamId {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < teams
}

function isSeat(v: unknown): v is SeatIndex {
  return v === 0 || v === 1
}

const clampAxis = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : null)

/** Returns a normalized copy, null for "no aim", or undefined when invalid. */
function readAim(v: unknown): Vec3 | null | undefined {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v) || v.length !== 3) return undefined
  const [x, y, z] = v
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  const len = Math.hypot(x, y, z)
  if (len < 1e-6) return undefined
  return [x / len, y / len, z / len]
}

function readFlight(v: unknown): FlightInput | undefined {
  if (!v || typeof v !== "object") return undefined
  const m = v as Record<string, unknown>
  const aim = readAim(m.aim)
  const throttle = clampAxis(m.throttle ?? 0), roll = clampAxis(m.roll ?? 0), yaw = clampAxis(m.yaw ?? 0), pitch = clampAxis(m.pitch ?? 0)
  if (aim === undefined || throttle === null || roll === null || yaw === null || pitch === null) return undefined
  return { aim, throttle, roll, yaw, pitch, boost: m.boost === true, brake: m.brake === true }
}

function readSeat(v: unknown): SeatInput | undefined {
  if (!v || typeof v !== "object") return undefined
  const m = v as Record<string, unknown>
  const aim = readAim(m.aim)
  if (aim === undefined) return undefined
  const out: SeatInput = { aim, firePrimary: m.firePrimary === true, fireSecondary: m.fireSecondary === true, flares: m.flares === true, ability: m.ability === true }
  // Lag compensation: how far behind the server the shooter sees remote aircraft (seconds, capped).
  if (typeof m.viewDelay === "number" && Number.isFinite(m.viewDelay)) out.viewDelay = Math.min(MAX_VIEW_DELAY, Math.max(0, m.viewDelay))
  if (m.steerBomb === true) out.steerBomb = true
  return out
}

/** Small fast seeded PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class RoomEngine {
  /** Room time in seconds (advances only via fixed ticks). */
  time = 0
  tick = 0
  readonly vehicles: VehicleEntity[] = []
  readonly players = new Map<string, PlayerState>()
  scores: number[]
  combat: CombatState = createCombatState()
  /** Room time when the current match began. */
  matchStartedAt = 0
  /** Non-null during the post-match intermission. */
  matchEndedAt: number | null = null
  winner: TeamId | null = null

  private accumulator = 0
  private nextId = 1
  private meta = new Map<string, VehicleMeta>()
  private events: GameEvent[] = []
  private lastPlayersJson = ""
  private lastPlayersAt = -Infinity
  /** Per-player decoders for the legacy (object) snapshot path. */
  private decoders = new Map<string, (m: WireServerMessage) => ServerMessage>()

  /** Enemy aircraft destroyed per team (time-limit tiebreak). */
  teamKills: number[]
  private cratersSent = 0
  private lastShipsJson = ""
  private lastShipsAt = -Infinity
  private rng: () => number
  private botNames = 0
  private lastBotSync = -Infinity

  constructor(public readonly code: string, public config: EngineConfig, private hooks: RoomEngineHooks) {
    this.config = sanitizeConfig(config)
    this.scores = new Array(this.config.teams).fill(0)
    this.teamKills = new Array(this.config.teams).fill(0)
    this.rng = createRng(hashString(code))
    this.syncBots()
  }

  // ───────────────────────── players ─────────────────────────

  /**
   * Register a human connection; returns its player id and sends `welcome`.
   * `beforeWelcome` lets transports map the new id to a connection before the first message goes out.
   */
  addPlayer(name: string, beforeWelcome?: (playerId: string) => void): string {
    const id = `p${this.nextId++}`
    const team = this.balancedTeam(null)
    this.players.set(id, this.newPlayer(id, cleanText(String(name ?? ""), NAME_MAX) || "Pilot", team, false))
    beforeWelcome?.(id)
    this.hooks.send(id, { type: "welcome", playerId: id, room: this.code, config: { ...this.config } })
    this.syncBots()
    this.hooks.onChange?.()
    return id
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId)
    if (!p) return
    this.leaveTurret(p.info)
    this.vacate(p.info)
    this.players.delete(playerId)
    this.decoders.delete(playerId)
    if (!p.info.bot) {
      this.syncBots()
      this.hooks.onChange?.()
    }
  }

  private newPlayer(id: string, name: string, team: TeamId, bot: boolean): PlayerState {
    return {
      info: { id, name, team, vehicleId: null, seat: null, kills: 0, deaths: 0, bot, respawnAt: 0, turret: null },
      flight: NEUTRAL_INPUT, seat: NEUTRAL_SEAT, queue: [], jitter: newJitterBuffer(), seq: -1, ack: -1, lastInputAt: -Infinity,
      chatTokens: CHAT_BURST, chatAt: this.time, needsPlayers: !bot, brain: null, leaving: false,
    }
  }

  /** Humans only (bots never keep a room alive). */
  humanCount(): number {
    let n = 0
    for (const p of this.players.values()) if (!p.info.bot) n++
    return n
  }

  playerCount(): number {
    return this.players.size
  }

  botCount(): number {
    return this.players.size - this.humanCount()
  }

  summary(): RoomSummary {
    return {
      code: this.code, name: this.config.name, teams: this.config.teams,
      players: this.playerCount(), humans: this.humanCount(), maxPlayers: this.config.teams * this.config.maxPerTeam,
    }
  }

  isFull(): boolean {
    return this.humanCount() >= this.config.teams * this.config.maxPerTeam
  }

  /** Humans per team (bots are ignored for balancing; they make room instead). */
  private teamCounts(exclude: string | null): number[] {
    const counts = new Array(this.config.teams).fill(0)
    for (const p of this.players.values()) if (!p.info.bot && p.info.id !== exclude) counts[p.info.team]++
    return counts
  }

  private balancedTeam(exclude: string | null): TeamId {
    const counts = this.teamCounts(exclude)
    let best = 0
    for (let t = 1; t < counts.length; t++) if (counts[t] < counts[best]) best = t
    return best as TeamId
  }

  // ───────────────────────── bots ─────────────────────────

  /** Bots wanted on a team given current humans. */
  private wantedBots(team: number, humans: number[]): number {
    const room = Math.max(0, this.config.maxPerTeam - humans[team])
    const fill = this.config.botFill
    if (fill !== undefined && fill > 0) {
      const total = humans.reduce((a, b) => a + b, 0)
      return total >= fill ? 0 : Math.min(room, Math.max(0, fill - humans[team]))
    }
    return Math.min(room, this.config.bots)
  }

  /** Add one bot to a team. */
  addBot(team: TeamId): string {
    const id = `b${this.nextId++}`
    const p = this.newPlayer(id, `${BOT_NAMES[this.botNames++ % BOT_NAMES.length]} [AI]`, team, true)
    p.brain = createBotBrain(Math.floor(this.rng() * 4294967296), this.config.botSkill ?? BOT_SKILL_DEFAULT)
    p.info.respawnAt = this.time + 0.5 + this.rng() * 2
    this.players.set(id, p)
    return id
  }

  /** Reconcile bot roster: add missing bots, mark surplus ones as leaving (they exit gracefully). */
  private syncBots(): void {
    this.lastBotSync = this.time
    const humans = this.teamCounts(null)
    for (let t = 0; t < this.config.teams; t++) {
      const want = this.wantedBots(t, humans)
      const bots = [...this.players.values()].filter(p => p.info.bot && p.info.team === t)
      const staying = bots.filter(b => !b.leaving)
      if (staying.length < want) {
        // Cancel departures first, then add.
        let need = want - staying.length
        for (const b of bots) if (b.leaving && need > 0) { b.leaving = false; need-- }
        for (let i = 0; i < need; i++) this.addBot(t as TeamId)
      } else if (staying.length > want) {
        // Prefer idle bots, then gunners, then pilots.
        const rank = (b: PlayerState) => (b.info.vehicleId === null ? 0 : b.info.seat === 1 ? 1 : 2)
        staying.sort((a, b) => rank(a) - rank(b))
        for (let i = 0; i < staying.length - want; i++) staying[i].leaving = true
      }
    }
    this.retireBots()
  }

  /** Remove leaving bots that can go now. */
  private retireBots(): void {
    for (const p of [...this.players.values()]) {
      if (!p.info.bot || !p.leaving) continue
      const v = this.vehicleOf(p.info)
      if (!v || !v.alive) { this.removePlayer(p.info.id); continue }
      if (!this.canLeave(v)) continue
      const otherId = v.seats[p.info.seat === 0 ? 1 : 0]
      this.removePlayer(p.info.id)
      // A bot's own parked aircraft leaves with it.
      if (!otherId) this.removeVehicleQuietly(v)
    }
  }

  private removeVehicleQuietly(v: VehicleEntity): void {
    const meta = this.meta.get(v.id)
    v.alive = false
    if (meta) meta.diedAt = -Infinity
  }

  /** Kick a bot out of its seat (it will respawn shortly). */
  private evictBot(bot: PlayerState): void {
    this.vacate(bot.info)
    bot.info.respawnAt = Math.max(bot.info.respawnAt, this.time + 1)
  }

  private updateBots(): void {
    if (this.time - this.lastBotSync >= BOT_SYNC_INTERVAL) this.syncBots()
    else this.retireBots()
    if (this.matchEndedAt !== null) return
    const now = this.time
    for (const p of this.players.values()) {
      const bot = p.info
      if (!bot.bot || p.leaving || bot.vehicleId || now < bot.respawnAt) continue
      const ride = this.vehicles.find(v => {
        if (!v.alive || v.team !== bot.team || v.seats[1] || !v.seats[0]) return false
        const pilot = this.players.get(v.seats[0])
        return !!pilot && !pilot.info.bot && now - this.meta.get(v.id)!.gunnerEmptySince >= BOT_GUNNER_DELAY
      })
      if (ride) { this.seatPlayer(bot, ride, 1); continue }
      const teammates: PlayerInfo[] = []
      for (const x of this.players.values()) if (x.info.team === bot.team && x.info.id !== bot.id) teammates.push(x.info)
      let kind = chooseBotVehicle(bot, teammates, this.vehicles, this.rng)
      if (!VEHICLES[kind]) kind = VEHICLE_KINDS[Math.floor(this.rng() * VEHICLE_KINDS.length)]
      this.spawnVehicle(bot, kind)
    }
  }

  /** Players may pick a team if it doesn't make it bigger than the smallest team + 1 and it isn't full. */
  private canJoinTeam(playerId: string, team: TeamId): boolean {
    const counts = this.teamCounts(playerId)
    return counts[team] < this.config.maxPerTeam && counts[team] <= Math.min(...counts)
  }

  // ───────────────────────── messages ─────────────────────────

  handle(playerId: string, message: ClientMessage): void {
    const p = this.players.get(playerId)
    if (!p || p.info.bot || !message || typeof message !== "object") return
    const m = message as unknown as Record<string, unknown>
    switch (m.type) {
      case "ping":
        if (typeof m.t === "number" && Number.isFinite(m.t)) this.hooks.send(playerId, { type: "pong", t: m.t })
        return
      case "input":
        return this.onInput(p, m)
      case "hello": {
        if (typeof m.name === "string") p.info.name = cleanText(m.name, NAME_MAX) || p.info.name
        if (isTeam(m.team, this.config.teams) && m.team !== p.info.team && this.canJoinTeam(playerId, m.team)) this.setTeam(p, m.team)
        this.hooks.onChange?.()
        return
      }
      case "team":
        if (!isTeam(m.team, this.config.teams) || m.team === p.info.team) return
        if (!this.canJoinTeam(playerId, m.team)) return this.error(playerId, "That team is full.")
        this.setTeam(p, m.team)
        this.hooks.onChange?.()
        return
      case "spawn":
        return this.onSpawn(p, m.kind)
      case "man-turret":
        return this.onManTurret(p, m.ship, m.turret)
      case "board":
        return this.onBoard(p, m.vehicle, m.seat)
      case "switch-seat":
        return this.onSwitchSeat(p, m.seat)
      case "leave-vehicle": {
        if (p.info.turret) { this.leaveTurret(p.info); return }
        const v = this.vehicleOf(p.info)
        if (v && v.alive && !this.canLeave(v)) return this.error(playerId, "You can only bail out at base.")
        this.vacate(p.info)
        return
      }
      case "chat":
        return this.onChat(p, m.text)
    }
  }

  private error(playerId: string, message: string): void {
    this.hooks.send(playerId, { type: "error", message })
  }

  private onInput(p: PlayerState, m: Record<string, unknown>): void {
    const seq = m.seq
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq <= p.seq) return
    if (seq <= p.ack) {
      // Already stood in for by a repeated input while the buffer ran dry: never apply it twice.
      p.jitter.streak = seq === p.seq + 1 ? p.jitter.streak + 1 : 0
      p.seq = seq
      p.jitter.late++
      return
    }
    const input: QueuedInput = { seq, at: this.tick }
    if (m.flight !== undefined) {
      input.flight = readFlight(m.flight)
      if (!input.flight) return
    }
    if (m.seat !== undefined) {
      input.seat = readSeat(m.seat)
      if (!input.seat) return
    }
    p.jitter.streak = seq === p.seq + 1 ? p.jitter.streak + 1 : 0
    p.seq = seq
    p.lastInputAt = this.time
    p.queue.push(input)
    // Hard cap: drop the oldest, but keep its state so nothing regresses.
    while (p.queue.length > INPUT_QUEUE_MAX) {
      this.consume(p, p.queue.shift()!)
      p.jitter.dropped++
    }
  }

  /**
   * Adaptive jitter buffer (playout schedule): input `seq` is due at tick `seq + offset`, where offset is set on
   * the first arrival to hold ~`target` ticks. Exactly one input is consumed per tick. A dry tick repeats the last
   * input as a stand-in for the next seq (ack advances; the late original is skipped, never double-applied).
   * Repeated underruns grow the buffer (one hold tick); a window with spare depth, or depth above
   * target + margin, shrinks it (one tick consumes two inputs).
   */
  private consumeTick(p: PlayerState): void {
    const jb = p.jitter
    const q = p.queue
    while (q.length && q[0].seq <= p.ack) { q.shift(); jb.late++ }
    if (!jb.primed) {
      if (!q.length) return
      jb.offset = q[0].at - q[0].seq + jb.target
      jb.primed = true
      jb.starveRun = 0
    }
    if (++jb.windowTicks >= JITTER_WINDOW) {
      if (jb.windowUnderruns === 0 && jb.windowMinSlack >= 1 && jb.windowMinSlack !== Infinity) {
        if (jb.target > JITTER_TARGET_MIN) jb.target--
        jb.offset--
      }
      jb.windowTicks = 0
      jb.windowMinSlack = Infinity
      jb.windowUnderruns = 0
    }
    if (q.length > jb.target + JITTER_CATCHUP_MARGIN) {
      jb.offset--
      jb.caughtUp++
    }
    const due = this.tick - jb.offset
    let consumed = 0
    while (consumed < 2 && q.length && q[0].seq <= due) {
      const next = q.shift()!
      const after = q[0]
      if (consumed === 0 && after && after.seq <= due && next.seat && after.seat) {
        // Two inputs this tick: keep one-shot presses from the first.
        after.seat = { ...after.seat, flares: after.seat.flares || next.seat.flares, ability: after.seat.ability || next.seat.ability }
      }
      this.consume(p, next)
      consumed++
    }
    if (consumed) {
      jb.starveRun = 0
      if (q.length < jb.windowMinSlack) jb.windowMinSlack = q.length
      return
    }
    if (p.ack >= due) return // ahead of schedule (buffer growing)
    // Dry tick.
    if (jb.starveRun === 0) jb.windowUnderruns++
    // Stand-ins only make sense for a client streaming one contiguous seq per tick.
    if (jb.starveRun < JITTER_MAX_SYNTH && p.ack >= 0 && jb.streak >= JITTER_STREAM_MIN && this.time - p.lastInputAt <= STALE_INPUT) {
      jb.starveRun++
      jb.synthesized++
      p.ack++
      jb.windowMinSlack = 0
      if ((jb.starveRun >= 2 || jb.windowUnderruns >= 2) && jb.target < JITTER_TARGET_MAX) {
        jb.target++
        jb.offset++
        jb.windowUnderruns = 0
      }
    } else {
      // Long gap (sender idle): re-prime on the next arrival.
      jb.starveRun = 0
      jb.primed = false
    }
  }

  private consume(p: PlayerState, input: QueuedInput): void {
    if (input.flight) p.flight = input.flight
    if (input.seat) p.seat = input.seat
    p.ack = input.seq
  }

  private onChat(p: PlayerState, text: unknown): void {
    if (typeof text !== "string") return
    const clean = cleanText(text, CHAT_MAX)
    if (!clean) return
    p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (this.time - p.chatAt) / CHAT_REFILL)
    p.chatAt = this.time
    if (p.chatTokens < 1) return this.error(p.info.id, "You're sending messages too fast.")
    p.chatTokens -= 1
    this.events.push({ type: "chat", player: p.info.id, text: clean })
  }

  private setTeam(p: PlayerState, team: TeamId): void {
    this.vacate(p.info)
    this.leaveTurret(p.info)
    p.info.team = team
    this.syncBots()
  }

  private onSpawn(p: PlayerState, kind: unknown): void {
    if (typeof kind !== "string" || !(VEHICLE_KINDS as string[]).includes(kind)) return
    if (this.matchEndedAt !== null) return this.error(p.info.id, "Match over — next round starting soon.")
    if (this.time < p.info.respawnAt) return this.error(p.info.id, "Respawn not ready.")
    const current = this.vehicleOf(p.info)
    if (current && current.alive && !this.canLeave(current)) return this.error(p.info.id, "Return to base to change aircraft.")
    if (!this.spawnCarrier(p.info.team)) return this.error(p.info.id, "Your carriers have been sunk.")
    this.vacate(p.info)
    this.leaveTurret(p.info)
    this.spawnVehicle(p.info, kind as VehicleKind)
  }

  /** Man one of your fleet's turrets instead of flying (seat input aims and fires it). */
  private onManTurret(p: PlayerState, shipId: unknown, turretId: unknown): void {
    if (typeof shipId !== "string" || typeof turretId !== "string") return
    const ship = FLEET.find(s => s.id === shipId)
    const mount = ship ? SHIP_SPECS[ship.kind].turrets.find(t => t.id === turretId) : undefined
    if (!ship || !mount || ship.team !== p.info.team || ship.team >= this.config.teams || !mount.mannable) return this.error(p.info.id, "Can't man that turret.")
    if (this.matchEndedAt !== null) return this.error(p.info.id, "Match over — next round starting soon.")
    if (this.time < p.info.respawnAt) return this.error(p.info.id, "Respawn not ready.")
    if (!turretOperational(this.combat, shipId, turretId)) return this.error(p.info.id, "That turret is knocked out.")
    const tr = shipRuntime(this.combat, shipId)!.turrets[turretId]
    if (tr.manned && tr.manned !== p.info.id) return this.error(p.info.id, "That turret is already manned.")
    const current = this.vehicleOf(p.info)
    if (current && current.alive && !this.canLeave(current)) return this.error(p.info.id, "Return to base first.")
    this.vacate(p.info)
    this.leaveTurret(p.info)
    tr.manned = p.info.id
    p.info.turret = { ship: shipId, turret: turretId }
    p.seat = NEUTRAL_SEAT
  }

  private leaveTurret(player: PlayerInfo): void {
    const t = player.turret
    if (!t) return
    const tr = shipRuntime(this.combat, t.ship)?.turrets[t.turret]
    if (tr && tr.manned === player.id) tr.manned = null
    player.turret = null
  }

  /** The team's first carrier still afloat (spawns go there), or null when all are sunk. */
  spawnCarrier(team: TeamId): string | null {
    for (const sh of FLEET) {
      if (sh.team !== team || sh.kind !== "carrier") continue
      const rt = shipRuntime(this.combat, sh.id)
      if (rt && !rt.sunk) return sh.id
    }
    return null
  }

  /** Spawn slot on whichever carrier is afloat (geography lays out the primary carrier; mirror onto others). */
  private spawnAt(team: TeamId, kind: VehicleKind, index: number) {
    const sp = spawnPoint(team, kind, index)
    const id = this.spawnCarrier(team)
    const primary = carrierOf(team)
    if (!id || id === primary.id) return sp
    const other = posedShip(id)
    if (!other) return sp
    const local = worldToShip(primary, sp.position)
    return { ...sp, position: shipToWorld(other, local), yaw: sp.yaw + other.heading - primary.heading }
  }

  /** Create a vehicle at the team's base with `player` in the pilot seat. */
  spawnVehicle(player: PlayerInfo, kind: VehicleKind): VehicleEntity {
    // Spawns (and respawns) always use the carrier's current pose.
    this.syncFleet()
    const team = player.team
    let index = 0
    for (let i = 0; i < SPAWN_SLOTS; i++) {
      const sp = this.spawnAt(team, kind, i).position
      const blocked = this.vehicles.some(v => v.alive && Math.hypot(v.flight.position[0] - sp[0], v.flight.position[1] - sp[1], v.flight.position[2] - sp[2]) < 25)
      if (!blocked) { index = i; break }
      index = i + 1
    }
    const spec = VEHICLES[kind]
    const v: VehicleEntity = {
      id: `v${this.nextId++}`, kind, team,
      flight: createFlightState(kind, this.spawnAt(team, kind, index % SPAWN_SLOTS)),
      hp: spec.maxHp, maxHp: spec.maxHp,
      seats: [player.id, null], aim: [null, null], weapons: createWeapons(kind),
      flaresReadyAt: 0, flareCount: spec.flares, abilityReadyAt: 0, spottedUntil: 0, lastDamagedBy: null, alive: true,
    }
    this.vehicles.push(v)
    this.meta.set(v.id, { emptySince: null, lastHp: v.hp, lastHitAt: -Infinity, diedAt: null, gunnerEmptySince: this.time })
    markSpawned(v, this.time)
    player.vehicleId = v.id
    player.seat = 0
    const ps = this.players.get(player.id)
    if (ps) { ps.flight = NEUTRAL_INPUT; ps.seat = NEUTRAL_SEAT }
    return v
  }

  private onBoard(p: PlayerState, vehicleId: unknown, seat: unknown): void {
    if (typeof vehicleId !== "string" || !isSeat(seat)) return
    const v = this.vehicles.find(x => x.id === vehicleId)
    if (!v || !v.alive || v.team !== p.info.team) return this.error(p.info.id, "Can't board that aircraft.")
    if (this.time < p.info.respawnAt) return this.error(p.info.id, "Respawn not ready.")
    if (p.info.vehicleId === v.id) return this.onSwitchSeat(p, seat)
    const current = this.vehicleOf(p.info)
    if (current && current.alive && !this.canLeave(current)) return
    const occupant = v.seats[seat] ? this.players.get(v.seats[seat]!) : undefined
    if (v.seats[seat] && !occupant?.info.bot) return this.error(p.info.id, "Seat taken.")
    this.vacate(p.info)
    if (occupant) {
      // Humans push bots out. A displaced bot pilot may stay on as gunner; a bot never pilots a human's aircraft.
      this.evictBot(occupant)
      const other = (1 - seat) as SeatIndex
      if (seat === 0 && !v.seats[other] && !occupant.leaving) this.seatPlayer(occupant.info, v, other)
    }
    this.seatPlayer(p.info, v, seat)
  }

  private onSwitchSeat(p: PlayerState, seat: unknown): void {
    if (!isSeat(seat)) return
    const v = this.vehicleOf(p.info)
    if (!v || !v.alive || p.info.seat === seat) return
    const occupant = v.seats[seat] ? this.players.get(v.seats[seat]!) : undefined
    if (v.seats[seat] && !occupant?.info.bot) return this.error(p.info.id, "Seat taken.")
    const from = p.info.seat!
    v.seats[from] = null
    v.aim[from] = null
    if (from === 1) this.meta.get(v.id)!.gunnerEmptySince = this.time
    if (occupant) {
      this.evictBot(occupant)
      // Swap only into the gunner seat; a bot never takes the pilot seat of a human's aircraft.
      if (from === 1) this.seatPlayer(occupant.info, v, 1)
    }
    this.seatPlayer(p.info, v, seat)
  }

  private seatPlayer(player: PlayerInfo, v: VehicleEntity, seat: SeatIndex): void {
    v.seats[seat] = player.id
    player.vehicleId = v.id
    player.seat = seat
    if (seat === 1) { const meta = this.meta.get(v.id); if (meta) meta.gunnerEmptySince = Infinity }
    const ps = this.players.get(player.id)
    if (ps) { ps.flight = NEUTRAL_INPUT; ps.seat = NEUTRAL_SEAT }
  }

  /** Remove a player from whatever seat they hold. */
  private vacate(player: PlayerInfo): void {
    const v = this.vehicleOf(player)
    if (v && player.seat !== null && v.seats[player.seat] === player.id) {
      v.seats[player.seat] = null
      v.aim[player.seat] = null
      if (player.seat === 1) { const meta = this.meta.get(v.id); if (meta) meta.gunnerEmptySince = this.time }
    }
    player.vehicleId = null
    player.seat = null
    const ps = this.players.get(player.id)
    if (ps) { ps.flight = NEUTRAL_INPUT; ps.seat = NEUTRAL_SEAT }
  }

  private vehicleOf(player: PlayerInfo): VehicleEntity | undefined {
    return player.vehicleId ? this.vehicles.find(v => v.id === player.vehicleId) : undefined
  }

  /** Crew may leave/swap aircraft only on their carrier deck or during spawn protection. */
  private canLeave(v: VehicleEntity): boolean {
    return this.onOwnDeck(v) || this.time - (v.spawnedAt ?? -Infinity) < SPAWN_PROTECTION
  }

  /** Landed on its own team's carrier flight deck. */
  onOwnDeck(v: VehicleEntity): boolean {
    if (!v.flight.onGround) return false
    const spec = SHIP_SPECS.carrier
    this.syncFleet()
    for (const sh of FLEET) {
      if (sh.team !== v.team || sh.kind !== "carrier") continue
      const rt = shipRuntime(this.combat, sh.id)
      const posed = posedShip(sh.id)
      if (!posed || (rt && rt.sunk)) continue
      const l = worldToShip(posed, v.flight.position)
      if (Math.abs(l[0]) <= spec.halfWidth + 2 && Math.abs(l[2]) <= spec.halfLength + 2 && l[1] >= spec.deckHeight - 2 && l[1] <= spec.deckHeight + 10) return true
    }
    return false
  }

  // ───────────────────────── simulation ─────────────────────────

  /** Advance wall-clock time (seconds). Runs fixed 60 Hz ticks internally and emits snapshots at 20 Hz. */
  advance(elapsed: number): void {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return
    this.accumulator += Math.min(elapsed, MAX_CATCH_UP)
    while (this.accumulator >= TICK_DT - 1e-9) {
      this.accumulator -= TICK_DT
      this.step()
      if (this.events.length) this.flushEvents()
      if (this.tick % TICKS_PER_SNAPSHOT === 0) this.broadcastSnapshot()
    }
    if (this.accumulator < 0) this.accumulator = 0
  }

  private step(): void {
    this.tick++
    this.time = this.tick * TICK_DT
    this.syncFleet()
    const now = this.time
    const events = this.events
    const vehicles = this.vehicles

    // One buffered input per player per tick (matches client prediction).
    for (const p of this.players.values()) {
      if (p.info.bot) continue
      this.consumeTick(p)
    }

    // Bot brains produce this tick's inputs (same path as human inputs below).
    for (const v of vehicles) {
      if (!v.alive) continue
      for (let i = 0; i < 2; i++) {
        const id = v.seats[i]
        const p = id ? this.players.get(id) : undefined
        if (!p || !p.brain) continue
        const out = botInput(p.brain, p.info, v, vehicles, now, this.combat.missiles, worldQuery, this.combat.ships, this.combat.projectiles)
        // botInput reuses its result objects per brain: copy what we keep.
        p.seat = { ...out.seat, aim: out.seat.aim && [out.seat.aim[0], out.seat.aim[1], out.seat.aim[2]] }
        if (i === 0) p.flight = out.flight ? { ...out.flight, aim: out.flight.aim && [out.flight.aim[0], out.flight.aim[1], out.flight.aim[2]] } : NEUTRAL_INPUT
        p.lastInputAt = now
      }
    }

    // Inputs → flight + weapons.
    for (const v of vehicles) {
      if (!v.alive) continue
      const pilot = v.seats[0] ? this.players.get(v.seats[0]) : undefined
      stepFlight(v.flight, pilot ? pilot.flight : NEUTRAL_INPUT, TICK_DT, worldQuery)
      for (let i = 0; i < 2; i++) {
        const s = i as SeatIndex
        const id = v.seats[s]
        const p = id ? this.players.get(id) : undefined
        if (!p) continue
        const input = now - p.lastInputAt > STALE_INPUT ? { ...p.seat, firePrimary: false, fireSecondary: false, flares: false, ability: false } : p.seat
        v.aim[s] = input.aim
        applySeatInput(this.combat, v, s, input, vehicles, now, events)
      }
    }

    // Player-manned ship turrets.
    for (const p of this.players.values()) {
      const t = p.info.turret
      if (!t) continue
      const input = now - p.lastInputAt > STALE_INPUT ? { ...p.seat, firePrimary: false } : p.seat
      applyTurretInput(this.combat, t.ship, t.turret, p.info.id, input, now, events)
    }

    const eventStart = events.length
    stepCombat(this.combat, vehicles, TICK_DT, now, events)

    // Sunk ships / knocked-out turrets throw their gunners back to the spawn screen (counts as a death).
    for (const p of this.players.values()) {
      const t = p.info.turret
      if (!t || turretOperational(this.combat, t.ship, t.turret)) continue
      this.leaveTurret(p.info)
      p.info.deaths++
      p.info.respawnAt = now + RESPAWN_DELAY
      p.seat = NEUTRAL_SEAT
    }

    // Damage bookkeeping (for crash credit) + crashes.
    for (const v of vehicles) {
      const meta = this.meta.get(v.id)!
      if (v.hp < meta.lastHp) meta.lastHitAt = now
      meta.lastHp = v.hp
      if (v.alive && v.flight.crashed) killVehicle(v, "crash", this.crashCredit(v, meta), events)
    }

    // Vehicle deaths (from combat or crashes this tick).
    for (const v of vehicles) {
      const meta = this.meta.get(v.id)!
      if (v.alive || meta.diedAt !== null) continue
      meta.diedAt = now
      let killEvent: Extract<GameEvent, { type: "kill" }> | undefined
      for (let i = eventStart; i < events.length; i++) {
        const e = events[i]
        if (e.type === "kill" && e.victim === v.id) { killEvent = e; break }
      }
      // Something marked it dead without an event (shouldn't happen): announce it ourselves.
      const killer = killEvent ? killEvent.killer : this.crashCredit(v, meta)
      if (!killEvent) {
        v.alive = true
        killVehicle(v, "crash", killer, events)
      }
      this.onVehicleDestroyed(v, killer, killEvent?.killerTeam)
    }

    this.cleanupVehicles()
    this.updateBots()
    if (this.matchEndedAt === null) this.updateScores()
    this.updateMatch()
  }

  /** Crashes credit the last attacker only if they hit the vehicle recently. */
  private crashCredit(v: VehicleEntity, meta: VehicleMeta): string | null {
    return v.lastDamagedBy && this.time - meta.lastHitAt <= CRASH_CREDIT_WINDOW ? v.lastDamagedBy : null
  }

  /** `killerTeam` scores kills with no killer player (fleet AA). */
  private onVehicleDestroyed(v: VehicleEntity, killer: string | null, aaTeam?: TeamId): void {
    for (let s = 0; s < 2; s++) {
      const id = v.seats[s]
      const p = id ? this.players.get(id) : undefined
      if (p) {
        p.info.deaths++
        p.info.vehicleId = null
        p.info.seat = null
        p.info.respawnAt = this.time + RESPAWN_DELAY
        p.flight = NEUTRAL_INPUT
        p.seat = NEUTRAL_SEAT
      }
      v.seats[s] = null
    }
    const kp = killer ? this.players.get(killer) : undefined
    const killerTeam = kp ? kp.info.team : killer ? this.vehicles.find(x => x.id === killer)?.team : aaTeam
    if (killerTeam === undefined || killerTeam === v.team) return
    if (kp) kp.info.kills++
    if (this.matchEndedAt !== null) return
    this.teamKills[killerTeam]++
  }

  /** Total max hp of the enemy fleets (active teams) a team is fighting. */
  private enemyFleetHp(team: number): number {
    let hp = 0
    for (const sh of FLEET) if (sh.team !== team && sh.team < this.config.teams) hp += SHIP_SPECS[sh.kind].maxHp
    return hp
  }

  /** Scores = % of enemy fleet hp destroyed (0–100, 1 decimal); emits `score` on change. */
  private updateScores(): void {
    const dealt = this.combat.shipDamageBy ?? []
    let changed = false
    for (let t = 0; t < this.config.teams; t++) {
      const pct = Math.round((1000 * (dealt[t] ?? 0)) / Math.max(1, this.enemyFleetHp(t))) / 10
      if (pct !== this.scores[t]) { this.scores[t] = pct; changed = true }
    }
    if (changed) this.events.push({ type: "score", scores: [...this.scores] })
  }

  private cleanupVehicles(): void {
    const now = this.time
    let removed = false
    for (const v of this.vehicles) {
      const meta = this.meta.get(v.id)!
      if (!v.alive) {
        if (meta.diedAt !== null && now - meta.diedAt >= WRECK_LINGER) removed = true
        continue
      }
      // A bot gunner never stays in an aircraft without a pilot.
      if (!v.seats[0] && v.seats[1]) {
        const gunner = this.players.get(v.seats[1])
        if (gunner?.info.bot) this.evictBot(gunner)
      }
      if (v.seats[0] || v.seats[1]) {
        meta.emptySince = null
        continue
      }
      if (meta.emptySince === null) meta.emptySince = now
      const idle = now - meta.emptySince
      if (this.onOwnDeck(v)) {
        if (idle >= PARKED_REMOVE_DELAY) { v.alive = false; meta.diedAt = -Infinity; removed = true }
      } else if (idle >= ABANDONED_DESTROY_DELAY) {
        const killer = this.crashCredit(v, meta)
        killVehicle(v, "crash", killer, this.events)
        meta.diedAt = now
        this.onVehicleDestroyed(v, killer)
      }
    }
    if (!removed) return
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i]
      const meta = this.meta.get(v.id)!
      if (!v.alive && meta.diedAt !== null && now - meta.diedAt >= WRECK_LINGER) {
        for (const id of v.seats) if (id) { const p = this.players.get(id); if (p) this.vacate(p.info) }
        this.vehicles.splice(i, 1)
        this.meta.delete(v.id)
      }
    }
  }

  private updateMatch(): void {
    const now = this.time
    if (this.matchEndedAt !== null) {
      if (now - this.matchEndedAt >= MATCH_RESTART_DELAY) this.resetMatch()
      return
    }
    // Fleet Strike: a team is out when all its carriers are sunk; last team with a carrier wins.
    const alive: TeamId[] = []
    for (let t = 0; t < this.config.teams; t++) if (this.spawnCarrier(t as TeamId)) alive.push(t as TeamId)
    if (alive.length <= 1) return this.endMatch(alive.length === 1 ? alive[0] : null, "carriers-sunk")
    if (now - this.matchStartedAt >= this.config.timeLimit) {
      // Time: most enemy ship damage dealt, then kills.
      const dealt = this.combat.shipDamageBy ?? []
      let best: TeamId | null = null
      let tie = false
      for (const t of alive) {
        if (best === null) { best = t; continue }
        const a = dealt[t] ?? 0, b = dealt[best] ?? 0
        if (a > b + 1e-6 || (Math.abs(a - b) <= 1e-6 && this.teamKills[t] > this.teamKills[best])) { best = t; tie = false }
        else if (Math.abs(a - b) <= 1e-6 && this.teamKills[t] === this.teamKills[best]) tie = true
      }
      this.endMatch(tie ? null : best, "time")
    }
  }

  private endMatch(winner: TeamId | null, reason: "carriers-sunk" | "time" | "score"): void {
    this.matchEndedAt = this.time
    this.winner = winner
    this.events.push({ type: "match-end", winner, reason })
    this.hooks.onChange?.()
  }

  private resetMatch(): void {
    for (const p of this.players.values()) {
      p.info.vehicleId = null
      p.info.seat = null
      p.info.kills = 0
      p.info.deaths = 0
      p.info.respawnAt = p.info.bot ? this.time + 0.5 + this.rng() * 2 : 0
      p.info.turret = null
      p.flight = NEUTRAL_INPUT
      p.seat = NEUTRAL_SEAT
    }
    this.vehicles.length = 0
    this.meta.clear()
    this.combat = createCombatState()
    this.scores = new Array(this.config.teams).fill(0)
    this.teamKills = new Array(this.config.teams).fill(0)
    this.cratersSent = 0
    this.lastShipsJson = ""
    this.matchStartedAt = this.time
    this.matchEndedAt = null
    this.winner = null
    this.events.push({ type: "score", scores: [...this.scores] })
    this.hooks.onChange?.()
  }

  /** Seconds since the current match started (0 during intermission). Drives the fleet approach. */
  matchTime(): number {
    return this.matchEndedAt !== null ? 0 : Math.max(0, this.time - this.matchStartedAt)
  }

  /**
   * Push this room's match time into geography's (module-global) fleet state. Called at the start of every
   * tick and before spawns, since several rooms (or the client renderer) may share the module.
   */
  syncFleet(): void {
    setFleetState(this.matchTime(), this.config.teams)
    // Sunk ships stop being spawn points / AA / (after SINK_SOLID_TIME) collision in geography.
    setShipStates(this.shipStates(), this.time)
  }

  /** Room time when the match ends (running) or the next one starts (intermission). */
  matchEndsAt(): number {
    return this.matchEndedAt !== null ? this.matchEndedAt + MATCH_RESTART_DELAY : this.matchStartedAt + this.config.timeLimit
  }

  // ───────────────────────── output ─────────────────────────

  private flushEvents(): void {
    const batch = this.events
    this.events = []
    const message: ServerMessage = { type: "events", events: batch }
    if (this.hooks.sendText) {
      const text = JSON.stringify(message)
      for (const p of this.players.values()) if (!p.info.bot) this.hooks.sendText(p.info.id, text)
    } else {
      for (const p of this.players.values()) if (!p.info.bot) this.hooks.send(p.info.id, message)
    }
  }

  /** Full (decoded) snapshot for one player — convenience for tests/tools; the network uses the wire format. */
  snapshotFor(playerId: string): Snapshot {
    const decode = createSnapshotDecoder()
    const p = this.players.get(playerId)
    const shared = this.wireShared(true)
    if (p) shared.vehicles = shared.vehicles.filter((_, i) => this.visibleTo(p.info.team, this.vehicles[i]))
    return decode({ ...shared, ...this.wirePersonal(p ?? null, false) } as WireSnapshot) as Snapshot
  }

  /**
   * Visibility contract: a stealth enemy is sent to `team` only while spotted or within STEALTH_VISUAL_RANGE
   * of one of that team's aircraft or (afloat) ships. Everything else is always visible.
   */
  visibleTo(team: number, v: VehicleEntity): boolean {
    if (v.team === team || !isHiddenStealth(v, this.time)) return true
    const p = v.flight.position, r2 = STEALTH_VISUAL_RANGE * STEALTH_VISUAL_RANGE
    for (const o of this.vehicles) {
      if (!o.alive || o.team !== team) continue
      const q = o.flight.position
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]
      if (dx * dx + dy * dy + dz * dz < r2) return true
    }
    for (const sh of posedFleet()) {
      if (sh.team !== team || shipRuntime(this.combat, sh.id)?.sunk) continue
      const dx = p[0] - sh.position[0], dy = p[1] - 20, dz = p[2] - sh.position[2]
      if (dx * dx + dy * dy + dz * dz < r2) return true
    }
    return false
  }

  private wireShared(withPlayers: boolean): Omit<WireSnapshot, "ack"> {
    const cs = this.combat
    const now = this.time
    const shared: Omit<WireSnapshot, "ack"> = {
      type: "snapshot",
      wire: 1,
      time: r3(now),
      tick: this.tick,
      vehicles: this.vehicles.map(v => packVehicle(v, now)),
      projectiles: cs.projectiles.map(packProjectile),
      missiles: cs.missiles.map(packMissile),
      flares: cs.flares.map(packFlare),
      scores: this.scores,
      matchEndsAt: r3(this.matchEndsAt()),
      matchStartedAt: r3(this.matchStartedAt),
      intermission: this.matchEndedAt !== null,
    }
    if (withPlayers) { shared.players = this.playerList(); shared.ships = this.shipStates(); shared.craters = (cs.craters ?? []).slice() }
    return shared
  }

  /** Ship objectives of active teams (protocol ShipState). */
  shipStates(): ShipState[] {
    const out: ShipState[] = []
    for (const sh of FLEET) {
      if (sh.team >= this.config.teams) continue
      const rt = shipRuntime(this.combat, sh.id)
      if (!rt) continue
      const turrets: ShipState["turrets"] = {}
      for (const k in rt.turrets) turrets[k] = { hp: Math.round(rt.turrets[k].hp), manned: rt.turrets[k].manned }
      out.push({ id: sh.id, hp: Math.round(rt.hp), maxHp: rt.maxHp, sunk: rt.sunk, sunkAt: r2(rt.sunkAt), turrets, damage: rt.damage.map(d => [d[0], d[1], d[2]] as Vec3) })
    }
    return out
  }

  private playerList(): PlayerInfo[] {
    return [...this.players.values()].map(p => ({ ...p.info, respawnAt: r2(p.info.respawnAt) }))
  }

  private wirePersonal(p: PlayerState | null, full: boolean): Pick<WireSnapshot, "ack" | "own" | "players" | "ships" | "craters"> {
    const out: Pick<WireSnapshot, "ack" | "own" | "players" | "ships" | "craters"> = { ack: p ? p.ack : -1 }
    const v = p ? this.vehicleOf(p.info) : undefined
    if (v) out.own = packOwn(v)
    // Joiners get everything (these keys come after the shared ones, so JSON.parse keeps these).
    if (full) {
      out.players = this.playerList()
      out.ships = this.shipStates()
      out.craters = (this.combat.craters ?? []).slice()
    }
    return out
  }

  private broadcastSnapshot(): void {
    if (this.humanCount() === 0) return
    // Players list only when it changed (or periodically as a safety net).
    const list = this.playerList()
    const listJson = JSON.stringify(list)
    const includePlayers = listJson !== this.lastPlayersJson || this.time - this.lastPlayersAt >= PLAYERS_RESEND
    if (includePlayers) { this.lastPlayersJson = listJson; this.lastPlayersAt = this.time }
    const shared = this.wireShared(false)
    if (includePlayers) shared.players = list
    // Ships only when changed (or once a second); craters as a diff since the last broadcast.
    const ships = this.shipStates()
    const shipsJson = JSON.stringify(ships)
    if (shipsJson !== this.lastShipsJson || this.time - this.lastShipsAt >= PLAYERS_RESEND) {
      this.lastShipsJson = shipsJson
      this.lastShipsAt = this.time
      shared.ships = ships
    }
    const craters = this.combat.craters ?? []
    if (craters.length > this.cratersSent) { shared.craters = craters.slice(this.cratersSent); this.cratersSent = craters.length }
    // Serialize the shared body once (vehicles separately: each packed vehicle is stringified once and
    // joined per team, so hidden stealth aircraft cost only a filtered join); per-player fields are a tail.
    const parts = shared.vehicles.map(v => JSON.stringify(v))
    const { vehicles: _omit, ...rest } = shared
    const head = `${JSON.stringify(rest).slice(0, -1)},"vehicles":`
    const all = `[${parts.join(",")}]`
    const anyHidden = this.vehicles.some(v => isHiddenStealth(v, this.time))
    const perTeam = new Map<number, string>()
    const vehiclesFor = (team: number): string => {
      if (!anyHidden) return all
      let json = perTeam.get(team)
      if (json === undefined) {
        json = `[${parts.filter((_, i) => this.visibleTo(team, this.vehicles[i])).join(",")}]`
        perTeam.set(team, json)
      }
      return json
    }
    for (const p of this.players.values()) {
      if (p.info.bot) continue
      const personal = this.wirePersonal(p, p.needsPlayers)
      p.needsPlayers = false
      const text = `${head}${vehiclesFor(p.info.team)},${JSON.stringify(personal).slice(1)}`
      if (this.hooks.sendText) this.hooks.sendText(p.info.id, text)
      else {
        let decode = this.decoders.get(p.info.id)
        if (!decode) this.decoders.set(p.info.id, (decode = createSnapshotDecoder()))
        this.hooks.send(p.info.id, decode(JSON.parse(text)))
      }
    }
  }
}

// ───────────────────────── wire format ─────────────────────────
// Compact snapshot encoding. `createSnapshotDecoder` turns it back into the protocol `Snapshot` shape.

/** Compact vehicle. Optional fields are omitted at their default (false/null/0). */
export interface WireVehicle {
  id: string
  k: VehicleKind
  t: TeamId
  /** position, velocity (2 dp), orientation (4 dp), angular velocity (2 dp), throttle (2 dp). */
  p: Vec3
  v: Vec3
  q: Quat
  w: Vec3
  th: number
  /** onGround / gearDown flags. */
  g?: 1
  gd?: 1
  c?: NonNullable<FlightState["crashed"]>
  hp: number
  s: [string | null, string | null]
  /** Seat aims (3 dp); omitted when both null. */
  a?: [Vec3 | null, Vec3 | null]
  /** Ammo per seat/slot (for pylon/store rendering); full runtimes only in `own`. */
  am: [number[], number[]]
  fc: number
  /** spottedUntil, only while in the future. */
  su?: number
  /** Dead (wreck). */
  d?: 1
}

/** Per-player detail for the vehicle the receiver occupies. */
export interface WireOwn {
  vehicle: string
  /** flight.tick (for prediction/reconciliation). */
  ft: number
  weapons: [WeaponRuntime[], WeaponRuntime[]]
  fr: number
  ar: number
  ld: string | null
  /** Recon look-to-spot progress / candidate (omitted when unset). */
  sp?: number
  sc?: string | null
}

export interface WireProjectile { id: number; w: WeaponId; o: string; vh: string; t: TeamId; p: Vec3; v: Vec3; a: number; l: number }
export interface WireMissile extends WireProjectile { tg: string | null; st?: 1; se?: SeatIndex }
export interface WireFlare { id: number; vh: string; p: Vec3; v: Vec3; a: number; l: number }

export interface WireSnapshot {
  type: "snapshot"
  wire: 1
  time: number
  tick: number
  vehicles: WireVehicle[]
  /** Present only when changed (≤ once per second otherwise) or for newly joined players. */
  players?: PlayerInfo[]
  /** Ship objectives: when changed (≤ once per second otherwise) or on join. */
  ships?: ShipState[]
  /** Craters since the last snapshot; the full list on join. */
  craters?: Crater[]
  projectiles: WireProjectile[]
  missiles: WireMissile[]
  flares: WireFlare[]
  scores: number[]
  matchEndsAt: number
  /** Room time the current match started; match time = intermission ? 0 : time - matchStartedAt. */
  matchStartedAt: number
  intermission: boolean
  ack: number
  own?: WireOwn
}

export type WireServerMessage = Exclude<ServerMessage, Snapshot> | WireSnapshot

const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000
const r4 = (n: number) => Math.round(n * 10000) / 10000
const v2 = (v: Vec3): Vec3 => [r2(v[0]), r2(v[1]), r2(v[2])]
const v3 = (v: Vec3): Vec3 => [r3(v[0]), r3(v[1]), r3(v[2])]

function packVehicle(v: VehicleEntity, now: number): WireVehicle {
  const f = v.flight
  const q = f.orientation
  const out: WireVehicle = {
    id: v.id, k: v.kind, t: v.team,
    p: v2(f.position), v: v2(f.velocity), q: [r4(q[0]), r4(q[1]), r4(q[2]), r4(q[3])], w: v2(f.angularVelocity), th: r2(f.throttle),
    hp: Math.round(v.hp * 10) / 10, s: v.seats,
    am: [v.weapons[0].map(w => w.ammo), v.weapons[1].map(w => w.ammo)],
    fc: v.flareCount,
  }
  if (f.onGround) out.g = 1
  if (f.gearDown) out.gd = 1
  if (f.crashed) out.c = f.crashed
  if (v.aim[0] || v.aim[1]) out.a = [v.aim[0] && v3(v.aim[0]), v.aim[1] && v3(v.aim[1])]
  if (v.spottedUntil > now) out.su = r2(v.spottedUntil)
  if (!v.alive) out.d = 1
  return out
}

function packOwn(v: VehicleEntity): WireOwn {
  const pack = (w: WeaponRuntime): WeaponRuntime => ({ ammo: w.ammo, readyAt: r3(w.readyAt), lockTarget: w.lockTarget, lock: r3(w.lock) })
  return {
    vehicle: v.id, ft: v.flight.tick,
    weapons: [v.weapons[0].map(pack), v.weapons[1].map(pack)],
    fr: r3(v.flaresReadyAt), ar: r3(v.abilityReadyAt), ld: v.lastDamagedBy,
    ...(v.spotProgress !== undefined ? { sp: r3(v.spotProgress) } : {}),
    ...(v.spotCandidate !== undefined ? { sc: v.spotCandidate } : {}),
  }
}

function packProjectile(x: Projectile): WireProjectile {
  return { id: x.id, w: x.weapon, o: x.owner, vh: x.vehicle, t: x.team, p: v2(x.position), v: v2(x.velocity), a: r3(x.age), l: r3(x.ttl) }
}

function packMissile(x: Missile): WireMissile {
  const out: WireMissile = {
    id: x.id, w: x.weapon, o: x.owner, vh: x.vehicle, t: x.team, p: v2(x.position), v: v2(x.velocity), a: r3(x.age), l: r3(x.ttl), tg: x.target,
  }
  if (x.steered) out.st = 1
  if (x.seat !== undefined) out.se = x.seat
  return out
}

function packFlare(x: Flare): WireFlare {
  return { id: x.id, vh: x.vehicle, p: v2(x.position), v: v2(x.velocity), a: r3(x.age), l: r3(x.ttl) }
}

/** Match time (seconds since the match started; 0 during intermission) as seen in a snapshot. */
export function snapshotMatchTime(s: Snapshot): number {
  const started = (s as Snapshot & { matchStartedAt?: number }).matchStartedAt ?? 0
  return s.intermission ? 0 : Math.max(0, s.time - started)
}

/**
 * Stateful decoder (one per connection): converts wire snapshots back to the protocol `Snapshot` shape,
 * remembering the last players list. Other messages pass through unchanged.
 */
export function createSnapshotDecoder(): (message: WireServerMessage | ServerMessage) => ServerMessage {
  let players: PlayerInfo[] = []
  let ships: ShipState[] | undefined
  return message => {
    if (message.type !== "snapshot" || !("wire" in message)) return message as ServerMessage
    const m = message as WireSnapshot
    if (m.players) players = m.players
    if (m.ships) ships = m.ships
    const own = m.own
    return {
      type: "snapshot",
      time: m.time,
      tick: m.tick,
      vehicles: m.vehicles.map(w => {
        const mine = own && own.vehicle === w.id ? own : null
        const v: VehicleEntity = {
          id: w.id, kind: w.k, team: w.t,
          flight: {
            kind: w.k, position: w.p, velocity: w.v, orientation: w.q, angularVelocity: w.w, throttle: w.th,
            onGround: w.g === 1, gearDown: w.gd === 1, crashed: w.c ?? null, tick: mine ? mine.ft : m.tick,
          },
          hp: w.hp, maxHp: VEHICLES[w.k]?.maxHp ?? w.hp,
          seats: w.s, aim: w.a ?? [null, null],
          weapons: mine ? mine.weapons : [
            w.am[0].map(ammo => ({ ammo, readyAt: 0, lockTarget: null, lock: 0 })),
            w.am[1].map(ammo => ({ ammo, readyAt: 0, lockTarget: null, lock: 0 })),
          ],
          flaresReadyAt: mine ? mine.fr : 0, flareCount: w.fc, abilityReadyAt: mine ? mine.ar : 0,
          spottedUntil: w.su ?? 0, lastDamagedBy: mine ? mine.ld : null, alive: w.d !== 1,
        }
        if (mine?.sp !== undefined) v.spotProgress = mine.sp
        if (mine?.sc !== undefined) v.spotCandidate = mine.sc
        return v
      }),
      players,
      ...(ships ? { ships } : {}),
      ...(m.craters ? { craters: m.craters } : {}),
      projectiles: m.projectiles.map(x => ({ id: x.id, weapon: x.w, owner: x.o, vehicle: x.vh, team: x.t, position: x.p, velocity: x.v, age: x.a, ttl: x.l })),
      missiles: m.missiles.map(x => {
        const out: Missile = {
          id: x.id, weapon: x.w, owner: x.o, vehicle: x.vh, team: x.t, position: x.p, velocity: x.v,
          target: x.tg, steered: x.st === 1, age: x.a, ttl: x.l,
        }
        if (x.se !== undefined) out.seat = x.se
        return out
      }),
      flares: m.flares.map(x => ({ id: x.id, vehicle: x.vh, position: x.p, velocity: x.v, age: x.a, ttl: x.l })),
      scores: m.scores,
      matchEndsAt: m.matchEndsAt,
      // Proposed protocol field (Snapshot.matchStartedAt); cast until protocol.ts adds it.
      matchStartedAt: m.matchStartedAt,
      intermission: m.intermission,
      ack: m.ack,
    } as Snapshot
  }
}
