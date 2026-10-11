// Authoritative game loop shared by the Room Durable Object and the browser's offline/loopback mode.
// Owned by the Server agent. Dependency-free: no DOM, no Date.now/Math.random inside the simulation.
import type { ClientMessage, RoomConfig, RoomSummary, ServerMessage, Snapshot } from "./protocol"
import { DEFAULT_ROOM_CONFIG, RESPAWN_DELAY } from "./protocol"
import type {
  Flare, FlightInput, FlightState, GameEvent, Missile, PlayerInfo, Projectile, Quat, SeatIndex, SeatInput, TeamId, Vec3,
  VehicleEntity, VehicleKind, WeaponId, WeaponRuntime,
} from "./types"
import { SNAPSHOT_RATE, TICK_DT, TICK_RATE } from "./types"
import { VEHICLES, VEHICLE_KINDS } from "./vehicles"
import { NEUTRAL_INPUT, createFlightState, stepFlight } from "./flight"
import { applySeatInput, createCombatState, createWeapons, killVehicle, stepCombat } from "./combat"
import type { CombatState } from "./combat"
import { inSafeZone, spawnPoint, worldQuery } from "./geography"

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
/** Unmanned vehicle outside its team's safe zone is destroyed after this many seconds. */
export const ABANDONED_DESTROY_DELAY = 20
/** Unmanned vehicle parked inside its team's safe zone is removed after this many seconds. */
export const PARKED_REMOVE_DELAY = 60
/** Crashes credit the last attacker if it damaged the vehicle within this window. */
export const CRASH_CREDIT_WINDOW = 8
export const MATCH_RESTART_DELAY = 15
/** Max queued inputs per player; older ones are dropped (bounds latency added by jitter buffering). */
export const INPUT_QUEUE_MAX = 6
/** Players list is re-sent at least this often even if unchanged (seconds). */
const PLAYERS_RESEND = 1
/** Human input older than this stops firing (lost connection / tab hidden). */
const STALE_INPUT = 1
const CHAT_MAX = 200
const CHAT_BURST = 4
const CHAT_REFILL = 1.5 // seconds per token
const NAME_MAX = 16
const SPAWN_SLOTS = 16

const NEUTRAL_SEAT: SeatInput = { aim: null, firePrimary: false, fireSecondary: false, flares: false, ability: false }

interface QueuedInput {
  seq: number
  flight?: FlightInput
  seat?: SeatInput
}

interface PlayerState {
  info: PlayerInfo
  flight: FlightInput
  seat: SeatInput
  queue: QueuedInput[]
  /** Highest input seq received. */
  seq: number
  /** Last input seq consumed by a tick (sent as snapshot ack). */
  ack: number
  lastInputAt: number
  chatTokens: number
  chatAt: number
  /** Needs the players list in its next snapshot (just joined). */
  needsPlayers: boolean
}

interface VehicleMeta {
  /** Room time when the vehicle last became unmanned (null while crewed). */
  emptySince: number | null
  lastHp: number
  lastHitAt: number
  diedAt: number | null
}

