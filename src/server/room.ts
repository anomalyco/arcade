// One Durable Object per room, holding one authoritative Match in memory.
//
// Design: sockets use plain `accept()` (not the hibernation API) and the match ticks on a
// setInterval while anyone is connected. The Match lives only in memory, so hibernating would
// throw away the game state while sockets stayed open; an accepted socket keeps the object
// resident instead. After the last socket leaves we keep ticking for IDLE_MS so reconnects land
// in the same game, then stop the timer and let the runtime evict the object. If it is evicted
// anyway (deploys), sockets close, clients reconnect and get a fresh lobby.
import { DurableObject } from "cloudflare:workers"
import { Match } from "../sim/match"
import type { ServerMsg } from "../sim/protocol"
import { MAX_MESSAGE_BYTES, parseClientMsg, randomPid, validPid, validRoom } from "./validate"

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
  ASSETS: Fetcher
}

const TICK_MS = 100
const IDLE_MS = 60_000
const RATE_PER_SEC = 40
const RATE_BURST = 80
const MAX_SOCKETS = 64

interface Session {
  ws: WebSocket
  pid: string
  joined: boolean
  tokens: number
  refilled: number
  strikes: number
}

export class Room extends DurableObject<Env> {
  private match: Match | null = null
  private room = ""
  private sessions = new Set<Session>()
  private byPid = new Map<string, Session>()
  private timer: ReturnType<typeof setInterval> | null = null
  private idleSince = 0

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 })
    const url = new URL(request.url)
    const room = url.searchParams.get("room") ?? ""
    if (!validRoom(room)) return new Response("Invalid room", { status: 400 })
    if (this.sessions.size >= MAX_SOCKETS) return new Response("Room is full", { status: 503 })
    const requested = url.searchParams.get("pid") ?? ""
    const pid = validPid(requested) ? requested : randomPid()

    this.room = room
    this.ensureMatch()
    const pair = new WebSocketPair()
    const client = pair[0]
    const ws = pair[1]
    ws.accept()
    const session: Session = { ws, pid, joined: false, tokens: RATE_BURST, refilled: Date.now(), strikes: 0 }
    this.sessions.add(session)
    ws.addEventListener("message", (event) => this.onMessage(session, event.data))
    ws.addEventListener("close", () => this.onClose(session))
    ws.addEventListener("error", () => this.onClose(session))
    this.startTicking()
    return new Response(null, { status: 101, webSocket: client })
  }

  private ensureMatch(): Match {
    if (!this.match) this.match = new Match(this.room, crypto.getRandomValues(new Uint32Array(1))[0]! >>> 0)
    return this.match
  }

  private allow(session: Session, now: number): boolean {
    session.tokens = Math.min(RATE_BURST, session.tokens + ((now - session.refilled) / 1000) * RATE_PER_SEC)
    session.refilled = now
    if (session.tokens < 1) return false
    session.tokens -= 1
    return true
  }

  private onMessage(session: Session, data: string | ArrayBuffer) {
    const now = Date.now()
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return this.reject(session, "Message too large")
    if (!this.allow(session, now)) return this.reject(session, "Slow down")
    const msg = parseClientMsg(data)
    if (!msg) return this.reject(session, "Invalid message")
    if (msg.type === "ping") return this.send(session, { type: "pong", t: msg.t, now })
    const match = this.ensureMatch()
    if (msg.type === "join") {
      const previous = this.byPid.get(session.pid)
      if (previous && previous !== session) {
        previous.joined = false
        this.sessions.delete(previous)
        try { previous.ws.close(4000, "Replaced by a newer connection") } catch {}
      }
      session.joined = true
      this.byPid.set(session.pid, session)
      match.join(session.pid, msg.name, now)
    } else if (session.joined) {
      match.handle(session.pid, msg, now)
    } else {
      return this.send(session, { type: "error", message: "Join first" })
    }
    this.flush()
  }

  private reject(session: Session, message: string) {
    session.strikes++
    if (session.strikes > 50) {
      try { session.ws.close(1008, "Too many invalid messages") } catch {}
      return
    }
    this.send(session, { type: "error", message })
  }

  private onClose(session: Session) {
    if (!this.sessions.delete(session)) return
    if (session.joined && this.byPid.get(session.pid) === session) {
      this.byPid.delete(session.pid)
      this.match?.leave(session.pid, Date.now())
      this.flush()
    }
    if (this.sessions.size === 0) this.idleSince = Date.now()
  }

  private startTicking() {
    this.idleSince = 0
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private tick() {
    const now = Date.now()
    const match = this.match
    if (!match) return
    try {
      match.tick(now)
      this.flush()
    } catch (error) {
      console.error("match tick failed", error)
    }
    if (this.sessions.size === 0 && this.idleSince && now - this.idleSince > IDLE_MS) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      // nobody came back: the next visitor gets a fresh lobby
      if (match.empty) this.match = null
    }
  }

  private flush() {
    const match = this.match
    if (!match) return
    for (const out of match.drain()) {
      const text = JSON.stringify(out.msg)
      if (out.to === null) {
        for (const session of this.sessions) if (session.joined) this.sendText(session, text)
      } else {
        const session = this.byPid.get(out.to)
        if (session) this.sendText(session, text)
      }
    }
  }

  private send(session: Session, msg: ServerMsg) {
    this.sendText(session, JSON.stringify(msg))
  }

  private sendText(session: Session, text: string) {
    try {
      session.ws.send(text)
    } catch {
      this.onClose(session)
    }
  }
}
