import type { RoomFrame } from "./room-core"

export type RoomSocketOptions<Hello> = {
  /** The game's storage prefix, for example "blackout". */
  game: string
  room: string
  /** Socket query parameters only the room's first arrival can set (private, mode, map...). */
  query?: Record<string, string | null | undefined>
  /** The hello frame for this connection, with the private seat token to reclaim (from an earlier welcome). */
  hello: (token: string | undefined) => Hello
  /** Any frame the socket doesn't handle itself (snapshots, roster, events). */
  receive: (msg: { type: string }) => void
  /** The room refused or ended the session; show the message. */
  fatal: (message: string) => void
  /** The room answered a `ping` sent at `t` (for round-trip readouts). */
  pong?: (t: number) => void
  encode: (msg: unknown) => string
  decode: (raw: string) => { type: string } | null
  /** Retry a rolling deployment up to five times with exponential backoff. */
  automaticReload?: boolean
}

/** sessionStorage key a version reload leaves for the page to rejoin its room. */
export const rejoinKey = (game: string) => `${game}.rejoin`

function socketUrl(room: string, query: Record<string, string | null | undefined>): string {
  const dir = location.pathname.replace(/[^/]*$/, "")
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v)
  const qs = q.toString()
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws/${encodeURIComponent(room)}${qs ? `?${qs}` : ""}`
}

/**
 * The client half of `@arcade/kit/net/room-core`: one room's socket. Reconnects with backoff, presenting the seat's
 * private token (kept per room in sessionStorage) to get the same seat back; handles welcome, errors, the version
 * reload and the idle countdown, and hands everything else to the game.
 */
export class RoomSocket<Hello> {
  private ws: WebSocket | null = null
  problem: string | null = "Connecting…"
  idleIn = 0
  private retries = 0
  private closed = false
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  /** Your public seat id: the last one this tab held in the room until the welcome confirms it. */
  id: string
  private token: string

  constructor(private readonly o: RoomSocketOptions<Hello>) {
    this.id = sessionStorage.getItem(this.key("id")) ?? ""
    this.token = sessionStorage.getItem(this.key("token")) ?? ""
    this.open()
  }

  private key(what: "id" | "token" | "reloadAttempts" | "reloadAt") {
    return `${this.o.game}.${what}.${this.o.room}`
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.o.encode(msg))
  }

  /** A connection problem or idle warning to show, or null. */
  status(): string | null {
    return this.problem ?? (this.idleIn > 0 ? `IDLE · MOVE OR YOU'LL BE KICKED IN ${this.idleIn}` : null)
  }

  close(): void {
    this.closed = true
    clearTimeout(this.reloadTimer)
    this.ws?.close()
  }

  private open(): void {
    const ws = new WebSocket(socketUrl(this.o.room, this.o.query ?? {}))
    this.ws = ws
    ws.onopen = () => {
      this.retries = 0
      ws.send(this.o.encode(this.o.hello(this.token || undefined)))
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return
      const msg = this.o.decode(e.data)
      if (msg) this.frame(msg as RoomFrame<unknown, unknown>)
    }
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return
      this.ws = null
      this.problem = "Connection lost. Reconnecting…"
      setTimeout(() => !this.closed && this.open(), Math.min(4000, 300 * 2 ** this.retries++))
    }
  }

  private frame(msg: RoomFrame<unknown, unknown> | { type: string }): void {
    const m = msg as RoomFrame<unknown, unknown>
    switch (m.type) {
      case "welcome":
        sessionStorage.removeItem(this.key("reloadAttempts"))
        sessionStorage.removeItem(this.key("reloadAt"))
        this.id = m.id
        this.token = m.token
        sessionStorage.setItem(this.key("id"), m.id)
        sessionStorage.setItem(this.key("token"), m.token)
        this.problem = null
        return
      case "error":
        this.closed = true
        this.o.fatal(m.message)
        return
      case "reload": {
        if (this.closed) return
        this.closed = true
        // Reload once into the same room (the page rejoins on its own); a second mismatch within a minute means the
        // new build isn't being served yet, so say so instead of looping.
        const key = this.o.automaticReload ? this.key("reloadAt") : `${this.o.game}.reloadAt`
        const last = Number(sessionStorage.getItem(key) ?? 0)
        const attempts = Math.max(0, Number(sessionStorage.getItem(this.key("reloadAttempts"))) || 0)
        if (this.o.automaticReload && attempts >= 5) return this.o.fatal("A new version is available. Reload the page to continue.")
        if (!this.o.automaticReload && Date.now() - last < 60_000) return this.o.fatal("A new version is rolling out. Reload the page in a moment.")
        const reload = () => {
          if (this.o.automaticReload) sessionStorage.setItem(this.key("reloadAttempts"), String(attempts + 1))
          sessionStorage.setItem(key, String(Date.now()))
          sessionStorage.setItem(rejoinKey(this.o.game), this.o.room)
          location.reload()
        }
        const delay = this.o.automaticReload && attempts > 0 ? Math.max(0, 5000 * 2 ** (attempts - 1) - (Date.now() - last)) : 0
        this.problem = "Reconnecting…"
        if (delay) this.reloadTimer = setTimeout(reload, delay)
        else reload()
        return
      }
      case "idle":
        this.idleIn = m.seconds
        return
      case "pong":
        this.o.pong?.(m.t)
        return
      default:
        this.o.receive(msg)
    }
  }
}
