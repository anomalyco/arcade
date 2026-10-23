/**
 * Headless, muted proof captures of the production bundle (run `vite build` first), from the fixed scenes in
 * `window.timber.stage`. Writes into `$LEASE_OUT` (HiveMind) or `--out`.
 *
 *   hivemind run --kind browser --fetch -- bun scripts/proof.ts
 *
 * fell.webm: one big tree felled up close (kerf chips, exhaust, hinge splinters, crown raking a neighbour, landing).
 * domino.webm: you fell a tree down a cleared lane; it knocks two notched trees onto two survivors (slow-mo).
 * saw-*.png: the saw in a survivor up close. hunt.png: the default view six seconds into an ordinary hunt.
 */
import { mkdirSync, renameSync } from "node:fs"
import { resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const { values: o } = parseArgs({ options: { out: { type: "string", default: process.env.LEASE_OUT ?? "captures/proof" } } })
const prefix = "/arcade/timber/"
const root = resolve("dist/arcade/timber")
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

type Timber = {
  world: { t: number; trees: { state: string }[]; jacks: { alive: boolean; downed: boolean; cause: string | null }[]; events: unknown[] }
  auto: { input: unknown; camera: unknown }
  stage(name: string): void
  frames: number
}
const NO = { mx: 0, my: 0, aim: 0, saw: false, dash: false, sprint: false, engine: false, torch: false, flare: false, use: false }
const size = { width: 1280, height: 720 }
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []

async function open(video: boolean) {
  const context = await browser.newContext({ viewport: size, ...(video ? { recordVideo: { dir: out, size } } : {}) })
  const page = await context.newPage()
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  const t0 = Date.now()
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?seed=3`, { waitUntil: "load" })
  await page.waitForFunction(() => ((globalThis as unknown as { timber?: Timber }).timber?.frames ?? 0) > 10, null, { timeout: 20_000, polling: 100 })
  return { context, page, t0 }
}

/** Cut the tree `index` from the end with the saw held until it goes, filming for `seconds`. */
async function fellClip(name: string, stage: string, index: number, camera: object, seconds: number) {
  const { context, page, t0 } = await open(true)
  const start = (Date.now() - t0) / 1000
  await page.evaluate(
    ({ stage, index, camera, no }) => {
      const g = (globalThis as unknown as { timber: Timber }).timber
      g.stage(stage)
      g.auto.camera = camera
      const first = g.world.trees.at(index)!
      const input = { ...no, saw: true }
      g.auto.input = input
      const id = setInterval(() => {
        if (first.state !== "standing") {
          input.saw = false
          clearInterval(id)
        }
      }, 50)
    },
    { stage, index, camera, no: NO },
  )
  await page.waitForTimeout(seconds * 1000)
  const state = await page.evaluate(() => {
    const g = (globalThis as unknown as { timber: Timber }).timber
    return { trees: g.world.trees.slice(-3).map((t) => t.state), jacks: g.world.jacks.map((j) => (j.alive ? (j.downed ? "down" : "alive") : j.cause)) }
  })
  console.log(`${name}: start ${start.toFixed(2)} s, ${JSON.stringify(state)}`)
  await context.close()
  const path = await page.video()?.path()
  if (path) renameSync(path, resolve(out, `${name}.webm`))
  await Bun.write(resolve(out, `${name}-start.txt`), start.toFixed(2))
}

await fellClip("fell", "fell", -3, { x: 8, y: 11, dist: 22, pitch: 0.6 }, 8)
await fellClip("domino", "domino", -3, { x: -2.5, y: 5, dist: 30, pitch: 0.95 }, 10)

// Saw stills.
{
  const { context, page } = await open(false)
  await page.evaluate((no) => {
    const g = (globalThis as unknown as { timber: Timber }).timber
    g.stage("saw")
    g.auto.camera = { x: 0, y: 12.3, dist: 7.5, pitch: 0.72 }
    g.auto.input = { ...no, mx: 0.15, saw: true }
  }, NO)
  let at = 0
  for (const ms of [500, 900, 1700]) {
    await page.waitForTimeout(ms - at)
    at = ms
    await page.screenshot({ path: resolve(out, `saw-${ms}.png`) })
  }
  await context.close()
}

// The default view in an ordinary hunt, as a survivor at night.
{
  const { context, page } = await open(false)
  await page.evaluate(() => (globalThis as unknown as { timber: Timber }).timber.stage("hunt"))
  await page.waitForTimeout(6_000)
  await page.screenshot({ path: resolve(out, "hunt.png") })
  await context.close()
}

await browser.close()
server.stop()
if (errors.length) console.log(`errors:\n${errors.slice(0, 20).join("\n")}`)
