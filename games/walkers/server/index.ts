// Static Worker: the page and its assets live under dist/arcade/walkers, so requests pass straight to the assets.
// Training runs entirely in the visitor's browser.

type Env = { ASSETS: Fetcher }

const PREFIX = /^\/arcade\/walkers(?=\/|$)/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(PREFIX, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
