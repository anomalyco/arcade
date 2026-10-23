import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "./browser-budget"
import { build, createServer, preview } from "vite"

// The shell from loading to play as a player meets it: stills of the loading screen, the title, the Escape menu and
// Settings; where the wordmark and the primary action sit on each (so a jump shows as a number); and how many clicks it
// takes to reach play, each one aimed where a player would aim it. `--clip` records the first game's loading → title →
// play. Headless and muted; `?shell` shows the shell under automation.
//   hivemind run --kind browser --fetch captures/shell-ingame -- bun scripts/prove-shell-ingame.ts barbara lot --tag after --clip
const args = process.argv.slice(2)
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1]! : "after"
const clip = args.includes("--clip")
const games = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--tag")
assert(games.length, "Name the games: bun scripts/prove-shell-ingame.ts barbara lot")
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "captures/shell-ingame", tag)
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
// Full Chromium in headless mode: the headless shell refuses Pointer Lock.
const executablePath = readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Install Playwright Chromium")
await using budget = browserBudget()
const browser = await budget.chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=user-gesture-required"] })
const BUILT = new Set(["barbara", "lot", "nightshift"])
type Rect = { x: number; y: number; w: number; h: number }
const report: Record<string, unknown> = {}

const screen = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.screen ?? null)
/** The largest visible wordmark (`.as-title`) and the first visible element for an action. */
const rectOf = (page: Page, selector: string) => page.evaluate((sel) => {
  const all = [...document.querySelectorAll<HTMLElement>(sel)].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
  const r = all.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null
}, selector)
const opaque = (page: Page) => page.evaluate(() => {
  const l = document.querySelector<HTMLElement>(".as-loading")
  return Boolean(l && !l.hidden && getComputedStyle(l).display !== "none" && Number(getComputedStyle(l).opacity) > 0.01)
})
const shift = (a: Rect | null, b: Rect | null) => (a && b ? { dx: b.x - a.x, dy: b.y - a.y, dw: b.w - a.w } : null)

/** Clicks the visible element for `selector` until the shell is playing; returns the clicks and where they landed. */
async function clickToPlay(page: Page, selector: string, audio: boolean) {
  const clicks: { x: number; y: number; on: string }[] = []
  for (let i = 0; i < 4; i++) {
    const r = await rectOf(page, selector)
    const x = r ? r.x + r.w / 2 : 640, y = r ? r.y + r.h / 2 : 360
    clicks.push({ x: Math.round(x), y: Math.round(y), on: r ? selector : "the world" })
    await page.mouse.click(x, y)
    const ok = await page.waitForFunction((a) => {
      const playing = document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.screen === "playing"
      const woods = (window as unknown as { woods?: { audio?: { begun?: boolean } } }).woods
      return playing && (!a || Boolean(woods?.audio?.begun))
    }, audio, { timeout: 2500 }).then(() => true, () => false)
    if (ok) return { clicks: clicks.length, at: clicks }
  }
  return { clicks: -1, at: clicks }
}

