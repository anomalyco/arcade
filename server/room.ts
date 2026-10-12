import { DurableObject } from "cloudflare:workers"
import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { BUILD } from "../shared/build.gen"
import { type ClientMsg, decodeClient, encodeServer } from "../shared/protocol"
import { seedOf } from "../shared/rng"
import { hostRestart, moveTeam, shuffleTeams } from "../shared/sim/host"
import { type ModeId, modeOf } from "../shared/sim/modes"
import { buildSnapshot, rosterOf } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { type Env, lobbyOf } from "./env"

const TICK_MS = 1000 / TICK_HZ
const SNAP_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))
/** After a stall, run at most this many catch-up ticks. */
const MAX_CATCHUP = 4
/** A dropped player's seat (and score) is kept this long for a reconnect. */
const GRACE_MS = 15_000
/** No input for this long while able to play gets you kicked; a warning shows for the last IDLE_WARN_MS. */
export const IDLE_KICK_MS = 90_000
export const IDLE_WARN_MS = 15_000
/** Aim changes smaller than this (radians) don't count as activity. */
const AIM_ACTIVE = 0.05

export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

const newId = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 10)

/** One room's game, independent of the transport so tests can drive it. */
export class RoomCore {
  world: World
  private conns = new Map<Conn, string>()
  private gone = new Map<string, number>()
  private rosterKey = ""
  private ticks = 0
  /** Last activity (clock ms) and aim per player, for the idle kick. */
  private active = new Map<string, { at: number; aim: number; warned: number }>()

  constructor(
    readonly code: string,
    mode: ModeId = "ffa",
    private clock: () => number = Date.now,
  ) {
    this.world = new World(seedOf(code), null, mode)
  }

  /** The creator's pick of mode, taken only while the room is empty. */
  setMode(mode: ModeId): boolean {
    if (this.world.humans.length) return false
    if (this.world.mode.id !== mode) this.world.setMode(mode)
    return true
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
    if (msg.type === "intent") {
      const i = msg.i
      const a = this.active.get(id)
      if (a && (i.mx || i.my || i.fire || i.reload || i.equip || i.use || Math.abs(i.aim - a.aim) > AIM_ACTIVE)) a.at = this.clock()
      if (a) a.aim = i.aim
      this.world.push(id, msg.seq, i)
      return
    }
    this.touch(id)
    if (msg.type === "gun") this.world.pickGun(id, msg.gun)
    else if (msg.type === "equip") this.world.pickEquip(id, msg.equip)
    else if (msg.type === "vote") this.world.vote(id, msg.mode)
    else if (msg.type === "team") moveTeam(this.world, id, msg.id, msg.team)
    else if (msg.type === "shuffle") shuffleTeams(this.world, id)
    else if (msg.type === "host") hostRestart(this.world, id, msg.action === "mode" ? msg.mode : this.world.mode.id, msg.newFloor)
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { type: "hello" }>): void {
    if (this.conns.has(conn)) return
    // A client built from different shared code (protocol, simulation) must reload before it can play here.
    if (msg.build !== BUILD) {
      conn.send(encodeServer(msg.build ? { type: "reload" } : { type: "error", message: "A new version of BLACKOUT is out. Reload the page." }))
      conn.close(4003, "stale client")
      return
    }
    const w = this.world
    let id = msg.id && this.gone.has(msg.id) && w.players.has(msg.id) ? msg.id : undefined
    if (id) this.gone.delete(id)
    else {
      if (w.humans.length >= MAX_PLAYERS) {
        conn.send(encodeServer({ type: "error", message: `Room ${this.code} is full.` }))
        conn.close(4001, "room full")
        return
      }
      id = newId()
      w.addHuman(id, msg.name, msg.gun, msg.equip)
    }
    this.conns.set(conn, id)
    this.active.set(id, { at: this.clock(), aim: 0, warned: 0 })
    conn.send(encodeServer({ type: "welcome", id, room: this.code }))
    conn.send(encodeServer({ type: "roster", players: rosterOf(w) }))
    conn.send(encodeServer(buildSnapshot(w, id)))
  }

  close(conn: Conn): void {
    const id = this.conns.get(conn)
    this.conns.delete(conn)
    if (id && ![...this.conns.values()].includes(id)) this.gone.set(id, this.clock())
  }

