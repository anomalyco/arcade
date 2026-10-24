/**
 * Headless, muted proof captures of the production bundle (run `vite build` first), from the fixed scenes in
 * `window.timber.stage`. Writes into `$LEASE_OUT` (HiveMind) or `--out`.
 *
 *   hivemind run --kind browser --fetch -- bun scripts/proof.ts
 *
 * flee.webm: you, a survivor, run from him in the dark over the shoulder, torch on, glancing back as the saw closes in.
 * kill.webm: you, the lumberjack, in first person: saw a survivor down, finish him, then drop the tree beyond him (the
 * felling cam cuts out to the low shot).
 * still-*.png: a glance back at him during the flee. `--stills` takes only look stills of every scene (fast);
 * `--perf` measures whole-frame GPU ms per scene at both fern densities (no captures).
 */
import { mkdirSync, renameSync } from "node:fs"
import { resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const { values: o } = parseArgs({ options: { out: { type: "string", default: process.env.LEASE_OUT ?? "captures/proof" }, stills: { type: "boolean", default: false }, perf: { type: "boolean", default: false }, sweep: { type: "boolean", default: false }, vm: { type: "boolean", default: false } } })
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
  peopleReady(): Promise<void>
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
  await page.evaluate(() => (globalThis as unknown as { timber: Timber }).timber.peopleReady())
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
  await page.evaluate(() => (globalThis as unknown as { timber: Timber }).timber.peopleReady())
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

const GO = `const go = (x, y) => { const d = Math.hypot(x - me.x, y - me.y) || 1; input.mx = (x - me.x) / d; input.my = (y - me.y) / d; input.aim = Math.atan2(y - me.y, x - me.x) }`
// Down the lane and round the corner, sprinting while he's close, glancing back (the torch on him) when he's near.
const FLEE = `
  const me = g.world.jacks[0], lj = g.world.jacks[1], t = g.world.t
  ${GO}
  // He hears you the whole way (a staged chase, not a hunt), engine running.
  lj.brain.seenX = me.x; lj.brain.seenY = me.y; lj.brain.seenT = t; lj.brain.sneak = false
  if (me.downed || !me.alive) { input.mx = input.my = 0; input.sprint = false; return }
  if (me.x < 17) go(18, 4); else go(18, 24)
  const d = Math.hypot(lj.x - me.x, lj.y - me.y)
  input.sprint = d < 5 || (input.sprint && d < 8)
  if (d < 7 && t % 4.5 > 3.1) input.aim = Math.atan2(lj.y - me.y, lj.x - me.x)
`
// Saw the survivor down and keep the bar in him until he's done, then cut the tree from his side so it falls away.
const KILL = `
  const me = g.world.jacks[0], s = g.world.jacks[1], t = g.world.trees.at(-1)
  ${GO}
  if (s.alive) {
    const d = Math.hypot(s.x - me.x, s.y - me.y)
    if (d > 1.15) { go(s.x, s.y); input.saw = d < 2.5 } else { input.mx = input.my = 0; input.aim = Math.atan2(s.y - me.y, s.x - me.x); input.saw = true }
  } else if (t.state === "standing") {
    const d = Math.hypot(t.x - 0.75 - me.x, t.y - me.y)
    if (d > 0.15) { go(t.x - 0.75, t.y); input.saw = d < 1 } else { input.mx = input.my = 0; input.aim = 0; input.saw = true }
  } else { input.mx = input.my = 0; input.saw = false }
`

// Saw the survivor down and leave him: watch him crawl off past his dropped torch, then cut the tree beyond him (the
// chips). With side, a low camera off his shoulder once he's down.
const down = (side: boolean) => `
  const me = g.world.jacks[0], s = g.world.jacks[1], t = g.world.trees.at(-1)
  ${GO}
  if (s.alive && !s.downed) {
    const d = Math.hypot(s.x - me.x, s.y - me.y)
    if (d > 1.15) { go(s.x, s.y); input.saw = d < 2.5 } else { input.mx = input.my = 0; input.aim = Math.atan2(s.y - me.y, s.x - me.x); input.saw = true }
    return
  }
  g.downAt ??= g.world.t
  ${side ? "if (s.alive) g.auto.camera = { x: s.x, y: s.y, dist: 2.4, pitch: 0.42, yaw: 2.4, height: 0.3, fov: 50 }" : ""}
  if (g.world.t - g.downAt < 3.2) { input.mx = input.my = 0; input.saw = false; input.aim = Math.atan2(s.y - me.y, s.x - me.x); return }
  if (t.state === "standing") {
    const d = Math.hypot(t.x - 0.75 - me.x, t.y - me.y)
    if (d > 0.15) { go(t.x - 0.75, t.y); input.saw = d < 1 } else { input.mx = input.my = 0; input.aim = 0; input.saw = true }
  } else { input.mx = input.my = 0; input.saw = false }
`

/** Whole-frame GPU ms per scene at each fern density: `--perf` (no captures). */
async function perf() {
  const { context, page } = await open(false)
  const rows: string[] = []
  for (const stage of ["saw", "chase", "hunt"]) {
    for (const ferns of [1, 0.5]) {
      const ms = await page.evaluate(
        async ({ stage, ferns, drive }) => {
          const g = (globalThis as unknown as { timber: Timber & { view: { forest: { settings: { fernDensity: number } } }; measure(n: number): Promise<{ median: number } | null> } }).timber
          g.view.forest.settings.fernDensity = ferns
          g.stage(stage)
          g.auto.camera = null
          const input = { mx: 0, my: 0, aim: 0, saw: false, dash: false, sprint: false, engine: false, torch: false, flare: false, use: false }
          g.auto.input = stage === "hunt" ? null : input
          const step = new Function("g", "input", drive) as (g: Timber, input: object) => void
          const id = setInterval(() => step(g, input), 30)
          await new Promise((r) => setTimeout(r, 4000))
          const m = await g.measure(30)
          clearInterval(id)
          return m?.median ?? -1
        },
        { stage, ferns, drive: stage === "saw" ? `input.saw = true` : stage === "chase" ? CHASE : `` },
      )
      rows.push(`${stage} ferns ${ferns}: ${ms.toFixed(1)} ms`)
      console.log(rows.at(-1))
    }
  }
  await Bun.write(resolve(out, "perf.txt"), rows.join("\n") + "\n")
  await context.close()
}

/** `--sweep`: the chase lane's GPU ms with one cost switched off at a time, to find where the frame goes. */
async function sweep() {
  const { context, page } = await open(false)
  const cases: [string, string][] = [
    ["baseline", ``],
    ["no tree templates", `f.debug.tree = false`],
    ["no depth prepass", `f.debug.prepass = false`],
    ["tree detail to 20 m", `f.quality = { ...f.quality, near: 20 }`],
    ["tree detail to 12 m", `f.quality = { ...f.quality, near: 12 }`],
    ["tree detail off", `f.quality = { ...f.quality, near: 0 }`],
    ["trees 12 m, no prepass", `f.quality = { ...f.quality, near: 12 }; f.debug.prepass = false`],
    ["no ferns", `f.debug.fern = false`],
    ["no motion blur", `g.blur.enabled = false`],
    ["baseline again", ``],
  ]
  const rows: string[] = []
  for (const [label, poke] of cases) {
    const ms = await page.evaluate(
      async ({ poke, drive }) => {
        const g = (globalThis as unknown as { timber: Timber & { view: { forest: unknown }; blur: { enabled: boolean }; look: Record<string, number>; measure(n: number): Promise<{ median: number } | null> } }).timber
        const f = g.view.forest as { debug: Record<string, boolean>; settings: Record<string, unknown>; quality: Record<string, unknown> }
        const saved = { debug: { ...f.debug }, settings: { ...f.settings }, quality: f.quality, blur: g.blur.enabled, people: g.look.realPeople }
        new Function("g", "f", poke)(g, f)
        g.stage("chase")
        g.auto.camera = null
        const input = { mx: 0, my: 0, aim: 0, saw: false, dash: false, sprint: false, engine: false, torch: false, flare: false, use: false }
        g.auto.input = input
        const step = new Function("g", "input", drive) as (g: Timber, input: object) => void
        const id = setInterval(() => step(g, input), 30)
        await new Promise((r) => setTimeout(r, 3500))
        const m = await g.measure(30)
        clearInterval(id)
        Object.assign(f.debug, saved.debug)
        Object.assign(f.settings, saved.settings)
        f.quality = saved.quality
        g.blur.enabled = saved.blur
        g.look.realPeople = saved.people
        return m?.median ?? -1
      },
      { poke, drive: CHASE },
    )
    rows.push(`chase ${label}: ${ms.toFixed(1)} ms`)
    console.log(rows.at(-1))
  }
  await Bun.write(resolve(out, "sweep.txt"), rows.join("\n") + "\n")
  await context.close()
}

if (o.sweep) {
  await sweep()
} else if (o.perf) {
  await perf()
} else if (o.vm) {
  // The first-person saw, the downed crawl and the chips, fast.
  await stills("vm", "kill", [700, 2600, 4200, 6000, 8500, 10500], null, down(false))
  await stills("down", "kill", [3200, 4500, 5800], null, down(true))
} else if (o.stills) {
  await stills("flee", "flee", [1500, 3300, 6000, 7700, 10000], null, FLEE)
  await stills("kill", "kill", [800, 2000, 3500, 5500, 7500], null, KILL)
  await stills("fell", "fell", [1200, 2600, 4200, 6000], null, FELL)
  {
    const { context, page } = await open(false)
    await page.evaluate(() => (globalThis as unknown as { timber: Timber }).timber.stage("hunt"))
    await page.waitForTimeout(6_000)
    await page.screenshot({ path: resolve(out, "hunt.png") })
    await context.close()
  }
} else {
  await clip("flee", "flee", 13, FLEE)
  await clip("kill", "kill", 13, KILL)
  await clip("down", "kill", 13, down(false))
  await stills("still", "flee", [3300], null, FLEE)
  await stills("kill", "kill", [1600, 2400], null, KILL)
}

await browser.close()
server.stop()
if (errors.length) console.log(`errors:\n${errors.slice(0, 20).join("\n")}`)
