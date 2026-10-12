import { DurableObject } from "cloudflare:workers"
import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { type ClientMsg, decodeClient, encodeServer } from "../shared/protocol"
import { seedOf } from "../shared/rng"
import { buildSnapshot, eventsFor, rosterOf } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import type { Env } from "./env"

const TICK_MS = 1000 / TICK_HZ
const SNAP_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))
/** After a stall, run at most this many catch-up ticks rather than fast-forwarding the match. */
const MAX_CATCHUP = 4

export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

const newId = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 10)

/**
 * One room's authoritative game, independent of the transport so tests can drive it. The Durable Object feeds it
 * sockets and calls loop() on a timer.
 */
export class RoomCore {
  world: World
  private conns = new Map<Conn, string>()
  private rosterSent = new Map<Conn, string>()
  private ticks = 0

  constructor(readonly code: string) {
    this.world = new World(seedOf(code))
  }

  get connections(): number {
    return this.conns.size
  }

  message(conn: Conn, raw: unknown): void {
    const msg = decodeClient(raw)
    if (msg) this.handle(conn, msg)
  }

  private handle(conn: Conn, msg: ClientMsg): void {
    if (msg.type === "ping") return conn.send(encodeServer({ type: "pong", t: msg.t }))
    if (msg.type === "hello") return this.hello(conn, msg)
    const id = this.conns.get(conn)
    if (!id) return
    if (msg.type === "intent") this.world.push(id, msg.seq, msg.i)
    else if (msg.type === "loadout") this.world.setLoadout(id, msg.loadout)
    else if (msg.type === "start" && this.world.host === id) this.world.start(msg.mode, msg.rounds, msg.map)
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { type: "hello" }>): void {
    if (this.conns.has(conn)) return
    // The first person back into an abandoned room gets a fresh lobby, not a stale match.
    if (this.world.humans.length === 0) this.world = new World(seedOf(this.code) + this.ticks)
    const w = this.world
    const prior = msg.id ? w.players.get(msg.id) : undefined
    let id = prior && prior.human && !prior.connected ? prior.id : undefined
    if (!id) {
      if (w.humans.length >= MAX_PLAYERS) {
        conn.send(encodeServer({ type: "error", code: "full", message: `Room ${this.code} is full.` }))
        conn.close(4001, "room full")
        return
      }
      id = newId()
    }
    w.addHuman(id, msg.name, msg.loadout)
    w.setLoadout(id, msg.loadout)
    this.conns.set(conn, id)
    conn.send(encodeServer({ type: "welcome", id, room: this.code }))
    this.sendTo(conn, id)
  }

  close(conn: Conn): void {
    const id = this.conns.get(conn)
    this.conns.delete(conn)
    this.rosterSent.delete(conn)
    if (id && ![...this.conns.values()].includes(id)) this.world.disconnect(id)
  }

  step(): void {
    this.world.step()
    this.ticks++
    const events = this.world.takeEvents()
    const snap = this.ticks % SNAP_EVERY === 0
    for (const [conn, id] of this.conns) {
      const mine = eventsFor(events, id)
      if (mine.length) conn.send(encodeServer({ type: "ev", events: mine }))
      if (snap) this.sendTo(conn, id)
    }
  }

  private sendTo(conn: Conn, id: string): void {
    const roster = rosterOf(this.world)
    const key = JSON.stringify(roster)
    if (this.rosterSent.get(conn) !== key) {
      this.rosterSent.set(conn, key)
      conn.send(encodeServer({ type: "roster", players: roster }))
    }
    conn.send(encodeServer(buildSnapshot(this.world, id)))
  }
}

/** One Durable Object per room code. Ticks while anyone is connected. */
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    const core = (this.core ??= new RoomCore(code))
    const pair = new WebSocketPair()
    const socket = pair[1]
    socket.accept()
    const conn: Conn = {
      send(data) {
        try {
          socket.send(data)
        } catch {}
      },
      close(c, reason) {
        try {
          socket.close(c, reason)
        } catch {}
      },
    }
    socket.addEventListener("message", (e) => core.message(conn, e.data))
    socket.addEventListener("close", () => core.close(conn))
    socket.addEventListener("error", () => core.close(conn))
    this.ensureLoop()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private ensureLoop(): void {
    if (this.timer) return
    this.clock = Date.now()
    this.timer = setInterval(() => this.loop(), TICK_MS)
  }

  private loop(): void {
    const core = this.core
    if (!core || core.connections === 0) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.clock) / TICK_MS)
    if (due > MAX_CATCHUP) {
      this.clock = now - MAX_CATCHUP * TICK_MS
      due = MAX_CATCHUP
    }
    for (let i = 0; i < due; i++) core.step()
    this.clock += due * TICK_MS
  }
}
