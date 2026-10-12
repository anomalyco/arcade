// Cloudflare Worker entry: static assets under /labs/wings/, REST API, and the Room / RoomDirectory Durable Objects.
import { DEFAULT_ROOM_CONFIG, EMPTY_ROOM_TTL_MS } from "./src/sim/protocol"
import type { ClientMessage, RoomSummary, ServerMessage } from "./src/sim/protocol"
import { RoomEngine, sanitizeConfig } from "./src/sim/room-engine"
import type { EngineConfig } from "./src/sim/room-engine"

type Env = {
  ROOMS: DurableObjectNamespace
  DIRECTORY: DurableObjectNamespace
  ASSETS: Fetcher
  /** Optional override (ms) for the empty-room TTL, e.g. `wrangler dev --var EMPTY_ROOM_TTL_MS:5000`. */
  EMPTY_ROOM_TTL_MS?: string
}

const BASE = "/labs/wings"
const CODE_RE = /^[a-z0-9]{3,16}$/
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const DIRECTORY_STALE_MS = 30_000
const DIRECTORY_REFRESH_MS = 5_000
const MAX_MESSAGE_BYTES = 8192
const MAX_MESSAGES_PER_SECOND = 240
/** Quick-play rooms top each team up to this many players with bots while fewer humans than this are present. */
const QUICKPLAY_BOT_FILL = 0
const CLOSE_ROOM_FULL = 4001
const CLOSE_ROOM_CLOSED = 4004

const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))
const room = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code))

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  let code = ""
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return code
}

/** Creates and initializes a room; retries on the (unlikely) code collision. */
async function createRoom(env: Env, config: EngineConfig): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = newCode()
    const response = await room(env, code).fetch("https://room/internal/init", {
      method: "POST", body: JSON.stringify({ code, config }),
    })
    if (response.ok) return code
    if (response.status !== 409) throw new Error(`room init failed: ${response.status}`)
  }
  throw new Error("could not allocate room code")
}

async function listRooms(env: Env): Promise<RoomSummary[]> {
  return (await directory(env).fetch("https://directory/list")).json()
}

async function api(request: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname
  if (path === "/api/health") return Response.json({ ok: true, name: "wings", time: Date.now() })
  if (path === "/api/rooms" && request.method === "GET") return Response.json(await listRooms(env))
  if (path === "/api/rooms" && request.method === "POST") {
    const text = await request.text()
    if (text.length > 4096) return Response.json({ error: "config too large" }, { status: 413 })
    let body: unknown = {}
    try { body = text ? JSON.parse(text) : {} } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }) }
    return Response.json({ code: await createRoom(env, sanitizeConfig(body)) })
  }
  if (path === "/api/quickplay" && request.method === "GET") {
    const open = (await listRooms(env)).filter(r => r.humans < r.maxPlayers).sort((a, b) => b.humans - a.humans)
    if (open.length) return Response.json({ code: open[0].code })
    return Response.json({ code: await createRoom(env, { ...DEFAULT_ROOM_CONFIG, ...(QUICKPLAY_BOT_FILL ? { botFill: QUICKPLAY_BOT_FILL } : {}) }) })
  }
  if (path === "/api/room") {
    const code = (url.searchParams.get("code") ?? "").toLowerCase()
    if (!CODE_RE.test(code)) return new Response("Invalid room code", { status: 400 })
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 })
    const forwarded = new URL("https://room/connect")
    forwarded.searchParams.set("code", code)
    return room(env, code).fetch(new Request(forwarded, request))
  }
  return Response.json({ error: "not found" }, { status: 404 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const prefixed = url.pathname === BASE || url.pathname.startsWith(BASE + "/")
    // The route's trailing wildcard also matches e.g. /labs/wingsuit; leave those to the origin.
    if (url.hostname === "anoma.ly" && !prefixed) return fetch(request)
    if (url.pathname === BASE) {
      url.pathname = BASE + "/"
      return Response.redirect(url.href, 308)
    }
    if (prefixed) url.pathname = url.pathname.slice(BASE.length) || "/"
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, url, env)
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }
    let response = await env.ASSETS.fetch(new Request(url, request))
    // SPA fallback: unknown non-file paths serve the app shell.
    if (response.status === 404 && request.method === "GET" && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      response = await env.ASSETS.fetch(new Request(new URL("/", url), request))
    }
    const location = response.headers.get("Location")
    if (prefixed && location) {
      const target = new URL(location, url)
      if (target.origin === url.origin && !target.pathname.startsWith(BASE + "/")) {
        target.pathname = BASE + target.pathname
        const redirected = new Response(response.body, response)
        redirected.headers.set("Location", target.href)
        return redirected
      }
    }
    return response
  },
} satisfies ExportedHandler<Env>

