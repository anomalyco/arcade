import { DurableObject } from "cloudflare:workers"
import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { seedOf } from "../shared/rng"
import { type ClientMsg, decodeClient, encodeServer } from "../shared/protocol"
import { type Intent, World } from "../shared/sim/world"
import { buildSnapshot, eventsFor } from "../shared/sim/view"
import { type Env } from "./env"

const TICK_MS = 1000 / TICK_HZ
const SNAP_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))
/** After a stall, run at most this many catch-up ticks at once rather than fast-forwarding the match. */
const MAX_CATCHUP = 4

type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0")

/** One Durable Object per room code. Holds the authoritative World and sockets, and ticks while anyone is connected. */
export class Room extends DurableObject<Env> {
  private world: World | null = null
  private code = ""
  private conns = new Map<Conn, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  private tickCount = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    this.code = code
    this.world ??= new World(seedOf(code))
    const pair = new WebSocketPair()
    const client = pair[0]
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
    socket.addEventListener("message", (e) => this.message(conn, e.data))
    socket.addEventListener("close", () => this.close(conn))
    socket.addEventListener("error", () => this.close(conn))
    return new Response(null, { status: 101, webSocket: client })
  }

  private message(conn: Conn, raw: unknown) {
    const msg = decodeClient(raw)
    if (!msg) return
    this.handle(conn, msg)
  }

  private handle(conn: Conn, msg: ClientMsg) {
    const world = this.world!
    if (msg.type === "ping") return conn.send(encodeServer({ type: "pong", t: msg.t }))
    if (msg.type === "hello") return this.hello(conn, msg)
    const id = this.conns.get(conn)
    if (!id) return
    if (msg.type === "intent") return world.push(id, msg.seq, msg.i as Intent)
    if (msg.type === "loadout") return world.setLoadout(id, msg.loadout)
    if (msg.type === "start") {
      if (world.host !== id) return
      world.requestStart(msg.mode, msg.rounds)
    }
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { type: "hello" }>) {
    const world = this.world!
    if (this.conns.has(conn)) return
    let id = msg.id && world.players.get(msg.id) && !world.players.get(msg.id)!.connected ? msg.id : undefined
    if (!id) {
      if (world.humans.length >= MAX_PLAYERS) {
        conn.send(encodeServer({ type: "error", code: "full", message: `Room ${this.code} is full.` }))
        conn.close(4001, "room full")
        return
      }
      id = newId()
    }
    world.addHuman(id, msg.name)
    world.setLoadout(id, msg.loadout)
    this.conns.set(conn, id)
    conn.send(encodeServer({ type: "welcome", id, room: this.code }))
    this.ensureLoop()
  }

  private close(conn: Conn) {
    const id = this.conns.get(conn)
    this.conns.delete(conn)
    if (!id) return
    const stillHere = [...this.conns.values()].includes(id)
    if (!stillHere) this.world?.disconnect(id)
  }

  private ensureLoop() {
    if (this.timer) return
    this.clock = Date.now()
    this.timer = setInterval(() => this.loop(), TICK_MS)
  }

  private loop() {
    const world = this.world!
    if (this.conns.size === 0) {
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
    for (let i = 0; i < due; i++) {
      world.step()
      this.tickCount++
      this.broadcast()
    }
    this.clock += due * TICK_MS
  }

  private broadcast() {
    const world = this.world!
    const events = world.takeEvents()
    const sendSnap = this.tickCount % SNAP_EVERY === 0
    for (const [conn, id] of this.conns) {
      const mine = eventsFor(events, id)
      if (mine.length > 0) conn.send(encodeServer({ type: "ev", events: mine }))
      if (sendSnap) conn.send(encodeServer(buildSnapshot(world, id, world.players.get(id)?.ack ?? 0)))
    }
  }
}
