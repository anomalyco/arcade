import { DurableObject } from "cloudflare:workers"
import { TICK_HZ } from "../shared/config"
import { type Conn, RoomCore } from "./core"
import { type Env, lobbyOf } from "./env"

const TICK_MS = 1000 / TICK_HZ
/** After a stall, run at most this many catch-up ticks at once rather than fast-forwarding the game. */
const MAX_CATCHUP = 4
/** Lobby reports: at most one per second, and a heartbeat well inside the Lobby's stale window. */
const REPORT_MIN_MS = 1000
const HEARTBEAT_MS = 60_000

/** One Durable Object per room code. Holds sockets in memory and ticks the simulation while anyone is around. */
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  /** Private rooms (made with "Create game") are never handed out by quick join. Sticky for the life of the code. */
  private priv: boolean | null = null
  private lobby: ReturnType<typeof lobbyOf> | null = null
  private reported = ""
  private reportAt = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    const core = (this.core ??= new RoomCore(code))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Only the room's first arrival can make it private, so a link can't hide an existing public room.
    if (!this.priv && core.humans() === 0 && new URL(req.url).searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const ws = pair[1]
    ws.accept()
    const conn: Conn = {
      send(data) {
        try {
          ws.send(data)
        } catch {}
      },
      close(code, reason) {
        try {
          ws.close(code, reason)
        } catch {}
      },
    }
    core.open(conn)
    ws.addEventListener("message", (e) => core.message(conn, e.data))
    ws.addEventListener("close", () => core.close(conn))
    ws.addEventListener("error", () => core.close(conn))
    this.ensureLoop()
    return new Response(null, { status: 101, webSocket: client })
  }

  private ensureLoop() {
    if (this.timer) return
    this.clock = Date.now()
    this.timer = setInterval(() => this.loop(), TICK_MS)
  }

  private loop() {
    const core = this.core
    if (!core || !core.alive()) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.report(true)
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
    this.report(false)
  }

  /** Tells the Lobby our seat count and phase when they change (throttled), plus a heartbeat. Fire-and-forget. */
  private report(force: boolean) {
    const core = this.core
    if (!core) return
    const players = core.humans()
    const phase = core.world?.phase ?? "waiting"
    const priv = !!this.priv
    const key = `${players}|${phase}|${priv}`
    const now = Date.now()
    if (!force && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < HEARTBEAT_MS))) return
    this.reported = key
    this.reportAt = now
    const lobby = (this.lobby ??= lobbyOf(this.env))
    lobby.report({ code: core.code, players, phase, private: priv }).then(undefined, () => {
      if (this.lobby === lobby) this.lobby = null
      this.reported = ""
    })
  }
}
