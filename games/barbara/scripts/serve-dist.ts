// Serves the production build at /arcade/barbara/ on 127.0.0.1 (a tailnet preview sits in front): bun scripts/serve-dist.ts [port]
import { resolve, sep } from "node:path"

const port = Number(process.argv[2] ?? 5297)
const root = resolve(import.meta.dir, "../dist/arcade/barbara")
const prefix = "/arcade/barbara/"
Bun.serve({ hostname: "127.0.0.1", port, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return Response.redirect(prefix, 302)
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep) && file !== root) return new Response("Not found", { status: 404 })
  const f = Bun.file(file)
  if (!(await f.exists())) return new Response("Not found", { status: 404 })
  return new Response(f, { headers: { "cache-control": "no-cache" } })
} })
console.log(`woods preview on http://127.0.0.1:${port}${prefix}`)
