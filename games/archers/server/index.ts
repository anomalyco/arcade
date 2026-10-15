import { GAME } from "../shared/config"

type Env = { ASSETS?: Fetcher }

const prefix = new RegExp(`^/arcade/${GAME.id}(?=/|$)`)

/**
 * The prototype is local-only for now: the Worker answers health and serves the built client under
 * `/arcade/archers`. Rooms arrive with online play.
 */
export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(prefix, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    if (env.ASSETS) return env.ASSETS.fetch(req)
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
