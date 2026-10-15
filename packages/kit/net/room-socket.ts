import type { RoomFrame } from "./room-core"

export type RoomSocketOptions<Hello> = {
  /** The game's storage prefix, for example "blackout". */
  game: string
  room: string
  /** Socket query parameters only the room's first arrival can set (private, mode, map...). */
  query?: Record<string, string | null | undefined>
  /** The hello frame for this connection, with the seat id to reclaim. */
  hello: (id: string | undefined) => Hello
  /** Any frame the socket doesn't handle itself (snapshots, roster, events). */
  receive: (msg: { type: string }) => void
  /** The room refused or ended the session; show the message. */
  fatal: (message: string) => void
  encode: (msg: unknown) => string
  decode: (raw: string) => { type: string } | null
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
 * The client half of `@arcade/kit/net/room-core`: one room's socket. Reconnects with the same seat id (kept per room
 * in sessionStorage) with backoff, handles welcome, errors, the version reload and the idle countdown, and hands
 * everything else to the game.
 */
export class RoomSocket<Hello> {
  private ws: WebSocket | null = null
  problem: string | null = "Connecting…"
  idleIn = 0
  private retries = 0
  private closed = false
  id: string

  constructor(private readonly o: RoomSocketOptions<Hello>) {
    this.id = sessionStorage.getItem(this.idKey) ?? ""
    this.open()
  }

  private get idKey() {
    return `${this.o.game}.id.${this.o.room}`
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
    this.ws?.close()
  }

  private open(): void {
    const ws = new WebSocket(socketUrl(this.o.room, this.o.query ?? {}))
    this.ws = ws
    ws.onopen = () => {
      this.retries = 0
      ws.send(this.o.encode(this.o.hello(this.id || undefined)))
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
        this.id = m.id
        sessionStorage.setItem(this.idKey, m.id)
        this.problem = null
        return
      case "error":
        this.closed = true
        this.o.fatal(m.message)
        return
      case "reload": {
        this.closed = true
        // Reload once into the same room (the page rejoins on its own); a second mismatch within a minute means the
        // new build isn't being served yet, so say so instead of looping.
        const key = `${this.o.game}.reloadAt`
        const last = Number(sessionStorage.getItem(key) ?? 0)
        if (Date.now() - last < 60_000) return this.o.fatal("A new version is rolling out. Reload the page in a moment.")
        sessionStorage.setItem(key, String(Date.now()))
        sessionStorage.setItem(rejoinKey(this.o.game), this.o.room)
        location.reload()
        return
      }
      case "idle":
        this.idleIn = m.seconds
        return
      case "pong":
        return
      default:
        this.o.receive(msg)
    }
  }
}
