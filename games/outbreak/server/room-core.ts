import { ByteWriter, frame } from "@arcade/kit/net/bytes"
import { AckHistory, BandwidthPacer } from "@arcade/kit/net/interest"
import { JitterBuffer, socketJitter } from "@arcade/kit/net/jitter-buffer"
import { Seats } from "@arcade/kit/net/seats"
import { cleanPlayerName } from "@arcade/kit/sim/matchmaking"
import { BUILD } from "../shared/build.gen"
import { TICK_DT, TICK_HZ } from "../shared/clock"
import { COOP_TIME_SCALE, COOP_TUNING, DEFAULT_COOP_ROOM, type CoopRoomOptions } from "../shared/coop-config"
import { CoopSim, MAX_SURVIVORS, type SurvivorSlot } from "../shared/coop-sim"
import {
  clampSurvivorVariant,
  DEFAULT_LOADOUT,
  SURVIVOR_VARIANT_COUNT,
  type LoadoutId,
  type SurvivorVariant,
} from "../shared/loadout"
import {
  commandOps,
  decodeClient,
  encodePersonal,
  encodeShared,
  MAX_NAME,
  SNAPSHOT_EVERY,
  unpackCommand,
  type ClientMsg,
  type RoomPhase,
  type RosterEntry,
  type ServerMsg,
  type SharedSnapshot,
} from "../shared/net-protocol"
import type { Command } from "../shared/session"

/** A dropped player's survivor (inventory, ammo, position) is kept this long for a reconnect. */
export const GRACE_MS = 60_000
/** Per-socket message budget (token bucket): the client sends about 30 input batches per second. */
const MSG_RATE = 120
const MSG_BURST = 240
/**
 * Inputs arrive over a WebSocket at 60 Hz, two commands per frame. Each command is stepped separately, so after a
 * short bridge of stand-ins a stalled survivor pauses and then catches up on the real commands exactly.
 */
const JITTER = socketJitter(TICK_HZ, { bridgeMs: 70 })

export type Conn = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void }

/**
 * `ledgerRev`: the progression ledger revision this seat's client has; 0 sends everything it can see.
 * `ackSnapTick`: highest snapshot tick acknowledged by this seat's client (for delta compression).
 * `history`: ring buffer of snapshots emitted to this seat so delta encoding matches client reconstruction.
 */
type SeatData = {
  slot: SurvivorSlot
  jitter: JitterBuffer<Command>
  ledgerRev: number
  ackSnapTick: number
  viewTick: number
  history: AckHistory<SharedSnapshot>
  pacer: BandwidthPacer
  lastSnapTick: number
  variant: SurvivorVariant
  loadout: LoadoutId
  ready: boolean
}
type ConnState = { seatId: string | null; tokens: number; at: number; bytes: number }

/** One co-op room's world and seats, independent of the transport so tests and benchmarks can drive it. */
export class CoopRoomCore {
  readonly sim: CoopSim
  readonly seats: Seats<SeatData>
  phase: RoomPhase
  tick = 0
  private snapIndex = 0
  private conns = new Map<Conn, ConnState>()
  private shooters = new Map<number, number>()
  private writer = new ByteWriter(4096)
  private personalWriter = new ByteWriter(256)
  private lastBubbleSnaps = new Map<string, SharedSnapshot>()
  private rosterKey = ""

  constructor(
    readonly code: string,
    readonly options: CoopRoomOptions = DEFAULT_COOP_ROOM,
    private readonly clock: () => number = Date.now,
    private readonly build = BUILD,
  ) {
    this.sim = new CoopSim(options.seed, options.houseSeed, options.terrain, { zombieCount: options.zombieCount })
    this.seats = new Seats(MAX_SURVIVORS, GRACE_MS, clock)
    this.phase = options.initialPhase ?? (build === "bench" ? "running" : "lobby")
  }

  /** Seat id of the current room host (lowest-index connected seat, or first held seat). */
  get hostId(): string | undefined {
    return this.seats.all.find((s) => s.connected)?.id ?? this.seats.all[0]?.id
  }

  /** True if another seat in the room has already claimed `variant`. */
  isVariantTaken(variant: SurvivorVariant, excludeSeatId?: string): boolean {
    return this.seats.all.some((s) => s.id !== excludeSeatId && s.data.variant === variant)
  }

