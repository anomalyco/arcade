// Headless proof for Lab stations and the knobs panels, through the dev router (`bun run dev`): every station opens in
// place, number keys switch, knobs in a station card drive the real section, Random is reproducible from the tuning
// seed, the widget layout can be edited and survives a reload, the OS cursor shows with the chrome hidden, and an idle
// panel does no DOM work.
//   hivemind run --kind browser --fetch captures/lab-stations -- bun games/lab/scripts/prove-stations.ts --serve
//   bun games/lab/scripts/prove-stations.ts --base http://127.0.0.1:5180      uses a running dev router
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const root = resolve(import.meta.dir, "../../..")
let base = arg("--base") ?? "http://127.0.0.1:5180"
const port = arg("--port") ?? String(5300 + Math.floor(Math.random() * 500))
const server = process.argv.includes("--serve")
  ? spawn("bun", ["scripts/dev.ts"], { cwd: root, env: { ...process.env, PORT: port, ARCADE_NO_GLOBAL_STATE: "1" }, stdio: ["ignore", "pipe", "inherit"] })
  : null
if (server) {
  base = `http://127.0.0.1:${port}`
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("dev server did not start in 60 s")), 60_000)
    server.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Arcade dev:")) { clearTimeout(timer); done() } })
  })
}
const out = resolve(root, arg("--out") ?? "captures/lab-stations")
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const errors: string[] = []
const report: Record<string, unknown> = { base }
type Snapshot = { view: string; station: { id: string } | null; variant: { id: string } | null; section: string | null }
type W = {
  stations: { snapshot(): Snapshot; open(id: string): Promise<boolean>; close(): void; layout(): Record<string, { widget: string; groups?: string[] }[]> | null; setEditing(on: boolean): void; editing: boolean }
  labPanel: { tuning: { seed: number; last: { seed: number; keys: string[] } | null }; navigation: { settings: Record<string, unknown>; rows: { group: string; control?: { key: string; label: string } }[] }; sync(): void }
  labWorkbench: { undo(): void; invoke(id: string, args?: Record<string, unknown>): { ok: boolean } }
}
const w = (page: Page) => page.evaluate.bind(page)

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !/favicon|status of (404|503)/.test(m.text())) errors.push(m.text()) })
  const snap = () => page.evaluate(() => (window as unknown as W).stations.snapshot())
  const t0 = Date.now()
  await page.goto(`${base}/arcade/lab/`)
  await page.waitForFunction(() => Boolean((window as unknown as W).stations), undefined, { timeout: 120000 })
  report.loadMs = Date.now() - t0
  // Start every proof from the files' layouts.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("arcade.lab.station")) localStorage.removeItem(k) })

  // The Lab opens on Home; this proof drives stations directly, so Home steps aside.
  await page.evaluate(() => (window as unknown as { labs: { home: { hide(): void } } }).labs.home.hide())
  const ids = await page.evaluate(() => {
    const res = (window as unknown as W).labWorkbench.invoke("station.list") as { ok: boolean; result?: { stations: { id: string }[] } }
    return res.ok ? res.result!.stations.map(s => s.id) : []
  })
  report.stations = ids
  assert(ids.length >= 13, `expected at least 13 stations, saw ${ids.length}`)

  // 1. Every station opens in place (game sections load their adapters on demand).
  const opened: Record<string, { ms: number; section: string | null; widgets: number }> = {}
  for (const id of ids) {
    const start = Date.now()
    const ok = await page.evaluate(id => (window as unknown as W).stations.open(id), id)
    assert(ok, `station ${id} opened`)
    const s = await snap()
    assert.equal(s.station?.id, id)
    const widgets = await page.locator(".ls-card").count()
    assert(widgets > 0, `station ${id} shows widgets`)
    opened[id] = { ms: Date.now() - start, section: s.section, widgets }
  }
  report.opened = opened

  // Number keys pick the open lab's variants: 3 is Weather's third, Storm.
  await page.evaluate(() => (window as unknown as W).stations.open("weather"))
  await page.waitForFunction(() => (window as unknown as W).stations.snapshot().section === "weather", undefined, { timeout: 30000 })
  await page.locator('canvas[aria-label="Lab scene"]').click({ position: { x: 600, y: 300 } })
  await page.keyboard.press("Escape")
  await page.keyboard.press("Digit3")
  assert.equal((await snap()).variant?.id, "storm")
  await page.waitForTimeout(1500)
  await page.screenshot({ path: resolve(out, "01-weather-storm.png") })

  // 2. A knobs card in the station drives the real weather section: more drop density, more drops.
  const drops = async () => {
    await page.waitForTimeout(1200)
    const text = await page.locator('[data-widget="perf"] .ls-live').textContent()
    return Number(/(\d+) drops/.exec(text ?? "")?.[1] ?? NaN)
  }
  const densityKey = await page.evaluate(() => (window as unknown as W).labPanel.navigation.rows.find(r => r.control?.label === "Drop density")?.control?.key)
  assert(densityKey, "weather has a Drop density control")
  await page.evaluate(() => (window as unknown as W).labWorkbench.invoke("weather.preset", { preset: "rain" }))
  const before = await drops()
  const slider = page.locator(`[data-widget="controls"] [data-field="${densityKey}"] [role="slider"]`).first()
  await slider.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight")
  await page.waitForTimeout(500)
  const density = await page.evaluate(k => (window as unknown as W).labPanel.navigation.settings[k], densityKey)
  const after = await drops()
  report.knobsDrive = { key: densityKey, density, dropsBefore: before, dropsAfter: after }
  assert(after > before, `drops went from ${before} to ${after}`)
  // Each setting shows once: Details leaves out the rows the card shows, and the card marks the edit.
  assert.equal(await page.locator(`.lab-inspector-body [data-field="${densityKey}"]`).count(), 0, "Details leaves out a row the station card shows")
  const cardValue = await page.locator(`[data-widget="controls"] [data-field="${densityKey}"]`).first().getAttribute("class")
  assert(cardValue?.includes("knobs-modified"), "the card marks the edited row as modified")

  // The Watch pin works on the card's knobs rows.
  const pin = page.locator(`[data-widget="controls"] [data-field="${densityKey}"] .lab-knobs-pin`).first()
  await pin.click({ force: true })
  assert.equal(await pin.getAttribute("aria-pressed"), "true", "pinning a card row marks it")
  await pin.click({ force: true })

  // Hold \ in the card: the section shows the value from before the last change, and gets it back on release.
  const setting = () => page.evaluate(k => (window as unknown as W).labPanel.navigation.settings[k] as number, densityKey)
  await slider.focus()
  await page.keyboard.down("Backslash")
  await page.waitForTimeout(150)
  const held = await setting()
  await page.keyboard.up("Backslash")
  await page.waitForTimeout(150)
  const released = await setting()
  report.compare = { changed: density, held, released }
  assert(held < (density as number), `holding \\ shows the earlier value (${held} < ${density})`)
  assert.equal(released, density, "releasing \\ brings the current value back")

  // 3. Random draws from the tuning seed: the same seed gives the same values; room and effect seeds stay.
  const roll = async (seed: number) => page.evaluate(async seed => {
    const win = window as unknown as W
    win.labPanel.tuning.seed = seed
    const card = document.querySelector('[data-widget="controls"] .knobs-panel')!
    card.querySelector<HTMLButtonElement>('header button[aria-label="Random"]')!.click()
    await new Promise(r => setTimeout(r, 300))
    const keys = [...card.querySelectorAll<HTMLElement>("[data-field]")].map(r => r.dataset.field!)
    return Object.fromEntries(keys.map(k => [k, win.labPanel.navigation.settings[k]]))
  }, seed)
  const roomSeed = await page.evaluate(() => (window as unknown as W).labPanel.navigation.settings.seed)
  const first = await roll(41)
  // The roll recorded the seed it drew from and moved the tuning seed on.
  const recorded = await page.evaluate(() => { const t = (window as unknown as W).labPanel.tuning; return { last: t.last, seed: t.seed } })
  assert.equal(recorded.last?.seed, 41, "the roll records its tuning seed")
  assert(recorded.last && recorded.last.keys.length > 0 && recorded.seed !== 41, `the tuning seed moves on after a roll (${JSON.stringify(recorded)})`)
  await page.evaluate(() => (window as unknown as W).labWorkbench.undo())
  const again = await roll(41)
  const other = await roll(42)
  report.random = { first, again, other }
  assert.deepEqual(again, first, "same tuning seed, same values")
  assert.notDeepEqual(other, first, "another seed rolls differently")
  assert.equal(await page.evaluate(() => (window as unknown as W).labPanel.navigation.settings.seed), roomSeed, "the room seed is untouched")
  await page.screenshot({ path: resolve(out, "02-weather-random.png") })

  // 4. Edit the layout: move Status to the dock with its menu, drag Measured to the right, pick groups for the controls.
  await page.locator('[aria-label="Edit station layout"]').click()
  await page.locator('.ls-card[data-widget-id="status"] [aria-label="Status options"]').click()
  await page.locator(".ls-menu-item", { hasText: "Move to Dock" }).click()
  let layout = await page.evaluate(() => (window as unknown as W).stations.layout()!)
  assert(layout.dock.some(x => x.widget === "status"), "status moved to the dock")
  await page.locator('.ls-card[data-widget-id="metrics"]').dragTo(page.locator('[data-station-slot="right"]'))
  layout = await page.evaluate(() => (window as unknown as W).stations.layout()!)
  report.dragged = layout.right.map(x => x.widget)
  assert(layout.right.some(x => x.widget === "metrics"), "metrics dragged to the right")
  await page.locator('.ls-card[data-widget-id="controls"] [aria-label="Controls options"]').click()
  await page.locator(".ls-menu-item", { hasText: "Configure" }).click()
  const wind = page.locator(".ls-check", { hasText: "Wind" }).locator("input")
  await wind.check()
  await page.locator('.ls-dialog input[type="text"]').fill("Rain and wind")
  await page.locator(".ls-dialog button", { hasText: "Save" }).click()
  await page.screenshot({ path: resolve(out, "03-weather-editing.png") })
  await page.locator(".ls-editbar button", { hasText: "Done" }).click()
  layout = await page.evaluate(() => (window as unknown as W).stations.layout()!)
  const controls = layout.right.find(x => x.widget === "controls")
  assert(controls?.groups?.some(g => /wind/i.test(g)), `controls groups: ${controls?.groups}`)

  // ... and it survives a reload.
  await page.goto(`${base}/arcade/lab/?station=weather`)
  await page.waitForFunction(() => (window as unknown as W).stations?.snapshot().station?.id === "weather", undefined, { timeout: 120000 })
  const reloaded = await page.evaluate(() => (window as unknown as W).stations.layout()!)
  report.layoutAfterReload = reloaded
  assert.deepEqual(reloaded, layout, "the saved layout comes back after a reload")
  assert.equal(await page.locator('.ls-card[data-widget-id="controls"] .ls-card-title').textContent(), "Rain and wind")
  await page.waitForTimeout(1200)
  await page.screenshot({ path: resolve(out, "04-weather-saved-layout.png") })

  // 6. With the chrome hidden (Backquote) the OS cursor shows over the canvas.
  await page.locator('canvas[aria-label="Lab scene"]').click({ position: { x: 500, y: 300 } })
  await page.keyboard.press("Backquote")
  await page.mouse.move(700, 420)
  await page.mouse.move(705, 424)
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('canvas[aria-label="Lab scene"]')!).cursor)
  report.cursorChromeHidden = cursor
  assert.notEqual(cursor, "none", "a cursor shows with the chrome hidden")
  await page.screenshot({ path: resolve(out, "07-chrome-hidden.png") })
  await page.keyboard.press("Backquote")

  // 7. Idle: no DOM work in any knobs panel and no panel syncs while nothing changes.
  await page.mouse.move(1, 1)
  await page.waitForTimeout(1500)
  report.idle = await page.evaluate(async () => {
    const win = window as unknown as W
    let syncs = 0
    const sync = win.labPanel.sync.bind(win.labPanel)
    win.labPanel.sync = () => { syncs++; sync() }
    let mutations = 0
    const observer = new MutationObserver(list => { mutations += list.length })
    for (const panel of document.querySelectorAll(".knobs-panel")) observer.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true })
    const frames: number[] = []
    const t0 = performance.now()
    await new Promise<void>(done => { const tick = (t: number) => { frames.push(t); if (t - t0 < 3000) requestAnimationFrame(tick); else done() }; requestAnimationFrame(tick) })
    observer.disconnect()
    win.labPanel.sync = sync
    const gaps = frames.slice(1).map((t, i) => t - frames[i]!)
    return { panels: document.querySelectorAll(".knobs-panel").length, mutations, syncs, frames: frames.length, medianFrameMs: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] }
  })
  assert.equal((report.idle as { mutations: number }).mutations, 0, "idle knobs panels do no DOM work")

  // 8. Three more stations as they open.
  for (const [id, file] of [["explosions", "08-explosions.png"], ["vegetation", "09-vegetation.png"], ["outbreak", "10-outbreak.png"]] as const) {
    if (!ids.includes(id)) continue
    await page.evaluate(id => (window as unknown as W).stations.open(id), id)
    await page.waitForTimeout(2500)
    await page.screenshot({ path: resolve(out, file) })
  }
  report.errors = errors
  assert.deepEqual(errors, [], "no page errors")
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  server?.kill()
}
