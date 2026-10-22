/// <reference types="@webgpu/types" />
// Headless proof for playing with the Backquote LabPanel open, and for its folded groups, on a stand-in game
// (scripts/lab/panel-play): Backquote opens and focuses the panel even while the pointer is locked, keys typed in the
// panel never reach the game, a click on the game hands input back (pointer lock) while the panel stays up, a click
// on the panel takes it again, Escape and the close button close it, only the chosen group starts open, sub-headings
// start folded, folds are remembered across a reload, search reveals folded rows, a group's header carries a modified
// dot and a reset, and the folded panel fits on screen.
//   hivemind run --kind browser --fetch captures/lab-panel-ux -- bun scripts/lab/prove-panel-play.ts
//   ... -- bun scripts/lab/prove-panel-play.ts --clip woods     also records clicking off the panel into a game's dist
// Never opens a visible window and never plays sound (muted browser).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"
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

type Harness = { panel: { visible: boolean; holdsInput: boolean; hasFocus(): boolean }; game: { accepted: string[] } }
const state = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { harness: Harness }).harness
  return { visible: h.panel.visible, holds: h.panel.holdsInput, focused: h.panel.hasFocus(), locked: document.pointerLockElement?.id === "game", accepted: [...h.game.accepted] }
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
  const server = await createServer({ root: resolve(import.meta.dir, "panel-play"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" })
  await server.listen()
  const addr = server.httpServer!.address()
  if (!addr || typeof addr === "string") throw new Error("No dev server port")
  const url = `http://127.0.0.1:${addr.port}/`
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => "harness" in window)
  const checks: string[] = []
  const ok = (name: string) => checks.push(name)

  // Backquote opens the panel and gives it the keyboard.
  await page.keyboard.press("Backquote")
  let s = await until(page, s => s.visible && s.focused && s.holds, "Backquote opens and focuses")
  ok("Backquote opens a focused panel that holds input")
  await page.keyboard.press("KeyW")
  s = await state(page)
  assert.deepEqual(s.accepted, [], "keys pressed on the panel stay out of the game")
  ok("keys on the panel stay out of the game")

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
  await head(page, "Flashlight").click()
  s = await until(page, s => s.holds && s.focused, "click on the panel takes input")
  assert.equal(await expanded(page, "Flashlight"), true, "clicking Flashlight's header opens it")
  ok("click on the panel takes input back; group header opens it")

  // Sub-headings start folded and fold memory survives a reload.
  const subs = await page.locator('[data-lab-panel] .knobs-subhead[aria-expanded]').evaluateAll(els => els.filter(e => e.getClientRects().length).map(e => [e.textContent, e.getAttribute("aria-expanded")]))
  assert(subs.length >= 2 && subs.every(([, e]) => e === "false"), `sub-headings start folded: ${JSON.stringify(subs)}`)
  ok("sub-headings start folded")
  await page.locator('[data-lab-panel] .knobs-subhead', { hasText: "Beam profile" }).click()
  await head(page, "Walking").click()
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

  // Escape from the panel and the close button both close it.
  await head(page, "Volume").click()
  await page.keyboard.press("Escape")
  await until(page, s => !s.visible, "Escape closes")
  ok("Escape from the panel closes it")
  await page.keyboard.press("Backquote")
  await until(page, s => s.visible, "reopen")
  await page.locator("[data-lab-panel] .knobs-close").click()
  await until(page, s => !s.visible, "close button closes")
  ok("the close button closes it")

  assert.deepEqual(errors, [], "no page errors")
  report.harness = checks
  await page.close()
  await server.close()
}

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
  const dir = resolve(out, "clip")
  mkdirSync(dir, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 1280, height: 720 } } })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=balanced`)
  await page.waitForSelector("[data-lab-panel]", { state: "attached", timeout: 300_000 })
  await page.waitForTimeout(4000)
  // Into the game, then open the panel and tune.
  await page.mouse.click(640, 400)
  await page.waitForTimeout(800)
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(900)
  const heads = page.locator("[data-lab-panel] .knobs-group-head[data-foldable]")
  if (await heads.count() > 1) { await heads.nth(1).click(); await page.waitForTimeout(700) }
  const slider = page.locator('[data-lab-panel] .knobs-row [role="slider"]').first()
  await slider.focus()
  for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(90) }
  await page.waitForTimeout(500)
  // Click off: back into the game with the panel still up, walk and look.
  await page.mouse.click(500, 420)
  await page.waitForTimeout(400)
  report.clipLocked = await page.evaluate(() => Boolean(document.pointerLockElement))
  await page.keyboard.down("KeyW")
  for (let i = 0; i < 30; i++) { await page.mouse.move(500 + i * 6, 420); await page.waitForTimeout(40) }
  await page.keyboard.up("KeyW")
  await page.waitForTimeout(400)
  // And back to the panel: Backquote frees the pointer and focuses it; Backquote again closes it.
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(500)
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(700)
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(900)
  const video = page.video()
  await context.close()
  server.stop(true)
  if (video) {
    const path = resolve(out, `${game}-play-with-panel.webm`)
    renameSync(await video.path(), path)
    report.clip = path
  }
}

try {
  await harness()
  if (clip) await record(clip)
} finally {
  writeFileSync(resolve(out, "prove-panel-play.json"), `${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
}
console.log(JSON.stringify(report, null, 2))
