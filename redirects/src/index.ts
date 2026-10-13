// Permanently redirects the old anoma.ly/labs/<game> URLs to anoma.ly/arcade/<game>, keeping the rest of the path and
// the query string so room links still land in the same room.
const GAMES = ["blackout", "getaway", "wings"]
const OLD = new RegExp(`^/labs/(${GAMES.join("|")})(?=/|$)`)

export default {
  fetch(req: Request): Response {
    const url = new URL(req.url)
    const match = url.pathname.match(OLD)
    if (!match) return new Response("not found", { status: 404 })
    url.pathname = url.pathname.replace(OLD, `/arcade/${match[1]}`)
    // 308 keeps the method for API POSTs; browsers treat both as permanent.
    const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308
    return Response.redirect(url.toString(), status)
  },
}
