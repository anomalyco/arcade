/** Loopback-only production assets for headless capture scripts. */
export function serveDist(root: string) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.includes("..")) return new Response("Bad path", { status: 400 })
    const file = Bun.file(`${root}${pathname}${pathname.endsWith("/") ? "index.html" : ""}`)
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
  } })
}
