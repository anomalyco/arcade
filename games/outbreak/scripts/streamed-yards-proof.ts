/**
 * Day and night frames of streamed lots beside the authored origin lots, to judge whether streamed blocks are dressed
 * like Ash and Elm (foundation shrubs, framing trees, porch, lawn and verge tufts, gravel driveway).
 *
 *   bun scripts/streamed-yards-proof.ts [--skip-build] [--viewport 1600x1000] [--out captures/streamed-yards]
 *
 * Picks the first few streamed L-plan bungalows and rectangular houses east of the origin block, frames each lot from
 * the street, and writes the frames plus `report.json` (vertices and level chunks drawn per frame). Headless Metal
 * Chromium, muted, no visible window: run it through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { generateWorldChunk } from "../shared/world"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(game, "../..", arg("out", "captures/streamed-yards")!)
const [vw, vh] = arg("viewport", "1600x1000")!.split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome, "Install Chromium first")

const lots: { name: string; x: number; y: number }[] = [{ name: "origin-ash", x: 29.5, y: 39 }]
let lPlans = 0, rects = 0
for (let cx = 3; cx < 14 && (lPlans < 2 || rects < 1); cx++) {
  for (const cy of [0, 2]) {
    const b = generateWorldChunk(7, 7, cx, cy, "streaming").buildings[0]
    if (!b || !["house", "ranch", "cottage", "cabin"].includes(b.archetype ?? "")) continue
    const lPlan = b.kind === "house"
    if (lPlan ? lPlans >= 2 : rects >= 1) continue
    lots.push({ name: `${lPlan ? "lplan" : "rect"}-${b.archetype}-${cx}-${cy}`, x: b.rect[0] + 6.5, y: b.rect[3] + 3.5 })
    if (lPlan) lPlans++
    else rects++
  }
}
const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud"
const report: Record<string, unknown> = { viewport: [vw, vh], lots: {} as Record<string, unknown> }
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
  for (const lot of lots) {
    for (const hour of [13, 22]) {
      const s = await page.evaluate(async a => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", a.hour)
        h.pose(a.lot.x, a.lot.y, -Math.PI / 2)
        const t0 = performance.now()
        for (let i = 0; performance.now() - t0 < 10000; i++) {
          h.session().ai.agents.length = 0
          await h.step()
          if (i > 40 && h.state().world.pendingBakes === 0) break
          await new Promise(r => setTimeout(r, 10))
        }
        const st = h.state()
        return { streamed: st.world.isStreamWindow, vertices: Math.round(st.vertices), ...h.levelDraw() }
      }, { lot, hour })
      await page.locator("#game").screenshot({ path: resolve(out, `${lot.name}-${hour}h.png`) })
      ;(report.lots as Record<string, unknown>)[`${lot.name}-${hour}h`] = { ...lot, ...s }
      console.log(lot.name, hour, JSON.stringify(s))
    }
  }
  report.errors = errors
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
