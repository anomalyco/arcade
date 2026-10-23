import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"
import type { CameraFilter } from "@arcade/kit/gpu/post/camcorder"
import type { OutbreakHarness } from "../src/harness"

await using budget = browserBudget()
const { chromium } = budget

// One headless, muted run and one still. The live pacer must hold both the sim and the final filter while paused.
// The menu is the game shell's (`?shell` shows it under automation) with Outbreak's run tools in its pause slot.
// hivemind run --kind browser --fetch captures/outbreak-pause -- bun games/outbreak/scripts/pause-menu-proof.ts
const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-pause")
mkdirSync(out, { recursive: true })
type ProofWindow = Window & {
  __arcadeHarness: OutbreakHarness
  cameraFilter: CameraFilter
  pauseProbe: { frames: number; time: number; maxStep: number }
  leakedPauseKeys: string[]
}
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Install Playwright Chromium")
const server = await createServer({ root: game, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const browser = await chromium.launch({ executablePath, headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const report: Record<string, unknown> = { errors }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(90000)
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  const port = (server.httpServer!.address() as { port: number }).port
  await page.goto(`http://127.0.0.1:${port}/?lobby=1&seed=7&houseSeed=1234&camera=iphone&shell`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as unknown as ProofWindow).__arcadeHarness?.ready)
  assert.equal(await page.evaluate(() => (window as unknown as ProofWindow).__arcadeHarness.coop()?.lobby?.practice), true)
  await page.locator('[data-act="solo"]').click()
  await page.evaluate(() => {
    const w = window as unknown as ProofWindow
    // The graph runs for the silence check; Chromium's --mute-audio keeps speakers silent throughout.
    w.__arcadeHarness.setLab("audioMuted", 0)
    w.leakedPauseKeys = []
    window.addEventListener("keydown", (e) => {
      if (document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen === "paused") w.leakedPauseKeys.push(e.code)
    })
    w.pauseProbe = { frames: 0, time: 0, maxStep: 0 }
    const encode = w.cameraFilter.encode.bind(w.cameraFilter)
    w.cameraFilter.encode = (encoder, target, frame) => {
      const p = w.pauseProbe
      if (p.frames) p.maxStep = Math.max(p.maxStep, frame[19]! - p.time)
      p.time = frame[19]!
      p.frames++
      encode(encoder, target, frame)
    }
  })
  await page.waitForFunction(() => (window as unknown as ProofWindow).pauseProbe.frames >= 4)
  await page.waitForFunction(() => (window as unknown as ProofWindow).__arcadeHarness.audio().voices > 0)
  const voicesBeforePause = await page.evaluate(() => (window as unknown as ProofWindow).__arcadeHarness.audio().voices)
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  await page.locator('[data-role="run-seed"]').waitFor()
  assert.equal(await page.locator('[data-role="run-seed"]').inputValue(), "7.1234")
  // Let any already-submitted GPU frame drain, without advancing the harness manually.
  const held = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const w = window as unknown as ProofWindow
    return { simTime: w.__arcadeHarness.state().time, ...w.pauseProbe }
  })
  // Start-screen shortcuts must never select a survivor, host a room, or start a new session in Pause.
  await page.locator('[data-act="resume"]').evaluate((el) => (el as HTMLElement).blur())
  for (const key of ["1", "h", "t", "Enter", "w", "Control+e", "Alt+1", "Control+Space", "Meta+e"]) await page.keyboard.press(key)
  const after = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    const w = window as unknown as ProofWindow
    return { simTime: w.__arcadeHarness.state().time, ...w.pauseProbe }
  })
  assert.deepEqual(after, held, "pause must freeze simulation, lighting updates and camera-filter submissions")
  assert.deepEqual(await page.evaluate(() => (window as unknown as ProofWindow).leakedPauseKeys), [])
  const voicesWhilePaused = await page.evaluate(() => (window as unknown as ProofWindow).__arcadeHarness.audio().voices)
  assert.equal(voicesWhilePaused, 0, "pause must stop ambient beds, held voices and the horde")
  report.audio = { voicesBeforePause, voicesWhilePaused }
  assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen), "paused")
  assert.equal(await page.locator("#outbreak-lobby").evaluate((el) => el.classList.contains("is-practice")), false)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(out, "pause-menu.png") })
  report.paused = { held, after }

  // Clipboard feedback must reflect success/failure, and copying must preserve the current run's two seeds.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { document.body.dataset.copiedReplay = text },
  } }))
  await page.locator('[data-act="copy-seed"]').click()
  await page.getByRole("button", { name: "Link copied", exact: true }).waitFor()
  const link = await page.evaluate(() => document.body.dataset.copiedReplay!)
  assert.equal(link, "https://anoma.ly/arcade/outbreak/?seed=7&houseSeed=1234&terrain=0.22")
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Denied") } })
  await page.locator('[data-act="copy-seed"]').click()
  await page.getByRole("button", { name: link, exact: true }).waitFor()
  await page.getByRole("button", { name: "Copy replay link", exact: true }).waitFor()
  report.replay = link

  await page.locator('[data-role="run-seed"]').fill("4294967296")
  await page.locator('[data-act="play-seed"]').click()
  assert.equal(await page.locator('[data-role="run-seed"]').evaluate((el) => (el as HTMLInputElement).validity.valid), false)
  await page.keyboard.press("Escape")
  await page.evaluate(() => { (window as unknown as ProofWindow).pauseProbe.maxStep = 0 })
  await page.waitForFunction((frames) => (window as unknown as ProofWindow).pauseProbe.frames > frames + 3, held.frames)
  const resumed = await page.evaluate(() => {
    const w = window as unknown as ProofWindow
    return { simTime: w.__arcadeHarness.state().time, ...w.pauseProbe }
  })
  assert(resumed.simTime > held.simTime)
  assert(resumed.maxStep < 0.25, "resume must not feed paused wall time into the filter")
  report.resumed = resumed
  await page.waitForFunction(() => (window as unknown as ProofWindow).__arcadeHarness.audio().voices > 0)
  report.audioResumed = true

  await page.getByRole("button", { name: "Pause", exact: true }).click()
  await page.locator('[data-act="loadout"]').click()
  await page.waitForFunction(() => (window as unknown as ProofWindow).__arcadeHarness.coop()?.lobby?.practice)
  await page.waitForFunction(() => (window as unknown as ProofWindow).__arcadeHarness.audio().voices > 0)
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => (window as unknown as ProofWindow).__arcadeHarness.coop()?.lobby?.mode === "closed")
  report.practiceRoundTrip = true
  assert.deepEqual(errors, [])
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  await server.close()
}
