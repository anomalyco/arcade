import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ, DT } from "../shared/config"
import { type ClientMsg, type Picks, type RosterEntry, type ServerMsg, decodeClient, encodeServer, seedOf } from "../shared/protocol"
import { type Input, NO_INPUT } from "../shared/sim/vehicle"
import { type Participant, World } from "../shared/sim/world"

/** A connected socket, as seen by the room. */
export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

type Player = {
  id: string
  name: string
  picks: Picks
  conn: Conn | null
  queue: { seq: number; input: Input }[]
  ack: number
  input: Input
  starve: number
  goneAt: number
}

/** Disconnected players keep their seat (and car) this long so a reconnect resumes seamlessly. */
const GRACE_TICKS = 15 * TICK_HZ
/** Server-side input buffer. Beyond this the oldest inputs are dropped so latency stays bounded. */
const MAX_QUEUE = 10
const TRIM_QUEUE = 3
/** With no input for this long (tab hidden, stalled link) the car lets go of the pedals. */
const STARVE_TICKS = 15
const SNAPSHOT_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))

function newId() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0")
}

/**
 * One room's authoritative game: roster, input buffering, the shared World and per-viewer snapshots.
 * Transport agnostic (the Durable Object feeds it sockets and calls step() at TICK_HZ) so it can be tested directly.
 */
export class RoomCore {
  readonly seed: number
  world: World | null = null
  tick = 0
  private conns = new Set<Conn>()
  private players = new Map<string, Player>()
  private byConn = new Map<Conn, Player>()

  constructor(readonly code: string) {
    this.seed = seedOf(code)
  }

  /** True while anyone is connected or holding a seat; the host stops ticking when false. */
  alive() {
    return this.conns.size > 0 || this.players.size > 0
  }

  humans() {
    return this.players.size
  }

  open(conn: Conn) {
    this.conns.add(conn)
  }

  close(conn: Conn) {
    this.conns.delete(conn)
    const p = this.byConn.get(conn)
    if (!p) return
    this.byConn.delete(conn)
    if (p.conn !== conn) return
    p.conn = null
    p.goneAt = this.tick
    p.queue = []
    p.input = NO_INPUT
    this.world?.setInput(p.id, NO_INPUT)
    this.broadcastRoster()
  }

  message(conn: Conn, raw: unknown) {
    const msg = decodeClient(raw)
    if (!msg) return
    if (msg.type === "ping") return this.send(conn, { type: "pong", t: msg.t })
    if (msg.type === "hello") return this.hello(conn, msg)
    const p = this.byConn.get(conn)
    if (!p || p.conn !== conn) return
    const last = p.queue.length ? p.queue[p.queue.length - 1]!.seq : p.ack
    if (msg.seq <= last) return
    p.queue.push({ seq: msg.seq, input: msg.input })
    if (p.queue.length > MAX_QUEUE) p.queue.splice(0, p.queue.length - TRIM_QUEUE)
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { type: "hello" }>) {
    if (this.byConn.has(conn)) return
    let p = msg.id ? this.players.get(msg.id) : undefined
    if (p && p.conn) p = undefined
    if (p) {
      // Resume: the client starts a fresh input stream, so forget the old acks.
      p.conn = conn
      p.queue = []
      p.ack = 0
      p.starve = 0
      p.picks = msg.picks
    } else {
      if (this.players.size >= MAX_PLAYERS) {
        this.send(conn, { type: "error", code: "full", message: `Room ${this.code} is full (${MAX_PLAYERS} players).` })
        conn.close(4001, "room full")
        return
      }
      // First person into an empty room gets a fresh game instead of a stale round.
      if (this.players.size === 0) this.world = null
      const id = msg.id && !this.players.has(msg.id) ? msg.id : newId()
      p = { id, name: msg.name, picks: msg.picks, conn, queue: [], ack: 0, input: NO_INPUT, starve: 0, goneAt: 0 }
      this.players.set(id, p)
      this.syncParticipants()
    }
    this.byConn.set(conn, p)
    this.send(conn, { type: "welcome", id: p.id, room: this.code, seed: this.seed, tick: this.tick })
    this.broadcastRoster()
    this.sendSnapshot(p)
  }

  /** Humans in join order. PvP only: no bots. */
  participants(): Participant[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, human: true, picks: p.picks }))
  }

  private syncParticipants() {
    const ps = this.participants()
    if (this.world) this.world.setParticipants(ps)
    else this.world = new World(this.seed, ps)
  }

  roster(): RosterEntry[] {
    return this.participants().map((p) => ({ id: p.id, name: p.name, human: p.human, connected: !p.human || !!this.players.get(p.id)?.conn }))
  }

  /** Advances one tick: expire seats, apply one buffered input per player, step the world, send events and snapshots. */
  step() {
    this.tick++
    let left = false
    for (const p of this.players.values())
      if (!p.conn && this.tick - p.goneAt > GRACE_TICKS) {
        this.players.delete(p.id)
        left = true
      }
    if (left) {
      this.syncParticipants()
      this.broadcastRoster()
    }
    const world = this.world
    if (!world) return
    for (const p of this.players.values()) {
      if (!p.conn) continue
      const next = p.queue.shift()
      if (next) {
        p.input = next.input
        p.ack = next.seq
        p.starve = 0
      } else if (++p.starve > STARVE_TICKS) p.input = NO_INPUT
      world.setInput(p.id, p.input)
    }
    world.step(DT)
    const events = world.drainEvents()
    const all = events.filter((e) => e.to === undefined).map((e) => ({ t: e.t, kind: e.kind, text: e.text, carId: e.carId }))
    if (all.length) this.broadcast({ type: "events", events: all })
    // Private events (the driver's own repair while unseen) go to that player only.
    for (const e of events) {
      const conn = e.to === undefined ? null : this.players.get(e.to)?.conn
      if (conn) this.send(conn, { type: "events", events: [{ t: e.t, kind: e.kind, text: e.text, carId: e.carId }] })
    }
    if (this.tick % SNAPSHOT_EVERY === 0) for (const p of this.players.values()) if (p.conn) this.sendSnapshot(p)
  }

  /** Spectators (no car this round) get a cop's fog-of-war view, so a second tab can't be used to spot the robber. */
  viewerFor(id: string) {
    const world = this.world!
    if (world.carOf(id)) return id
    return world.cops()[0]?.ownerId ?? id
  }

  private sendSnapshot(p: Player) {
    const world = this.world
    if (!world || !p.conn) return
    const car = world.carOf(p.id)
    this.send(p.conn, { type: "snapshot", tick: this.tick, ack: p.ack, view: world.view(this.viewerFor(p.id)), you: car ? car.body : null })
  }

  private broadcastRoster() {
    this.broadcast({ type: "roster", players: this.roster() })
  }

  private broadcast(msg: ServerMsg) {
    const data = encodeServer(msg)
    for (const p of this.players.values()) if (p.conn) p.conn.send(data)
  }

  private send(conn: Conn, msg: ServerMsg) {
    conn.send(encodeServer(msg))
  }
}
