// Two headless Metal Chromium pages in one co-op room, driven with real keyboard and mouse input: both join,
// A walks to the Ash House front door and opens it with E, then fires; both pages must agree.
// Screenshots of both views go to captures/outbreak-coop/. No visible window, no audio.
//
//   bun scripts/coop-browser.ts                                         # against wrangler dev on :8797
//   bun scripts/coop-browser.ts --url=https://anoma.ly/arcade/outbreak/
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { chromium, type Page } from "playwright-core"

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")
const base = arg("url") ?? "http://127.0.0.1:8797/arcade/outbreak/"
const room = arg("room") ?? randomRoomCode(undefined, Math.random, 5)
const out = resolve(import.meta.dir, "../../../captures/outbreak-coop")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome, "Install Chromium first")

type Coop = {
  id: string
  index: number
  connected: boolean
  roster: { name: string }[]
  local: { x: number; y: number; magAmmo: number }
  remotes: { index: number; x: number; y: number }[]
  doors: { id: string; open: boolean }[]
  shots: number[]
  bytesIn: number
  snapshots: number
  rtt: number
}
const coop = (page: Page) => page.evaluate(() => (window as unknown as { __arcadeHarness: { coop(): Coop } }).__arcadeHarness.coop())
async function until(what: string, test: () => Promise<boolean>, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { room, link: `${base}?room=${room}` }
try {
  const pages: Page[] = []
  const errors: string[] = []
  for (const name of ["Ann", "Bob"]) {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`))
    page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`))
    await page.goto(`${base}?room=${room}&name=${name}`, { waitUntil: "load" })
    await page.waitForFunction(() => (window as unknown as { __arcadeHarness?: { ready: boolean } }).__arcadeHarness?.ready, null, { timeout: 30000 })
    pages.push(page)
  }
  const [a, b] = pages as [Page, Page]
  await until("both connected with a roster of two", async () => {
    const [ca, cb] = [await coop(a), await coop(b)]
    return ca.connected && cb.connected && ca.roster.length === 2 && cb.roster.length === 2 && ca.remotes.length === 1 && cb.remotes.length === 1
  })
  report.joined = true

  // A walks north to the front door with W, then presses E.
  await a.bringToFront()
  await a.mouse.click(450, 200)
  await a.keyboard.down("KeyW")
  await until("A at the door", async () => (await coop(a)).local.y < 36.6, 10000)
  await a.keyboard.up("KeyW")
  await a.waitForTimeout(250)
  await a.keyboard.press("KeyE")
  await until("door open on both pages", async () => {
    const [ca, cb] = [await coop(a), await coop(b)]
    return Boolean(ca.doors.find((d) => d.id === "ash-front")?.open && cb.doors.find((d) => d.id === "ash-front")?.open)
  })
  report.doorOpenOnBoth = true

  // A fires (left click) back toward the street.
  const before = await coop(a)
  await a.mouse.click(450, 520)
  await until("shot on both pages", async () => {
    const [ca, cb] = [await coop(a), await coop(b)]
    return ca.local.magAmmo === before.local.magAmmo - 1 && cb.shots.length > 0
  })
  report.shotOnBoth = true

  await a.waitForTimeout(800)
  const [ca, cb] = [await coop(a), await coop(b)]
  const aOnB = cb.remotes[0]!
  report.disagreementM = +Math.hypot(ca.local.x - aOnB.x, ca.local.y - aOnB.y).toFixed(3)
  assert.ok((report.disagreementM as number) < 0.1, "B sees A where A is")
  report.rttMs = [Math.round(ca.rtt * 1000), Math.round(cb.rtt * 1000)]
  const t0 = Date.now()
  const bytes0 = [ca.bytesIn, cb.bytesIn]
  await a.waitForTimeout(3000)
  const [ca2, cb2] = [await coop(a), await coop(b)]
  report.downKBps = [ca2.bytesIn - bytes0[0]!, cb2.bytesIn - bytes0[1]!].map((x) => +(x / ((Date.now() - t0) / 1000) / 1024).toFixed(1))
  await a.screenshot({ path: resolve(out, "a.png") })
  await b.screenshot({ path: resolve(out, "b.png") })
  report.errors = errors
  assert.deepEqual(errors, [])
  report.ok = true
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(JSON.stringify(report, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
