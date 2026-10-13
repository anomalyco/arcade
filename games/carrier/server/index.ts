import { roomName } from "../shared/protocol"
import type { Env } from "./env"
import { lobbyApi } from "./lobby"

export { Lobby } from "./lobby"
export { Room } from "./room"

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/arcade\/carrier(?=\/|$)/, "")
    // GET /api/quick, POST /api/create, GET /api/room/:code, GET /api/stats (server/lobby.ts).
    const api = await lobbyApi(path, req, env.LOBBY)
    if (api) return api
    // /ws?room=CODE[&private=1]: the room's Durable Object, keyed by its name.
    if (path === "/ws" || path === "/ws/") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
      const room = roomName(url.searchParams.get("room"))
      const headers = new Headers(req.headers)
      headers.set("x-room", room)
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request(req, { headers }))
    }
    if (env.ASSETS) return env.ASSETS.fetch(req)
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
