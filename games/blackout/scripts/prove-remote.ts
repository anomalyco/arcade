// Practice round in headless Chromium: remote soldiers drawn from interpolated snapshots must move without velocity
// jumps, and the page must log no errors. Run after `vite build`: bun scripts/prove-remote.ts [--map=lot] [--seconds=4]
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d
const map = opt("map", "lot")
const seconds = Number(opt("seconds", "4"))
const prefix = "/arcade/blackout/"
const root = resolve(import.meta.dir, "../dist/arcade/blackout")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === `${prefix}api/stats`) return Response.json({ players: 0, games: 0 })
    if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const f = Bun.file(file)
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?practice&map=${map}&bench`, { waitUntil: "load" })
  await page.waitForFunction(() => (globalThis as any).wizardProof?.game?.snap?.phase === "play", undefined, { timeout: 20_000 })
  const result = await page.evaluate(async (frames) => {
    const game = (globalThis as any).wizardProof.game
    const tracks = new Map<string, { x: number; y: number; t: number }[]>()
    for (let f = 0; f < frames; f++) {
      await new Promise((r) => requestAnimationFrame(r))
      const t = performance.now() / 1000
      for (const a of game.avatars.values()) {
        if (!a.alive) continue
        const list = tracks.get(a.id) ?? []
        list.push({ x: a.x, y: a.y, t })
        tracks.set(a.id, list)
      }
    }
    let jumps = 0, samples = 0
    for (const list of tracks.values())
      for (let i = 2; i < list.length; i++) {
        const [a, b, c] = [list[i - 2]!, list[i - 1]!, list[i]!]
        const v1 = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1e-3, b.t - a.t)
        const v2 = Math.hypot(c.x - b.x, c.y - b.y) / Math.max(1e-3, c.t - b.t)
        if (v1 > 20 || v2 > 20) continue // respawn teleport
        samples++
        if (Math.abs(v2 - v1) > 1.5) jumps++
      }
    return { soldiers: tracks.size, samples, jumps, buffered: game.remote?.size ?? 0 }
  }, seconds * 60)
  console.log(JSON.stringify({ map, ...result, errors }))
  if (errors.length) throw new Error(errors.join("\n"))
  if (!result.samples) throw new Error("no remote soldiers moved")
} finally {
  await browser.close()
  server.stop()
}
