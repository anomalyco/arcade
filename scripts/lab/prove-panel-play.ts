/// <reference types="@webgpu/types" />
// Headless proof for playing with the Backquote LabPanel open, and for its folded groups, on a stand-in game
// (scripts/lab/panel-play): Backquote opens and focuses the panel even while the pointer is locked, keys typed in the
// panel never reach the game, a click on the game hands input back (pointer lock) while the panel stays up, a click
// on the panel takes it again, Escape and the close button close it, only the chosen group starts open, sub-headings
// start folded, folds are remembered across a reload, search reveals folded rows, a group's header carries a modified
// dot and a reset, and the folded panel fits on screen. Regressions from review: Backquote focuses the panel when its
// first row is folded away, a canvas click right after a nudge or a search Escape hands input back (and doesn't close
// the panel), keys and pointer moves typed at the panel reach neither a window-capture lobby nor the kit's Input, and a
// capture "open" panel leaves keys typed in a knobs menu to the menu.
//   hivemind run --kind browser --fetch captures/lab-panel-ux -- bun scripts/lab/prove-panel-play.ts
//   ... -- bun scripts/lab/prove-panel-play.ts --clip woods     also records clicking off the panel into a game's dist
// Never opens a visible window and never plays sound (muted browser).
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, sep } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const root = resolve(import.meta.dir, "../..")
const out = resolve(root, arg("--out") ?? "captures/lab-panel-ux")
const clip = arg("--clip")
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const report: Record<string, unknown> = {}

type Harness = {
  panel: { visible: boolean; holdsInput: boolean; hasFocus(): boolean }
  game: { accepted: string[]; input: string[]; lobby: string[]; clicks: string[] }
  input: { mouse: { x: number; y: number } }
}
const state = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { harness: Harness }).harness
  return {
    visible: h.panel.visible, holds: h.panel.holdsInput, focused: h.panel.hasFocus(), locked: document.pointerLockElement?.id === "game",
    accepted: [...h.game.accepted], input: [...h.game.input], lobby: [...h.game.lobby], clicks: [...h.game.clicks], mouse: { ...h.input.mouse },
  }
})
const head = (page: Page, group: string) => page.locator(`[data-lab-panel] .knobs-group-head[data-group="${group}"]`)
const expanded = async (page: Page, group: string) => (await head(page, group).getAttribute("aria-expanded")) === "true"
const until = async (page: Page, test: (s: Awaited<ReturnType<typeof state>>) => boolean, what: string) => {
  for (let i = 0; i < 40; i++) {
    const s = await state(page)
    if (test(s)) return s
    await page.waitForTimeout(50)
  }
  assert.fail(`${what}: ${JSON.stringify(await state(page))}`)
}