interface Peer {
  playerId: string
  windowStart: number
  messages: number
}

export class Room implements DurableObject {
  private engine: RoomEngine | null = null
  private code: string | null = null
  private peers = new Map<WebSocket, Peer>()
  private sockets = new Map<string, WebSocket>()
  private timer: ReturnType<typeof setInterval> | undefined
  private last = 0
  private emptySince: number | null = null
  private emptyTimer: ReturnType<typeof setTimeout> | undefined
  private lastDirectoryUpdate = 0
  private readonly ttl: number

  constructor(private state: DurableObjectState, private env: Env) {
    const override = Number(env.EMPTY_ROOM_TTL_MS)
    this.ttl = Number.isFinite(override) && override > 0 ? override : EMPTY_ROOM_TTL_MS
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/internal/init" && request.method === "POST") {
      const body = await request.json() as { code: string; config: unknown }
      if (this.engine || await this.state.storage.get("config")) return new Response("exists", { status: 409 })
      const config = sanitizeConfig(body.config)
      await this.state.storage.put({ code: body.code, config })
      await this.load(body.code)
      this.updateDirectory(true)
      // Nobody may ever join; make sure the room still expires.
      this.startEmptyCountdown()
      return Response.json({ code: body.code })
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 })
    const code = url.searchParams.get("code") ?? ""
    const engine = await this.load(code)
    const pair = new WebSocketPair()
    const [client, socket] = [pair[0], pair[1]]
    socket.accept()
    if (engine.isFull()) {
      socket.send(JSON.stringify({ type: "error", message: "Room is full." } satisfies ServerMessage))
      socket.close(CLOSE_ROOM_FULL, "Room full")
      return new Response(null, { status: 101, webSocket: client })
    }
    const peer: Peer = { playerId: "", windowStart: Date.now(), messages: 0 }
    this.peers.set(socket, peer)
    // addPlayer sends `welcome` through hooks.send, so register the socket under the id first.
    peer.playerId = engine.addPlayer("Pilot", id => this.sockets.set(id, socket))
    socket.addEventListener("message", event => this.onMessage(socket, event.data))
    socket.addEventListener("close", () => this.onClose(socket))
    socket.addEventListener("error", () => this.onClose(socket))
    this.cancelEmptyCountdown()
    this.start()
    this.updateDirectory(true)
    return new Response(null, { status: 101, webSocket: client })
  }

  async alarm(): Promise<void> {
    if (this.engine && this.engine.humanCount() > 0) return
    if (this.emptySince !== null && Date.now() - this.emptySince < this.ttl - 250) {
      await this.state.storage.setAlarm(this.emptySince + this.ttl)
      return
    }
    await this.destroy()
  }

  private async load(code: string): Promise<RoomEngine> {
    if (this.engine) return this.engine
    const stored = await this.state.storage.get<EngineConfig>("config")
    const storedCode = await this.state.storage.get<string>("code")
    this.code = storedCode ?? code
    const config = stored ?? sanitizeConfig({ ...DEFAULT_ROOM_CONFIG, name: `Room ${this.code.toUpperCase()}` })
    if (!stored) await this.state.storage.put({ code: this.code, config })
    this.engine = new RoomEngine(this.code, config, {
      send: (playerId, message) => this.sendText(playerId, JSON.stringify(message)),
      sendText: (playerId, text) => this.sendText(playerId, text),
      onChange: () => this.updateDirectory(false),
    })
    return this.engine
  }

  private sendText(playerId: string, text: string): void {
    const socket = this.sockets.get(playerId)
    if (!socket || socket.readyState !== WebSocket.READY_STATE_OPEN) return
    try { socket.send(text) } catch { /* socket closing */ }
  }

  private onMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    const peer = this.peers.get(socket)
    if (!peer || !this.engine || typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return
    const now = Date.now()
    if (now - peer.windowStart >= 1000) { peer.windowStart = now; peer.messages = 0 }
    if (++peer.messages > MAX_MESSAGES_PER_SECOND) return
    let message: ClientMessage
    try { message = JSON.parse(data) } catch { return }
    this.engine.handle(peer.playerId, message)
  }

  private onClose(socket: WebSocket): void {
    const peer = this.peers.get(socket)
    if (!peer) return
    this.peers.delete(socket)
    this.sockets.delete(peer.playerId)
    try { socket.close(1000, "bye") } catch { /* already closed */ }
    if (!this.engine) return
    this.engine.removePlayer(peer.playerId)
    if (this.engine.humanCount() === 0) {
      this.stop()
      this.startEmptyCountdown()
    }
    this.updateDirectory(true)
  }

  private start(): void {
    if (this.timer) return
    this.last = Date.now()
    this.timer = setInterval(() => this.loop(), 1000 / 60)
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private loop(): void {
    const engine = this.engine
    if (!engine) return this.stop()
    const now = Date.now()
    engine.advance((now - this.last) / 1000)
    this.last = now
    if (now - this.lastDirectoryUpdate >= DIRECTORY_REFRESH_MS) this.updateDirectory(true)
  }

  private startEmptyCountdown(): void {
    this.emptySince = Date.now()
    if (this.emptyTimer !== undefined) clearTimeout(this.emptyTimer)
    this.emptyTimer = setTimeout(() => void this.checkEmpty(), this.ttl)
    void this.state.storage.setAlarm(this.emptySince + this.ttl)
  }

  private cancelEmptyCountdown(): void {
    this.emptySince = null
    if (this.emptyTimer !== undefined) clearTimeout(this.emptyTimer)
    this.emptyTimer = undefined
    void this.state.storage.deleteAlarm()
  }

  private async checkEmpty(): Promise<void> {
    if (this.emptySince === null || (this.engine && this.engine.humanCount() > 0)) return
    if (Date.now() - this.emptySince < this.ttl - 250) return
    await this.destroy()
  }

  /** Stop simulating, wipe storage and drop out of the room browser. */
  private async destroy(): Promise<void> {
    this.stop()
    if (this.emptyTimer !== undefined) clearTimeout(this.emptyTimer)
    for (const socket of this.peers.keys()) try { socket.close(CLOSE_ROOM_CLOSED, "Room closed") } catch { /* ignore */ }
    this.peers.clear()
    this.sockets.clear()
    const code = this.code ?? (await this.state.storage.get<string>("code")) ?? null
    this.engine = null
    this.code = null
    this.emptySince = null
    await this.state.storage.deleteAlarm()
    await this.state.storage.deleteAll()
    if (code) await directory(this.env).fetch("https://directory/unregister", { method: "POST", body: JSON.stringify({ code }) })
  }

  private updateDirectory(force: boolean): void {
    const engine = this.engine
    if (!engine) return
    const now = Date.now()
    if (!force && now - this.lastDirectoryUpdate < 1000) return
    this.lastDirectoryUpdate = now
    const request = engine.config.listed
      ? new Request("https://directory/register", { method: "POST", body: JSON.stringify(engine.summary()) })
      : new Request("https://directory/unregister", { method: "POST", body: JSON.stringify({ code: engine.code }) })
    this.state.waitUntil(directory(this.env).fetch(request).then(() => undefined, () => undefined))
  }
}

