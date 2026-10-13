import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-m1")
mkdirSync(out, { recursive: true })
const build = Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" })
assert.equal(build.exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome, "Install Chromium before the Metal proof")
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)
  assert.equal(adapter.vendor, "apple")
  const pose = async (x: number, y: number, aim: number, hour = 18, zoom = 46) => page.evaluate(async ({ x, y, aim, hour, zoom }) => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0); h.setLab("hour", hour); h.setLab("zoom", zoom)
    h.pose(x, y, aim)
    for (let i = 0; i < 5; i++) await h.step()
  }, { x, y, aim, hour, zoom })
  const shot = async (name: string) => {
    await page.screenshot({ path: resolve(out, `${name}.png`) })
  }
  await pose(42, 43, -.7, 18, 58)
  await shot("01-dusk-street")
  await pose(31, 34, .3, 18, 38)
  await shot("02-house-interior")
  await pose(27.7, 31, -Math.PI / 2, 18, 38)
  const closed = await page.evaluate(() => (window as any).__arcadeHarness.fog(27.7, 27))
  assert.equal(closed, "unexplored")
  await shot("02-house-closed")
  // Exercise the same edge-triggered command that the F key submits.
  await page.evaluate(async () => { const h = (window as any).__arcadeHarness; await h.step(1 / 60, { interact: true }); await h.step() })
  assert.equal(await page.evaluate(() => (window as any).__arcadeHarness.fog(27.7, 27)), "visible")
  await shot("03-door-reveal")
  await pose(27.7, 31, Math.PI / 2, 18, 38)
  assert.equal(await page.evaluate(() => (window as any).__arcadeHarness.fog(27.7, 27)), "explored")
  await shot("04-explored-shroud")
  await pose(42, 43, -.7, 0, 58)
  await shot("05-night-lamps")
  // Actual shared Lab input path and input isolation, not just the automation setters.
  await page.keyboard.press("Backquote")
  const time = page.getByRole("slider", { name: "Time", exact: true })
  await time.fill("12")
  await time.dispatchEvent("input")
  const hour = await page.evaluate(() => (window as any).__arcadeHarness.state().hour)
  assert.equal(hour, 12)
  const before = await page.evaluate(() => (window as any).__arcadeHarness.state().player)
  const clock = await page.evaluate(() => { const h = (window as any).__arcadeHarness; h.freeze(false); return h.state().time })
  await page.keyboard.down("w")
  await page.waitForFunction(t => (window as any).__arcadeHarness.state().time > t + .15, clock)
  await page.keyboard.up("w")
  const after = await page.evaluate(() => { const h = (window as any).__arcadeHarness; h.freeze(); return h.state().player })
  assert.equal(after.x, before.x); assert.equal(after.y, before.y)
  await page.keyboard.press("Backquote")
  // Real F key edge toggles exactly once; Dvorak E moves right without opening a door.
  await pose(27.7, 39, -Math.PI / 2)
  await page.evaluate(() => (window as any).__arcadeHarness.freeze(false))
  await page.keyboard.press("f")
  await page.waitForFunction(() => (window as any).__arcadeHarness.state().town.doors[0].open)
  await page.keyboard.down("d")
  await page.waitForFunction(x => (window as any).__arcadeHarness.state().player.x > x + .15, 27.7)
  await page.keyboard.up("d")
  const dvorakX = await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", key: "e", bubbles: true }))
    return h.state().player.x
  })
  await page.waitForFunction(x => (window as any).__arcadeHarness.state().player.x > x + .15, dvorakX)
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyE", key: "e", bubbles: true })))
  assert.equal(await page.evaluate(() => (window as any).__arcadeHarness.state().revision), 2)
  await page.evaluate(() => (window as any).__arcadeHarness.freeze())
  assert.deepEqual(errors, [])
  await Bun.write(resolve(out, "proof.json"), JSON.stringify({ adapter, captures: ["01-dusk-street", "02-house-interior", "02-house-closed", "03-door-reveal", "04-explored-shroud", "05-night-lamps"], errors, door: "blocked → visible → explored", lab: "time slider + live input isolation", input: "F door + WASD and Dvorak movement" }, null, 2))
  console.log(`Metal proof passed: ${out}`)
} finally { await browser.close(); fixture.stop(true) }