async function harness() {
  // No dependency discovery and a fresh cache: a dependency optimised mid-run reloads the page and loses its state.
  const cacheDir = mkdtempSync(resolve(tmpdir(), "panel-play-vite-"))
  const server = await createServer({
    root: resolve(import.meta.dir, "panel-play"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
    cacheDir, optimizeDeps: { noDiscovery: true },
  })
  await server.listen()
  const addr = server.httpServer!.address()
  if (!addr || typeof addr === "string") throw new Error("No dev server port")
  const url = `http://127.0.0.1:${addr.port}/`
  const errors: string[] = []
  // Each page is its own browser context, so fold memory starts empty.
  const open = async (query = "") => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    page.on("pageerror", e => errors.push(e.message))
    await page.goto(url + query)
    await page.waitForFunction(() => "harness" in window)
    return page
  }
  const page = await open()
  const checks: string[] = []
  const ok = (name: string) => checks.push(name)

  // Backquote opens the panel and gives it the keyboard.
  await page.keyboard.press("Backquote")
  let s = await until(page, s => s.visible && s.focused && s.holds, "Backquote opens and focuses")
  ok("Backquote opens a focused panel that holds input")
  await page.keyboard.press("KeyW")
  s = await state(page)
  assert.deepEqual(s.accepted, [], "keys pressed on the panel stay out of the game")
  assert.deepEqual(s.input, [], "keys pressed on the panel stay out of the kit Input")
  ok("keys on the panel stay out of the game")
  await page.mouse.move(600, 500)
  s = await state(page)
  assert(Math.abs(s.mouse.x - 600) > 1 || Math.abs(s.mouse.y - 500) > 1, `the kit Input doesn't aim while the panel holds input: ${JSON.stringify(s.mouse)}`)
  ok("pointer moves while the panel holds input stay out of the kit Input")

  // Folding: only the chosen group opens; sub-headings start folded; the folded panel fits.
  assert.equal(await expanded(page, "Walking"), true, "Walking starts open")
  for (const g of ["Flashlight", "Forest", "Camera", "Volume"]) assert.equal(await expanded(page, g), false, `${g} starts folded`)
  ok("only the openGroups group starts open")
  const fit = await page.evaluate(() => { const b = document.querySelector<HTMLElement>("[data-lab-panel] .lab-panel-body")!; return { scroll: b.scrollHeight, client: b.clientHeight, height: b.getBoundingClientRect().height } })
  assert(fit.scroll <= fit.client + 1, `folded panel fits (${JSON.stringify(fit)})`)
  report.harnessFit = fit
  ok("folded panel fits without scrolling")
  await page.screenshot({ path: resolve(out, "harness-open.png") })

  // A click on the game hands input back and locks the pointer; the panel stays up.
  await page.mouse.click(400, 400)
  s = await until(page, s => s.locked && !s.holds && !s.focused, "click on the game locks and hands input back")
  assert.equal(s.visible, true, "panel stays open while playing")
  ok("click on the game locks the pointer, panel stays open")
  await page.keyboard.press("KeyW")
  s = await until(page, s => s.accepted.includes("KeyW"), "game takes keys while the panel is open")
  ok("game takes keys while the panel is open and unfocused")

  // Backquote toggles while locked: closing keeps playing, opening frees the pointer and focuses the panel.
  await page.keyboard.press("Backquote")
  s = await until(page, s => !s.visible, "Backquote closes while locked")
  assert.equal(s.locked, true, "closing while playing keeps the pointer locked")
  ok("Backquote closes while pointer-locked and keeps playing")
  await page.keyboard.press("Backquote")
  s = await until(page, s => s.visible && s.focused && !s.locked, "Backquote opens while locked, frees the pointer")
  ok("Backquote opens while pointer-locked, frees the pointer and focuses the panel")

  // Back to the game, then a click on the panel takes input again.
  await page.mouse.click(400, 400)
  await until(page, s => s.locked && !s.holds, "relock")
  await page.evaluate(() => document.exitPointerLock())
  await until(page, s => !s.locked, "unlock")
  await page.mouse.move(650, 420)
  await until(page, s => Math.abs(s.mouse.x - 650) < 0.5 && Math.abs(s.mouse.y - 420) < 0.5, "the kit Input aims again once the panel lets go")
  ok("the kit Input aims again once the panel lets go")
  await head(page, "Flashlight").click()
  s = await until(page, s => s.holds && s.focused, "click on the panel takes input")
  assert.equal(await expanded(page, "Flashlight"), true, "clicking Flashlight's header opens it")
  ok("click on the panel takes input back; group header opens it")

  // A nudge keeps the gesture open for a moment; a click on the game straight after still hands input back.
  await page.locator('[data-lab-panel] .knobs-row[data-field="walkSpeed"] [role="slider"]').focus()
  await page.keyboard.press("ArrowRight")
  await page.mouse.click(400, 400)
  await until(page, s => s.locked && !s.holds && s.visible, "a click right after a nudge locks the pointer")
  ok("a click on the game right after a nudge hands input back")
  await page.evaluate(() => document.exitPointerLock())
  await until(page, s => !s.locked, "unlock after nudge")

  // Sub-headings start folded and fold memory survives a reload.
  const subs = await page.locator('[data-lab-panel] .knobs-subhead[aria-expanded]').evaluateAll(els => els.filter(e => e.getClientRects().length).map(e => [e.textContent, e.getAttribute("aria-expanded")]))
  assert(subs.length >= 2 && subs.every(([, e]) => e === "false"), `sub-headings start folded: ${JSON.stringify(subs)}`)
  ok("sub-headings start folded")
  const beam = page.locator('[data-lab-panel] .knobs-subhead', { hasText: "Beam profile" })
  // Clicks while Flashlight's card is still folding open can miss: click until it reads open.
  for (let i = 0; i < 5 && (await beam.getAttribute("aria-expanded")) !== "true"; i++) { await beam.click(); await page.waitForTimeout(400) }
  assert.equal(await beam.getAttribute("aria-expanded"), "true", "Beam profile opens from its sub-heading")
  await head(page, "Walking").click()
  await page.waitForTimeout(400)
  await page.reload()
  await page.waitForFunction(() => "harness" in window)
  await page.keyboard.press("Backquote")
  await until(page, s => s.visible, "reopen after reload")
  assert.equal(await expanded(page, "Flashlight"), true, "Flashlight stays open after a reload")
  assert.equal(await expanded(page, "Walking"), false, "Walking stays folded after a reload")
  assert.equal(await page.locator('[data-lab-panel] .knobs-subhead', { hasText: "Beam profile" }).getAttribute("aria-expanded"), "true", "Beam profile stays open after a reload")
  report.folds = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.includes(":folds:"))))
  ok("folds are remembered across a reload (localStorage)")

  // Search reveals a row in a folded group's folded sub-heading; typing never reaches the game, and Backquote in the
  // field is text.
  const before = (await state(page)).accepted.length
  const search = page.locator("[data-lab-panel] .knobs-search input")
  await search.click()
  await page.keyboard.type("sensor`w")
  s = await state(page)
  assert.equal(s.visible, true, "Backquote typed in search doesn't close the panel")
  assert.equal(s.accepted.length, before, "typing in search never reaches the game")
  await search.fill("sensor noise")
  const row = page.locator('[data-lab-panel] .knobs-row[data-field="noise"]')
  await row.waitFor({ state: "visible", timeout: 2000 })
  ok("search reveals a folded row; typing stays in the field")
  await search.fill("")

  // Escape clearing a search, then a click on the game: input goes back to the game and the panel stays up.
  await search.click()
  await page.keyboard.type("walk")
  await page.keyboard.press("Escape")
  assert.equal(await search.inputValue(), "", "Escape clears the search")
  s = await state(page)
  assert(s.visible && s.focused && s.lobby.length === 0, `Escape in search clears it without closing: ${JSON.stringify(s)}`)
  await page.waitForTimeout(50)
  await page.mouse.click(400, 400)
  await until(page, s => s.locked && !s.holds && s.visible, "a click after a search Escape hands input back, panel open")
  ok("Escape in search, then a click on the game, keeps the panel open")
  await page.evaluate(() => document.exitPointerLock())
  await until(page, s => !s.locked, "unlock after search")

  // Modified dot and reset on a group header.
  await page.evaluate(() => { const h = (window as unknown as { harness: { settings: Record<string, number>; panel: { refresh(): void } } }).harness; h.settings.vignette = 0.8; h.panel.refresh() })
  await page.waitForTimeout(200)
  assert(await head(page, "Camera").evaluate(e => e.hasAttribute("data-modified")), "Camera's header is marked modified")
  const reset = head(page, "Camera").locator(".knobs-group-reset")
  assert.equal(await reset.getAttribute("data-shown"), "true", "Camera's header shows its reset")
  await page.screenshot({ path: resolve(out, "harness-modified.png") })
  await reset.click()
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => (window as unknown as { harness: { settings: Record<string, number> } }).harness.settings.vignette), 0.35, "group reset puts Vignette back")
  assert(!(await head(page, "Camera").evaluate(e => e.hasAttribute("data-modified"))), "Camera's mark clears")
  ok("a group header carries a modified dot and a reset")

  // Escape from the panel and the close button both close it, past a lobby listening in window capture.
  await head(page, "Volume").click()
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
  s = await until(page, s => !s.visible, "Escape closes")
  assert.deepEqual(s.lobby, [], "Enter and Escape typed in the panel never reach a window-capture lobby")
  ok("Escape from the panel closes it; Enter and Escape there skip the game's capture listeners")
  await page.keyboard.press("Backquote")
  await until(page, s => s.visible, "reopen")
  await page.locator("[data-lab-panel] .knobs-close").click()
  await until(page, s => !s.visible, "close button closes")
  ok("the close button closes it")

  await page.close()

  // The first row in a folded group: Backquote still gives the panel the keyboard, and Escape closes it.
  const folded = await open("?open=Volume")
  await folded.keyboard.press("Backquote")
  s = await until(folded, s => s.visible && s.focused && s.holds, "Backquote focuses a panel whose first row is folded")
  assert.equal(await expanded(folded, "Walking"), false, "Walking (the first row's group) starts folded")
  await folded.keyboard.press("KeyW")
  s = await state(folded)
  assert.deepEqual(s.input, [], "keys go to the panel, not the game, when its first row is folded")
  await folded.keyboard.press("Escape")
  await until(folded, s => !s.visible, "Escape closes a panel whose first row is folded")
  ok("Backquote focuses the panel when its first row is folded; keys stay out; Escape closes")
  await folded.close()

  // Capture "open": keys typed in a knobs menu on <body> (a stand-in menu here) belong to the menu, not the panel.
  const capture = await open("?capture=open")
  await capture.keyboard.press("Backquote")
  await until(capture, s => s.visible && s.holds, "capture open panel opens")
  const walk = () => capture.evaluate(() => (window as unknown as { harness: { settings: Record<string, number> } }).harness.settings.walkSpeed)
  const walkBefore = await walk()
  await capture.evaluate(() => {
    const menu = Object.assign(document.createElement("div"), { className: "knobs-menu", tabIndex: -1, id: "proof-menu" })
    menu.addEventListener("keydown", e => { menu.dataset.keys = `${menu.dataset.keys ?? ""}${e.code} ` })
    document.body.append(menu)
    menu.focus()
  })
  await capture.keyboard.press("ArrowDown")
  await capture.keyboard.press("ArrowLeft")
  const menuKeys = await capture.locator("#proof-menu").getAttribute("data-keys")
  assert.equal(menuKeys?.trim(), "ArrowDown ArrowLeft", "keys typed in a knobs menu reach the menu")
  assert.equal(await walk(), walkBefore, "keys typed in a knobs menu don't move the panel's first row")
  s = await state(capture)
  assert(s.visible && s.focused, `the panel counts its menu as its own: ${JSON.stringify(s)}`)
  ok("capture open: keys typed in a knobs menu go to the menu")
  await capture.close()

  assert.deepEqual(errors, [], "no page errors")
  report.harness = checks
  await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

