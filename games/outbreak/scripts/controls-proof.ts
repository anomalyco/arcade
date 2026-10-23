import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Control keys (playtest Oct 21: Ctrl+W closed the game while crouching; M muted instead of opening the map), in the
 * real game in headless Metal Chromium (`--mute-audio`, no window), driven by real key presses through the live loop:
 * Z crouches and Ctrl does not; M opens and closes the map and leaves mute alone; Today's settings put both back.
 * Writes stills of the map legend and the training room's crouch hint, and a readout.
 *
 *   bun scripts/controls-proof.ts [--out <dir>]
 */
const root = resolve(import.meta.dir, "..")
const argOut = process.argv.indexOf("--out")
const out = resolve(argOut >= 0 ? process.argv[argOut + 1]! : resolve(root, "captures/controls"))

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium not found")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const read = (page: Page) =>
  page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    return { crouching: Boolean(h.session().view.player.crouching), map: Boolean(h.map.inspect().open), muted: Boolean(h.audio().muted) }
  })
const settle = (page: Page) => page.waitForTimeout(400)
async function hold(page: Page, key: string) {
  await page.keyboard.down(key)
  await settle(page)
  const r = await read(page)
  await page.keyboard.up(key)
  await settle(page)
  return r
}
async function tap(page: Page, key: string) {
  await page.keyboard.press(key)
  await settle(page)
  return read(page)
}

try {
  mkdirSync(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1&hour=13`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  // `bench` starts frozen; the live loop has to run for held keys to reach the sim.
  await page.evaluate(() => (window as any).__arcadeHarness.freeze(false))
  await page.mouse.click(480, 200)
  const start = await read(page)
  const readout: Record<string, unknown> = { start }
  readout.holdZ = await hold(page, "KeyZ")
  readout.holdCtrl = await hold(page, "ControlLeft")
  readout.tapM = await tap(page, "KeyM")
  await page.screenshot({ path: resolve(out, "map-legend.png"), clip: { x: 0, y: 440, width: 960, height: 160 }, timeout: 120_000 })
  readout.tapMAgain = await tap(page, "KeyM")
  readout.tapN = await tap(page, "KeyN")
  await tap(page, "KeyN")

  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    h.setLab("crouchKey", 1)
    h.setLab("mapKey", 1)
  })
  readout.todayHoldCtrl = await hold(page, "ControlLeft")
  readout.todayHoldZ = await hold(page, "KeyZ")
  readout.todayTapM = await tap(page, "KeyM")
  readout.todayTapN = await tap(page, "KeyN")
  await tap(page, "KeyN")
  await tap(page, "KeyM")
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    h.setLab("crouchKey", 0)
    h.setLab("mapKey", 0)
  })
  readout.errors = errors
  writeFileSync(resolve(out, "readout.json"), JSON.stringify(readout, null, 2))
  console.log(JSON.stringify(readout, null, 2))

  const r = readout as Record<string, { crouching: boolean; map: boolean; muted: boolean }>
  assert.equal(errors.length, 0, errors.join("\n"))
  assert.equal(r.holdZ!.crouching, true, "Z did not crouch")
  assert.equal(r.holdCtrl!.crouching, false, "Ctrl still crouches by default")
  assert.equal(r.tapM!.map, true, "M did not open the map")
  assert.equal(r.tapM!.muted, start.muted, "M changed mute")
  assert.equal(r.tapMAgain!.map, false, "M did not close the map")
  assert.equal(r.tapN!.map, true, "N no longer opens the map")
  assert.equal(r.todayHoldCtrl!.crouching, true, "Today's Ctrl did not crouch")
  assert.equal(r.todayHoldZ!.crouching, false, "Z crouched with Today's Ctrl")
  assert.equal(r.todayTapM!.map, false, "Today's M opened the map")
  assert.notEqual(r.todayTapM!.muted, start.muted, "Today's M did not mute")
  assert.equal(r.todayTapN!.map, true, "Today's N did not open the map")
} finally {
  await browser.close()
  await server.close()
}