  private touch(id: string): void {
    const a = this.active.get(id)
    if (a) a.at = this.clock()
  }

  /**
   * Kicks players who haven't touched the controls for IDLE_KICK_MS. Time on the end screen or spent dead (waiting to
   * respawn, or spectating after elimination) doesn't count. The last IDLE_WARN_MS get a countdown.
   */
  private idle(now: number): void {
    for (const [conn, id] of [...this.conns]) {
      const a = this.active.get(id)
      const p = this.world.players.get(id)
      if (!a || !p) continue
      if (this.world.phase !== "play" || !p.alive) {
        a.at = now
        continue
      }
      const left = IDLE_KICK_MS - (now - a.at)
      if (left <= 0) {
        conn.send(encodeServer({ type: "error", message: "You were kicked for being idle." }))
        conn.close(4002, "idle")
        this.conns.delete(conn)
        this.active.delete(id)
        this.gone.delete(id)
        this.world.remove(id)
        this.world.fill()
        continue
      }
      const secs = left <= IDLE_WARN_MS ? Math.ceil(left / 1000) : 0
      if (secs !== a.warned) {
        a.warned = secs
        conn.send(encodeServer({ type: "idle", seconds: secs }))
      }
    }
  }

  step(): void {
    const now = this.clock()
    for (const [id, at] of this.gone) {
      if (now - at < GRACE_MS) continue
      this.gone.delete(id)
      this.active.delete(id)
      this.world.remove(id)
      this.world.fill()
    }
    this.idle(now)
    this.world.step()
    this.ticks++
    const events = this.world.takeEvents()
    const roster = rosterOf(this.world)
    const key = JSON.stringify(roster)
    const rosterChanged = key !== this.rosterKey
    this.rosterKey = key
    for (const [conn, id] of this.conns) {
      if (events.length) conn.send(encodeServer({ type: "ev", events }))
      if (rosterChanged) conn.send(encodeServer({ type: "roster", players: roster }))
      if (this.ticks % SNAP_EVERY === 0) conn.send(encodeServer(buildSnapshot(this.world, id)))
    }
  }
}

/** Lobby reports: at most one per second, and a heartbeat well inside the Lobby's stale window. */
const REPORT_MIN_MS = 1000
const HEARTBEAT_MS = 10_000

/** One Durable Object per room code. Ticks while anyone is connected and reports its seats to the Lobby. */
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  /** Made with "Create game" (reported to the Lobby; quick join still finds the room once people are in it). */
  private priv: boolean | null = null
  /** The mode the room was created with, for the first match whenever the room starts up again. */
  private mode: ModeId | null = null
  private reported = ""
  private reportAt = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    this.mode ??= modeOf(await this.ctx.storage.get<string>("mode")) ?? "ffa"
    const core = (this.core ??= new RoomCore(code, this.mode))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Likewise only the first arrival picks the mode (Create game sends it).
    const mode = modeOf(new URL(req.url).searchParams.get("mode"))
    if (mode && core.connections === 0 && core.setMode(mode)) {
      this.mode = mode
      await this.ctx.storage.put("mode", mode)
    }
    // Only the first arrival in an empty room can make it private, so a link can't hide an existing public room.
    if (!this.priv && core.connections === 0 && new URL(req.url).searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
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
    if (!this.timer) {
      this.clock = Date.now()
      this.timer = setInterval(() => this.loop(), TICK_MS)
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private loop(): void {
    const core = this.core!
    if (core.connections === 0) {
      clearInterval(this.timer!)
      this.timer = null
      this.report(core, true)
      // Nobody left: the next visitor gets a fresh room.
      this.core = null
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
    this.report(core, false)
  }

  /** Tells the Lobby our human count and phase when they change (throttled), plus a heartbeat. Fire-and-forget. */
  private report(core: RoomCore, force: boolean): void {
    const players = core.connections === 0 ? 0 : core.world.humans.length
    const phase = core.world.phase
    const priv = !!this.priv
    const mode = core.world.mode.id
    const key = `${players}|${phase}|${priv}|${mode}`
    const now = Date.now()
    if (!force && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < HEARTBEAT_MS))) return
    this.reported = key
    this.reportAt = now
    lobbyOf(this.env)
      .report({ code: core.code, players, phase, private: priv, mode })
      .then(undefined, () => (this.reported = ""))
  }
}