  /** Picks `preferred` when unclaimed, otherwise the lowest free survivor variant (0..3). */
  private pickFreeVariant(preferred?: SurvivorVariant, excludeSeatId?: string): SurvivorVariant {
    if (preferred !== undefined && !this.isVariantTaken(preferred, excludeSeatId)) return preferred
    for (let i = 0; i < SURVIVOR_VARIANT_COUNT; i++) {
      const v = i as SurvivorVariant
      if (!this.isVariantTaken(v, excludeSeatId)) return v
    }
    return clampSurvivorVariant(preferred, 0)
  }

  /** Transitions the room from `"lobby"` to `"running"` and broadcasts the updated roster and initial running snapshot. */
  start(): boolean {
    if (this.phase === "running") return false
    this.phase = "running"
    for (const seat of this.seats.all) {
      seat.data.ready = true
      seat.data.jitter = new JitterBuffer(commandOps, JITTER)
    }
    this.sendRoster(true)
    this.snapshot()
    return true
  }

  private checkAutoStart(): void {
    if (this.phase !== "lobby") return
    const connected = this.seats.all.filter((s) => s.connected)
    if (connected.length >= 2 && connected.every((s) => s.data.ready)) {
      this.start()
    } else {
      this.sendRoster()
    }
  }

  get connections(): number {
    return this.conns.size
  }

  /** Bytes sent to each open connection so far (for bandwidth measurements). */
  get bytesSent(): number[] {
    return [...this.conns.values()].map((c) => c.bytes)
  }

  open(conn: Conn): void {
    this.conns.set(conn, { seatId: null, tokens: MSG_BURST, at: this.clock(), bytes: 0 })
  }

  message(conn: Conn, raw: unknown): void {
    const state = this.conns.get(conn)
    if (!state) return
    const now = this.clock()
    state.tokens = Math.min(MSG_BURST, state.tokens + ((now - state.at) / 1000) * MSG_RATE)
    state.at = now
    if (state.tokens < 1) return
    state.tokens--
    const msg = decodeClient(raw)
    if (msg) this.handle(conn, state, msg)
  }

  close(conn: Conn): void {
    const state = this.conns.get(conn)
    this.conns.delete(conn)
    if (!state?.seatId) return
    const stillOpen = [...this.conns.values()].some((c) => c.seatId === state.seatId)
    if (!stillOpen) this.seats.leave(state.seatId)
    this.checkAutoStart()
  }

  private send(conn: Conn, msg: ServerMsg | Uint8Array): void {
    const data = msg instanceof Uint8Array ? msg : JSON.stringify(msg)
    const state = this.conns.get(conn)
    const len = typeof data === "string" ? data.length : data.byteLength
    if (state) state.bytes += len
    conn.send(data)
  }

  private handle(conn: Conn, state: ConnState, msg: ClientMsg): void {
    if (msg.t === "ping") {
      if (msg.a && state.seatId) {
        const seat = this.seats.byId(state.seatId)
        if (seat && msg.a > seat.data.ackSnapTick && seat.data.history.get(msg.a)) {
          seat.data.ackSnapTick = msg.a
        }
      }
      return this.send(conn, { t: "pong", c: msg.c })
    }
    if (msg.t === "hello") return this.hello(conn, state, msg)
    if (!state.seatId) return
    const seat = this.seats.byId(state.seatId)
    if (!seat) return
    if (msg.t === "pick") {
      if (this.phase !== "lobby") return
      let changed = false
      if (msg.name !== undefined) {
        const nextName = cleanPlayerName(msg.name, MAX_NAME, "Survivor")
        if (nextName !== seat.name) {
          seat.name = nextName
          changed = true
        }
      }
      if (msg.variant !== undefined && !this.isVariantTaken(msg.variant, seat.id) && seat.data.variant !== msg.variant) {
        seat.data.variant = msg.variant
        seat.data.ready = false
        changed = true
      }
      if (msg.loadout !== undefined && seat.data.loadout !== msg.loadout) {
        seat.data.loadout = msg.loadout
        this.sim.progression.setLoadout(seat.data.slot, msg.loadout)
        seat.data.ledgerRev = 0
        seat.data.ready = false
        changed = true
      }
      if (changed) this.sendRoster(true)
      return
    }
    if (msg.t === "ready") {
      if (this.phase !== "lobby") return
      seat.data.ready = msg.ready
      this.checkAutoStart()
      return
    }
    if (msg.t === "start") {
      if (this.phase !== "lobby") return
      const connected = this.seats.all.filter((s) => s.connected)
      const allReady = connected.length > 0 && connected.every((s) => s.data.ready)
      if (seat.id === this.hostId || allReady) this.start()
      return
    }
    if (this.phase === "lobby") return
    if (msg.a && msg.a > seat.data.ackSnapTick && seat.data.history.get(msg.a)) {
      seat.data.ackSnapTick = msg.a
    }
    if (msg.v && msg.v <= this.tick) {
      seat.data.viewTick = msg.v
    }
    // step() advances the tick before taking, so these can be applied from the next tick on.
    for (let i = 0; i < msg.c.length; i++) seat.data.jitter.push(msg.s + i, unpackCommand(msg.c[i]), this.tick + 1)
  }

