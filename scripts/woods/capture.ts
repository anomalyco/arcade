/**
 * Headless, muted stills of the woods look station at the concept viewpoints, with the renderer's stats and GPU time.
 * Run through HiveMind browser admission:
 *
 *   hivemind run --kind browser --fetch captures/woods -- bun scripts/woods/capture.ts [--views trail,hollow,camp]
 *     [--set key=value,...] [--size 1920x1080] [--frames 90] [--measure] [--tag name]
 *
 * It starts the Lab's Vite dev server on a free port, so nothing is built first.
 */
import { chromium } from "playwright-core"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const root = resolve(import.meta.dir, "../..")
const tag = arg("tag", "current")
const out = resolve(root, "captures/woods", tag)
await mkdir(out, { recursive: true })
const views = arg("views", "trail,hollow,camp").split(",")
const [width, height] = arg("size", "1920x1080").split("x").map(Number) as [number, number]
const frames = Number(arg("frames", "90"))
const sets = arg("set", "").split(",").filter(Boolean).map(p => p.split("=") as [string, string])
const query = arg("query", "")

const port = 5300 + Math.floor(Math.random() * 400)
const server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: resolve(root, "games/lab"), stdout: "pipe", stderr: "pipe" })
const base = `http://127.0.0.1:${port}`
for (let i = 0; ; i++) {
  try { if ((await fetch(base + "/woods.html")).ok) break } catch {}
  if (i > 200) throw new Error("vite did not start")
  await Bun.sleep(150)
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("headless Chromium missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--enable-features=WebGPUExperimentalFeatures"] })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
const report: Record<string, unknown> = { size: [width, height], frames, sets, captured: new Date().toISOString(), host: (await Bun.$`hostname`.text()).trim() }
const errors: string[] = []
report.errors = errors
type Woods = { ready: boolean; frames: number; paused: boolean; step(ms: number): void; setView(v: string): void; settings: Record<string, unknown>; stats(): unknown; measure(n?: number): Promise<{ median: number } | null>; view: { debug: Record<string, unknown>; renderer: { passContext: { device: GPUDevice } } } }
try {
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.stack ?? e.message))
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`) })
  page.on("response", r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`) })
  const results: Record<string, unknown> = {}
  for (const view of views) {
    const t0 = Date.now()
    await page.goto(`${base}/woods.html?view=${view}&time=20${query.includes("quality=") ? "" : "&quality=high"}${query ? "&" + query : ""}`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await page.waitForFunction(() => { const w = (window as unknown as { woods?: Woods }).woods; return w?.ready && w.frames > 4 }, undefined, { timeout: 240_000 }).catch(async e => {
      errors.push(`timeout: ${await page.evaluate(() => document.getElementById("hud")?.textContent ?? "")}`)
      throw e
    })
    const loadMs = Date.now() - t0
    await page.addStyleTag({ content: "#hud,[data-lab-panel]{display:none!important}" })
    const info = await page.evaluate(async ({ sets, frames }) => {
      const w = (window as unknown as { woods: Woods }).woods
      w.paused = true
      for (const [k, v] of sets) w.settings[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v
      for (let i = 0; i < frames; i++) w.step(1000 / 60)
      await w.view.renderer.passContext.device.queue.onSubmittedWorkDone()
      return w.stats()
    }, { sets, frames })
    await page.screenshot({ path: resolve(out, `${view}.png`), timeout: 60_000 })
    const gpu = process.argv.includes("--measure") ? await page.evaluate(() => (window as unknown as { woods: Woods }).woods.measure(16)) : null
    // --costs "a=1;b=off,c=2": GPU time with each group of settings applied in turn (then restored).
    const costs: Record<string, number | null> = {}
    for (const group of arg("costs", "").split(";").filter(Boolean)) {
      const pairs = group.split(",").map(p => p.split("=") as [string, string])
      costs[group] = await page.evaluate(async ({ pairs, frames }) => {
        const w = (window as unknown as { woods: Woods }).woods
        const target = (k: string) => k.startsWith("debug.") ? [w.view.debug, k.slice(6)] as const : [w.settings, k] as const
        const old = pairs.map(([k]) => { const [o, f] = target(k); return [k, o[f]] as const })
        for (const [k, v] of pairs) { const [o, f] = target(k); o[f] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v }
        for (let i = 0; i < 3; i++) w.step(1000 / 60)
        const r = await w.measure(12)
        for (const [k, v] of old) { const [o, f] = target(k); o[f] = v }
        for (let i = 0; i < 3; i++) w.step(1000 / 60)
        return r?.median ?? null
      }, { pairs, frames })
    }
    results[view] = { loadMs, stats: info, gpuMs: gpu?.median ?? null, costs }
    console.log(view, JSON.stringify(results[view]))
  }
  report.views = results
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  server.kill()
}
if (errors.length) console.log("ERRORS:\n" + errors.slice(0, 40).join("\n"))
console.log(`wrote ${out}`)
