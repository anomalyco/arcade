#!/usr/bin/env bun
// Static server for the audio lab: bun audio-lab/serve.ts [--port 5199]
import { join, normalize } from "node:path"

const ROOT = import.meta.dir
const portArg = process.argv.indexOf("--port")
const preferred = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT ?? 5199)

function serve(port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname)
      if (path.endsWith("/")) path += "index.html"
      const full = normalize(join(ROOT, path))
      if (!full.startsWith(ROOT)) return new Response("Forbidden", { status: 403 })
      const file = Bun.file(full)
      if (!(await file.exists())) return new Response("Not found", { status: 404 })
      const cache = full.endsWith(".mp3") ? "public, max-age=60" : "no-cache"
      return new Response(file, { headers: { "cache-control": cache } })
    },
  })
}

let server
for (let port = preferred; port < preferred + 20; port++) {
  try {
    server = serve(port)
    break
  } catch {}
}
if (!server) throw new Error("No free port")
console.log(`Ashwood audio lab: http://localhost:${server.port}/`)