  private hello(conn: Conn, state: ConnState, msg: Extract<ClientMsg, { t: "hello" }>): void {
    if (state.seatId) return
    if (msg.build !== this.build) {
      this.send(conn, { t: "reload" })
      conn.close(4003, "stale client")
      return
    }
    const name = cleanPlayerName(msg.name, MAX_NAME, "Survivor")
    const joined = this.seats.join(name, msg.token, (index, id) => {
      const slot = this.sim.addSurvivor(id, index)
      const variant = this.pickFreeVariant(msg.variant ?? clampSurvivorVariant(index), id)
      const loadout = msg.loadout ?? DEFAULT_LOADOUT
      if (loadout !== DEFAULT_LOADOUT) this.sim.progression.setLoadout(slot, loadout)
      return {
        slot,
        jitter: new JitterBuffer(commandOps, JITTER),
        ledgerRev: 0,
        ackSnapTick: 0,
        viewTick: 0,
        history: new AckHistory<SharedSnapshot>(32),
        pacer: new BandwidthPacer(SNAPSHOT_EVERY, 9, 22 * 1024),
        lastSnapTick: -SNAPSHOT_EVERY,
        variant,
        loadout,
        ready: this.phase === "running",
      }
    })
    if (!joined.ok) {
      this.send(conn, { t: "error", message: `Room ${this.code} is full (${MAX_SURVIVORS} survivors).` })
      conn.close(4001, "room full")
      return
    }
    const seat = joined.seat
    // A reconnect starts a fresh command stream (the client's sequence numbers restart at 0).
    if (joined.resumed) {
      seat.data.jitter = new JitterBuffer(commandOps, JITTER)
      if (this.phase === "lobby") {
        if (msg.variant !== undefined && !this.isVariantTaken(msg.variant, seat.id)) {
          seat.data.variant = msg.variant
        }
        if (msg.loadout !== undefined && msg.loadout !== seat.data.loadout) {
          seat.data.loadout = msg.loadout
          this.sim.progression.setLoadout(seat.data.slot, msg.loadout)
        }
      }
    }
    seat.data.ledgerRev = 0
    seat.data.ackSnapTick = 0
    seat.data.history.clear()
    seat.data.lastSnapTick = -SNAPSHOT_EVERY
    for (const [other, s] of this.conns) {
      if (other !== conn && s.seatId === seat.id) {
        s.seatId = null
        other.close(4004, "replaced")
      }
    }
    state.seatId = seat.id
    if (msg.lobby === false && this.phase === "lobby" && seat.id === this.hostId) {
      this.phase = "running"
    }
    const o = this.options
    this.send(conn, {
      t: "welcome",
      id: seat.id,
      token: seat.token,
      index: seat.index,
      room: this.code,
      seed: o.seed,
      houseSeed: o.houseSeed,
      terrain: o.terrain,
      zombieCount: o.zombieCount,
      phase: this.phase,
      hostId: this.hostId,
      variant: seat.data.variant,
      loadout: seat.data.loadout,
    })
    this.sendRoster(true)
    if (this.phase === "running") this.snapshot([conn])
  }

  private roster(): RosterEntry[] {
    const hostId = this.hostId
    return this.seats.all.map((s) => ({
      id: s.id,
      index: s.index,
      name: s.name,
      connected: s.connected,
      variant: s.data.variant,
      loadout: s.data.loadout,
      ready: s.data.ready,
      host: s.id === hostId,
    }))
  }

  private sendRoster(force = false): void {
    const players = this.roster()
    const hostId = this.hostId
    const key = JSON.stringify({ phase: this.phase, hostId, players })
    if (!force && key === this.rosterKey) return
    this.rosterKey = key
    for (const [conn, s] of this.conns) {
      if (s.seatId) this.send(conn, { t: "roster", players, phase: this.phase, hostId })
    }
  }

  /** True while anyone is connected or a dropped survivor is still within its grace window. */
  get alive(): boolean {
    return this.conns.size > 0 || this.seats.all.length > 0
  }

