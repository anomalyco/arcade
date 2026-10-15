/**
 * Headless captures of the production bundle (run `vite build` first): screenshots at given times, optionally a
 * muted video. Local sessions only (practice, watch), so no Worker is needed.
 *
 *   bun scripts/capture.ts --query "watch&seed=3" --shots 2,6,10 --out captures/archers
 *   bun scripts/capture.ts --query "watch&seed=3" --video 24 --out captures/archers
 */
import { mkdirSync } from "node:fs"
import { resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { CHROME_ARGS, PACE_60 } from "./headless"
import { chromium } from "playwright-core"

const { values: o } = parseArgs({
  options: {
    query: { type: "string", default: "watch&seed=3" },
    shots: { type: "string", default: "3" },
    out: { type: "string", default: "captures" },
    video: { type: "string" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "720" },
    eval: { type: "string" },
  },
})
const prefix = "/arcade/archers/"
const root = resolve("dist/arcade/archers")
const out = resolve(o.out!)
mkdirSync(out, { recursive: true })
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const asset = Bun.file(file)
    return (await asset.exists()) ? new Response(asset) : new Response("Not found", { status: 404 })
  },
})
const browser = await chromium.launch({ headless: true, args: CHROME_ARGS })
const size = { width: Number(o.width), height: Number(o.height) }
const context = await browser.newContext({ viewport: size, ...(o.video ? { recordVideo: { dir: out, size } } : {}) })
const page = await context.newPage()
await page.addInitScript(PACE_60)
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(m.text())
})
await page.goto(`http://127.0.0.1:${server.port}${prefix}?${o.query}`, { waitUntil: "load" })
try {
  await page.waitForFunction(() => (globalThis as { archers?: unknown }).archers, null, { timeout: 15_000 })
} catch (e) {
  console.log(`not ready: ${errors.join("\n")}`)
  await page.screenshot({ path: resolve(out, "not-ready.png") })
  throw e
}
const t0 = Date.now()
if (o.eval) await page.evaluate(o.eval)
if (o.video) await page.waitForTimeout(Number(o.video) * 1000)
else {
  for (const s of o.shots!.split(",").map(Number)) {
    await page.waitForTimeout(Math.max(0, s * 1000 - (Date.now() - t0)))
    const file = resolve(out, `shot-${s}s.png`)
    await page.screenshot({ path: file })
    console.log(file)
  }
}
type Probe = { world: { s: { phase: string; round: number; archers: { name: string; wins: number; kills: number; alive: boolean }[] } }; counts: Record<string, number>; sound: { played: Record<string, number> } }
const state = await page.evaluate(() => {
  const g = (globalThis as { archers?: Probe }).archers
  return g ? { phase: g.world.s.phase, round: g.world.s.round, archers: g.world.s.archers.map((a) => `${a.name} w${a.wins} k${a.kills}${a.alive ? "" : " dead"}`), counts: g.counts, sounds: g.sound.played } : null
})
console.log(JSON.stringify(state))
await context.close()
if (o.video) console.log(`video: ${await page.video()?.path()}`)
await browser.close()
server.stop()
if (errors.length) console.log(`errors:\n${errors.slice(0, 20).join("\n")}`)
