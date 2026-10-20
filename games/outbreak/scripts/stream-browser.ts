// One headless, muted session: startup diagnostics and 1080p/720p stream surfaces.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/stream-readiness")
mkdirSync(out, { recursive: true })
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname.replace(/^\/arcade\/outbreak/, "")
  const file = Bun.file(resolve(root, `.${path === "/" || !path ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: { errors: string[]; warnings: string[]; checks: Record<string, unknown> } = { errors: [], warnings: [], checks: {} }
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => report.errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") report.errors.push(m.text()); if (m.type() === "warning") report.warnings.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/arcade/outbreak/`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  const shots = async (name: string) => {
    const boxes = []
    for (const [width, height] of [[1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width: width!, height: height! })
      await page.evaluate(async () => { await (window as any).__arcadeHarness.step() })
      await page.screenshot({ path: resolve(out, `${name}-${height}.png`) })
      boxes.push(await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((e) => e.checkVisibility()).map((e) => {
          const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }
        }) })))
    }
    report.checks[name] = boxes
  }
  report.checks.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await shots("lobby")
  await page.locator('[data-act="solo"]').click()
  await shots("gameplay")
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  const pause = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const before = h.state().time
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { before, after: h.state().time }
  })
  assert.equal(pause.before, pause.after)
  report.checks.pause = pause
  await shots("pause-seed")
  await page.keyboard.press("Escape")
  await page.evaluate(() => (window as any).__arcadeHarness.freeze())
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const s = h.session()
    s.view.player.health = 0
    for (let i = 0; i < 440; i++) s.update(1 / 60, { mx: 0, my: 0, aim: 0, interact: false }, 120)
    await h.step()
  })
  await shots("death")
  await page.getByRole("button", { name: "Restart", exact: true }).click()
  await page.evaluate(async () => { const h = (window as any).__arcadeHarness; await h.step(); if (h.state().death.runOver) throw new Error("Restart retained run-over") })
  await page.evaluate(async () => { const h = (window as any).__arcadeHarness; h.stageWayOut("escape-card"); await h.step() })
  await shots("escape")
  await page.getByRole("button", { name: "New town", exact: true }).click()
  report.checks.newTown = await page.evaluate(async () => { const h = (window as any).__arcadeHarness; await h.step(); return { seed: h.state().town.seed, houseSeed: h.state().town.houseSeed, death: h.state().death, wayOut: h.state().wayOut } })
} catch (error) {
  report.errors.push(`PROOF: ${error instanceof Error ? error.stack : error}`)
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  fixture.stop(true)
  await browser.close()
}
if (report.errors.length) process.exitCode = 1
