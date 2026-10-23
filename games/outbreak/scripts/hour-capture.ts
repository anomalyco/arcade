// Deterministic canvas captures at fixed hours (seed 7, fixed pose and camera, frozen clock) for pixel-diffing two builds.
// Builds nothing: run `bun run build` first, or copy this script into an older commit's export.
// HOUR_OUT=<dir> [HOUR_LAB='{"key":value}'] [HOURS=16,17.5,18.5,22] bun scripts/hour-capture.ts
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const out = process.env.HOUR_OUT!
assert(out)
mkdirSync(out, { recursive: true })
const labOverrides: Record<string, number | string> = JSON.parse(process.env.HOUR_LAB ?? "{}")
const hours = (process.env.HOURS ?? "16,17.5,18.5,22").split(",").map(Number)
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
const meta: Record<string, unknown> = {}
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const hideHud = (hidden: boolean) => page.evaluate((hidden) => {
    for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, #hud, .hud")) el.style.visibility = hidden ? "hidden" : ""
  }, hidden)
  // Natural start: whatever hour a fresh session opens at.
  meta.startHour = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.reset(7); h.setLab("timeScale", 0)
    const s = h.state()
    return s.hour ?? s.view?.hour ?? null
  })
  const scenes = [
    ...hours.map(hour => ({ name: `street-${hour}`, x: 30, y: 41, aim: -Math.PI / 2, hour, zoom: 42 })),
    ...hours.map(hour => ({ name: `yard-${hour}`, x: 20, y: 35, aim: -1.6, hour, zoom: 42 })),
    { name: "start", x: 30, y: 41, aim: -Math.PI / 2, hour: null as number | null, zoom: 42 },
    { name: `street-${hours[0]}-repeat`, x: 30, y: 41, aim: -Math.PI / 2, hour: hours[0]!, zoom: 42 },
  ]
  for (const scene of scenes) {
    const info = await page.evaluate(async ({ s, labOverrides }) => {
      const h = (window as any).__arcadeHarness
      h.reset(7); h.setLab("timeScale", 0); h.setLab("zoom", s.zoom)
      if (s.hour !== null) h.setLab("hour", s.hour)
      for (const [key, value] of Object.entries(labOverrides)) h.setLab(key, value)
      for (const [x, y, a] of [[30, 41, -1.57], [20, 35, -1.57], [20, 26, 0], [30, 21, 1.57], [38, 32, 3.14]]) {
        h.pose(x, y, a); await h.step()
      }
      h.pose(s.x, s.y, s.aim)
      for (let i = 0; i < 8; i++) await h.step()
      const st = h.state()
      return { hour: st.hour ?? null, look: h.getLook?.() ?? null }
    }, { s: scene, labOverrides })
    meta[scene.name] = info
    await hideHud(true)
    await page.locator("#game").screenshot({ path: resolve(out, `${scene.name}.png`) })
    await hideHud(false)
    await page.screenshot({ path: resolve(out, `${scene.name}-hud.png`) })
  }
  meta.errors = errors
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
} finally {
  await browser.close()
  fixture.stop(true)
}
