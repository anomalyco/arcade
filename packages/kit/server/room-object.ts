import { DurableObject } from "cloudflare:workers"
import type { Conn } from "../net/room-core"

/** What the Durable Object drives: a `RoomCore` or anything shaped like one. */
export type TickedCore = {
  readonly code: string
  readonly connections: number
  /** Called when a socket is accepted, before its first message. */
  open?(conn: Conn): void
  message(conn: Conn, raw: unknown): void
  close(conn: Conn): void
  step(): void
}

/** After a stall, run at most this many catch-up ticks. */
const MAX_CATCHUP = 4
/** Lobby reports: at most one per second, and a heartbeat well inside the Lobby's stale window. */
const REPORT_MIN_MS = 1000
const HEARTBEAT_MS = 10_000

/**
 * One Durable Object per room code. Accepts sockets, ticks the core at a fixed rate while anyone is connected (with
 * bounded catch-up after a stall), drops the core once the room empties, and reports to the Lobby when what it would
 * report changes (throttled) plus a heartbeat. The subclass builds the core and says what to report.
 */
export abstract class RoomObject<Env, Core extends TickedCore, Report> extends DurableObject<Env> {
  protected core: Core | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  private reported = ""
  private reportAt = 0

  protected abstract readonly tickMs: number
  /** The live core, created (and configured from the joining URL and storage) when needed. */
  protected abstract open(code: string, url: URL): Promise<Core>
  /** What the Lobby should know; `empty` once the last socket left. */
  protected abstract report(core: Core, empty: boolean): Report
  /** Sends a report to the Lobby. */
  protected abstract send(report: Report): Promise<unknown>

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    const core = await this.open(code, new URL(req.url))
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
    core.open?.(conn)
    socket.addEventListener("message", (e) => core.message(conn, e.data))
    socket.addEventListener("close", () => core.close(conn))
    socket.addEventListener("error", () => core.close(conn))
    if (!this.timer) {
      this.clock = Date.now()
      this.timer = setInterval(() => this.loop(), this.tickMs)
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private loop(): void {
    const core = this.core!
    if (core.connections === 0) {
      clearInterval(this.timer!)
      this.timer = null
      this.publish(core, true)
      // Nobody left: the next visitor gets a fresh room.
      this.core = null
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.clock) / this.tickMs)
    if (due > MAX_CATCHUP) {
      this.clock = now - MAX_CATCHUP * this.tickMs
      due = MAX_CATCHUP
    }
    for (let i = 0; i < due; i++) core.step()
    this.clock += due * this.tickMs
    this.publish(core, false)
  }

  /** Fire-and-forget; a failed report is retried on the next tick. */
  private publish(core: Core, force: boolean): void {
    const report = this.report(core, core.connections === 0)
    const key = JSON.stringify(report)
    const now = Date.now()
    if (!force && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < HEARTBEAT_MS))) return
    this.reported = key
    this.reportAt = now
    this.send(report).then(undefined, () => (this.reported = ""))
  }
}