async function run(game: string, record: boolean) {
  const dir = resolve(root, "games", game)
  const built = BUILT.has(game)
  // Games with rooms stamp their build id first (`shared/build.gen.ts`).
  if (existsSync(`${dir}/scripts/build-id.ts`)) execFileSync("bun", ["scripts/build-id.ts"], { cwd: dir, stdio: "inherit" })
  if (built) await build({ root: dir, logLevel: "error" })
  const server = built
    ? await preview({ root: dir, logLevel: "error", preview: { host: "127.0.0.1", port: 0 } })
    : await createServer({ root: dir, logLevel: "error", server: { host: "127.0.0.1", port: 0 } }).then(async (s) => (await s.listen(), s))
  const errors: string[] = []
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...(record ? { recordVideo: { dir: out, size: { width: 1280, height: 720 } } } : {}) })
  const page = await context.newPage()
  page.setDefaultTimeout(150_000)
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  const shot = (name: string) => page.screenshot({ path: `${out}/${game}-${name}.png` })
  const r: Record<string, unknown> = {}
  try {
    const port = (server.httpServer!.address() as { port: number }).port
    await page.goto(`http://127.0.0.1:${port}${server.config.base}?shell`, { waitUntil: "domcontentloaded" })
    // The loading screen, once it is past halfway (or as late as it shows).
    const loading = await page.waitForFunction(() => {
      const l = document.querySelector<HTMLElement>(".as-loading")
      if (!l || l.hidden) return document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.screen === "title" ? "none" : false
      // The bar's label: inside the curtain before the in-world shell, in the menu column after.
      const text = `${l.textContent ?? ""} ${document.querySelector(".as-load")?.textContent ?? ""}`
      const pct = Number(/(\d+)%/.exec(text)?.[1] ?? 0)
      return pct >= 50 ? "shown" : false
    }, undefined, { polling: 50 }).then((h) => h.jsonValue())
    if (loading === "shown") {
      r.loadingTitle = await rectOf(page, ".as-loading .as-title, .arcade-shell .as-brand .as-title")
      await shot("loading")
    }
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.screen === "title")
    await page.waitForFunction(() => {
      const l = document.querySelector<HTMLElement>(".as-loading")
      return !l || l.hidden || getComputedStyle(l).display === "none" || Number(getComputedStyle(l).opacity) <= 0.01
    })
    await page.waitForTimeout(1500)
    r.stillLoading = await opaque(page)
    r.title = await rectOf(page, ".arcade-shell .as-title")
    r.titlePlay = await rectOf(page, ".arcade-shell [data-act=solo], .arcade-shell [data-act=play]")
    r.titleVolume = await rectOf(page, ".arcade-shell input[data-vol=master]")
    await shot("title")
    r.loadingToTitle = shift(r.loadingTitle as Rect | null, r.title as Rect | null)
    const toPlay = await clickToPlay(page, ".arcade-shell [data-act=solo], .arcade-shell [data-act=play]", game === "barbara")
    r.clicksToPlay = toPlay
    r.locked = await page.evaluate(() => document.pointerLockElement !== null)
    await page.waitForTimeout(1800)
    if (record) await shot("playing")
    // Escape: the browser's own release of the pointer lock (or the key, for games without one).
    if (r.locked) await page.evaluate(() => document.exitPointerLock())
    else await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.screen === "paused")
    await page.waitForTimeout(900)
    r.pauseTitle = await rectOf(page, ".arcade-shell .as-title")
    r.pauseResume = await rectOf(page, ".arcade-shell [data-act=resume]")
    r.pauseVolume = await rectOf(page, ".arcade-shell input[data-vol=master]")
    r.titleToPause = shift(r.title as Rect | null, r.pauseTitle as Rect | null)
    r.playToResume = shift(r.titlePlay as Rect | null, r.pauseResume as Rect | null)
    await shot("pause")
    if (!record) {
      await page.locator(".arcade-shell [data-act=settings]").first().click()
      await page.waitForSelector(".as-settings")
      await page.waitForTimeout(700)
      await shot("settings")
      await page.locator(".arcade-shell [data-act=back]").first().click()
      await page.waitForTimeout(500)
      // M and the master slider agree: M mutes, the slider shows it; raising the slider unmutes.
      const vol = page.locator(".arcade-shell input[data-vol=master]").first()
      if ((await vol.count()) > 0) {
        // Automation starts muted: M unmutes, M mutes again.
        const muted0 = await page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.muted)
        await page.keyboard.press("KeyM")
        await page.waitForTimeout(200)
        const unmutedByM = await page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.muted)
        await page.keyboard.press("KeyM")
        await page.waitForTimeout(300)
        const muted = await page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.muted)
        await shot("pause-muted")
        const box = (await vol.boundingBox())!
        await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2)
        await page.waitForTimeout(300)
        const after = await page.evaluate(() => document.querySelector<HTMLElement>(".arcade-shell[data-screen]")?.dataset.muted)
        r.muteAgreement = { start: muted0, afterM: unmutedByM, afterSecondM: muted, afterSliderRaised: after, ok: muted0 === "true" && unmutedByM === "false" && muted === "true" && after === "false" }
      }
    }
    r.clicksToResume = await clickToPlay(page, ".arcade-shell [data-act=resume]", false)
    await page.waitForTimeout(1200)
    r.errors = errors
    report[game] = r
  } catch (e) {
    await shot("failure").catch(() => {})
    report[game] = { ...r, error: String(e), errors }
  } finally {
    const video = page.video()
    await context.close()
    if (video) {
      const webm = await video.path()
      const mp4 = `${out}/${game}-flow.mp4`
      rmSync(mp4, { force: true })
      try {
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4])
        rmSync(webm)
      } catch {}
    }
    await server.close()
  }
}

try {
  for (const [i, g] of games.entries()) await run(g, clip && i === 0)
} finally {
  await browser.close()
}
// Merge, so games can be proven one run at a time inside the browser budget.
const previous = existsSync(`${out}/report.json`) ? JSON.parse(readFileSync(`${out}/report.json`, "utf8")) : {}
writeFileSync(`${out}/report.json`, JSON.stringify({ ...previous, ...report }, null, 2))
console.log(JSON.stringify(report, null, 2))
if (Object.values(report).some((r) => "error" in (r as object))) await budget.exit(1)
