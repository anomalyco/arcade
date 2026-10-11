/// <reference types="vite/client" />
// Browser networking: WebSocket room client with reconnect + RTT, REST helpers, and offline loopback rooms.
import type { ClientMessage, RoomConfig, RoomSummary, ServerMessage } from "./sim/protocol"
import type { TeamId } from "./sim/types"
import { createLoopbackRoom } from "./sim/loopback"
import { createSnapshotDecoder } from "./sim/room-engine"
import type { RoomHandlers, RoomStatus } from "./sim/loopback"

export type { RoomHandlers, RoomStatus }

export interface RoomConnection {
  send(message: ClientMessage): void
  close(): void
  /** Smoothed round-trip time in ms (0 until measured / offline). */
  rtt(): number
  /** True for in-browser offline rooms. */
  readonly offline: boolean
}

export interface ConnectOptions {
  /** Preferred team, sent with `hello` (server may override to keep teams balanced). */
  team?: TeamId
}

/** Close codes the server uses for permanent rejections (no reconnect). */
export const CLOSE_ROOM_FULL = 4001
export const CLOSE_ROOM_CLOSED = 4004
const PING_INTERVAL = 2000

const api = (path: string) => `${import.meta.env.BASE_URL}api/${path}`

function wsUrl(path: string): string {
  const url = new URL(api(path), location.href)
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}

export function connectRoom(code: string, name: string, handlers: RoomHandlers, options: ConnectOptions = {}): RoomConnection {
  let socket: WebSocket | null = null
  let closed = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let rtt = 0
  const url = wsUrl(`room?code=${encodeURIComponent(code)}`)

  const ping = setInterval(() => sendRaw({ type: "ping", t: performance.now() }), PING_INTERVAL)

  function sendRaw(message: ClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function connect() {
    if (closed) return
    handlers.onStatus?.("connecting")
    const ws = new WebSocket(url)
    socket = ws
    // Fresh decoder per connection: the server resends the players list to new joiners.
    const decode = createSnapshotDecoder()
    ws.onopen = () => {
      if (socket !== ws) return
      attempt = 0
      sendRaw({ type: "hello", name, team: options.team })
      sendRaw({ type: "ping", t: performance.now() })
      handlers.onStatus?.("open")
    }
    ws.onmessage = event => {
      if (socket !== ws || typeof event.data !== "string") return
      let message: ServerMessage
      try { message = decode(JSON.parse(event.data)) } catch { return }
      if (message.type === "pong" && Number.isFinite(message.t)) {
        const sample = performance.now() - message.t
        rtt = rtt ? rtt * 0.8 + sample * 0.2 : sample
      }
      handlers.onMessage(message)
    }
    ws.onclose = event => {
      if (socket !== ws) return
      socket = null
      handlers.onStatus?.("closed")
      if (closed || event.code === CLOSE_ROOM_FULL || event.code === CLOSE_ROOM_CLOSED) return
      const delay = Math.min(8000, 500 * 2 ** attempt++) * (0.75 + Math.random() * 0.5)
      retryTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => { if (socket === ws) ws.close() }
  }

  connect()
  return {
    offline: false,
    send: sendRaw,
    close() {
      if (closed) return
      closed = true
      clearInterval(ping)
      clearTimeout(retryTimer)
      const ws = socket
      socket = null
      ws?.close(1000, "bye")
      handlers.onStatus?.("closed")
    },
    rtt: () => rtt,
  }
}

/** Run a full room (with bots) inside the browser. Same interface as connectRoom. */
export function createLocalRoom(config: Partial<RoomConfig>, name: string, handlers: RoomHandlers): RoomConnection {
  const room = createLoopbackRoom(config, name, handlers)
  return { offline: true, send: room.send, close: room.close, rtt: room.rtt }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

export async function listRooms(): Promise<RoomSummary[]> {
  return json<RoomSummary[]>(await fetch(api("rooms")))
}

/** Create a room and return its code. */
export async function createRoom(config: Partial<RoomConfig>): Promise<string> {
  const body = await json<{ code: string }>(await fetch(api("rooms"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
  }))
  return body.code
}

/** Code of the best room to join right now (fullest public non-full room, or a fresh one). */
export async function quickPlay(): Promise<string> {
  return (await json<{ code: string }>(await fetch(api("quickplay")))).code
}

/** True if the multiplayer server answers within `timeoutMs` (use to fall back to createLocalRoom). */
export async function serverAvailable(timeoutMs = 2500): Promise<boolean> {
  try {
    const response = await fetch(api("health"), { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const body = await response.json() as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}
