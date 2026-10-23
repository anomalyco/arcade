/**
 * Where the boot goes: loads the built game headless (Metal) with a query (default `?smoke`), records a CPU profile
 * until two frames are drawn, and prints the `woods:` boot marks and the top self-time functions. Run through HiveMind
 * after `vite build` (add `--minify false` for readable names): `bun scripts/boot-profile.ts [?query]`. `BOOT_PROFILE=0`
 * records no profile (marks only, without the sampler's overhead).
 */
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const prefix = "/arcade/barbara/"
const root = resolve(process.env.BOOT_DIST ?? "dist/arcade/barbara")
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
page.on("pageerror", (e) => console.log("pageerror", e.message))
const cdp = await page.context().newCDPSession(page)
const profiling = process.env.BOOT_PROFILE !== "0"
if (profiling) {
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 })
  await cdp.send("Profiler.start")
}
await page.goto(`http://127.0.0.1:${server.port}${prefix}${process.argv[2] ?? "?smoke"}`, { waitUntil: "load", timeout: 30_000 })
await page.waitForFunction(() => ((window as unknown as { woods?: { frames: number } }).woods?.frames ?? 0) >= 2, undefined, { timeout: 120_000, polling: 250 })
console.log("marks", JSON.stringify(await page.evaluate(() => performance.getEntriesByType("mark").map((m) => [m.name, Math.round(m.startTime)]))))
console.log("stats", JSON.stringify(await page.evaluate(() => (window as unknown as { woods: { stats(): { loadMs: number; buildMs: number } } }).woods.stats()).then(({ loadMs, buildMs }) => ({ loadMs, buildMs }))))
if (!profiling) { await browser.close(); server.stop(true); process.exit(0) }
const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } }
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map<string, number>()
profile.samples.forEach((id, i) => {
  const f = byId.get(id)!.callFrame
  const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`
  self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000)
})
for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log("self", Math.round(ms), k)
await browser.close()
server.stop(true)
