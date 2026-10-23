// One bounded, headless Metal run: High/Ultra at 1600×900 CSS pixels, DPR 1 and 2.
// Build Barbara first. Timings include a paired repeat; the Retina stills use the same frozen view.
import { mkdirSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { resolve, sep } from "node:path"
import type { GameQuality } from "../packages/kit/client/quality"
import type { ForestQuality } from "../packages/kit/forest/settings"
import { browserBudget } from "./browser-budget"

if (!/aak2-2|Kits-Shiny-Computer/i.test(hostname())) throw new Error("Run this measurement on mini or pro through HiveMind")
const out = resolve("captures/barbara-ultra")
mkdirSync(out, { recursive: true })
const root = resolve("games/barbara/dist/arcade/barbara"), prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return await f.exists() ? new Response(f) : new Response("no", { status: 404 })
} })
type Api = {
  frames: number; paused: boolean; quality: GameQuality<ForestQuality>
  step(ms: number): void; setPose(x: number, z: number, yaw: number, pitch: number): void
  world: { camp: { x: number; z: number } }
  state: { t: number; players: { x: number; z: number }[]; brains: { mode: string; timer: number }[] }
  renderer: { device: GPUDevice }
  measure(n: number): Promise<{ median: number; samples: number[] } | null>
  stats(): unknown
}
declare const woods: Api
await using budget = browserBudget()
const browser = await budget.chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const results: unknown[] = [], errors: string[] = []
try {
  for (const dpr of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr })
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&shell`)
    await page.waitForFunction(() => (window as unknown as { woods?: Api }).woods?.frames! > 2, null, { timeout: 90000 })
    await page.evaluate(async () => {
      woods.paused = true
      const c = woods.world.camp, x = c.x + 8, z = c.z - 48
      woods.state.t = 100
      woods.setPose(x, z, 0.15, -0.12)
      for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999 }
      for (const p of woods.state.players.slice(1)) { p.x = x + 50; p.z = z + 50 }
      for (let i = 0; i < 90; i++) {
        woods.step(1000 / 60)
        await woods.renderer.device.queue.onSubmittedWorkDone()
      }
    })
    await page.addStyleTag({ content: ".arcade-shell, #goal, #story, #prompt, #toast { visibility: hidden !important }" })
    for (const [round, tier] of (["high", "ultra", "ultra", "high"] as const).entries()) {
      const sample = await page.evaluate(async tier => {
        woods.quality.setMode(tier, false)
        for (let i = 0; i < 24; i++) { woods.step(0); await woods.renderer.device.queue.onSubmittedWorkDone() }
        const frame: number[] = []
        for (let i = 0; i < 24; i++) {
          const t = performance.now()
          woods.step(0)
          await woods.renderer.device.queue.onSubmittedWorkDone()
          frame.push(performance.now() - t)
        }
        const gpu = await woods.measure(12)
        frame.sort((a, b) => a - b)
        const canvas = document.querySelector("canvas")!
        return { frameMedian: frame[12], frameP95: frame[22], frame, gpu, canvas: [canvas.width, canvas.height], quality: woods.quality.state(), stats: woods.stats() }
      }, tier)
      results.push({ dpr, tier, round, ...sample })
      console.log(JSON.stringify({ dpr, tier, round, frameMs: sample.frameMedian, gpuMs: sample.gpu?.median, canvas: sample.canvas }))
      if (dpr === 2 && round < 2) await page.locator("canvas").first().screenshot({ path: `${out}/${tier}.png` })
    }
    // Check the actual shared Settings DOM, including updates while the card stays open.
    await page.addStyleTag({ content: ".arcade-shell { visibility: visible !important }" })
    await page.locator('[data-act="settings"]').first().click()
    const modes = await page.locator('[data-act="quality"]').evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.mode))
    if (modes.join(",") !== "auto,ultra,high,balanced,low") throw new Error(`Unexpected quality choices: ${modes}`)
    await page.locator('[data-act="quality"][data-mode="auto"]').click()
    await page.evaluate(() => {
      const c = woods.quality.controller
      for (let i = 1; i < 60; i++) c.recordFrame(24, 0, i * 24)
    })
    await page.waitForFunction(() => document.querySelector('[data-note="quality"]')?.textContent?.startsWith("Auto: Balanced"))
    results.push({ dpr, settings: await page.locator('[data-note="quality"]').textContent(), modes })
    await page.close()
  }
} finally {
  writeFileSync(`${out}/timings.json`, JSON.stringify({ host: hostname(), results, errors }, null, 2))
  await browser.close()
  server.stop(true)
}
if (errors.length) throw new Error(errors.join("\n"))
