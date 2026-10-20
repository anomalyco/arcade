/**
 * Contact sheet of varied houses (AR-79): twelve styled homes of seed 7 framed from their street side at 13:00, a
 * residential street at 22:00 by flashlight, and the same street with "Today" houses for comparison.
 *
 *   bun scripts/house-variety-sheet.ts [--skip-build] [--viewport 1200x800] [--out captures/house-variety]
 *
 * Writes one PNG per frame and `report.json` (house style, vertices, errors). Headless Metal Chromium, muted, no visible
 * window: run it through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { generateWorldChunk } from "../shared/world"

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(game, "../..", arg("out", "captures/house-variety")!)
const [vw, vh] = arg("viewport", "1200x800")!.split("x").map(Number) as [number, number]
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

// Seed 7 chunks holding one of each kind of home (see scripts/house-variety-dump.ts).
const CHUNKS: [number, number][] = [[7, 3], [6, 3], [-2, -3], [4, -3], [-3, -2], [5, -1], [9, 4], [-1, 2], [3, 4], [5, -2], [-1, -1], [0, 6]]
// Homes are framed from their back yard facing the street: the camera looks north, so the house fills the frame.
type Shot = { name: string; x: number; y: number; aim?: number; hour: number; zoom: number; flashlight?: boolean; today?: boolean; style?: string }
const shots: Shot[] = []
for (const [cx, cy] of CHUNKS) {
  const ch = generateWorldChunk(7, 7, cx, cy, "streaming")
  const b = ch.buildings[0]
  assert(b?.style, `no styled home at ${cx},${cy}`)
  const s = b.style
  const d = ch.doors.find(q => q.id === `${b.id}-front`)
  const x = d ? (d.rect[0] + d.rect[2]) / 2 : (b.rect[0] + b.rect[2]) / 2
  shots.push({ name: `${String(shots.length + 1).padStart(2, "0")}-${s.form}-${s.condition}`, x, y: b.rect[1] - 1.2, hour: 13, zoom: 34, style: `${s.form} ${s.condition}: ${s.roof} roof, ${s.siding}, ${s.porch} porch, ${s.storeys} storey, ${s.household}, yard ${s.yard.map(y => y.kind).join("+") || "bare"}` })
}
shots.push({ name: "street-day", x: 150, y: -8, aim: -Math.PI / 2, hour: 13, zoom: 56 })
shots.push({ name: "street-night", x: 150, y: -8, aim: -Math.PI / 2, hour: 22, zoom: 46, flashlight: true })
shots.push({ name: "street-day-today", x: 150, y: -8, aim: -Math.PI / 2, hour: 13, zoom: 56, today: true })

const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud"
const report: Record<string, unknown> = { viewport: [vw, vh], shots: {} as Record<string, unknown> }
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
  for (const shot of shots) {
    const s = await page.evaluate(async a => {
      const h = (window as any).__arcadeHarness
      if (a.today) h.setLab("houseVariety", 0)
      h.setLab("timeScale", 0)
      // A wide, long sight cone so the whole house reads in a still (not the play look).
      h.setLab("cone", 180)
      h.setLab("range", 40)
      h.setLab("hour", a.hour)
      h.setLab("zoom", a.zoom)
      h.pose(a.x, a.y, a.aim ?? Math.PI / 2)
      h.session().view.player.flashlightOn = Boolean(a.flashlight)
      const t0 = performance.now()
      for (let i = 0; performance.now() - t0 < 12000; i++) {
        h.session().ai.agents.length = 0
        await h.step()
        if (i > 50 && h.state().world.pendingBakes === 0) break
        await new Promise(r => setTimeout(r, 10))
      }
      const st = h.state()
      return { streamed: st.world.isStreamWindow, vertices: Math.round(st.vertices), houses: st.houses }
    }, shot)
    await page.locator("#game").screenshot({ path: resolve(out, `${shot.name}.png`) })
    ;(report.shots as Record<string, unknown>)[shot.name] = { ...shot, ...s }
    console.log(shot.name, JSON.stringify(s))
  }
  report.errors = errors
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
