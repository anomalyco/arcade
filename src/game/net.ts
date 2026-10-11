import type { Role } from "../../shared/config"
import { type ChatMsg, type ClientMsg, type RosterEntry, type ServerMsg, decodeServer, encodeClient } from "../../shared/protocol"
import { type City, generateCity } from "../../shared/sim/city"
import type { Input } from "../../shared/sim/vehicle"
import type { SimEvent, WorldView } from "../../shared/sim/world"
import { NetClient } from "./netcode"
import type { Session } from "./session"

const PING_MS = 2000
const CONNECT_TIMEOUT_MS = 10000

function socketUrl(room: string, priv: boolean) {
  const dir = location.pathname.replace(/[^/]*$/, "")
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws/${encodeURIComponent(room)}${priv ? "?private=1" : ""}`
}

/** Thrown by NetSession.connect when the room has no free seat. */
export class RoomFullError extends Error {
  override name = "RoomFullError"
}

/** Online room session: a WebSocket to the room's Durable Object, with prediction, interpolation and auto-reconnect. */
export class NetSession implements Session {
  private ws: WebSocket | null = null
  private client: NetClient | null = null
  private roster: RosterEntry[] = []
  private rtt = -1
  private state: "connecting" | "online" | "reconnecting" | "full" | "kicked" | "closed" = "connecting"
  private idle: number | null = null
  private kickReason: string | null = null
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private last: WorldView | null = null
  private ready: { resolve: (s: Session) => void; reject: (e: Error) => void } | null = null
  private id = ""
  private chats: ChatMsg[] = []

  /** Resolves once the room has welcomed us and sent the first snapshot. `priv` makes a brand-new room private. */
  static connect(room: string, name: string, picks: Record<Role, string>, priv = false): Promise<Session> {
    const s = new NetSession(room.toUpperCase(), name, picks, priv)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.close()
        reject(new Error(`Could not reach room ${s.room}.`))
      }, CONNECT_TIMEOUT_MS)
      s.ready = {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      s.open()
    })
  }

  private constructor(
    readonly room: string,
    private name: string,
    private picks: Record<Role, string>,
    private priv: boolean,
  ) {}

  get myId() {
    return this.id
  }

  get city(): City {
    return this.client!.city
  }

  private open() {
    const ws = new WebSocket(socketUrl(this.room, this.priv))
    this.ws = ws
    ws.onopen = () => {
      this.send({ type: "hello", name: this.name, picks: this.picks, id: this.id || undefined })
      this.ping()
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return
      const msg = decodeServer(e.data)
      if (msg) this.receive(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.state === "closed" || this.state === "full" || this.state === "kicked") return
      this.state = "reconnecting"
      const delay = Math.min(5000, 400 * 2 ** this.retry++)
      this.retryTimer = setTimeout(() => this.open(), delay)
    }
    if (!this.pingTimer) this.pingTimer = setInterval(() => this.ping(), PING_MS)
  }

  private receive(msg: ServerMsg) {
    switch (msg.type) {
      case "welcome":
        this.id = msg.id
        this.retry = 0
        if (!this.client) this.client = new NetClient(generateCity(msg.seed), msg.id, (m) => this.send(m))
        else {
          this.client.myId = msg.id
          this.client.resetStream()
        }
        this.state = "online"
        return
      case "pong":
        this.rtt = this.rtt < 0 ? performance.now() - msg.t : this.rtt * 0.7 + (performance.now() - msg.t) * 0.3
        return
      case "chat":
        this.chats.push(msg)
        if (this.chats.length > 50) this.chats.shift()
        return
      case "roster":
        this.roster = msg.players
        return
      case "error":
        if (msg.code === "full") {
          this.state = "full"
          this.ready?.reject(new RoomFullError(msg.message))
          this.ready = null
        } else if (msg.code === "idle") {
          this.state = "kicked"
          this.kickReason = msg.message
          this.ready?.reject(new Error(msg.message))
          this.ready = null
        }
        return
    }
    if (msg.type === "snapshot") this.idle = msg.idleIn ?? null
    this.client?.receive(msg)
    if (msg.type === "snapshot" && this.ready && this.client) {
      this.ready.resolve(this)
      this.ready = null
    }
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(msg))
  }

  private ping() {
    this.send({ type: "ping", t: performance.now() })
  }

  update(dt: number, input: Input): WorldView {
    const v = this.client?.update(dt, input)
    if (v) this.last = v
    return this.last!
  }

  chat(text: string) {
    this.send({ type: "chat", text })
  }

  drainChat(): ChatMsg[] {
    return this.chats.splice(0)
  }

  drainEvents(): SimEvent[] {
    return this.client?.drainEvents() ?? []
  }

  players() {
    return this.roster.map((p) => ({ id: p.id, name: p.name, human: p.human }))
  }

  close() {
    this.state = "closed"
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  idleIn() {
    return this.state === "online" ? this.idle : null
  }

  kicked() {
    return this.kickReason
  }

  status() {
    if (this.state === "online") return this.rtt < 0 ? "online" : `online ${Math.round(this.rtt)}ms`
    if (this.state === "full") return "room full"
    return this.state
  }
}
