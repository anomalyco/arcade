import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "./browser-budget"
import { build, createServer, preview } from "vite"

// Stills of the shared game shell (title, settings, pause) in each game, and one clip: open Settings, change quality
// and volume, resume. Headless and muted; `?shell` shows the shell under automation.
//   hivemind run --kind browser --fetch captures/game-shell -- bun scripts/prove-game-shell.ts lot nightshift --clip lot
const args = process.argv.slice(2)
const clipGame = args.includes("--clip") ? args[args.indexOf("--clip") + 1] : null
const games = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--clip")
assert(games.length, "Name the games: bun scripts/prove-game-shell.ts lot nightshift")
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "captures/game-shell")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
// Full Chromium in headless mode: the headless shell refuses Pointer Lock (WrongDocumentError), as Lot's capture notes.
const executablePath = readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Install Playwright Chromium")
await using budget = browserBudget()
const { chromium } = budget
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=user-gesture-required"] })
const report: Record<string, unknown> = {}
/** Per-game URL extras and what to click to reach play. */
const SETUP: Record<string, { query?: string; timeout?: number; built?: boolean; lobby?: boolean }> = {
  nightshift: { timeout: 180_000 }, lot: { timeout: 180_000, built: true },
  brawl: { lobby: true }, outbreak: { lobby: true }, getaway: { lobby: true }, blackout: { lobby: true }, carrier: { lobby: true }, archers: { lobby: true },
}

const screen = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen ?? null)
const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}.png` })

async function run(game: string, clip: boolean) {
  const dir = resolve(root, "games", game)
  // The Lot imports public/ scripts at runtime, which only the built site serves.
  if (SETUP[game]?.built) await build({ root: dir, logLevel: "error" })
  const server = SETUP[game]?.built
    ? await preview({ root: dir, logLevel: "error", preview: { host: "127.0.0.1", port: 0 } })
    : await createServer({ root: dir, logLevel: "error", server: { host: "127.0.0.1", port: 0 } }).then(async (s) => (await s.listen(), s))
  const errors: string[] = []
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...(clip ? { recordVideo: { dir: out, size: { width: 1280, height: 720 } } } : {}) })
  const page = await context.newPage()
  page.setDefaultTimeout(SETUP[game]?.timeout ?? 90_000)
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  try {
    const port = (server.httpServer!.address() as { port: number }).port
    await page.goto(`http://127.0.0.1:${port}${server.config.base}?shell${SETUP[game]?.query ?? ""}`, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen === "title")
    await page.waitForTimeout(1500)
    const tag = clip ? `${game}-clip` : game
    const fit: Record<string, { overflow: number; fade: string }> = {}
    const measure = () => page.evaluate(() => {
      const c = document.querySelector<HTMLElement>(".as-card")!
      return { overflow: c.scrollHeight - c.clientHeight, fade: c.dataset.fade ?? "" }
    })
    if (!clip) {
      await shot(page, `${tag}-title`)
      fit["1280x720"] = await measure()
      // The title must fit (or scroll with a fade) at both common sizes.
      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.waitForTimeout(500)
      await shot(page, `${tag}-title-1080`)
      fit["1920x1080"] = await measure()
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.waitForTimeout(300)
    }
    await page.locator(".as-card [data-act=settings]").first().click()
    await page.waitForSelector(".as-settings")
    if (!clip) await shot(page, `${tag}-settings`)
    if (!clip && SETUP[game]?.lobby) {
      // The lobby: a private room's card (code, Copy invite link, players) for games that gather first, or the
      // title with its lobby choices for games that play as soon as they join.
      await page.locator("[data-act=back]").click()
      await page.locator(".as-card input[data-field=name]").fill("Kit").catch(() => {})
      await shot(page, `${tag}-lobby`)
      await page.locator(".as-card [data-act=settings]").first().click()
      await page.waitForSelector(".as-settings")
    }
    else {
      await page.waitForTimeout(700)
      // Silent games (Walkers) have no Sound section; games without quality have no Graphics row.
      const quality = (await page.locator(".as-seg [data-mode=low]").count()) > 0
      if (quality) {
        await page.locator(".as-seg [data-mode=low]").click()
        await page.waitForTimeout(900)
      }
      const master = page.locator("input[data-vol=master]")
      if ((await master.count()) > 0) {
        const box = (await master.boundingBox())!
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(700)
        // The slider keeps focus after the drag: M must still mute and unmute.
        await page.keyboard.press("KeyM")
        await page.waitForTimeout(600)
        await page.keyboard.press("KeyM")
        await page.waitForTimeout(600)
      }
      if (quality) {
        await page.locator(".as-seg [data-mode=high]").click()
        await page.waitForTimeout(900)
      }
    }
    await page.locator("[data-act=back]").click()
    const play = page.locator(".as-card [data-act=play], .as-card [data-act=solo]").first()
    // Rooms-only games (Carrier) have no Play on the title: play and pause need a room server, so stop here.
    if ((await play.count()) === 0) {
      report[tag] = { ok: true, finalScreen: await screen(page), titleFit: fit, note: "rooms only: no Play without a room server", errors }
      return
    }
    await play.click()
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen === "playing")
    await page.waitForTimeout(clip ? 1500 : 800)
    // Escape: pointer-lock games lose the lock (the browser's own Escape), others get the key.
    const locked = await page.evaluate(() => document.pointerLockElement !== null)
    if (locked) await page.evaluate(() => document.exitPointerLock())
    else await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen === "paused")
    await page.waitForTimeout(500)
    if (!clip) await shot(page, `${tag}-pause`)
    if (clip) {
      await page.locator("[data-act=resume]").click()
      await page.waitForFunction(() => document.querySelector<HTMLElement>(".arcade-shell")?.dataset.screen === "playing")
      await page.waitForTimeout(1500)
    }
    report[tag] = { ok: true, finalScreen: await screen(page), titleFit: fit, errors }
  } catch (e) {
    await shot(page, `${game}-failure`).catch(() => {})
    report[game] = { ok: false, error: String(e), errors }
  } finally {
    const video = page.video()
    await context.close()
    if (video) {
      const webm = await video.path()
      const mp4 = `${out}/${game}-settings-clip.mp4`
      rmSync(mp4, { force: true })
      try {
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4])
        rmSync(webm)
      } catch {
        renameSync(webm, `${out}/${game}-settings-clip.webm`)
      }
    }
    await server.close()
  }
}

try {
  for (const g of games) await run(g, false)
  if (clipGame) await run(clipGame, true)
} finally {
  await browser.close()
}
console.log(JSON.stringify(report, null, 2))
if (Object.values(report).some((r) => !(r as { ok: boolean }).ok)) await budget.exit(1)
