/**
 * Headless, muted proof captures of the production bundle (run `vite build` first), from the fixed scenes in
 * `window.timber.stage`. Writes into `$LEASE_OUT` (HiveMind) or `--out`.
 *
 *   hivemind run --kind browser --fetch -- bun scripts/proof.ts
 *
 * fell.webm: one big tree felled up close in the low chase view; the felling cam swings out side-on as it goes over.
 * chase.webm: you, the lumberjack, run a survivor down a lane and drop a half-cut tree after them.
 * still.png: the saw in the cut, at night, lit by its own work light. `--stills` takes only look stills (fast).
 */
import { mkdirSync, renameSync } from "node:fs"
import { resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const { values: o } = parseArgs({ options: { out: { type: "string", default: process.env.LEASE_OUT ?? "captures/proof" }, stills: { type: "boolean", default: false } } })
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
  world: { t: number; trees: { x: number; y: number; state: string }[]; jacks: { x: number; y: number; alive: boolean; downed: boolean; cause: string | null }[]; events: unknown[] }
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
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?seed=3&quality=high`, { waitUntil: "load" })
  await page.waitForFunction(() => ((globalThis as unknown as { timber?: Timber }).timber?.frames ?? 0) > 10, null, { timeout: 60_000, polling: 100 })
  return { context, page, t0 }
}

/** Film `stage` for `seconds`, driven by `drive` (run in the page, every 30 ms). */
async function clip(name: string, stage: string, seconds: number, drive: string) {
  const { context, page, t0 } = await open(true)
  const start = (Date.now() - t0) / 1000
  await page.evaluate(
    ({ stage, no, drive }) => {
      const g = (globalThis as unknown as { timber: Timber }).timber
      g.stage(stage)
      g.auto.camera = null
      const input = { ...no }
      g.auto.input = input
      const step = new Function("g", "input", drive) as (g: Timber, input: typeof no) => void
      setInterval(() => step(g, input), 30)
    },
    { stage, no: NO, drive },
  )
  await page.waitForTimeout(seconds * 1000)
  const state = await page.evaluate(() => {
    const g = (globalThis as unknown as { timber: Timber }).timber
    return { trees: g.world.trees.slice(-4).map((t) => t.state), jacks: g.world.jacks.map((j) => (j.alive ? (j.downed ? "down" : "alive") : j.cause)) }
  })
  console.log(`${name}: start ${start.toFixed(2)} s, ${JSON.stringify(state)}`)
  await context.close()
  const path = await page.video()?.path()
  if (path) renameSync(path, resolve(out, `${name}.webm`))
  await Bun.write(resolve(out, `${name}-start.txt`), start.toFixed(2))
}

/** A still at each of `at` (ms after staging) of `stage`, driven by `drive` (run in the page, every 30 ms). */
async function stills(name: string, stage: string, at: number[], camera: object | null, drive: string) {
  const { context, page } = await open(false)
  await page.evaluate(
    ({ stage, camera, no, drive }) => {
      const g = (globalThis as unknown as { timber: Timber }).timber
      g.stage(stage)
      g.auto.camera = camera
      const input = { ...no }
      g.auto.input = input
      const step = new Function("g", "input", drive) as (g: Timber, input: typeof no) => void
      setInterval(() => step(g, input), 30)
    },
    { stage, camera, no: NO, drive },
  )
  let t = 0
  for (const ms of at) {
    await page.waitForTimeout(ms - t)
    t = ms
    await page.screenshot({ path: resolve(out, `${name}-${ms}.png`) })
  }
  await context.close()
}

// Saw the last-but-two tree (the staged one) until it goes, then stop.
const FELL = `const t = g.world.trees.at(-3); input.saw = t.state === "standing"`
// Run at the lane tree, saw it over after the survivor, then chase them down the lane.
const CHASE = `
  const me = g.world.jacks[0], s = g.world.jacks[1], t = g.world.trees.at(-4)
  const go = (x, y) => { const d = Math.hypot(x - me.x, y - me.y) || 1; input.mx = (x - me.x) / d; input.my = (y - me.y) / d; input.aim = Math.atan2(y - me.y, x - me.x) }
  if (t.state === "standing") {
    const d = Math.hypot(t.x - 0.75 - me.x, t.y - me.y)
    if (d > 0.15) { go(t.x - 0.75, t.y); input.saw = d < 3 }
    else { input.mx = input.my = 0; input.aim = 0; input.saw = true }
  } else { go(s.x, s.y); input.saw = Math.hypot(s.x - me.x, s.y - me.y) < 4 }
`

if (o.stills) {
  await stills("fell", "fell", [1200, 2600, 4200, 6000], null, FELL)
  await stills("chase", "chase", [1500, 3500, 5500], null, CHASE)
  {
    const { context, page } = await open(false)
    await page.evaluate(() => (globalThis as unknown as { timber: Timber }).timber.stage("hunt"))
    await page.waitForTimeout(6_000)
    await page.screenshot({ path: resolve(out, "hunt.png") })
    await context.close()
  }
} else {
  await clip("fell", "fell", 10, FELL)
  await clip("chase", "chase", 12, CHASE)
  await stills("still", "fell", [1800], null, FELL)
}

await browser.close()
server.stop()
if (errors.length) console.log(`errors:\n${errors.slice(0, 20).join("\n")}`)
