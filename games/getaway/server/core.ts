import { IDLE_COP_KICK_SECONDS, IDLE_DARK_KICK_SECONDS, IDLE_KICK_SECONDS, IDLE_WARN_SECONDS, MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ, DT } from "../shared/config"
import { type ClientMsg, type Picks, type RosterEntry, type ServerMsg, decodeClient, encodeServer, seedOf } from "../shared/protocol"
import { type InputOps, JitterBuffer } from "@arcade/kit/net/jitter-buffer"
import { ROOM_JITTER } from "@arcade/kit/net/room-core"
import { type Input, NO_INPUT } from "../shared/sim/vehicle"
import { type Participant, World } from "../shared/sim/world"

/** A connected socket, as seen by the room. */
export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

type Player = {
  id: string
  name: string
  picks: Picks
  conn: Conn | null
  jitter: JitterBuffer<Input>
  input: Input
  starve: number
  goneAt: number
  /** Ticks connected without input activity, and the last input received (activity is any change or non-neutral input). */
  idle: number
  last: Input
  /** Chat rate limit: a token bucket, refilled one token per CHAT_REFILL_TICKS up to CHAT_BURST. */
  chatTokens: number
  chatAt: number
}

/** Disconnected players keep their seat (and car) this long so a reconnect resumes seamlessly. */
const GRACE_TICKS = 15 * TICK_HZ
/**
 * The world latches gadget and engine presses when their held value changes, so a stand-in keeps the held keys (no
 * spurious edge) and merging keeps the earlier input's press when the later one has let go.
 */
const INPUT_OPS: InputOps<Input> = {
  merge: (a, b) => ({ ...b, gadget: b.gadget ?? a.gadget ?? null, engine: !!(b.engine || a.engine) }),
  standIn: (last) => last,
  hasEdges: (i) => (i.gadget ?? null) !== null || !!i.engine,
}
const newJitter = () => new JitterBuffer(INPUT_OPS, ROOM_JITTER)
/** With no input for this long (tab hidden, stalled link) the car lets go of the pedals. */
const STARVE_TICKS = 15
const CHAT_BURST = 3
const CHAT_REFILL_TICKS = 0.8 * TICK_HZ
const SNAPSHOT_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))

const sameInput = (a: Input, b: Input) =>
  a.throttle === b.throttle && a.brake === b.brake && a.steer === b.steer && !!a.handbrake === !!b.handbrake && !!a.boost === !!b.boost && (a.gadget ?? null) === (b.gadget ?? null) && !!a.engine === !!b.engine

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
    p.jitter = newJitter()
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
    if (msg.type === "chat") return this.chat(p, msg.text)
    if (!sameInput(msg.input, p.last) || !sameInput(msg.input, NO_INPUT)) p.idle = 0
    p.last = msg.input
    // step() advances the tick before taking, so this input can be applied from the next tick on.
    p.jitter.push(msg.seq, msg.input, this.tick + 1)
  }

  private chat(p: Player, text: string) {
    p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (this.tick - p.chatAt) / CHAT_REFILL_TICKS)
    p.chatAt = this.tick
    if (p.chatTokens < 1) return
    p.chatTokens--
    p.idle = 0
    const role = this.world && this.world.robberId === p.id ? "robber" : "cop"
    this.broadcast({ type: "chat", from: p.id, name: p.name, role, text, t: Date.now() })
  }

  private system(name: string, text: string) {
    this.broadcast({ type: "chat", from: "", name, role: "system", text, t: Date.now() })
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { type: "hello" }>) {
    if (this.byConn.has(conn)) return
    let p = msg.id ? this.players.get(msg.id) : undefined
    if (p && p.conn) p = undefined
    if (p) {
      // Resume: the client starts a fresh input stream, so forget the old acks.
      p.conn = conn
      p.jitter = newJitter()
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
      p = { id, name: msg.name, picks: msg.picks, conn, jitter: newJitter(), input: NO_INPUT, starve: 0, goneAt: 0, idle: 0, last: NO_INPUT, chatTokens: CHAT_BURST, chatAt: this.tick }
      this.players.set(id, p)
      this.syncParticipants()
      this.system(p.name, "joined")
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
        this.system(p.name, "left")
        left = true
      } else if (p.conn && ++p.idle >= this.idleLimit(p) && this.kickable(p)) {
        this.kick(p)
        this.system(p.name, "was kicked for idling")
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
      // One input per tick from the jitter buffer: it stands in for late inputs (without applying the original
      // twice) and, catching up, hands over two, applied as the later one with both presses.
      const got = p.jitter.take(this.tick)
      if (got.length) {
        p.input = got.length === 1 ? got[0]! : INPUT_OPS.merge(got[0]!, got[1]!)
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
    if (this.tick % SNAPSHOT_EVERY === 0) {
      const base = world.viewBase()
      for (const p of this.players.values()) if (p.conn) this.sendSnapshot(p, base)
    }
  }

  /** Idle ticks allowed before a kick: longer for the driver sitting dark on purpose. */
  idleLimit(p: Player) {
    const world = this.world
    const car = world?.carOf(p.id)
    const dark = !!car && world!.robberId === p.id && !!car.body.engineOff
    const cop = !!car && car.role === "cop" && (world!.phase === "chase" || world!.phase === "headstart")
    return (dark ? IDLE_DARK_KICK_SECONDS : cop ? IDLE_COP_KICK_SECONDS : IDLE_KICK_SECONDS) * TICK_HZ
  }

  /** Nobody is kicked during the end card or while spectating; the idle timer keeps running meanwhile. */
  private kickable(p: Player) {
    const world = this.world
    return !!world && world.phase !== "end" && !!world.carOf(p.id)
  }

  /** Seconds until an idle kick, while the warning is up. */
  idleIn(id: string): number | undefined {
    const p = this.players.get(id)
    if (!p) return undefined
    const left = this.idleLimit(p) - p.idle
    return left <= IDLE_WARN_SECONDS * TICK_HZ ? Math.max(0, Math.ceil(left / TICK_HZ)) : undefined
  }

  /** Drops an idle player's seat at once (no reconnect grace). The caller resyncs participants. */
  private kick(p: Player) {
    const conn = p.conn!
    this.send(conn, { type: "error", code: "idle", message: "Kicked for being idle." })
    this.players.delete(p.id)
    this.byConn.delete(conn)
    this.conns.delete(conn)
    conn.close(4002, "idle")
  }

  /** Spectators (no car this round) get a cop's fog-of-war view, so a second tab can't be used to spot the robber. */
  viewerFor(id: string) {
    const world = this.world!
    if (world.carOf(id)) return id
    return world.cops()[0]?.ownerId ?? id
  }

  private sendSnapshot(p: Player, base?: ReturnType<World["viewBase"]>) {
    const world = this.world
    if (!world || !p.conn) return
    const car = world.carOf(p.id)
    const idleIn = this.idleIn(p.id)
    this.send(p.conn, { type: "snapshot", tick: this.tick, ack: Math.max(0, p.jitter.ack), view: world.view(this.viewerFor(p.id), base), you: car ? car.body : null, ...(idleIn === undefined ? {} : { idleIn }) })
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
