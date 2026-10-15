// Muted aiming-sweep clip from the game camera: the survivor turns a full circle on the street, then sweeps through
// the hallway doorways, one canvas frame per step. Frames land in captures/outbreak-noir/<SWEEP_PHASE>/sweep/.
//   SWEEP_PHASE=beam-after SWEEP_LAB='{"beamQuality":0}' bun scripts/beam-sweep.ts && ffmpeg -framerate 30 -i …
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const phase = process.env.SWEEP_PHASE ?? "beam-after"
const lab: Record<string, number> = JSON.parse(process.env.SWEEP_LAB ?? "{}")
const out = resolve(process.env.SWEEP_OUT ?? resolve(game, "../../captures/outbreak-noir"), phase, "sweep")
mkdirSync(out, { recursive: true })
if (process.env.SWEEP_SKIP_BUILD !== "1") assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body > *:not(#game)")) el.style.visibility = "hidden"
  })
  const legs = [
    { x: 27, y: 44, from: 0, to: Math.PI * 2, frames: 150, hour: 22, zoom: 42, open: false },
    { x: 27.7, y: 31, from: Math.PI * 1.15, to: -Math.PI * 0.15, frames: 90, hour: 22, zoom: 34, open: true },
  ]
  let frame = 0
  for (const leg of legs) {
    await page.evaluate(async ({ leg, lab }) => {
      const h = (window as any).__arcadeHarness
      h.reset(7); h.setLab("timeScale", 0); h.setLab("hour", leg.hour); h.setLab("zoom", leg.zoom)
      for (const [k, v] of Object.entries(lab)) h.setLab(k, v)
      h.pose(leg.x, leg.y, leg.from)
      if (leg.open) await h.step(1 / 60, { interact: true })
      for (let i = 0; i < 20; i++) await h.step()
    }, { leg, lab })
    for (let i = 0; i < leg.frames; i++) {
      const aim = leg.from + ((leg.to - leg.from) * i) / (leg.frames - 1)
      await page.evaluate(async (aim) => {
        const h = (window as any).__arcadeHarness
        await h.step(1 / 30, { aim })
      }, aim)
      await page.locator("#game").screenshot({ path: resolve(out, `${String(frame++).padStart(4, "0")}.png`) })
    }
  }
  assert.deepEqual(errors, [])
  console.log(`wrote ${frame} frames to ${out}`)
} finally { await browser.close(); fixture.stop(true) }
