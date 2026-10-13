import { DurableObject } from "cloudflare:workers"
import { roomCode } from "../shared/crew"
import type { Env } from "./env"
import { Matchmaker, type RoomEntry, type RoomReport } from "./matchmaking"

/**
 * Singleton matchmaker (`LOBBY.idFromName("lobby")`). Room reports are kept in storage too, so a Lobby that was evicted
 * or restarted still knows every live room at once instead of waiting for their next heartbeat.
 */
export class Lobby extends DurableObject<Env> {
  private mm = new Matchmaker()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomEntry[]>("rooms")
      for (const r of saved ?? []) this.mm.rooms.set(r.code, r)
    })
  }

  async report(r: RoomReport): Promise<void> {
    this.mm.report(r, Date.now())
    await this.ctx.storage.put("rooms", [...this.mm.rooms.values()])
  }

  quick(): string {
    return this.mm.quick(Date.now())
  }

  create(): string {
    return this.mm.create(Date.now())
  }

  info(code: string) {
    return this.mm.info(code, Date.now())
  }

  stats() {
    return this.mm.stats(Date.now())
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
 *
 * A Room reports itself with `lobbyOf(env.LOBBY).report({ code, players, private })` (throttled, with a heartbeat well
 * inside STALE_MS). The first arrival in an empty room makes it private by connecting to `/ws?room=CODE&private=1`.
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
