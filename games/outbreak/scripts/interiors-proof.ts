/**
 * Aligned interior captures for rugs and themed interiors, plus rug-pool readiness, memory and GPU timing.
 *
 *   bun scripts/interiors-proof.ts [--phase after] [--dist dist/arcade/outbreak] [--skip-build]
 *
 * Writes `captures/interiors/<phase>/<scene>.png` (canvas only, HUD hidden) and `report.json`. A `before` phase
 * can point `--dist` at a build of origin/main: the same poses are used and rug stats are skipped.
 * Headless Metal Chromium, muted, no visible window. Run through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { generateWorldChunk } from "../shared/world"
import { planInterior } from "../src/interiors/plan"

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const phase = arg("phase", "after")!
const out = resolve(game, "../../captures/interiors", phase)
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, arg("dist", "dist/arcade/outbreak")!)
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })

// A procedural house of each theme near the origin block, found with the same deterministic plan the game uses.
const procedural: { name: string; x: number; y: number }[] = []
const seen = new Set<string>()
for (let r = 3; r < 9 && procedural.length < 3; r++) for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) {
  if (Math.max(Math.abs(cx), Math.abs(cy)) !== r) continue
  for (const b of generateWorldChunk(7, 7, cx, cy, "streaming").buildings) {
    const plan = planInterior(b, 7)
    if (b.kind !== "house" || plan.theme === "plain" || seen.has(plan.theme) || procedural.length >= 3) continue
    seen.add(plan.theme)
    procedural.push({ name: `proc-${plan.theme}`, x: b.rect[0] + 3.4, y: b.rect[3] - 2.6 })
  }
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { phase, scenes: {} as Record<string, unknown> }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)
  report.adapter = adapter
  const scenes = [
    { name: "ash-living", x: 25.6, y: 32.4, aim: -Math.PI / 2, hour: 19, zoom: 26 },
    { name: "ash-hall", x: 27.6, y: 31.2, aim: -Math.PI / 2, hour: 20, zoom: 30 },
    { name: "elm-living", x: 24.6, y: 62.4, aim: -Math.PI / 2, hour: 19, zoom: 26 },
    { name: "elm-night-flashlight", x: 25.4, y: 61.6, aim: -2.4, hour: 23.5, zoom: 26, flashlight: true },
    { name: "elm-day", x: 24.6, y: 62.4, aim: -Math.PI / 2, hour: 13, zoom: 26 },
    ...procedural.map(p => ({ ...p, aim: -Math.PI / 2, hour: 19, zoom: 28 })),
  ]
  for (const scene of scenes) {
    const stats = await page.evaluate(async s => {
      const h = (window as any).__arcadeHarness
      h.reset(7); h.setLab("timeScale", 0); h.setLab("hour", s.hour); h.setLab("zoom", s.zoom)
      h.pose(s.x, s.y, s.aim)
      for (let i = 0; i < 6; i++) await h.step()
      const t0 = performance.now()
      // Let the streamed window load and the rug pool bake the rooms around the survivor.
      while (performance.now() - t0 < 12000) {
        await h.step(1 / 60, s.flashlight ? { flashlight: true } : undefined)
        if (!h.interiors) { if (performance.now() - t0 > 1500) break; continue }
        const st = h.interiors()
        if (st.settled && performance.now() - t0 > 600) break
        await new Promise(r => setTimeout(r, 30))
      }
      for (let i = 0; i < 6; i++) await h.step()
      const state = h.state()
      const p = state.player
      const windowSlot = (state.world?.windowBuildings ?? []).findIndex((b: { rect: number[] }) => p.x > b.rect[0] && p.x < b.rect[2] && p.y > b.rect[1] && p.y < b.rect[3])
      return { settleMs: Math.round(performance.now() - t0), interiors: h.interiors?.() ?? null, player: p, streamed: state.world?.isStreamWindow ?? false, windowSlot }
    }, scene)
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud")) el.style.visibility = "hidden"
    })
    await page.locator("#game").screenshot({ path: resolve(out, `${scene.name}.png`) })
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud")) el.style.visibility = ""
    })
    ;(report.scenes as Record<string, unknown>)[scene.name] = { ...scene, ...stats }
    console.log(scene.name, JSON.stringify({ streamed: stats.streamed, windowSlot: stats.windowSlot, settleMs: stats.settleMs, resident: stats.interiors?.resident, bakes: stats.interiors?.bakes, maxBakeMs: stats.interiors?.maxBakeMs, maxUploadMs: stats.interiors?.maxUploadMs }))
  }
  report.errors = errors
  if (errors.length) console.error(errors.slice(0, 10).join("\n"))
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