  /** One 60 Hz tick. The world pauses while nobody is connected or while the room is in the pre-game lobby. */
  step(): void {
    const expired = this.seats.expire()
    for (const seat of expired) this.sim.removeSurvivor(seat.id, this.phase === "running")
    if (expired.length) this.checkAutoStart()
    if (!this.seats.connectedCount || this.phase === "lobby") return
    this.tick++
    const sim = this.sim
    for (const seat of this.seats.all) {
      const slot = seat.data.slot
      const inputs = seat.data.jitter.take(this.tick)
      if (!inputs.length) {
        slot.survivor.vx = slot.survivor.vy = 0
        continue
      }
      const viewTime = seat.data.viewTick > 0 ? seat.data.viewTick * TICK_DT : undefined
      for (const command of inputs) {
        const lastShot = sim.combat.shots.at(-1)?.id ?? 0
        sim.stepSurvivor(slot, command, TICK_DT, COOP_TUNING, false, viewTime)
        for (const shot of sim.combat.shots) if (shot.id > lastShot) this.shooters.set(shot.id, slot.index)
      }
    }
    sim.stepWorld(TICK_DT, COOP_TIME_SCALE, COOP_TUNING)
    if (this.shooters.size > 64) {
      const live = new Set(sim.combat.shots.map((s) => s.id))
      for (const id of this.shooters.keys()) if (!live.has(id)) this.shooters.delete(id)
    }
    if (this.tick % SNAPSHOT_EVERY === 0) this.snapshot()
  }

  /**
   * Emits per-recipient interest-filtered and delta-compressed snapshots, sharing encoded bytes whenever
   * recipients share the same chunk bubble `(winCx, winCy)` and acked baseline tick.
   */
  snapshot(to?: Conn[]): void {
    this.snapIndex++
    const sharedCache = new Map<string, { bytes: Uint8Array; snap: SharedSnapshot }>()
    const nextBubbleSnaps = new Map<string, SharedSnapshot>()
    for (const [conn, s] of this.conns) {
      if (to && !to.includes(conn)) continue
      const seat = s.seatId ? this.seats.byId(s.seatId) : undefined
      if (!seat) continue
      const data = seat.data
      if (!to && this.tick - data.lastSnapTick < data.pacer.stride()) continue
      data.lastSnapTick = this.tick

      const slot = data.slot
      const viewerCenter = this.sim.worldStream.getSurvivorWindowCenter(slot.id, slot.survivor.x, slot.survivor.y)
      const bubbleKey = `${viewerCenter.cx},${viewerCenter.cy}`
      const baseSnap = data.ackSnapTick > 0 ? data.history.get(data.ackSnapTick) : undefined
      const baseTick = baseSnap ? baseSnap.tick : 0
      const baseBubble = (baseSnap as (SharedSnapshot & { _bubbleKey?: string }) | undefined)?._bubbleKey
      const canShare = baseTick === 0 || baseBubble === bubbleKey
      const cacheKey = `${bubbleKey}:${baseTick}`
      let cached = canShare ? sharedCache.get(cacheKey) : undefined
      if (!cached) {
        const outHolder: { snap?: SharedSnapshot & { _bubbleKey?: string } } = {}
        const bytes = encodeShared(this.sim, this.tick, this.shooters, this.writer, {
          viewerCenter,
          baseSnap,
          prevBubbleSnap: this.lastBubbleSnaps.get(bubbleKey),
          snapIndex: this.snapIndex,
          outSnapshot: outHolder,
        })
        if (outHolder.snap) outHolder.snap._bubbleKey = bubbleKey
        cached = { bytes, snap: outHolder.snap! }
        if (canShare) sharedCache.set(cacheKey, cached)
      }
      if (this.tick > 0 && cached.snap) {
        data.history.record(this.tick, cached.snap)
        nextBubbleSnaps.set(bubbleKey, cached.snap)
      }

      const delta = this.sim.progression.ledger.diff(data.ledgerRev, { visibleTo: seat.id })
      if (delta) data.ledgerRev = delta.toRev
      const notices = slot.notices.splice(0)
      const personal = encodePersonal(data.jitter.ack, slot.survivor, delta, notices, this.personalWriter)
      const packet = frame(personal, cached.bytes)
      data.pacer.record(packet.byteLength, this.sim.time)
      this.send(conn, packet)
    }
    for (const [k, snap] of nextBubbleSnaps) this.lastBubbleSnaps.set(k, snap)
  }
}
