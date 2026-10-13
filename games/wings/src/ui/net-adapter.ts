/// <reference types="vite/client" />
// Thin adapter over src/net.ts (Server agent). Falls back to a minimal built-in implementation
// (in-browser RoomEngine + raw WebSocket/REST) while net.ts does not exist yet.
import type { ClientMessage, RoomConfig, RoomSummary, ServerMessage } from "../sim/protocol"
import { DEFAULT_ROOM_CONFIG } from "../sim/protocol"

export type NetStatus = "connecting" | "open" | "closed"
export interface NetHandlers {
  onMessage(message: ServerMessage): void
  onStatus(status: NetStatus): void
}
export interface Connection {
  send(message: ClientMessage): void
  close(): void
}
export interface NetApi {
  connectRoom(code: string, name: string, handlers: NetHandlers): Connection
  createLocalRoom(config: RoomConfig, name: string, handlers: NetHandlers): Connection
  listRooms(): Promise<RoomSummary[]>
  createRoom(config: Partial<RoomConfig>): Promise<string>
  quickPlay(): Promise<string>
}

// Resolves to {} when src/net.ts does not exist, so typecheck and build stay green either way.
const netModules = import.meta.glob("../net.ts")
const API = `${import.meta.env.BASE_URL}api`

let cached: Promise<NetApi> | null = null

export function getNet(): Promise<NetApi> {
  return (cached ??= load())
}

function codeOf(r: unknown): string {
  if (typeof r === "string") return r
  if (r && typeof r === "object" && "code" in r) return String((r as { code: unknown }).code)
  throw new Error("No room code returned")
}

async function load(): Promise<NetApi> {
  const loader = netModules["../net.ts"]
  if (loader) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (await loader()) as any
    if (typeof m.connectRoom === "function") {
      return {
        connectRoom: (code, name, h) => m.connectRoom(code, name, h),
        createLocalRoom: (config, name, h) => m.createLocalRoom(config, name, h),
        listRooms: async () => {
          const r = await m.listRooms()
          return Array.isArray(r) ? r : (r?.rooms ?? [])
        },
        createRoom: async config => codeOf(await m.createRoom(config)),
        quickPlay: async () => codeOf(await m.quickPlay()),
      }
    }
  }
  return fallback
}

async function getJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok) throw new Error(`Server ${res.status}`)
  const type = res.headers.get("content-type") ?? ""
  if (!type.includes("json")) throw new Error("Server offline")
  return res.json()
}

const fallback: NetApi = {
  connectRoom(code, name, handlers) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${proto}//${location.host}${API}/room?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`)
    handlers.onStatus("connecting")
    ws.onopen = () => {
      handlers.onStatus("open")
      ws.send(JSON.stringify({ type: "hello", name } satisfies ClientMessage))
    }
    ws.onmessage = e => {
      try { handlers.onMessage(JSON.parse(String(e.data))) } catch {}
    }
    ws.onclose = () => handlers.onStatus("closed")
    return {
      send: m => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) },
      close: () => ws.close(),
    }
  },

  createLocalRoom(config, name, handlers) {
    let closed = false
    let timer = 0
    let engine: import("../sim/room-engine").RoomEngine | null = null
    let me = ""
    handlers.onStatus("connecting")
    import("../sim/room-engine").then(({ RoomEngine }) => {
      if (closed) return
      engine = new RoomEngine("LOCAL", { ...DEFAULT_ROOM_CONFIG, ...config, listed: false }, {
        send(playerId, message) {
          if (playerId === me && !closed) handlers.onMessage(structuredClone(message))
        },
      })
      me = engine.addPlayer(name)
      handlers.onStatus("open")
      engine.handle(me, { type: "hello", name })
      let last = performance.now()
      timer = window.setInterval(() => {
        const now = performance.now()
        const dt = Math.min(0.25, (now - last) / 1000)
        last = now
        engine!.advance(dt)
      }, 1000 / 60)
    })
    return {
      send: m => { if (engine && !closed) engine.handle(me, structuredClone(m)) },
      close: () => {
        closed = true
        clearInterval(timer)
        if (engine) engine.removePlayer(me)
        handlers.onStatus("closed")
      },
    }
  },

  async listRooms() {
    const r = await getJson("/rooms")
    return (Array.isArray(r) ? r : ((r as { rooms?: RoomSummary[] }).rooms ?? [])) as RoomSummary[]
  },
  async createRoom(config) {
    return codeOf(await getJson("/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) }))
  },
  async quickPlay() {
    return codeOf(await getJson("/quickplay"))
  },
}
