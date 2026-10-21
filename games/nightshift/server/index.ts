type Env = { ASSETS: { fetch(request: Request): Promise<Response> } }
export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url)
    if (url.pathname === "/arcade/nightshift/api/health") return new Response("ok")
    if (url.pathname === "/arcade/nightshift") return Response.redirect(url.origin + "/arcade/nightshift/", 308)
    url.pathname = url.pathname.replace(/^\/arcade\/nightshift\//, "/")
    return env.ASSETS.fetch(new Request(url, request))
  },
}
