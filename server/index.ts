import { type Env } from "./env"

export { Room } from "./room"

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } })

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

function newRoomCode(): string {
  let out = ""
  for (let i = 0; i < 4; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/labs\/blackout(?=\/|$)/, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    if (path === "/api/create") return json({ room: newRoomCode() })
    const ws = path.match(/^\/ws\/([a-z0-9]{4,8})\/?$/)
    if (ws) {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
      const code = ws[1]!
      const headers = new Headers(req.headers)
      headers.set("x-room", code)
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(req, { headers }))
    }
    if (env.ASSETS) return env.ASSETS.fetch(req)
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