interface DirectoryEntry {
  summary: RoomSummary
  lastSeen: number
}

export class RoomDirectory implements DurableObject {
  private rooms = new Map<string, DirectoryEntry>()

  constructor(private state: DurableObjectState, _env: Env) {
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.list<DirectoryEntry>()
      for (const [code, entry] of stored) this.rooms.set(code, entry)
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/register" && request.method === "POST") {
      const summary = await request.json() as RoomSummary
      if (typeof summary?.code !== "string" || !CODE_RE.test(summary.code)) return new Response("bad", { status: 400 })
      const entry = { summary, lastSeen: Date.now() }
      this.rooms.set(summary.code, entry)
      await this.state.storage.put(summary.code, entry)
      return new Response("ok")
    }
    if (url.pathname === "/unregister" && request.method === "POST") {
      const { code } = await request.json() as { code: string }
      if (typeof code === "string" && this.rooms.delete(code)) await this.state.storage.delete(code)
      return new Response("ok")
    }
    if (url.pathname === "/list") {
      const now = Date.now()
      const stale: string[] = []
      for (const [code, entry] of this.rooms) if (now - entry.lastSeen > DIRECTORY_STALE_MS) stale.push(code)
      for (const code of stale) this.rooms.delete(code)
      if (stale.length) await this.state.storage.delete(stale)
      const list = [...this.rooms.values()].map(e => e.summary).sort((a, b) => b.humans - a.humans || b.players - a.players)
      return Response.json(list)
    }
    return new Response("not found", { status: 404 })
  }
}
