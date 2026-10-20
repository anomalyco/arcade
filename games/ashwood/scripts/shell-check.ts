// Play-shell check: home screen → Settings (persisted across a reload) → Play → title card → intro → walk, debug keys
// ignored, Esc pause → Resume → Quit to title, then the debug routes. Headless, muted, 1280×720, one page at a time.
//
//   bun scripts/shell-check.ts                                  # dev server :5196 (/debug and ?query → debug sandbox)
//   bun scripts/shell-check.ts --base http://localhost:5197/ --prod   # a `vite preview` build (/debug → the game)
//
// Captures go to captures/shell-*.png. Exits 1 on any failure.
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const base = flag("base") ?? "http://localhost:5196/"
const prod = args.includes("--prod")
const shots = !args.includes("--no-shots")
const out = `${import.meta.dir}/../captures`
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${out}/shell-${name}${prod ? "-prod" : ""}.png` })
}
type G = { __static?: { mode: string; flow: { phase: string; paused: boolean }; skip(): void }; __afterhours?: { complete: boolean; errors: string[] }; __afterhoursPlayer?: { pos: { x: number; z: number }; fly: boolean }; __afterhoursDebug?: { camera: { fov: number } } }
const state = (page: Page) =>
  page.evaluate(() => {
    const g = globalThis as unknown as G
    return { mode: g.__static?.mode ?? "debug", phase: g.__static?.flow.phase, paused: g.__static?.flow.paused, complete: g.__afterhours?.complete, errors: g.__afterhours?.errors ?? [], pos: g.__afterhoursPlayer ? { ...g.__afterhoursPlayer.pos } : null, fly: g.__afterhoursPlayer?.fly, fov: g.__afterhoursDebug?.camera.fov, lab: !!document.querySelector("[data-lab-panel]") }
  })
const complete = (page: Page) => page.waitForFunction(() => (globalThis as unknown as G).__afterhours?.complete, null, { timeout: 180_000 })

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
try {
  // Home screen, while loading and once ready.
  await page.goto(base)
  await page.evaluate(() => localStorage.removeItem("static.settings"))
  await page.waitForSelector("#shell", { timeout: 30_000 })
  await page.waitForTimeout(1500)
  await shot(page, "loading")
  await complete(page)
  await page.waitForTimeout(2500)
  await shot(page, "home")
  let s = await state(page)
  check(s.mode === "play" && s.phase === "menu", `/ is the game (mode ${s.mode}, phase ${s.phase})`)
  check(!s.lab, "no Lab panel in play")

  // Settings: FOV and invert Y persist across a reload.
  await page.click("text=Settings")
  await page.waitForTimeout(400)
  await page.$eval(".shell-row input[type=range][max='90']", (el) => {
    const i = el as HTMLInputElement
    i.value = "80"
    i.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await page.click(".shell-choice button[data-value='true']")
  await shot(page, "settings")
  s = await state(page)
  check(s.fov === 80, `FOV applied live (${s.fov})`)
  await page.click(".shell-back >> visible=true")
  await page.click("text=Credits")
  await page.waitForTimeout(800)
  const credits = await page.$$eval(".shell-models li", (l) => l.length)
  check(credits > 20, `credits list parsed from CREDITS.md (${credits} entries)`)
  await shot(page, "credits")
  await page.click(".shell-back >> visible=true")
  await page.click("text=Character")
  await page.click(".shell-list button[data-id='kate']")
  check((await page.evaluate(() => localStorage.getItem("afterhours.character"))) === "kate", "character saved")
  await page.click(".shell-back >> visible=true")

  await page.reload()
  await complete(page)
  s = await state(page)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("static.settings") ?? "{}"))
  check(s.fov === 80 && saved.invertY === true, `settings persist across reload (fov ${s.fov}, invertY ${saved.invertY})`)
  await page.evaluate(() => localStorage.removeItem("static.settings"))

  // Play → title card → intro → explore.
  await page.waitForTimeout(800)
  await page.click(".shell-play")
  await page.waitForTimeout(4200)
  s = await state(page)
  check(s.phase === "title", `Play starts the title card (${s.phase})`)
  await shot(page, "title-1")
  await page.waitForTimeout(7000)
  await shot(page, "title-2")
  await page.keyboard.press("Space")
  await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "intro", null, { timeout: 10_000 })
  check(true, "title card → intro")
  await page.waitForTimeout(6000)
  await shot(page, "intro")
  // The cutscene's own skip: hold Space for a second.
  await page.keyboard.down("Space")
  await page.waitForTimeout(1400)
  await page.keyboard.up("Space")
  await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "explore", null, { timeout: 30_000 })
  await page.waitForTimeout(1800)
  await shot(page, "explore")
  s = await state(page)
  check(s.phase === "explore", `intro → explore at (${s.pos?.x.toFixed(1)}, ${s.pos?.z.toFixed(1)})`)
  const before = s.pos!
  await page.keyboard.down("KeyW")
  await page.waitForTimeout(1500)
  await page.keyboard.up("KeyW")
  s = await state(page)
  const moved = Math.hypot(s.pos!.x - before.x, s.pos!.z - before.z)
  check(moved > 1, `W walks (${moved.toFixed(2)} m)`)
  await page.keyboard.press("KeyN")
  await page.keyboard.press("Digit5")
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(300)
  const after = (await state(page)).pos!
  s = await state(page)
  check(!s.fly && Math.hypot(after.x - s.pos!.x, after.z - s.pos!.z) < 0.5 && !s.lab, `N / digits / Backquote ignored (fly ${s.fly}, lab ${s.lab})`)

  // Pause.
  await page.keyboard.press("Escape")
  await page.waitForTimeout(600)
  s = await state(page)
  check(!!s.paused, "Esc pauses")
  await shot(page, "pause")
  await page.click("text=Resume")
  await page.waitForTimeout(400)
  s = await state(page)
  check(!s.paused && s.phase === "explore", "Resume")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  await page.click("text=Quit to title")
  await page.waitForTimeout(600)
  s = await state(page)
  check(s.phase === "menu" && !s.paused, `Quit to title (${s.phase})`)

  // Debug routes.
  for (const url of [`${base}debug`, `${base}?view=lot&shot=1`]) {
    await page.goto(url)
    await complete(page)
    await page.waitForTimeout(500)
    s = await state(page)
    const debug = !url.includes("?") && prod ? "play" : "debug"
    check(s.mode === debug, `${url.slice(base.length - 1)} → ${s.mode} (want ${debug})`)
    if (debug === "debug" && !url.includes("shot")) check(s.lab, "debug has the Lab panel")
    if (url.endsWith("debug")) await shot(page, "debug")
  }
  check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(" | ")}`)
} catch (e) {
  failures.push(String(e))
  console.log("FAIL", e)
} finally {
  await page.close()
  await browser.close()
}
process.exit(failures.length ? 1 : 0)
