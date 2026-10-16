import { labUrl } from "../lab-url"
import { roomLocationHint, type RoomLocationHint } from "../net/room-core"

export { roomLocationHint, type RoomLocationHint }

/** The Lobby's RPC surface the router calls. */
export type LobbyApi = { quick(): unknown; create(): unknown; stats(): unknown }

/** Structural, so any game's `DurableObjectNamespace<Room>` fits. */
export type GameEnv = {
  ROOM: {
    idFromName(name: string): DurableObjectId
    get(id: DurableObjectId, options?: { locationHint?: DurableObjectLocationHint }): { fetch(req: Request): Promise<Response> }
  }
  ASSETS?: Fetcher
}

export type GameWorkerOptions<Env> = {
  /** The game's route name: the Worker serves `/arcade/<game>` and `/arcade/<game>/*`. */
  game: string
  lobby?: (env: Env) => LobbyApi
  /** Custom `/api/*` handler (runs before the default lobby endpoints). */
  api?: (path: string, req: Request, env: Env) => Promise<Response | null> | Response | null
  /** Room code validator/normalizer for `/ws/<code>` or `/ws?room=<code>`. */
  roomCode?: (raw: string) => string | null
  /** Query parameter carrying the room code on `/ws` upgrades (e.g. `"room"` for `/ws?room=CODE`). */
  wsQueryParam?: string
  /** Redirect the old `/lab.html` to the shared Lab (default true). */
  lab?: boolean
}

const DEFAULT_ROOM_CODE = (raw: string) => (/^[a-z0-9]{4,8}$/.test(raw) ? raw : null)
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } })

/**
 * The Worker for a room-based game: strips the `/arcade/<game>` prefix, answers health, quick join, create and stats
 * from the Lobby, forwards `/ws/<code>` (or `/ws?room=<code>`) upgrades to that code's Room Durable Object, and serves assets otherwise.
 */
export function gameWorker<Env extends GameEnv>(options: GameWorkerOptions<Env>): ExportedHandler<Env> {
  const prefix = new RegExp(`^/arcade/${options.game}(?=/|$)`)
  const parseCode = options.roomCode ?? DEFAULT_ROOM_CODE
  return {
    async fetch(req, env): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname.replace(prefix, "")
      if (options.lab !== false && path === "/lab.html") return Response.redirect(labUrl(req.url, options.game), 301)
      if (options.api && path.startsWith("/api/")) {
        const res = await options.api(path, req, env)
        if (res) return res
      }
      if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
      if (options.lobby) {
        if (path === "/api/quick") return json({ room: await options.lobby(env).quick() })
        if (path === "/api/create") return json({ room: await options.lobby(env).create() })
        if (path === "/api/stats") return json(await options.lobby(env).stats())
      }
      if (options.wsQueryParam && (path === "/ws" || path === "/ws/")) {
        if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
        const code = parseCode(url.searchParams.get(options.wsQueryParam) ?? "")
        if (!code) return new Response("bad room code", { status: 400 })
        const headers = new Headers(req.headers)
        headers.set("x-room", code)
        const locationHint = roomLocationHint(req as { cf?: { continent?: string; country?: string; regionCode?: string } })
        const stub = locationHint ? env.ROOM.get(env.ROOM.idFromName(code), { locationHint }) : env.ROOM.get(env.ROOM.idFromName(code))
        return stub.fetch(new Request(req, { headers }))
      }
      const ws = path.match(/^\/ws\/([^/]+)\/?$/)
      if (ws) {
        const code = parseCode(decodeURIComponent(ws[1]!))
        if (!code) return options.roomCode ? new Response("bad room code", { status: 400 }) : new Response("not found", { status: 404 })
        if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
        const headers = new Headers(req.headers)
        headers.set("x-room", code)
        const locationHint = roomLocationHint(req as { cf?: { continent?: string; country?: string; regionCode?: string } })
        const stub = locationHint ? env.ROOM.get(env.ROOM.idFromName(code), { locationHint }) : env.ROOM.get(env.ROOM.idFromName(code))
        return stub.fetch(new Request(req, { headers }))
      }
      if (env.ASSETS) return env.ASSETS.fetch(req)
      return new Response("not found", { status: 404 })
    },
  }
}
