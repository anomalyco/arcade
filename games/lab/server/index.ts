// Assets live under dist/arcade/lab/, so the static binding serves the prefixed path directly.
export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/arcade\/lab(?=\/|$)/, "")
    if (path === "") return Response.redirect(`${url.origin}/arcade/lab/${url.search}`, 301)
    if (path === "/lab.html") return Response.redirect(`${url.origin}/arcade/lab/${url.search}`, 301)
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>
