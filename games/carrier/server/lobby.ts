import { LobbyObject } from "@arcade/kit/server/lobby-object"
import { roomCode } from "../shared/crew"
import type { Env } from "./env"
import { Matchmaker, type RoomReport } from "./matchmaking"

/** Singleton matchmaker (`@arcade/kit/server/lobby-object`, `LOBBY.idFromName("lobby")`). */
export class Lobby extends LobbyObject<Env, RoomReport> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, new Matchmaker())
  }
}

type LobbyNs = DurableObjectNamespace<Lobby>

export const lobbyOf = (ns: LobbyNs) => ns.get(ns.idFromName("lobby"))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

/**
 * The lobby API, for server/index.ts to call with the prefix-stripped path. Returns null for any other path.
 *
 *   GET  /api/quick        -> { room }  the fullest open public room, else a fresh shared code
 *   POST /api/create       -> { room }  a fresh private code (also GET, so a plain link works)
 *   GET  /api/room/:code   -> { code, players, full, live }
 *   GET  /api/stats        -> { players, games }
 */
export async function lobbyApi(path: string, req: Request, ns: LobbyNs): Promise<Response | null> {
  if (!path.startsWith("/api/")) return null
  const lobby = lobbyOf(ns)
  if (path === "/api/quick") return json({ room: await lobby.quick() })
  if (path === "/api/create") return req.method === "POST" || req.method === "GET" ? json({ room: await lobby.create() }) : json({ error: "method" }, 405)
  if (path === "/api/stats") return json(await lobby.stats())
  const m = path.match(/^\/api\/room\/([^/]+)\/?$/)
  if (m) {
    const code = roomCode(decodeURIComponent(m[1]!))
    return code ? json(await lobby.info(code)) : json({ error: "bad code" }, 400)
  }
  return json({ error: "not found" }, 404)
}
