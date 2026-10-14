import { labUrl } from "@arcade/kit/lab-url"
export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/arcade\/outbreak(?=\/|$)/, "")
    if (path === "/lab.html") return Response.redirect(labUrl(req.url, "outbreak"), 301)
    if (path === "/api/health") return Response.json({ ok: true, session: "local" })
    if (path.startsWith("/api/") || path.startsWith("/ws/")) return new Response("Not found", { status: 404 })
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>
