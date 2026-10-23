/**
 * Stills and paired GPU cost of the prop library in the start house (Backquote › Props), one headless run:
 *
 *   bun scripts/props-stills.ts --out <dir>      (via hivemind run --kind browser)
 *
 * Captures Ash's entry hall from above at 19:00 (the RE-house study frame) with props off and on, the same at 21:00
 * zoomed out, and the living room and kitchen lit at noon; then alternates off/on on the same frozen frame timing each
 * with the renderer's timestamp queries (3456×1894). Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/props"))!)
const rounds = Number(arg("rounds", "10"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "props-stills-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render })")
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Shot = { name: string; hour: number; zoom: number; x: number; y: number; aim: number; props: boolean; flashlight: boolean }
const HALL = { x: 27.7, y: 34.3, aim: -Math.PI / 2 }
const LIVING = { x: 25.2, y: 32.6, aim: -Math.PI / 2 }
const KITCHEN = { x: 33.2, y: 32.6, aim: -Math.PI / 2 }
const shots: Shot[] = [
  { name: "hall-19h-z26-off", hour: 19, zoom: 26, ...HALL, props: false, flashlight: true },
  { name: "hall-19h-z26-on", hour: 19, zoom: 26, ...HALL, props: true, flashlight: true },
  { name: "hall-21h-z32-off", hour: 21, zoom: 32, ...HALL, props: false, flashlight: true },
  { name: "hall-21h-z32-on", hour: 21, zoom: 32, ...HALL, props: true, flashlight: true },
  { name: "living-13h-z18-off", hour: 13, zoom: 18, ...LIVING, props: false, flashlight: false },
  { name: "living-13h-z18-on", hour: 13, zoom: 18, ...LIVING, props: true, flashlight: false },
  { name: "kitchen-13h-z18-on", hour: 13, zoom: 18, ...KITCHEN, props: true, flashlight: false },
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/** Same frozen frame for stills and timing: pose, hour, zoom, props on/off, then wait until the library has loaded. */
async function setup(page: Page, s: Omit<Shot, "name">) {
  return page.evaluate(async s => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("propsOn", s.props)
    h.pose(s.x, s.y, s.aim)
    const p = h.state().player
    p.flashlightOn = s.flashlight
    p.flashlightOutput = s.flashlight ? 1 : 0
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((!s.props || props?.ready) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    for (let i = 0; i < 20; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    return h.state().props
  }, s)
}

async function open(width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  return page
}

try {
  const page = await open(1536, 1024, 1)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  for (const shot of shots) {
    const props = await setup(page, shot)
    await page.screenshot({ path: resolve(out, `${shot.name}.png`) })
    ;(meta.shots as Record<string, unknown>)[shot.name] = { ...shot, props }
    console.log(shot.name, JSON.stringify(props?.lastFrame ?? null))
  }

  // Paired GPU cost at the bench resolution, interior frame: alternate off/on, second-fastest of 16 timed frames each.
  await page.close()
  const gpuPage = await open(1728, 947, 2)
  meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
  const a: number[] = [], b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const on of r % 2 ? [true, false] : [false, true]) {
      await setup(gpuPage, { hour: 19, zoom: 34, x: 27.7, y: 31, aim: -Math.PI / 2, props: on, flashlight: true })
      const ms = await gpuPage.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const v: number[] = []
        // GPU clocks swing between two states (3.7 vs 7–11 ms on the Studio); the second-fastest of 16 frames is
        // the steady-clock cost, so pairs compare like with like.
        for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
        return v.slice(2).sort((x: number, y: number) => x - y)[1]!
      })
      ;(on ? b : a).push(ms)
    }
  }
  const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
  const diffs = a.map((x, i) => b[i]! - x)
  meta.gpu = { scene: "interior 19:00 zoom 34 (bench pose)", off: med(a), on: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
  console.log(`GPU off=${med(a).toFixed(3)} ms on=${med(b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms`)
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
