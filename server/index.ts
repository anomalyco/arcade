import { normalizeRoom } from "../shared/protocol"
import type { Env } from "./env"

export { Room } from "./room"

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/labs\/getaway(?=\/|$)/, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    const ws = path.match(/^\/ws\/([^/]+)\/?$/)
    if (ws) {
      const code = normalizeRoom(decodeURIComponent(ws[1]!))
      if (!code) return new Response("bad room code", { status: 400 })
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
      const headers = new Headers(req.headers)
      headers.set("x-room", code)
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(req, { headers }))
    }
    if (env.ASSETS) return env.ASSETS.fetch(req)
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
