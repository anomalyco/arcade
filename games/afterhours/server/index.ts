// ASHWOOD's Worker: single player, so it only serves the built assets under /arcade/ashwood (dist/arcade/ashwood) and
// keeps the unlisted game out of search indexes.

type Env = { ASSETS: { fetch(req: Request): Promise<Response> } }

const PREFIX = /^\/arcade\/ashwood(?=\/|$)/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (!PREFIX.test(url.pathname)) return new Response("not found", { status: 404 })
    const path = url.pathname.replace(PREFIX, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    const res = await env.ASSETS.fetch(req)
    const out = new Response(res.body, res)
    out.headers.set("X-Robots-Tag", "noindex, nofollow")
    return out
  },
}
