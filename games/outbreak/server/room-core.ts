import { ByteWriter, frame } from "@arcade/kit/net/bytes"
import { AckHistory, BandwidthPacer } from "@arcade/kit/net/interest"
import { JitterBuffer } from "@arcade/kit/net/jitter-buffer"
import { Seats } from "@arcade/kit/net/seats"
import { cleanPlayerName } from "@arcade/kit/sim/matchmaking"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { COOP_TIME_SCALE, COOP_TUNING, DEFAULT_COOP_ROOM, type CoopRoomOptions } from "../shared/coop-config"
import { CoopSim, MAX_SURVIVORS, type SurvivorSlot } from "../shared/coop-sim"
import {
  commandOps,
  decodeClient,
  encodePersonal,
  encodeShared,
  MAX_NAME,
  SNAPSHOT_EVERY,
  unpackCommand,
  type ClientMsg,
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
}
type ConnState = { seatId: string | null; tokens: number; at: number; bytes: number }

/** One co-op room's world and seats, independent of the transport so tests and benchmarks can drive it. */
export class CoopRoomCore {
  readonly sim: CoopSim
  readonly seats: Seats<SeatData>
  tick = 0
  private snapIndex = 0
  private conns = new Map<Conn, ConnState>()
  private shooters = new Map<number, number>()
  private writer = new ByteWriter(4096)
  private personalWriter = new ByteWriter(256)
  private rosterKey = ""

  constructor(
    readonly code: string,
    readonly options: CoopRoomOptions = DEFAULT_COOP_ROOM,
    private readonly clock: () => number = Date.now,
    private readonly build = BUILD,
  ) {
    this.sim = new CoopSim(options.seed, options.houseSeed, options.terrain, { zombieCount: options.zombieCount })
    this.seats = new Seats(MAX_SURVIVORS, GRACE_MS, clock)
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
    this.sendRoster()
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
    if (msg.a && msg.a > seat.data.ackSnapTick && seat.data.history.get(msg.a)) {
      seat.data.ackSnapTick = msg.a
    }
    if (msg.v && msg.v <= this.tick) {
      seat.data.viewTick = msg.v
    }
    for (let i = 0; i < msg.c.length; i++) seat.data.jitter.push(msg.s + i, unpackCommand(msg.c[i]), this.tick)
  }

  private hello(conn: Conn, state: ConnState, msg: Extract<ClientMsg, { t: "hello" }>): void {
    if (state.seatId) return
    if (msg.build !== this.build) {
      this.send(conn, { t: "reload" })
      conn.close(4003, "stale client")
      return
    }
    const name = cleanPlayerName(msg.name, MAX_NAME, "Survivor")
    const joined = this.seats.join(name, msg.token, (index, id) => ({
      slot: this.sim.addSurvivor(id, index),
      jitter: new JitterBuffer(commandOps),
      ledgerRev: 0,
      ackSnapTick: 0,
      viewTick: 0,
      history: new AckHistory<SharedSnapshot>(32),
      pacer: new BandwidthPacer(SNAPSHOT_EVERY, 9, 22 * 1024),
      lastSnapTick: -SNAPSHOT_EVERY,
    }))
    if (!joined.ok) {
      this.send(conn, { t: "error", message: `Room ${this.code} is full (${MAX_SURVIVORS} survivors).` })
      conn.close(4001, "room full")
      return
    }
    const seat = joined.seat
    // A reconnect starts a fresh command stream (the client's sequence numbers restart at 0).
    if (joined.resumed) seat.data.jitter = new JitterBuffer(commandOps)
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
    })
    this.sendRoster(true)
    this.snapshot([conn])
  }

  private roster(): RosterEntry[] {
    return this.seats.all.map((s) => ({ id: s.id, index: s.index, name: s.name, connected: s.connected }))
  }

  private sendRoster(force = false): void {
    const players = this.roster()
    const key = JSON.stringify(players)
    if (!force && key === this.rosterKey) return
    this.rosterKey = key
    for (const [conn, s] of this.conns) if (s.seatId) this.send(conn, { t: "roster", players })
  }

  /** True while anyone is connected or a dropped survivor is still within its grace window. */
  get alive(): boolean {
    return this.conns.size > 0 || this.seats.all.length > 0
  }

  /** One 60 Hz tick. The world pauses while nobody is connected. */
  step(): void {
    const expired = this.seats.expire()
    for (const seat of expired) this.sim.removeSurvivor(seat.id, true)
    if (expired.length) this.sendRoster()
    if (!this.seats.connectedCount) return
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
          snapIndex: this.snapIndex,
          outSnapshot: outHolder,
        })
        if (outHolder.snap) outHolder.snap._bubbleKey = bubbleKey
        cached = { bytes, snap: outHolder.snap! }
        if (canShare) sharedCache.set(cacheKey, cached)
      }
      if (this.tick > 0 && cached.snap) {
        data.history.record(this.tick, cached.snap)
      }

      const delta = this.sim.progression.ledger.diff(data.ledgerRev, { visibleTo: seat.id })
      if (delta) data.ledgerRev = delta.toRev
      const notices = slot.notices.splice(0)
      const personal = encodePersonal(data.jitter.ack, slot.survivor, delta, notices, this.personalWriter)
      const packet = frame(personal, cached.bytes)
      data.pacer.record(packet.byteLength, this.sim.time)
      this.send(conn, packet)
    }
  }
}