// Playwright's screencast doesn't keep up with a WebGPU game, so the clip is screenshots (about 4 a second) with a
// caption naming each step, encoded with ffmpeg; the frames are deleted afterwards.
async function record(game: string) {
  const built = resolve(root, "games", game, "dist/arcade", game)
  assert(existsSync(built), `build ${game} first (bun run --cwd games/${game} build)`)
  const prefix = `/arcade/${game}/`
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (!path.startsWith(prefix)) return Response.redirect(prefix, 302)
    const file = resolve(built, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(built + sep) && file !== built) return new Response("Not found", { status: 404 })
    const f = Bun.file(file)
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  } })
  const frames = resolve(out, `${game}-frames`)
  rmSync(frames, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=balanced`)
  await page.waitForSelector("[data-lab-panel]", { state: "attached", timeout: 300_000 })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    const c = document.createElement("div")
    c.id = "proof-caption"
    c.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:10px;background:rgba(0,0,0,.72);color:#fff;font:600 15px system-ui;pointer-events:none"
    document.body.append(c)
  })
  let n = 0
  const caption = (text: string) => page.evaluate(t => { document.getElementById("proof-caption")!.textContent = t }, text)
  const shoot = async (count: number) => {
    for (let i = 0; i < count; i++) await page.screenshot({ path: resolve(frames, `${String(n++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 85, timeout: 60_000 })
  }
  const locked = () => page.evaluate(() => Boolean(document.pointerLockElement))
  const steps: Record<string, unknown>[] = []
  const note = async (step: string) => steps.push({ step, locked: await locked(), panel: await page.evaluate(() => !document.querySelector("[data-lab-panel] .lab-panel-body")!.hasAttribute("hidden")) })

  await caption("The woods: click Play alone")
  await shoot(3)
  await page.locator("#solo").click()
  await page.waitForTimeout(500)
  await note("playing")
  await caption("Playing · press ` to open the knobs")
  await shoot(3)
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(600)
  await note("panel open")
  await caption("` opens the knobs and frees the pointer · groups folded, Flashlight open")
  await shoot(5)
  await page.locator('[data-lab-panel] .knobs-group-head[data-group="Camera"]').click()
  await page.waitForTimeout(500)
  await caption("Open Camera, tune Exposure")
  const exposure = page.locator('[data-lab-panel] .knobs-row[data-field="woods.exposure"] [role="slider"]')
  await exposure.focus()
  for (let i = 0; i < 10; i++) { await page.keyboard.press("ArrowRight"); await shoot(1) }
  await shoot(3)
  await caption("Click the woods: back to playing, the knobs stay open")
  await page.mouse.click(520, 420)
  await page.waitForTimeout(300)
  await note("clicked off")
  await shoot(2)
  await caption("W walks, the mouse looks · keys go to the game, not the panel")
  await page.keyboard.down("KeyW")
  for (let i = 0; i < 12; i++) { await page.mouse.move(520 + i * 8, 420); await shoot(1) }
  await page.keyboard.up("KeyW")
  await note("walked")
  await caption("` again: back to the knobs (pointer freed, panel focused)")
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(400)
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(500)
  await note("back to panel")
  await shoot(4)
  await caption("Escape closes it")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)
  await note("closed")
  await shoot(4)
  await page.close()
  server.stop(true)
  const path = resolve(out, `${game}-play-with-panel.mp4`)
  execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", "4", "-i", resolve(frames, "%04d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path])
  rmSync(frames, { recursive: true, force: true })
  report.clip = path
  report.clipSteps = steps
}

try {
  await harness()
  if (clip) await record(clip)
} finally {
  writeFileSync(resolve(out, "prove-panel-play.json"), `${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
}
console.log(JSON.stringify(report, null, 2))
