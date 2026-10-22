type Env = { ASSETS: { fetch(request: Request): Promise<Response> } }
export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (new URL(request.url).pathname === "/arcade/woods/api/health") return new Response("ok")
    return env.ASSETS.fetch(request)
  },
}
