// Headless proof of the single-origin developer router and hub. Writes captures/dev-hub/.
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, ".."), out = join(root, "captures/dev-hub")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).reverse().map(name => `${cache}/${name}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=user-gesture-required"] })
const errors: string[] = [], report: Record<string, unknown> = {}, routers: ChildProcess[] = []
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }

function freePort() {
  return new Promise<number>(done => { const probe = createNetServer(); probe.listen(0, "127.0.0.1", () => { const address = probe.address() as { port: number }; probe.close(() => done(address.port)) }) })
}
async function router(...args: string[]) {
  const port = await freePort()
  const child = spawn("bun", ["scripts/dev.ts", ...args], { cwd: root, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] })
  routers.push(child)
  let log = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { log += chunk })
  for (let i = 0; i < 100 && !log.includes("Arcade dev:"); i++) await Bun.sleep(100)
  check(log.includes("Arcade dev:"), `Router did not start:\n${log}`)
  return { origin: `http://127.0.0.1:${port}`, log: () => log }
}
async function instrumentedPage(width = 1280, height = 800) {
  const page = await browser.newPage({ viewport: { width, height } })
  page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`))
  page.on("console", message => { if (message.type() === "error" && !/404|503|Failed to load resource|WebSocket connection/.test(message.text())) errors.push(`${page.url()}: ${message.text()}`) })
  await page.addInitScript(() => {
    const state = { draws: 0, audio: [] as AudioContext[] }; Object.assign(window, { hubProof: state })
    const submit = GPUQueue.prototype.submit
    GPUQueue.prototype.submit = function (...args) { state.draws++; return submit.apply(this, args) }
    const OriginalAudio = window.AudioContext
    window.AudioContext = class extends OriginalAudio { constructor(...args: ConstructorParameters<typeof AudioContext>) { super(...args); state.audio.push(this) } }
  })
  return page
}
const proof = (page: Page) => page.evaluate(() => { const state = (window as unknown as { hubProof: { draws: number; audio: AudioContext[] } }).hubProof; return { draws: state.draws, audio: state.audio.length, runningAudio: state.audio.filter(context => context.state === "running").length } })

try {
  const local = await router()
  const { origin } = local
  const page = await instrumentedPage()
  const failed: string[] = []
  page.on("requestfailed", request => { if (request.url().startsWith(origin)) failed.push(request.url()) })
  page.on("response", response => { if (response.url().startsWith(origin) && response.status() >= 400 && !response.url().includes("/api/")) failed.push(`${response.status()} ${response.url()}`) })
  const hmr = new Set<string>()
  page.on("console", message => { if (message.text().includes("[vite] connected")) hmr.add(new URL(page.url()).pathname.split("/")[2]!) })

  // One entry URL.
  await page.goto(`${origin}/`)
  check(page.url() === `${origin}/arcade/getaway/dev.html`, `Entry redirect: ${page.url()}`)
  check(await page.locator(".hub-env").textContent() === "Local", "Environment label")
  const links = Object.fromEntries(await page.locator("a.game").evaluateAll(cards => cards.map(card => [(card as HTMLElement).dataset.game, card.getAttribute("href")])))
  check(JSON.stringify(links) === JSON.stringify({ getaway: "/arcade/getaway/", blackout: "/arcade/blackout/", wings: "https://anoma.ly/arcade/wings/", carrier: "/arcade/carrier/", outbreak: "/arcade/outbreak/" }), `Game links ${JSON.stringify(links)}`)
  for (const card of await page.locator("[data-prototypes] a").all()) check(!await card.isVisible(), "Prototype promoted")
  check(await page.getByText("bun run dev --workers").isVisible(), "Workers note")
  await page.screenshot({ path: join(out, "games.png") })

  // Game deep links open this checkout on the same origin; back returns to the hub.
  const games: Record<string, unknown> = {}
  for (const game of ["getaway", "blackout", "outbreak", "carrier"]) {
    await page.goto(`${origin}/arcade/getaway/dev.html#games`)
    if (game === "outbreak" || game === "carrier") await page.getByText("Prototypes", { exact: true }).click()
    await page.locator(`a.game[data-game="${game}"]`).click()
    await page.waitForURL(`${origin}/arcade/${game}/`)
    await page.waitForLoadState("load"); await page.waitForTimeout(game === "carrier" ? 2500 : 1500)
    const served = await page.evaluate(() => ({ vite: !!document.querySelector('script[src$="/@vite/client"]'), scripts: [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map(script => new URL(script.src).pathname) }))
    check(served.vite && served.scripts.every(path => path.startsWith(`/arcade/${game}/`)), `${game} not served locally under its prefix: ${served.scripts}`)
    const state = await proof(page)
    check(state.runningAudio === 0, `${game} started audio without a gesture`)
    await page.goBack(); await page.waitForURL(/\/arcade\/getaway\/dev\.html#games$/)
    games[game] = { prefix: `/arcade/${game}/`, viteClient: true, audioContexts: state.audio, runningAudio: state.runningAudio }
  }
  report.games = games
  check(failed.length === 0, `Failed same-origin requests:\n${failed.join("\n")}`)

  // Worker endpoints are explicit.
  const health = await page.evaluate(async () => { const response = await fetch("/arcade/getaway/api/health"); return { status: response.status, body: await response.json() } })
  check(health.status === 503 && /--workers/.test(health.body.error), "Worker-off response")
  report.workersOff = health

  // HMR through the shared socket: edit the hub stylesheet and observe a hot CSS update without reload.
  await page.goto(`${origin}/arcade/getaway/dev.html#games`)
  await page.waitForFunction(() => document.querySelector("a.game") !== null)
  await page.evaluate(() => { (window as unknown as { hmrMarker: boolean }).hmrMarker = true })
  const css = join(root, "packages/kit/dev-hub.css"), original = readFileSync(css, "utf8")
  const updated = page.waitForEvent("console", { predicate: message => /hot updated.*dev-hub\.css/.test(message.text()), timeout: 15_000 })
  writeFileSync(css, `${original}\n.hmr-probe { color: red }\n`)
  try { await updated } finally { writeFileSync(css, original) }
  check(await page.evaluate(() => (window as unknown as { hmrMarker?: boolean }).hmrMarker === true), "HMR reloaded the page")
  check(hmr.has("getaway") && hmr.has("blackout"), `HMR sockets: ${[...hmr]}`)
  report.hmr = { connected: [...hmr], cssHotUpdate: true, fullReload: false }

  // Catalogue.
  await page.getByRole("link", { name: "Catalogue", exact: true }).click()
  await page.locator('[role=option][aria-selected="true"]').waitFor()
  await page.waitForFunction(() => (window as unknown as { hubProof: { draws: number } }).hubProof.draws > 0)
  const ids = await page.locator(".asset-list [role=option]").evaluateAll(options => options.map(option => (option as HTMLElement).dataset.assetId!))
  check(ids.length === 25 && await page.locator("canvas").count() === 1, "Registry or canvas budget")
  for (const id of ids) {
    await page.locator(`[data-asset-id="${id}"]`).click()
    check(await page.locator("[data-asset-id]").last().textContent() === id && page.url().endsWith(`#catalogue/${encodeURIComponent(id)}`), `Selection ${id}`)
  }
  await page.locator(`[data-asset-id="${ids[0]}"]`).focus(); await page.keyboard.press("ArrowDown")
  check(page.url().endsWith(`#catalogue/${encodeURIComponent(ids[1]!)}`), "List arrow navigation")
  const searchbox = page.getByRole("searchbox", { name: "Search assets" })
  await searchbox.fill("prop cone"); check(await page.locator(".asset-list [role=option]").count() === 1, "ID filter")
  await searchbox.press("ArrowDown"); await page.keyboard.press("Enter")
  check(await page.locator("[data-asset-id]").last().textContent() === "getaway:prop:cone", "Search → list → select")
  await searchbox.fill(""); await page.getByRole("combobox", { name: "Asset category" }).selectOption("character")
  check(await page.locator(".asset-list [role=option]").count() === 1, "Category filter")
  await page.getByRole("combobox", { name: "Asset category" }).selectOption("all")
  await page.locator('[data-asset-id="getaway:compact"]').click()
  const light = page.getByRole("combobox", { name: "Setup", exact: true })
  check(await page.getByRole("button", { name: "Randomize Lighting" }).isHidden(), "Lighting group actions visible")
  for (const setup of ["neutral", "day", "night", "interior"]) {
    await light.selectOption(setup)
    await page.getByRole("button", { name: "Export feedback", exact: true }).click()
    const json = JSON.parse(await page.getByRole("textbox", { name: "Feedback JSON content" }).inputValue())
    check(json.assetId === "getaway:compact" && json.lighting.setup === setup && json.seed === 7, "Feedback identity or settings")
    await page.getByRole("button", { name: "Close", exact: true }).click()
  }

  // Camera grammar.
  const canvas = page.getByLabel("Asset viewer", { exact: true }), box = (await canvas.boundingBox())!
  const camera = () => page.evaluate(() => JSON.parse(document.querySelector<HTMLTextAreaElement>('[aria-label="Feedback JSON content"]')!.value || "{}").camera)
  const exportCamera = async () => { await page.getByRole("button", { name: "Export feedback", exact: true }).click(); const value = await camera(); await page.getByRole("button", { name: "Close", exact: true }).click(); return value }
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const c0 = await exportCamera()
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy, { steps: 6 }); await page.mouse.up()
  const c1 = await exportCamera(); check(c1.yaw !== c0.yaw && c1.focus.join() === c0.focus.join(), "Drag should orbit")
  await page.keyboard.down("Shift"); await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 40, { steps: 6 }); await page.mouse.up(); await page.keyboard.up("Shift")
  const c2 = await exportCamera(); check(c2.focus.join() !== c1.focus.join() && c2.yaw === c1.yaw, "Shift-drag should pan")
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "right" }); await page.mouse.move(cx - 60, cy, { steps: 6 }); await page.mouse.up({ button: "right" })
  const c3 = await exportCamera(); check(c3.yaw !== c2.yaw, "Right-drag should orbit")
  check(!await page.getByRole("menu", { name: "Asset actions" }).isVisible(), "Right-drag opened the menu")
  await page.mouse.click(cx, cy, { button: "right" })
  check(await page.getByRole("menu", { name: "Asset actions" }).isVisible(), "Right-click menu")
  await page.keyboard.press("Escape")
  check(!await page.getByRole("menu", { name: "Asset actions" }).isVisible(), "Menu Escape")
  await canvas.focus(); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("f"); await page.keyboard.press("+")
  await page.keyboard.press("Escape"); check(await searchbox.evaluate(element => element === document.activeElement), "Escape focus")
  const feedbackBox = page.getByRole("textbox", { name: "Asset feedback", exact: true })
  await feedbackBox.fill("Inspect rear wheel"); await page.keyboard.press("f")
  check((await feedbackBox.inputValue()).endsWith("f"), "Canvas F hijacked text input")
  await feedbackBox.fill("Inspect rear wheel")
  check(!(await canvas.evaluate(element => element.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true })))), "Canvas Ctrl-wheel/pinch should zoom 3D camera and prevent browser page zoom")
  check(await canvas.evaluate(element => element.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, metaKey: true, cancelable: true }))), "Meta+wheel hijacked")
  check(await canvas.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: true, cancelable: true, bubbles: true }))), "Cmd shortcut hijacked")
  await page.screenshot({ path: join(out, "catalogue.png") })

  // Persistence: reload keeps asset, lighting and draft; back leaves the catalogue.
  await page.reload(); await page.locator('[role=option][aria-selected="true"]').waitFor()
  check(await page.locator("[data-asset-id]").last().textContent() === "getaway:compact", "Reload kept asset")
  check(await light.inputValue() === "interior" && await feedbackBox.inputValue() === "Inspect rear wheel", "Reload kept lighting/draft")

  // Rendering stops off-page and while hidden; no audio anywhere in the hub.
  await page.getByRole("link", { name: "Games", exact: true }).click()
  const before = await proof(page); await page.waitForTimeout(250); const after = await proof(page)
  check(after.draws === before.draws && after.audio === 0, "Hidden route rendering/audio")
  await page.getByRole("link", { name: "Catalogue", exact: true }).click(); await page.waitForTimeout(150)
  check(page.url().endsWith("#catalogue/getaway%3Acompact"), "Catalogue nav restores selection")
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")) })
  const hidden = await proof(page); await page.waitForTimeout(250)
  check((await proof(page)).draws === hidden.draws, "Hidden document rendered")
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")) })
  report.catalogue = { assets: ids.length, canvases: 1, audioContexts: after.audio, hiddenRoutePaused: true, syntheticVisibilityPaused: true, reloadPersists: true }

  // Sandbox round trip on both Lab hosts.
  await page.getByRole("link", { name: "Sandbox", exact: true }).click()
  await page.waitForURL(`${origin}/arcade/getaway/lab.html`)
  await page.getByRole("link", { name: "Dev Hub" }).click()
  check(page.url() === `${origin}/arcade/getaway/dev.html#games`, "Lab return navigation")
  await page.goto(`${origin}/arcade/blackout/lab.html`); await page.getByRole("link", { name: "Dev Hub" }).click()
  check(page.url() === `${origin}/arcade/blackout/dev.html#games` && await page.locator(".hub-env").textContent() === "Local", "Blackout hub")
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${origin}/arcade/getaway/dev.html#catalogue`); await page.locator('[role=option][aria-selected="true"]').waitFor(); await page.waitForTimeout(300)
  await page.screenshot({ path: join(out, "mobile.png") })
  await page.close()

  // Worker endpoints through the same origin when enabled.
  const withWorkers = await router("--workers")
  const workerPage = await browser.newPage()
  await workerPage.goto(`${withWorkers.origin}/arcade/getaway/dev.html`)
  const workerHealth = await workerPage.evaluate(async () => (await fetch("/arcade/getaway/api/health")).text())
  check(workerHealth === "ok", `Worker health ${workerHealth}`)
  const socket = await workerPage.evaluate(() => new Promise<string>(done => {
    const ws = new WebSocket(`ws://${location.host}/arcade/getaway/ws/PROOF`)
    ws.onopen = () => { done("open"); ws.close() }; ws.onerror = () => done("error"); setTimeout(() => done("timeout"), 10_000)
  }))
  check(socket === "open", `Worker WebSocket ${socket}`)
  report.workersOn = { health: workerHealth, webSocket: socket }
  await workerPage.close()

  // A single game's own Vite server cannot reach the others, so it links production and says how to get local games.
  const dir = join(root, "games/getaway"), standalone = await createServer({ root: dir, configFile: join(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 } })
  await standalone.listen()
  try {
    const address = standalone.httpServer!.address() as { port: number }
    const alone = await browser.newPage()
    await alone.goto(`http://127.0.0.1:${address.port}/dev.html`)
    check(await alone.locator('a.game[data-game="blackout"]').getAttribute("href") === "https://anoma.ly/arcade/blackout/", "Standalone fallback")
    check(await alone.getByText("bun run dev", { exact: true }).isVisible() && await alone.locator(".hub-env").textContent() === "Production", "Standalone note")
    report.standalone = { blackout: "https://anoma.ly/arcade/blackout/" }
    await alone.close()
  } finally { await standalone.close() }

  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, errors }, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const child of routers) child.kill("SIGTERM")
  await browser.close()
}