/** Bots are disabled for now: `bots` is always sanitized to 0. */
export function sanitizeConfig(input: unknown, base: RoomConfig = DEFAULT_ROOM_CONFIG): RoomConfig {
  const c = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const int = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  const name = typeof c.name === "string" ? cleanText(c.name, 32) : ""
  return {
    teams: int(c.teams, 2, 4, base.teams),
    bots: 0,
    maxPerTeam: int(c.maxPerTeam, 1, 16, base.maxPerTeam),
    scoreLimit: int(c.scoreLimit, 1, 1000, base.scoreLimit),
    timeLimit: int(c.timeLimit, 60, 7200, base.timeLimit),
    listed: typeof c.listed === "boolean" ? c.listed : base.listed,
    name: name || base.name,
  }
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
  return { aim, firePrimary: m.firePrimary === true, fireSecondary: m.fireSecondary === true, flares: m.flares === true, ability: m.ability === true }
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

  constructor(public readonly code: string, public config: RoomConfig, private hooks: RoomEngineHooks) {
    this.config = sanitizeConfig(config)
    this.scores = new Array(this.config.teams).fill(0)
  }

  // ───────────────────────── players ─────────────────────────

  /**
   * Register a human connection; returns its player id and sends `welcome`.
   * `beforeWelcome` lets transports map the new id to a connection before the first message goes out.
   */
  addPlayer(name: string, beforeWelcome?: (playerId: string) => void): string {
    const id = `p${this.nextId++}`
    const team = this.balancedTeam(null)
    this.players.set(id, {
      info: { id, name: cleanText(String(name ?? ""), NAME_MAX) || "Pilot", team, vehicleId: null, seat: null, kills: 0, deaths: 0, bot: false, respawnAt: 0 },
      flight: NEUTRAL_INPUT, seat: NEUTRAL_SEAT, queue: [], seq: -1, ack: -1, lastInputAt: -Infinity,
      chatTokens: CHAT_BURST, chatAt: this.time, needsPlayers: true,
    })
    beforeWelcome?.(id)
    this.hooks.send(id, { type: "welcome", playerId: id, room: this.code, config: { ...this.config } })
    this.hooks.onChange?.()
    return id
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId)
    if (!p) return
    this.vacate(p.info)
    this.players.delete(playerId)
    this.decoders.delete(playerId)
    this.hooks.onChange?.()
  }

  humanCount(): number {
    return this.players.size
  }

  playerCount(): number {
    return this.players.size
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

  private teamCounts(exclude: string | null): number[] {
    const counts = new Array(this.config.teams).fill(0)
    for (const p of this.players.values()) if (p.info.id !== exclude) counts[p.info.team]++
    return counts
  }

  private balancedTeam(exclude: string | null): TeamId {
    const counts = this.teamCounts(exclude)
    let best = 0
    for (let t = 1; t < counts.length; t++) if (counts[t] < counts[best]) best = t
    return best as TeamId
  }

  /** Players may pick a team if it doesn't make it bigger than the smallest team + 1 and it isn't full. */
  private canJoinTeam(playerId: string, team: TeamId): boolean {
    const counts = this.teamCounts(playerId)
    return counts[team] < this.config.maxPerTeam && counts[team] <= Math.min(...counts)
  }

  // ───────────────────────── messages ─────────────────────────

  handle(playerId: string, message: ClientMessage): void {
    const p = this.players.get(playerId)
    if (!p || !message || typeof message !== "object") return
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
      case "board":
        return this.onBoard(p, m.vehicle, m.seat)
      case "switch-seat":
        return this.onSwitchSeat(p, m.seat)
      case "leave-vehicle": {
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
    const input: QueuedInput = { seq }
    if (m.flight !== undefined) {
      input.flight = readFlight(m.flight)
      if (!input.flight) return
    }
    if (m.seat !== undefined) {
      input.seat = readSeat(m.seat)
      if (!input.seat) return
    }
    p.seq = seq
    p.lastInputAt = this.time
    p.queue.push(input)
    // Drop the oldest beyond the cap, but keep their state so nothing regresses.
    while (p.queue.length > INPUT_QUEUE_MAX) this.consume(p, p.queue.shift()!)
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
    p.info.team = team
  }

  private onSpawn(p: PlayerState, kind: unknown): void {
    if (typeof kind !== "string" || !(VEHICLE_KINDS as string[]).includes(kind)) return
    if (this.matchEndedAt !== null) return this.error(p.info.id, "Match over — next round starting soon.")
    if (this.time < p.info.respawnAt) return this.error(p.info.id, "Respawn not ready.")
    const current = this.vehicleOf(p.info)
    if (current && current.alive && !this.canLeave(current)) return this.error(p.info.id, "Return to base to change aircraft.")
    this.vacate(p.info)
    this.spawnVehicle(p.info, kind as VehicleKind)
  }

  /** Create a vehicle at the team's base with `player` in the pilot seat. */
  spawnVehicle(player: PlayerInfo, kind: VehicleKind): VehicleEntity {
    const team = player.team
    let index = 0
    for (let i = 0; i < SPAWN_SLOTS; i++) {
      const sp = spawnPoint(team, kind, i).position
      const blocked = this.vehicles.some(v => v.alive && Math.hypot(v.flight.position[0] - sp[0], v.flight.position[1] - sp[1], v.flight.position[2] - sp[2]) < 25)
      if (!blocked) { index = i; break }
      index = i + 1
    }
    const spec = VEHICLES[kind]
    const v: VehicleEntity = {
      id: `v${this.nextId++}`, kind, team,
      flight: createFlightState(kind, spawnPoint(team, kind, index % SPAWN_SLOTS)),
      hp: spec.maxHp, maxHp: spec.maxHp,
      seats: [player.id, null], aim: [null, null], weapons: createWeapons(kind),
      flaresReadyAt: 0, flareCount: spec.flares, abilityReadyAt: 0, spottedUntil: 0, lastDamagedBy: null, alive: true,
    }
    this.vehicles.push(v)
    this.meta.set(v.id, { emptySince: null, lastHp: v.hp, lastHitAt: -Infinity, diedAt: null })
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
    if (v.seats[seat]) return this.error(p.info.id, "Seat taken.")
    this.vacate(p.info)
    this.seatPlayer(p.info, v, seat)
  }

  private onSwitchSeat(p: PlayerState, seat: unknown): void {
    if (!isSeat(seat)) return
    const v = this.vehicleOf(p.info)
    if (!v || !v.alive || p.info.seat === seat) return
    if (v.seats[seat]) return this.error(p.info.id, "Seat taken.")
    const from = p.info.seat!
    v.seats[from] = null
    v.aim[from] = null
    this.seatPlayer(p.info, v, seat)
  }

  private seatPlayer(player: PlayerInfo, v: VehicleEntity, seat: SeatIndex): void {
    v.seats[seat] = player.id
    player.vehicleId = v.id
    player.seat = seat
    const ps = this.players.get(player.id)
    if (ps) { ps.flight = NEUTRAL_INPUT; ps.seat = NEUTRAL_SEAT }
  }

  /** Remove a player from whatever seat they hold. */
  private vacate(player: PlayerInfo): void {
    const v = this.vehicleOf(player)
    if (v && player.seat !== null && v.seats[player.seat] === player.id) {
      v.seats[player.seat] = null
      v.aim[player.seat] = null
    }
    player.vehicleId = null
    player.seat = null
    const ps = this.players.get(player.id)
    if (ps) { ps.flight = NEUTRAL_INPUT; ps.seat = NEUTRAL_SEAT }
  }

  private vehicleOf(player: PlayerInfo): VehicleEntity | undefined {
    return player.vehicleId ? this.vehicles.find(v => v.id === player.vehicleId) : undefined
  }

  /** Crew may leave/swap aircraft only on the ground or inside their safe zone. */
  private canLeave(v: VehicleEntity): boolean {
    return v.flight.onGround || inSafeZone(v.team, v.flight.position)
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
    const now = this.time
    const events = this.events
    const vehicles = this.vehicles

    // One queued input per player per tick (matches client prediction); an empty queue repeats the last input.
    for (const p of this.players.values()) {
      const next = p.queue.shift()
      if (next) this.consume(p, next)
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

    const eventStart = events.length
    stepCombat(this.combat, vehicles, TICK_DT, now, events)

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
      this.onVehicleDestroyed(v, killer)
    }

    this.cleanupVehicles()
    this.updateMatch()
  }

  /** Crashes credit the last attacker only if they hit the vehicle recently. */
  private crashCredit(v: VehicleEntity, meta: VehicleMeta): string | null {
    return v.lastDamagedBy && this.time - meta.lastHitAt <= CRASH_CREDIT_WINDOW ? v.lastDamagedBy : null
  }

  private onVehicleDestroyed(v: VehicleEntity, killer: string | null): void {
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
    if (!killer) return
    const kp = this.players.get(killer)
    const killerTeam = kp ? kp.info.team : this.vehicles.find(x => x.id === killer)?.team
    if (killerTeam === undefined || killerTeam === v.team) return
    if (kp) kp.info.kills++
    if (this.matchEndedAt !== null) return
    this.scores[killerTeam]++
    this.events.push({ type: "score", scores: [...this.scores] })
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
      if (v.seats[0] || v.seats[1]) {
        meta.emptySince = null
        continue
      }
      if (meta.emptySince === null) meta.emptySince = now
      const idle = now - meta.emptySince
      if (inSafeZone(v.team, v.flight.position)) {
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
    const top = Math.max(...this.scores)
    const leaders = this.scores.flatMap((s, t) => (s === top ? [t as TeamId] : []))
    if (top >= this.config.scoreLimit) this.endMatch(leaders[0])
    else if (now - this.matchStartedAt >= this.config.timeLimit) this.endMatch(leaders.length === 1 ? leaders[0] : null)
  }

  private endMatch(winner: TeamId | null): void {
    this.matchEndedAt = this.time
    this.winner = winner
    this.events.push({ type: "match-end", winner })
    this.hooks.onChange?.()
  }

  private resetMatch(): void {
    for (const p of this.players.values()) {
      p.info.vehicleId = null
      p.info.seat = null
      p.info.kills = 0
      p.info.deaths = 0
      p.info.respawnAt = 0
      p.flight = NEUTRAL_INPUT
      p.seat = NEUTRAL_SEAT
    }
    this.vehicles.length = 0
    this.meta.clear()
    this.combat = createCombatState()
    this.scores = new Array(this.config.teams).fill(0)
    this.matchStartedAt = this.time
    this.matchEndedAt = null
    this.winner = null
    this.events.push({ type: "score", scores: [...this.scores] })
    this.hooks.onChange?.()
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
      for (const id of this.players.keys()) this.hooks.sendText(id, text)
    } else {
      for (const id of this.players.keys()) this.hooks.send(id, message)
    }
  }

  /** Full (decoded) snapshot for one player — convenience for tests/tools; the network uses the wire format. */
  snapshotFor(playerId: string): Snapshot {
    const decode = createSnapshotDecoder()
    const p = this.players.get(playerId)
    const shared = this.wireShared(true)
    return decode({ ...shared, ...this.wirePersonal(p ?? null, false) } as WireSnapshot) as Snapshot
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
      intermission: this.matchEndedAt !== null,
    }
    if (withPlayers) shared.players = this.playerList()
    return shared
  }

  private playerList(): PlayerInfo[] {
    return [...this.players.values()].map(p => ({ ...p.info, respawnAt: r2(p.info.respawnAt) }))
  }

  private wirePersonal(p: PlayerState | null, players: boolean): Pick<WireSnapshot, "ack" | "own" | "players"> {
    const out: Pick<WireSnapshot, "ack" | "own" | "players"> = { ack: p ? p.ack : -1 }
    const v = p ? this.vehicleOf(p.info) : undefined
    if (v) out.own = packOwn(v)
    if (players) out.players = this.playerList()
    return out
  }

  private broadcastSnapshot(): void {
    if (this.players.size === 0) return
    // Players list only when it changed (or periodically as a safety net).
    const list = this.playerList()
    const listJson = JSON.stringify(list)
    const includePlayers = listJson !== this.lastPlayersJson || this.time - this.lastPlayersAt >= PLAYERS_RESEND
    if (includePlayers) { this.lastPlayersJson = listJson; this.lastPlayersAt = this.time }
    const shared = this.wireShared(false)
    if (includePlayers) shared.players = list
    // Serialize the shared body once; per-player fields are appended as a short JSON tail.
    const body = JSON.stringify(shared)
    const head = body.slice(0, -1)
    for (const p of this.players.values()) {
      const personal = this.wirePersonal(p, p.needsPlayers && !includePlayers)
      p.needsPlayers = false
      const text = `${head},${JSON.stringify(personal).slice(1)}`
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
  projectiles: WireProjectile[]
  missiles: WireMissile[]
  flares: WireFlare[]
  scores: number[]
  matchEndsAt: number
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

/**
 * Stateful decoder (one per connection): converts wire snapshots back to the protocol `Snapshot` shape,
 * remembering the last players list. Other messages pass through unchanged.
 */
export function createSnapshotDecoder(): (message: WireServerMessage | ServerMessage) => ServerMessage {
  let players: PlayerInfo[] = []
  return message => {
    if (message.type !== "snapshot" || !("wire" in message)) return message as ServerMessage
    const m = message as WireSnapshot
    if (m.players) players = m.players
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
        return v
      }),
      players,
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
      intermission: m.intermission,
      ack: m.ack,
    }
  }
}
