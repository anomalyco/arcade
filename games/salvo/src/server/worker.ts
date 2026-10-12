import type { Env } from "./room"
import { BASE, randomRoom, validRoom } from "./validate"
export { Room } from "./room"

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    const ws = path.match(/^\/arcade\/salvo\/ws\/([^/]+)\/?$/)
    if (ws) {
      const room = ws[1]!.toLowerCase()
      if (!validRoom(room)) return json({ error: "Invalid room" }, 400)
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected WebSocket" }, 426)
      const internal = new URL("https://room/ws")
      internal.searchParams.set("room", room)
      const pid = url.searchParams.get("pid")
      if (pid) internal.searchParams.set("pid", pid)
      return env.ROOMS.getByName(room).fetch(new Request(internal, request))
    }

    if (path === `${BASE}/api/rooms`) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
      return json({ room: randomRoom() }, 201)
    }
    if (path === `${BASE}/api/health`) return json({ ok: true, now: Date.now() })
    if (path.startsWith(`${BASE}/api/`) || path.startsWith(`${BASE}/ws`)) return json({ error: "Not found" }, 404)

    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 })
    const link = path.match(/^\/arcade\/salvo\/r\/([^/]+)\/?$/)
    if (link && !validRoom(link[1]!.toLowerCase())) return new Response("Invalid room", { status: 404 })
    if (link || path === BASE || path === `${BASE}/`) {
      const index = new URL(url)
      // auto-trailing-slash would redirect /index.html to /, losing the room path
      index.pathname = `${BASE}/`
      const response = await env.ASSETS.fetch(new Request(index, request))
      const headers = new Headers(response.headers)
      headers.set("cache-control", "no-cache")
      return new Response(response.body, { status: response.status, headers })
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
