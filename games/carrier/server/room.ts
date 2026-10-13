import { DurableObject } from "cloudflare:workers"
import { type Conn, RoomCore } from "./core"
import type { Env } from "./env"
import { lobbyOf } from "./lobby"

/** Ship simulation tick (ms): each tick runs as many fixed SHIP.tick steps as sea time needs. */
const TICK_MS = 50
/** Lobby reports: at most one per second, and a heartbeat well inside the Lobby's stale window. */
const REPORT_MIN_MS = 1000
const HEARTBEAT_MS = 10_000

/**
 * One Durable Object per room code (index.ts passes it in `x-room`). The world, crew and ships live in memory only:
 * when the last player leaves they are gone. Ticks while anyone is connected and reports its player count to the Lobby.
 */
export class Room extends DurableObject<Env> {
  private core = new RoomCore()
  private timer: ReturnType<typeof setInterval> | null = null
  private code = ""
  /** Made with Create game: the Lobby keeps it out of quick join. */
  private priv: boolean | null = null
  private reported = ""
  private reportAt = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    this.code = req.headers.get("x-room") ?? this.code
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Only the first arrival in an empty room can make it private, so a link can't hide an existing public room.
    const wantPrivate = new URL(req.url).searchParams.get("private") === "1"
    if (this.core.players === 0 && wantPrivate !== this.priv) {
      this.priv = wantPrivate
      await this.ctx.storage.put("private", wantPrivate)
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
      close(code, reason) {
        try {
          socket.close(code, reason)
        } catch {}
      },
    }
    socket.addEventListener("message", (e) => this.core.message(conn, e.data))
    socket.addEventListener("close", () => this.core.close(conn))
    socket.addEventListener("error", () => this.core.close(conn))
    this.timer ??= setInterval(() => this.loop(), TICK_MS)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private loop(): void {
    this.core.step()
    if (this.core.players === 0) {
      clearInterval(this.timer!)
      this.timer = null
      this.report(true)
      return
    }
    this.report(false)
  }

  /** Tells the Lobby our player count when it changes (throttled), plus a heartbeat. Fire-and-forget. */
  private report(force: boolean): void {
    if (!this.code) return
    const players = this.core.players
    const priv = !!this.priv
    const key = `${players}|${priv}`
    const now = Date.now()
    if (!force && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < HEARTBEAT_MS))) return
    this.reported = key
    this.reportAt = now
    lobbyOf(this.env.LOBBY)
      .report({ code: this.code, players, private: priv })
      .then(
        () => {},
        () => (this.reported = ""),
      )
  }
}
