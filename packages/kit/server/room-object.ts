import { DurableObject } from "cloudflare:workers"
import type { Conn } from "../net/room-core"
import { settle } from "./settle"

/** What the Durable Object drives: a `RoomCore` or anything shaped like one. */
export type TickedCore = {
  readonly code?: string
  readonly connections?: number
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
export abstract class RoomObject<Env, Core extends TickedCore, Report = void> extends DurableObject<Env> {
  protected core: Core | null = null
  protected readonly sockets = new Set<Conn>()
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0
  private reported = ""
  private reportAt = 0

  protected abstract readonly tickMs: number
  protected readonly maxCatchup: number = MAX_CATCHUP
  protected readonly heartbeatMs: number = HEARTBEAT_MS
  protected readonly catchup: boolean = true
  /** The live core, created (and configured from the joining URL and storage) when needed. */
  protected abstract open(code: string, url: URL): Promise<Core>
  /** Whether the room should stay alive on this tick (defaults to active socket count). */
  protected isAlive(core: Core): boolean {
    return (core.connections ?? this.sockets.size) > 0
  }
  /** What the Lobby should know; `empty` once the room is closing. Return `null` if the game has no Lobby. */
  protected abstract report(core: Core, empty: boolean): Report | null
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
    this.sockets.add(conn)
    core.open?.(conn)
    let closed = false
    const onClose = () => {
      if (closed) return
      closed = true
      this.sockets.delete(conn)
      core.close(conn)
    }
    socket.addEventListener("message", (e) => {
      if (typeof Blob !== "undefined" && e.data instanceof Blob) {
        void e.data.arrayBuffer().then((buf) => core.message(conn, buf))
        return
      }
      core.message(conn, e.data)
    })
    socket.addEventListener("close", onClose)
    socket.addEventListener("error", onClose)
    if (!this.timer) {
      this.clock = Date.now()
      this.timer = setInterval(() => this.loop(), this.tickMs)
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private loop(): void {
    const core = this.core
    if (!core) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    if (!this.catchup) {
      core.step()
      if (!this.isAlive(core)) {
        clearInterval(this.timer!)
        this.timer = null
        this.publish(core, true)
        this.core = null
        return
      }
      this.publish(core, false)
      return
    }
    if (!this.isAlive(core)) {
      clearInterval(this.timer!)
      this.timer = null
      this.publish(core, true)
      // Nobody left: the next visitor gets a fresh room.
      this.core = null
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.clock) / this.tickMs)
    if (due > this.maxCatchup) {
      this.clock = now - this.maxCatchup * this.tickMs
      due = this.maxCatchup
    }
    for (let i = 0; i < due; i++) core.step()
    this.clock += due * this.tickMs
    this.publish(core, false)
  }

  /** Fire-and-forget; a failed report is retried on the next tick. */
  private publish(core: Core, empty: boolean): void {
    if (!this.report || !this.send) return
    const report = this.report(core, empty)
    if (report === null || report === undefined) return
    const key = JSON.stringify(report)
    const now = Date.now()
    if (!empty && (now - this.reportAt < REPORT_MIN_MS || (key === this.reported && now - this.reportAt < this.heartbeatMs))) return
    this.reported = key
    this.reportAt = now
    settle(() => this.send(report), () => (this.reported = ""))
  }
}
