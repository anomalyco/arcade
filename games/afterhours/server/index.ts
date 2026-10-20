// ASHWOOD's Worker: single player, so it only serves the built assets under /arcade/ashwood (dist/arcade/ashwood) and
// keeps the unlisted game out of search indexes.
//
// Delivery: binary models (.glb, .bin) have brotli copies made at build time (scripts/precompress.ts); browsers that
// accept br get those (~20% fewer bytes; Cloudflare doesn't compress binary types itself). Cache lifetimes: Vite's
// content-hashed bundles under /assets/ never change, so they're immutable for a year; the unhashed game data (models,
// textures, sounds, fonts) is fresh for an hour and then revalidated by ETag; the page itself always revalidates.

type Env = { ASSETS: { fetch(req: Request | string): Promise<Response> } }

const PREFIX = /^\/arcade\/ashwood(?=\/|$)/
const PRECOMPRESSED = /\.(glb|bin)$/
const IMMUTABLE = "public, max-age=31536000, immutable"
const DATA = "public, max-age=3600"

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (!PREFIX.test(url.pathname)) return new Response("not found", { status: 404 })
    const path = url.pathname.replace(PREFIX, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })

    // The browser's own Accept-Encoding (Cloudflare normalises the request header before the Worker sees it).
    const accepts = (req as { cf?: { clientAcceptEncoding?: string } }).cf?.clientAcceptEncoding ?? req.headers.get("accept-encoding") ?? ""
    if (PRECOMPRESSED.test(path) && (req.method === "GET" || req.method === "HEAD") && /\bbr\b/.test(accepts)) {
      const br = await env.ASSETS.fetch(new Request(new URL(`${url.pathname}.br`, url), { method: req.method, headers: req.headers }))
      if (br.status === 200 || br.status === 304) {
        const headers = new Headers(br.headers)
        headers.set("content-encoding", "br")
        headers.set("content-type", path.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream")
        headers.set("vary", "accept-encoding")
        headers.set("cache-control", DATA)
        headers.set("x-robots-tag", "noindex, nofollow")
        headers.delete("content-length")
        return new Response(br.body, { status: br.status, headers, encodeBody: "manual" } as ResponseInit)
      }
    }

    const res = await env.ASSETS.fetch(req)
    const out = new Response(res.body, res)
    out.headers.set("X-Robots-Tag", "noindex, nofollow")
    if (res.ok || res.status === 304) {
      if (path.startsWith("/assets/")) out.headers.set("cache-control", IMMUTABLE)
      else if (/\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html")) out.headers.set("cache-control", DATA)
    }
    return out
  },
}
