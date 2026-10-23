/**
 * Before/after stills and paired GPU cost of finished props (Backquote › Rugs & interiors › Finished props): Ash's
 * fitted kitchen with `propFinish` 0 (Today) and 1 from the same frozen frame, at noon and by torch at 19:00, plus the
 * albedo validator view; then alternates 0/1 with the renderer's timestamp queries (3456×1894).
 *
 *   bun scripts/finish-stills.ts --out <dir> [--shots name,name|none] [--rounds n]   (via hivemind run --kind browser)
 *
 * `--rounds 0` skips the GPU pairs; split stills and pairs into two runs to keep each under the browser budget.
 *
 * Headless Metal Chromium, muted, no visible window.
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
const out = resolve(arg("out", resolve(root, "../../captures/finish"))!)
const rounds = Number(arg("rounds", "8"))
const only = arg("shots")
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "finish-stills-hooks",
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

type Shot = { name: string; hour: number; zoom: number; x: number; y: number; aim: number; finish: 0 | 1; check?: boolean; flashlight: boolean }
const KITCHEN = { x: 33.2, y: 32.6, aim: -Math.PI / 2 }
const shots: Shot[] = [
  { name: "kitchen-13h-z14-today", hour: 13, zoom: 14, ...KITCHEN, finish: 0, flashlight: false },
  { name: "kitchen-13h-z14-finished", hour: 13, zoom: 14, ...KITCHEN, finish: 1, flashlight: false },
  { name: "kitchen-19h-z18-today", hour: 19, zoom: 18, ...KITCHEN, finish: 0, flashlight: true },
  { name: "kitchen-19h-z18-finished", hour: 19, zoom: 18, ...KITCHEN, finish: 1, flashlight: true },
  { name: "kitchen-13h-z14-albedo-check", hour: 13, zoom: 14, ...KITCHEN, finish: 1, check: true, flashlight: false },
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/** Same frozen frame for stills and timing: pose, hour, zoom and finish (a level rebuild), then wait for the rugs. */
async function setup(page: Page, s: Omit<Shot, "name">, settle = 120) {
  return page.evaluate(async ({ s, settle }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("propFinish", s.finish)
    h.setLab("albedoCheck", s.check ? 1 : 0)
    h.pose(s.x, s.y, s.aim)
    const p = h.state().player
    p.flashlightOn = s.flashlight
    p.flashlightOutput = s.flashlight ? 1 : 0
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    // Long enough for the camera to settle after the level rebuild, so both variants frame the same.
    for (let i = 0; i < settle; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    const rugs = h.interiors?.()
    return { settled: rugs?.settled, resident: rugs?.resident, ms: Math.round(performance.now() - t0) }
  }, { s, settle })
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
    if (only && !only.split(",").includes(shot.name)) continue
    const state = await setup(page, shot)
    await page.screenshot({ path: resolve(out, `${shot.name}.png`) })
    ;(meta.shots as Record<string, unknown>)[shot.name] = { ...shot, state }
    console.log(shot.name, JSON.stringify(state))
  }

  // Paired GPU cost at the bench resolution on the kitchen at night: alternate 0/1, second-fastest of 16 frames each.
  await page.close()
  if (rounds > 0) {
    const gpuPage = await open(1728, 947, 2)
    meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
    const a: number[] = [], b: number[] = []
    for (let r = 0; r < rounds; r++) {
      for (const finish of r % 2 ? [1, 0] as const : [0, 1] as const) {
        // Timing needs the same pose and settled rugs, not a settled camera: a short settle keeps the pairs in budget.
      const st = await setup(gpuPage, { hour: 19, zoom: 18, ...KITCHEN, finish, flashlight: true }, 20)
        const ms = await gpuPage.evaluate(async () => {
          const h = (window as any).__arcadeHarness
          const v: number[] = []
          // A frame right after the rebuild can return a bogus interval: skip any the timer rejects.
          for (let i = 0; i < 24 && v.length < 18; i++) { try { v.push(await h.renderer.measure(h.render)) } catch {} }
          return v.slice(2).sort((x: number, y: number) => x - y)[1] ?? NaN
        })
        ;(finish ? b : a).push(ms)
      console.log(`round ${r} finish=${finish} ${ms.toFixed(3)} ms (setup ${JSON.stringify(st)})`)
      writeFileSync(resolve(out, "gpu.json"), JSON.stringify({ partial: true, raw: { a, b } }, null, 2))
      }
    }
    const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
    const diffs = a.map((x, i) => b[i]! - x)
    meta.gpu = { scene: "Ash kitchen 19:00 zoom 18, torch", today: med(a), finished: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
    console.log(`GPU today=${med(a).toFixed(3)} ms finished=${med(b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms`)
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, rounds > 0 && only === "none" ? "gpu.json" : "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
