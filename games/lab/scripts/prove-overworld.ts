// Headless proof for the Lab Overworld through the dev router (`bun run dev`): the map loads with only shared
// sections, number keys glide into stations, variants apply, Esc returns, a game station loads its adapters on
// demand, and a voice note (Chrome's fake microphone fed a spoken WAV) goes through the dev server to the board.
//   bun games/lab/scripts/prove-overworld.ts --serve [--out dir] [--no-board]     starts its own dev server (hivemind)
//   bun games/lab/scripts/prove-overworld.ts --base http://127.0.0.1:5197 ...      uses a running one
// Run it through the fleet: hivemind run --kind browser -- bun games/lab/scripts/prove-overworld.ts --serve --no-board
// Never plays sound: the WAV is written with `say -o` and only fed to the fake capture device.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
let base = arg("--base") ?? "http://127.0.0.1:5180"
// The voice-note route is loopback-only, so a fleet job serves the Lab itself.
const server = process.argv.includes("--serve")
  ? spawn("bun", ["scripts/dev.ts"], { cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, PORT: arg("--port") ?? "5297", ARCADE_NO_GLOBAL_STATE: "1" }, stdio: ["ignore", "pipe", "inherit"] })
  : null
if (server) {
  base = `http://127.0.0.1:${arg("--port") ?? "5297"}`
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("dev server did not start in 60 s")), 60_000)
    server.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Arcade dev:")) { clearTimeout(timer); done() } })
  })
}
const out = resolve(arg("--out") ?? resolve(import.meta.dir, "../../../captures/lab-overworld"))
const board = !process.argv.includes("--no-board")
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const wav = resolve(out, "fake-mic.wav")
execFileSync("say", ["-o", wav, "--data-format=LEI16@16000", "The fireball looks too orange here, and the smoke should hang around longer after the blast."])

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
})
const errors: string[] = []
const report: Record<string, unknown> = { base }
type W = { overworld: { snapshot(): { view: string; station: { id: string } | null; variant: { id: string } | null; section: string | null } } ; lab?: unknown }

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  await context.grantPermissions(["microphone"], { origin: base })
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text()) })
  const loadStart = Date.now()
  await page.goto(`${base}/arcade/lab/?overworld`)
  await page.waitForFunction(() => Boolean((window as unknown as W).overworld), undefined, { timeout: 90000 })
  report.loadMs = Date.now() - loadStart
  const snap = () => page.evaluate(() => (window as unknown as W).overworld.snapshot())
  /** Esc until the map shows: the workbench may spend the first Esc clearing a selection. */
  const backToMap = async () => {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape")
      if (await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().view === "overworld", undefined, { timeout: 1500 }).then(() => true, () => false)) return
    }
    throw new Error("Esc did not return to the map")
  }
  const sections = () => page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>('[data-control="section"] option')].map(o => o.value))
  const startSections = await sections()
  report.startSections = startSections
  assert(!startSections.includes("outbreak-vignette"), "overworld starts without game adapters")
  const labels = await page.locator(".ow-label").count()
  report.stations = labels
  assert(labels >= 13, `expected 13 stations, saw ${labels}`)
  await page.waitForTimeout(800)
  // The OS cursor shows over the map (the drawn glyph is hidden with the chrome), as a pointer over a plot.
  await page.mouse.move(40, 400)
  await page.mouse.move(42, 402)
  const cursorOff = await page.evaluate(() => getComputedStyle(document.querySelector("canvas")!).cursor)
  const label = await page.locator(".ow-label").first().boundingBox()
  await page.mouse.move(label!.x + label!.width / 2, label!.y - 40)
  await page.mouse.move(label!.x + label!.width / 2 + 2, label!.y - 42)
  const cursorOn = await page.evaluate(() => getComputedStyle(document.querySelector("canvas")!).cursor)
  report.cursor = { map: cursorOff, plot: cursorOn }
  assert.notEqual(cursorOff, "none", "a cursor shows over the map")
  assert.equal(cursorOn, "pointer", "a pointer shows over a plot")
  await page.screenshot({ path: resolve(out, "01-overworld.png") })

  // Quick travel: key 1 glides into Explosions.
  const canvas = page.locator("canvas").first()
  await canvas.focus()
  const t0 = Date.now()
  await page.keyboard.press("Digit1")
  await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().view === "station")
  report.travelMs = Date.now() - t0
  let s = await snap()
  assert.equal(s.station?.id, "explosions")
  assert.equal(s.section, "effects")
  await page.keyboard.press("Digit2")
  s = await snap()
  assert.equal(s.variant?.id, "propane")
  await page.waitForTimeout(1200)
  await page.screenshot({ path: resolve(out, "02-explosions-propane.png") })

  // Esc back to the map, then the Outbreak station loads its game's adapters on demand.
  await backToMap()
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(out, "03-back-to-map.png") })
  const t1 = Date.now()
  await page.keyboard.press("Digit0")
  await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().section === "outbreak-vignette", undefined, { timeout: 60000 })
  report.lazyOutbreakMs = Date.now() - t1
  await page.waitForTimeout(1500)
  await page.screenshot({ path: resolve(out, "04-outbreak.png") })

  // Weather runs the shared weather section with its presets as variants.
  await backToMap()
  await page.keyboard.press("Digit3")
  await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().section === "weather", undefined, { timeout: 30000 })
  await page.keyboard.press("Digit3")
  assert.equal((await snap()).variant?.id, "storm")
  await page.waitForTimeout(1500)
  await page.screenshot({ path: resolve(out, "04b-weather-storm.png") })
  await backToMap()
  await page.keyboard.press("Digit0")
  await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().section === "outbreak-vignette", undefined, { timeout: 60000 })

  // ] steps to the next station without going back.
  await page.keyboard.press("BracketRight")
  await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().station?.id === "blackout", undefined, { timeout: 60000 })
  await backToMap()

  // Voice note at Explosions: talk (fake mic), draw a circle with Shift held, finish, send.
  await page.keyboard.press("Digit1")
  await page.waitForFunction(() => (window as unknown as W).overworld.snapshot().station?.id === "explosions")
  await page.waitForTimeout(600)
  await page.keyboard.press("KeyN")
  await page.waitForSelector(".fb-pill:not([hidden])", { timeout: 10000 })
  await page.waitForTimeout(1200)
  await page.mouse.move(520, 380)
  await page.keyboard.down("Shift")
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2
    await page.mouse.move(560 + Math.cos(a) * 90, 360 + Math.sin(a) * 70)
  }
  await page.keyboard.up("Shift")
  await page.keyboard.press("Digit4")
  await page.waitForTimeout(5200)
  await page.screenshot({ path: resolve(out, "05-recording.png") })
  await page.keyboard.press("KeyN")
  await page.waitForSelector("[data-ow-review]", { timeout: 20000 })
  await page.screenshot({ path: resolve(out, "06-review.png") })
  const response = page.waitForResponse(r => r.url().includes("/__arcade/lab/feedback"), { timeout: 120000 })
  await page.locator("[data-ow-review] textarea").fill(arg("--note") ?? "Automated test of the Lab Overworld voice-note path (fake microphone). Nothing to act on.")
  if (board) await page.locator('[data-ow-review] [data-action="send"]').click()
  else await page.locator('[data-ow-review] [data-action="save"]').click()
  const result = await (await response).json()
  report.feedback = result
  assert(result.dir, "bundle saved locally")
  if (board) assert(result.board?.decision, `board delivery: ${JSON.stringify(result.board)}`)
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(out, "07-sent.png") })
  report.errors = errors
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  server?.kill()
}
