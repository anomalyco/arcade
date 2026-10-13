import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

const host = process.env.PROOF_URL ?? "http://getaway-next.localhost:1355"
const out = process.env.PROOF_OUT ?? resolve("../../captures/lab-keyboard")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)!
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = [], passed: string[] = []
function watch(page: Page) {
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
}
async function active(page: Page, key: string) {
  const value = await page.locator('[data-row][data-active="true"]').getAttribute("data-row")
  if (value !== key) throw new Error(`Focus: ${value} != ${key}`)
}
async function value(page: Page, key: string, expected: number) {
  const actual = Number(await page.locator(`[data-key="${key}"]`).inputValue())
  if (Math.abs(actual - expected) > 1e-10) throw new Error(`${key}: ${actual} != ${expected}`)
}
async function search(page: Page, text: string, shortcut = "/") {
  await page.keyboard.press(shortcut)
  await page.getByRole("combobox", { name: "Search controls" }).fill(text)
  await page.keyboard.press("Enter")
}
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  watch(page)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.route("**/src/main.ts*", async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace("let rafActive = !benchMode;", "window.__labKeys = { controls, debug, scene }; let rafActive = !benchMode;") })
  })
  await page.goto(`${host}/?solo&peaceful=1&seed=7`)
  await page.waitForFunction(() => Boolean((window as any).__view))
  const adapter = await page.evaluate(() => (window as any).__getawayBench.adapterInfo)
  if (!adapter.architecture.includes("metal")) throw new Error("Metal required")
  await page.locator("#view").focus()
  await page.keyboard.down("ArrowUp")
  await page.keyboard.press("Backquote")
  if (await page.evaluate(() => (window as any).__labKeys.controls.read(0).throttle !== 0)) throw new Error("Held game key was not released")
  await page.keyboard.up("ArrowUp")
  await page.evaluate(() => {
    const w = window as any
    w.__leaked = []
    for (const type of ["keydown", "keyup", "keypress"]) addEventListener(type, e => w.__leaked.push([type, (e as KeyboardEvent).key]))
  })
  await active(page, "Lights")
  await page.keyboard.press("ArrowDown"); await active(page, "style")
  await page.keyboard.press("ArrowRight"); await value(page, "style", 0)
  await page.keyboard.press("ArrowLeft"); await value(page, "style", 4)
  await page.keyboard.press("ArrowDown"); await active(page, "beamLength")
  await page.keyboard.press("ArrowRight"); await value(page, "beamLength", 12.5)
  await page.keyboard.press("Shift+ArrowRight"); await value(page, "beamLength", 17.5)
  await page.keyboard.press("Alt+ArrowLeft"); await value(page, "beamLength", 17.45)
  await page.keyboard.press("Enter")
  await page.getByRole("textbox", { name: "Exact Beam length" }).fill("7.125")
  await page.keyboard.press("Escape"); await value(page, "beamLength", 17.45)
  await page.keyboard.press("Space")
  await page.getByRole("textbox", { name: "Exact Beam length" }).fill("8.375")
  await page.keyboard.press("Enter"); await value(page, "beamLength", 8.375)
  await page.keyboard.press("0"); await value(page, "beamLength", 12)
  // Layout-aware hotkeys: Dvorak R/C on unrelated physical codes.
  await page.evaluate(() => {
    for (const [key, code] of [["r", "KeyP"], ["c", "KeyI"]]) for (const type of ["keydown", "keyup"]) dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true }))
  })
  await page.getByRole("button", { name: "Copy Lights JSON" }).filter({ hasText: "Copied" }).waitFor()
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
  if (typeof copied.beamLength !== "number" || !("style" in copied)) throw new Error("Keyboard Copy is not group JSON")
  await page.keyboard.press("Shift+0")
  await value(page, "beamLength", 12); await value(page, "poolSize", 3.4); await value(page, "tailGlow", 2)
  await search(page, "plint")
  await active(page, "poolIntensity")
  await page.keyboard.press("ArrowLeft"); await value(page, "poolIntensity", 0.03)
  await page.keyboard.press("Tab"); await active(page, "Emissions")
  await page.keyboard.press("Shift+Tab"); await active(page, "Lights")
  await page.keyboard.press("ArrowLeft")
  if (await page.locator('[data-key="style"]').isVisible()) throw new Error("Group did not fold")
  await search(page, "beaml", "Meta+k")
  await active(page, "beamLength")
  if (!(await page.locator('[data-key="style"]').isVisible())) throw new Error("Search did not unfold group")
  await search(page, "physics")
  await active(page, "physicsDebug")
  await page.keyboard.press("Space")
  if (!(await page.getByRole("checkbox", { name: "Physics debug" }).isChecked())) throw new Error("Switch did not toggle")
  await page.keyboard.press("0")
  if (await page.getByRole("checkbox", { name: "Physics debug" }).isChecked()) throw new Error("Switch did not reset")
  // Focus outside the panel must not hand the keyboard back to the game.
  await page.locator("#view").focus()
  await page.keyboard.press("ArrowUp")
  if (await page.evaluate(() => (window as any).__labKeys.controls.read(0).throttle !== 0)) throw new Error("Canvas focus leaked keyboard input")
  await page.screenshot({ path: join(out, "getaway-focus.png") })
  await page.keyboard.down("Escape"); await page.keyboard.up("Escape")
  if (await page.locator('[aria-label="Debug controls"]').isVisible()) throw new Error("Escape did not close")
  const leaked = await page.evaluate(() => (window as any).__leaked)
  if (leaked.length) throw new Error(`Panel key leakage: ${JSON.stringify(leaked)}`)
  passed.push("Getaway: focus, modifiers, exact edit/cancel, fuzzy search, folding, groups, Dvorak, randomize, resets, Copy, input capture and closing keyup")
  await page.close()

  // Use Blackout's real input and Lab adapter in an isolated page on the same local Vite server.
  const blackout = await browser.newPage()
  watch(blackout)
  // Serve only these two fixtures through Playwright; don't widen Vite's filesystem allow-list.
  const root = resolve(import.meta.dir, "../../.."), transpiler = new Bun.Transpiler({ loader: "ts" })
  for (const file of ["game/input", "ui/debug-overlay"]) {
    const source = readFileSync(`${root}/games/blackout/src/${file}.ts`, "utf8").replace('"@arcade/kit/lab-panel"', `"/@fs${root}/packages/kit/lab-panel.ts"`)
    await blackout.route(`**/blackout-fixture/${file}.js`, route => route.fulfill({ contentType: "application/javascript", body: transpiler.transformSync(source) }))
  }
  await blackout.route("**/src/main.ts*", route => route.fulfill({ contentType: "application/javascript", body: "export {}" }))
  await blackout.goto(`${host}/`)
  await blackout.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path)
    const [{ Input }, { DebugOverlay, juiceSettings }] = await Promise.all([
      load("/blackout-fixture/game/input.js"), load("/blackout-fixture/ui/debug-overlay.js"),
    ])
    const w = window as any, input = new Input(document.querySelector("canvas")), settings = juiceSettings()
    const panel = new DebugOverlay(settings, new URLSearchParams(), () => input.release())
    w.__blackoutKeys = { input, settings, panel }; w.__leaked = 0
    addEventListener("keydown", () => w.__leaked++)
    addEventListener("keyup", () => w.__leaked++)
  })
  await blackout.keyboard.press("Backquote")
  await active(blackout, "Controls")
  await search(blackout, "sound rings")
  await active(blackout, "rings")
  await blackout.keyboard.press("ArrowRight")
  if (!(await blackout.getByRole("checkbox", { name: "Sound Rings" }).isChecked())) throw new Error("Blackout toggle failed")
  await blackout.keyboard.press("0")
  if (await blackout.getByRole("checkbox", { name: "Sound Rings" }).isChecked()) throw new Error("Blackout approved default lost")
  await blackout.keyboard.press("Tab"); await active(blackout, "Controls")
  await blackout.keyboard.press("Enter")
  await blackout.keyboard.press("ArrowUp")
  await blackout.keyboard.press("Space") // All Off remains keyboard reachable.
  if (await blackout.locator('[data-key="monitors"]').isChecked()) throw new Error("All Off keyboard action failed")
  await blackout.keyboard.press("ArrowDown"); await active(blackout, "Controls")
  await blackout.keyboard.press("Space")
  await blackout.keyboard.press("ArrowDown"); await active(blackout, "monitors")
  await blackout.keyboard.press("Shift+0")
  await blackout.keyboard.press("Escape")
  const blackState = await blackout.evaluate(() => {
    const w = window as any
    return { leaked: w.__leaked, held: w.__blackoutKeys.input.keys.size, rings: w.__blackoutKeys.settings.rings, lamps: w.__blackoutKeys.settings.lamps }
  })
  if (blackState.leaked || blackState.held || blackState.rings || blackState.lamps) throw new Error(JSON.stringify(blackState))
  passed.push("Blackout: ungrouped controls, focus, search, folding, reset defaults and real game-input isolation")
  await blackout.evaluate(() => {
    const w = window as any, LabPanel = Object.getPrototypeOf(w.__blackoutKeys.panel.constructor)
    w.__blackoutKeys.panel.dispose()
    const settings = { amount: 1 }
    const panel = new LabPanel(settings, [{ key: "amount", label: "Amount", group: "Fixture", min: 0, max: 10, step: 1 }], new URLSearchParams("mux=1"), () => {})
    let leaked = 0
    addEventListener("message", () => leaked++)
    const key = (key: string, code = key, modifiers = {}) => {
      for (const kind of ["keydown", "keyup"]) dispatchEvent(new MessageEvent("message", { source: window, origin: location.origin, data: { type: "mux-key", kind, key, code, run: "", ...modifiers } }))
    }
    key("`", "Backquote"); key("/", "Slash")
    for (const char of "amount") key(char)
    key("Enter"); key("ArrowRight", "ArrowRight", { altKey: true })
    if (settings.amount !== 1.1) throw new Error("Mux search/modifier failed")
    key("Enter")
    for (const char of "3.125") key(char)
    key("Enter")
    if (Number(settings.amount) !== 3.125) throw new Error("Mux exact entry failed")
    key("Escape")
    if (panel.visible || leaked) throw new Error("Mux keys escaped capture")
    panel.dispose()
  })
  passed.push("Comparison mux: search text, modifiers, exact entry and closing keyup isolation")
  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, "proof.json"), JSON.stringify({ adapter, passed, errors }, null, 2))
  console.log({ adapter, passed, errors })
} finally { await browser.close() }
