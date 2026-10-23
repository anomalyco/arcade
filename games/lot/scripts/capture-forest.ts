import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serveDist } from "./serve-dist"

await using budget = browserBudget()
const { chromium } = budget

// Forest/ground-dressing proof at the title camera, headless and muted, through HiveMind browser admission:
//   bun scripts/capture-forest.ts [--base <dist of origin/main's lot>]
// Stills of main (when --base is given), the branch's Today presets and the new look; paired whole-frame GPU timings
// (renderer.measure, alternating configurations) and CPU build/rebuild times.
const out = resolve(process.env.LOT_CAPTURE_DIR ?? "captures/forest")
await mkdir(out, { recursive: true })
const baseAt = process.argv.indexOf("--base")
const branchServer = serveDist(resolve(import.meta.dir, "../dist")), mainServer = baseAt > 0 ? serveDist(resolve(process.argv[baseAt + 1]!)) : null
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("Headless Chromium missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--enable-webgpu-developer-features"] })
const report: Record<string, unknown> = { viewport: [1920, 1080], captured: new Date().toISOString() }
type Lot = { ready: boolean; frames: number; paused: boolean; forest?: Record<string, unknown>; dressing?: Record<string, unknown>; timings?: unknown; dressingCount?: number;
  forestStats?: () => unknown; renderer: { passContext: { device: GPUDevice }; render(f: unknown): void; measure(f: unknown): Promise<number> } }
const CONFIGS = {
  today: { forest: { look: "today", lod0: 65, lod1: 107.5, fade: 0, far: 1000, thinStart: 140, thinEnd: 320, thinFraction: 0, crown: 1, inner: 0, face: 0, species: 0 }, dressing: { look: "today", weeds: 0, leaves: 0, gravel: 0, litter: 0 } },
  forest: { forest: { look: "massed", lod0: 34, lod1: 110, fade: 5, far: 1000, thinStart: 140, thinEnd: 320, thinFraction: 0.5, crown: 1.15, inner: 1, face: 0.45, species: 1 }, dressing: { look: "today", weeds: 0, leaves: 0, gravel: 0, litter: 0 } },
  after: { forest: { look: "massed", lod0: 34, lod1: 110, fade: 5, far: 1000, thinStart: 140, thinEnd: 320, thinFraction: 0.5, crown: 1.15, inner: 1, face: 0.45, species: 1 }, dressing: { look: "dressed", weeds: 1, leaves: 1, gravel: 1, litter: 1 } },
} as const

async function open(url: string, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.stack ?? e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(`${m.text()} (${m.location().url})`) })
  page.on("response", r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`) })
  const t0 = Date.now()
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.waitForFunction(() => { const w = window as unknown as { lot?: Lot }; return w.lot?.ready && w.lot.frames > 48 }, undefined, { timeout: 150_000 })
  const loadMs = Date.now() - t0
  await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
  return { page, context, loadMs }
}
const frames = (page: Page, n: number) => page.evaluate(async n => {
  const lot = (window as unknown as { lot: Lot }).lot, start = lot.frames
  while (lot.frames < start + n) await new Promise(r => requestAnimationFrame(r))
}, n)
async function still(page: Page, name: string) {
  await page.evaluate(async () => { const lot = (window as unknown as { lot: Lot }).lot; lot.paused = true; await lot.renderer.passContext.device.queue.onSubmittedWorkDone(); await new Promise(r => requestAnimationFrame(r)) })
  await page.screenshot({ path: resolve(out, `${name}.png`), timeout: 60_000 })
  await page.evaluate(() => { (window as unknown as { lot: Lot }).lot.paused = false })
}
const apply = (page: Page, config: keyof typeof CONFIGS) => page.evaluate(c => {
  const lot = (window as unknown as { lot: Lot }).lot
  Object.assign(lot.forest!, c.forest); Object.assign(lot.dressing!, c.dressing)
}, CONFIGS[config])
// Whole-frame GPU interval, several samples per configuration, configurations alternated to pair out drift.
async function gpu(page: Page, configs: (keyof typeof CONFIGS | null)[], rounds = 6, samples = 8) {
  const times: Record<string, number[]> = {}
  // Keep the last frame input so the same frame can be re-drawn under timestamp queries (works on main's build too).
  await page.evaluate(() => {
    const w = window as unknown as { lot: Lot; lastFrame?: unknown }, r = w.lot.renderer, render = r.render.bind(r)
    r.render = f => { w.lastFrame = f; render(f) }
  })
  await frames(page, 2)
  for (let r = 0; r < rounds; r++) for (const c of configs) {
    if (c) { await apply(page, c); await frames(page, 20) }
    const key = c ?? "main"
    const t = await page.evaluate(async n => {
      const lot = (window as unknown as { lot: Lot }).lot, ms: number[] = []
      lot.paused = true
      const f = (window as unknown as { lastFrame: unknown }).lastFrame
      for (let i = 0; i < n; i++) ms.push(await lot.renderer.measure(f))
      lot.paused = false
      return ms
    }, samples)
    ;(times[key] ??= []).push(...t)
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!
  return Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { medianMs: median(v), n: v.length, minMs: Math.min(...v), maxMs: Math.max(...v) }]))
}

try {
  if (mainServer) {
    const errors: string[] = []
    const { page, context, loadMs } = await open(new URL("/arcade/lot/", mainServer.url).href, errors)
    await still(page, "main")
    report.main = { loadMs, timings: await page.evaluate(() => (window as unknown as { lot: Lot }).lot.timings ?? null), gpu: await gpu(page, [null]), errors }
    await context.close()
  }
  const errors: string[] = []
  const { page, context, loadMs } = await open(new URL("/arcade/lot/", branchServer.url).href, errors)
  const branch: Record<string, unknown> = { loadMs, timings: await page.evaluate(() => (window as unknown as { lot: Lot }).lot.timings), errors }
  for (const config of ["today", "forest", "after"] as const) {
    await apply(page, config)
    await frames(page, 40)
    await still(page, config)
    branch[config] = await page.evaluate(() => { const lot = (window as unknown as { lot: Lot }).lot; return { forest: lot.forestStats!(), dressing: lot.dressingCount } })
  }
  branch.gpu = await gpu(page, ["today", "after"])
  report.branch = branch
  await context.close()
  if (errors.length) throw new Error(errors.join("\n"))
  console.log("Verified", out)
} catch (error) {
  report.failure = String(error)
  throw error
} finally {
  await Bun.write(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
  await browser.close()
  branchServer.stop(true); mainServer?.stop(true)
}
