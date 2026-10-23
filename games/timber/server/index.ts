// Static Worker: the page and its assets live under dist/arcade/timber, so requests pass straight to the assets.

type Env = { ASSETS: { fetch(request: Request): Promise<Response> } }

const PREFIX = /^\/arcade\/timber(?=\/|$)/

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const path = new URL(request.url).pathname.replace(PREFIX, "")
    if (path === "/api/health") return new Response("ok", { headers: { "content-type": "text/plain" } })
    return env.ASSETS.fetch(request)
  },
}
