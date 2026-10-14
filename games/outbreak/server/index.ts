import { labUrl } from "@arcade/kit/lab-url"
import { ROOM_CODE } from "../shared/net-protocol"
import type { RoomEnv } from "./room"

export { OutbreakRoom } from "./room"

export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/arcade\/outbreak(?=\/|$)/, "")
    if (path === "/lab.html") return Response.redirect(labUrl(req.url, "outbreak"), 301)
    if (path === "/api/health") return Response.json({ ok: true, session: "coop" })
    const ws = path.match(/^\/ws\/([^/]+)\/?$/)
    if (ws) {
      const code = ws[1]!.toLowerCase()
      if (!ROOM_CODE.test(code)) return new Response("bad room code", { status: 400 })
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
      const headers = new Headers(req.headers)
      headers.set("x-room", code)
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(req, { headers }))
    }
    if (path.startsWith("/api/") || path.startsWith("/ws/")) return new Response("Not found", { status: 404 })
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<RoomEnv>
