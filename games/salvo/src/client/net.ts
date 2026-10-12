// Transports: a WebSocket to the Room Durable Object, or an in-browser Match for solo play.
import { Match } from "../sim/match"
import type { ClientMsg, ServerMsg } from "../sim/protocol"

export type Status = "connecting" | "open" | "closed"

export interface Transport {
  readonly online: boolean
  readonly room: string
  send(msg: ClientMsg): void
  onMessage(cb: (msg: ServerMsg) => void): void
  onStatus(cb: (status: Status) => void): void
  // estimated server clock in ms
  serverNow(): number
  close(): void
}

// Server routes always live under /arcade/salvo; in vite dev they are proxied to wrangler.
const SERVER_BASE = "/arcade/salvo"
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
const ROOM_RE = /^[a-z0-9]{3,24}$/
const PING_MS = 2000

function appBase(): string {
  const base = import.meta.env?.BASE_URL
  if (base && base.startsWith("/")) return base.endsWith("/") ? base : `${base}/`
  const at = location.pathname.indexOf(`${SERVER_BASE}/`)
  return at >= 0 ? location.pathname.slice(0, at + SERVER_BASE.length + 1) : "/"
}

function randomString(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ""
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== "string") return null
  try {
    const msg = JSON.parse(data)
    return msg && typeof msg === "object" && typeof msg.type === "string" ? (msg as ServerMsg) : null
  } catch {
    return null
  }
}

function storedPid(room: string): string {
  const key = `salvo:pid:${room}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing && /^[A-Za-z0-9_-]{8,40}$/.test(existing)) return existing
    const pid = randomString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 20)
    sessionStorage.setItem(key, pid)
    return pid
  } catch {
    return randomString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 20)
  }
}

export function connectOnline(room: string): Transport {
  room = room.toLowerCase()
  const pid = storedPid(room)
  const messageCbs: Array<(msg: ServerMsg) => void> = []
  const statusCbs: Array<(status: Status) => void> = []
  const queue: string[] = []
  let status: Status = "connecting"
  let ws: WebSocket | null = null
  let lastJoin: string | null = null
  let attempts = 0
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let pinger: ReturnType<typeof setInterval> | null = null
  // recent clock samples; the lowest-rtt one gives the most trustworthy offset
  const samples: Array<{ rtt: number; offset: number }> = []
  let offset = 0

  const setStatus = (next: Status) => {
    if (status === next) return
    status = next
    for (const cb of statusCbs) cb(next)
  }

  const ping = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ClientMsg))
  }

  const connect = () => {
    if (closed) return
    setStatus("connecting")
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(`${proto}//${location.host}${SERVER_BASE}/ws/${encodeURIComponent(room)}?pid=${encodeURIComponent(pid)}`)
    ws = socket
    socket.onopen = () => {
      attempts = 0
      // the server binds a socket to a player on join, so replay it after every reconnect
      if (lastJoin) socket.send(lastJoin)
      for (const text of queue.splice(0)) socket.send(text)
      ping()
      pinger = setInterval(ping, PING_MS)
      setStatus("open")
    }
    socket.onmessage = (event) => {
      const msg = parseServerMsg(event.data)
      if (!msg) return
      if (msg.type === "pong") {
        const now = Date.now()
        const rtt = Math.max(0, now - msg.t)
        samples.push({ rtt, offset: msg.now - (msg.t + rtt / 2) })
        if (samples.length > 8) samples.shift()
        const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
        offset = samples.length === 1 ? best.offset : offset + (best.offset - offset) * 0.5
      }
      for (const cb of messageCbs) cb(msg)
    }
    socket.onclose = (event) => {
      if (ws !== socket) return
      ws = null
      if (pinger) clearInterval(pinger)
      pinger = null
      // 4000: another tab took over this player; don't fight it
      if (closed || event.code === 4000) {
        closed = true
        setStatus("closed")
        return
      }
      setStatus("connecting")
      const delay = Math.min(8000, 400 * 2 ** attempts) * (0.75 + Math.random() * 0.5)
      attempts++
      retry = setTimeout(connect, delay)
    }
  }

  connect()

  return {
    online: true,
    room,
    send(msg) {
      if (closed) return
      const text = JSON.stringify(msg)
      if (msg.type === "join") lastJoin = text
      if (ws?.readyState === WebSocket.OPEN) ws.send(text)
      else if (msg.type !== "join" && msg.type !== "ping" && queue.length < 32) queue.push(text)
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onStatus(cb) {
      statusCbs.push(cb)
      cb(status)
    },
    serverNow() {
      return Date.now() + offset
    },
    close() {
      closed = true
      if (retry) clearTimeout(retry)
      if (pinger) clearInterval(pinger)
      ws?.close(1000, "bye")
      ws = null
      setStatus("closed")
    },
  }
}

export function createLocal(): Transport {
  const id = "local"
  const match = new Match("solo", (Math.random() * 2 ** 32) >>> 0)
  const messageCbs: Array<(msg: ServerMsg) => void> = []
  const statusCbs: Array<(status: Status) => void> = []
  let status: Status = "open"
  let pending = false

  const deliver = (msg: ServerMsg) => {
    for (const cb of messageCbs) cb(msg)
  }
  // deliver asynchronously so callers never re-enter their own handlers
  const flush = () => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      for (const out of match.drain()) if (out.to === null || out.to === id) deliver(out.msg)
    })
  }
  const timer = setInterval(() => {
    match.tick(Date.now())
    flush()
  }, 50)

  return {
    online: false,
    room: "solo",
    send(msg) {
      if (status === "closed") return
      const now = Date.now()
      if (msg.type === "ping") {
        queueMicrotask(() => deliver({ type: "pong", t: msg.t, now }))
        return
      }
      if (msg.type === "join") match.join(id, msg.name, now)
      else match.handle(id, msg, now)
      flush()
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onStatus(cb) {
      statusCbs.push(cb)
      cb(status)
    },
    serverNow() {
      return Date.now()
    },
    close() {
      if (status === "closed") return
      clearInterval(timer)
      match.leave(id, Date.now())
      status = "closed"
      for (const cb of statusCbs) cb(status)
    },
  }
}

export async function createRoom(): Promise<string> {
  try {
    const res = await fetch(`${SERVER_BASE}/api/rooms`, { method: "POST" })
    if (res.ok) {
      const body = (await res.json()) as { room?: unknown }
      if (typeof body.room === "string" && ROOM_RE.test(body.room)) return body.room
    }
  } catch {}
  return randomString(ROOM_ALPHABET, 5)
}

export function roomFromLocation(): string | null {
  const fromPath = location.pathname.match(/\/r\/([A-Za-z0-9]+)\/?$/)?.[1]
  const room = (fromPath ?? new URLSearchParams(location.search).get("room") ?? "").toLowerCase()
  return ROOM_RE.test(room) ? room : null
}

export function roomLink(room: string): string {
  return `${location.origin}${appBase()}r/${room}`
}
