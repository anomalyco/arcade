/**
 * Aligned wall-sconce captures: the same frozen pose with sconce lights off and on, at night, night with the
 * flashlight, by day, and on each quality tier, in a room of every sconce theme.
 *
 *   bun scripts/sconce-proof.ts [--dist dist/arcade/outbreak] [--skip-build]
 *
 * Writes `captures/sconces/<scene>-<variant>.png` (canvas only, HUD hidden) and `report.json` with the number of
 * sconce lights each variant lit. Headless Metal Chromium, muted, no visible window. Run through
 * `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { generateWorldChunk } from "../shared/world"
import { INTERIOR_THEMES, planInterior } from "../src/interiors/plan"

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(game, "../../captures/sconces")
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, arg("dist", "dist/arcade/outbreak")!)
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })

const theme = (t: (typeof INTERIOR_THEMES)[number]) => INTERIOR_THEMES.indexOf(t)
const scenes: { name: string; x: number; y: number; theme: number }[] = [
  { name: "ash-mansion", x: 25.6, y: 32.4, theme: theme("mansion") },
  { name: "elm-village", x: 24.6, y: 62.4, theme: theme("village") },
  { name: "ash-station", x: 25.6, y: 32.4, theme: theme("station") },
]
// A seeded procedural house that dresses itself with sconces (no forced theme).
search: for (let r = 3; r < 9; r++) for (let cx = -r; cx <= r; cx++) for (let cy = -r; cy <= r; cy++) {
  if (Math.max(Math.abs(cx), Math.abs(cy)) !== r) continue
  for (const b of generateWorldChunk(7, 7, cx, cy, "streaming").buildings) {
    const t = planInterior(b, 7).theme
    if (t !== "mansion" && t !== "village" && t !== "station") continue
    scenes.push({ name: `proc-${t}`, x: (b.rect[0] + b.rect[2]) / 2, y: (b.rect[1] + b.rect[3]) / 2, theme: -1 })
    break search
  }
}

const variants = [
  { name: "off", hour: 21, quality: "high", sconceLights: 0 },
  { name: "on", hour: 21, quality: "high", sconceLights: -1 },
  { name: "flashlight-off", hour: 23.5, quality: "high", sconceLights: 0, flashlight: true },
  { name: "flashlight-on", hour: 23.5, quality: "high", sconceLights: -1, flashlight: true },
  { name: "day", hour: 13, quality: "high", sconceLights: -1 },
  { name: "balanced", hour: 21, quality: "balanced", sconceLights: -1 },
  { name: "low", hour: 21, quality: "low", sconceLights: -1 },
]

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { scenes: {} as Record<string, unknown> }
const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud"
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  report.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const scene of scenes) {
    // Find a sconce on a camera-facing wall of this house and stand in front of it.
    const pose = await page.evaluate(async s => {
      const h = (window as any).__arcadeHarness
      h.reset(7); h.setLab("timeScale", 0); h.setLab("hour", 21); h.setLab("zoom", 26); h.setLab("quality", "high")
      h.setInterior("sconceLights", -1)
      h.setInterior("interiorTheme", s.theme)
      h.pose(s.x, s.y, -Math.PI / 2)
      const t0 = performance.now()
      while (performance.now() - t0 < 12000) {
        await h.step()
        if (h.interiors().settled && performance.now() - t0 > 800) break
        await new Promise(r => setTimeout(r, 30))
      }
      const inside = (r: number[]) => s.x > r[0]! && s.x < r[2]! && s.y > r[1]! && s.y < r[3]!
      const mine = h.sconces().filter((c: { rect: number[] }) => inside(c.rect))
      const pick = mine.find((c: { nz: number }) => c.nz > 0.5) ?? mine[0]
      return { count: mine.length, pick }
    }, scene)
    const rows: Record<string, unknown> = { ...scene, sconcesInHouse: pose.count, sconce: pose.pick }
    if (!pose.pick) {
      console.log(scene.name, "no sconces found")
      ;(report.scenes as Record<string, unknown>)[scene.name] = rows
      continue
    }
    const px = pose.pick.x + pose.pick.nx * 1.7, py = pose.pick.z + pose.pick.nz * 1.7
    for (const v of variants) {
      const st = await page.evaluate(async ({ v, px, py }) => {
        const h = (window as any).__arcadeHarness
        h.setLab("quality", v.quality); h.setLab("hour", v.hour); h.setInterior("sconceLights", v.sconceLights)
        h.pose(px, py, -Math.PI / 2 + 0.35)
        // The flashlight input is a toggle press.
        if (h.state().flashlight.on !== Boolean(v.flashlight)) await h.step(1 / 60, { flashlight: true })
        // Long enough for the roof cutaway to follow the new pose.
        for (let i = 0; i < 90; i++) {
          await h.step()
          if (i % 10 === 0) await new Promise(r => setTimeout(r, 16))
        }
        return { sconceLights: h.interiors().sconceLights, flashlight: h.state().flashlight.on }
      }, { v, px, py })
      await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
      await page.locator("#game").screenshot({ path: resolve(out, `${scene.name}-${v.name}.png`) })
      await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "" }, HUD)
      assert.equal(st.flashlight, Boolean(v.flashlight), `${scene.name}-${v.name} flashlight`)
      rows[v.name] = st.sconceLights
    }
    ;(report.scenes as Record<string, unknown>)[scene.name] = rows
    console.log(scene.name, JSON.stringify(rows))
  }
  report.errors = errors
  if (errors.length) console.error(errors.slice(0, 10).join("\n"))
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
