/// <reference types="@webgpu/types" />
// Headless proof for the Lab's knobs readouts and overlays: toolbar tooltips with shortcut chips, ⌘K as knobs'
// command palette (the workbench's commands by registry id, Details through commandsFrom, `palette.open` replying with
// ranked results), a confirm before deleting several objects (Esc keeps them, Delete removes them, the toast's Undo
// brings them back), Watch pins as readouts that only change when their setting does, and the frame-time readout
// (graph with a 16.7 ms line, CPU and GPU meters) with what it costs the main thread.
//   hivemind run --kind browser --fetch captures/lab-overlays -- bun scripts/lab/prove-overlays.ts
// Never opens a visible window and never plays sound (muted browser, AudioContext blocked).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const root = resolve(import.meta.dir, "../..")
const out = resolve(root, arg("--out") ?? "captures/lab-overlays")
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" })
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No dev server port")
const base = `http://127.0.0.1:${addr.port}`

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const errors: string[] = []
const report: Record<string, unknown> = { base }

async function open(path: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error" && !/favicon|status of (404|503)/.test(m.text())) errors.push(m.text())
  })
  await page.addInitScript(() => {
    window.AudioContext = class {
      constructor() {
        throw new Error("Live audio is disabled in this proof")
      }
    } as unknown as typeof AudioContext
    localStorage.clear()
  })
  await page.goto(`${base}/arcade/lab/${path}`)
  await page.waitForFunction(() => Boolean((window as any).labWorkbench), undefined, { timeout: 120000 })
  await page.waitForTimeout(2500)
  return { context, page }
}

const invoke = (page: Page, id: string, args?: Record<string, unknown>) =>
  page.evaluate(async ([id, args]) => {
    const res = (window as any).labWorkbench.invoke(id, args)
    if (!res.ok) throw new Error(`${id}: ${res.error}`)
    return await res.result
  }, [id, args] as const)

const shown = (page: Page, selector: string) => page.evaluate(sel => Boolean(document.querySelector(sel)), selector)

try {
  const { context, page } = await open("?game=getaway&section=spawn")
  const canvas = page.locator(".lab-viewport > canvas")

  // Tooltips: the Frame button's hint with its shortcut as a key chip.
  await page.locator('[data-action="frame"]').hover()
  await page.waitForTimeout(900)
  const tip = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>(".knobs-layers>.knobs-tooltip")
    return t ? { text: t.querySelector(".knobs-tooltip-text")?.textContent ?? "", keys: [...t.querySelectorAll(".knobs-kbd")].map(k => k.textContent) } : null
  })
  await page.screenshot({ path: resolve(out, "tooltip-frame.png"), clip: { x: 900, y: 0, width: 540, height: 120 } })
  report.tooltip = tip
  assert(tip && /frame/i.test(tip.text) && tip.keys.includes("F"), `the Frame button shows its hint and F (${JSON.stringify(tip)})`)
  const titles = await page.evaluate(() => [...document.querySelectorAll(".lab-topbar [title]")].map(e => e.outerHTML.slice(0, 80)))
  assert.deepEqual(titles, [], "the top bar has no native title tooltips left")
  await page.mouse.move(700, 500)

  // ⌘K: knobs' palette over the workbench's commands and Details; Enter runs a command by its registry id.
  await canvas.focus()
  await page.keyboard.press("Meta+k")
  await page.waitForTimeout(400)
  const paletteOpen = await shown(page, ".knobs-layers>.knobs-palette")
  await page.keyboard.type("frame scene")
  await page.waitForTimeout(250)
  const paletteRows = await page.evaluate(() => [...document.querySelectorAll(".knobs-palette .knobs-palette-item")].slice(0, 6).map(r => r.textContent?.trim() ?? ""))
  await page.screenshot({ path: resolve(out, "palette-frame-scene.png") })
  const camBefore = await page.evaluate(() => (window as any).labWorkbench.state().camera)
  await page.keyboard.press("Enter")
  await page.waitForTimeout(600)
  const camAfter = await page.evaluate(() => (window as any).labWorkbench.state().camera)
  const closed = !(await shown(page, ".knobs-layers>.knobs-palette"))
  const cli = (await invoke(page, "palette.open", { query: "skid" })) as { open: boolean; results: { section: string | null; label: string }[] }
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  report.palette = { paletteOpen, paletteRows, closed, camMoved: JSON.stringify(camBefore) !== JSON.stringify(camAfter), cli: cli.results.slice(0, 6) }
  assert(paletteOpen, "⌘K opens knobs' command palette")
  assert(paletteRows[0] && /frame scene/i.test(paletteRows[0]), `typing finds Frame Scene first (${paletteRows})`)
  assert(closed, "Enter runs it and closes the palette")
  assert(cli.open && cli.results.length > 0, `palette.open replies with ranked results (${JSON.stringify(cli.results.slice(0, 3))})`)
  assert(cli.results.some(r => r.section?.startsWith("Details")), `Details' fields reach the palette through commandsFrom (${JSON.stringify(cli.results.slice(0, 8))})`)

  // Confirm before deleting several objects; Esc keeps them, Delete removes them, Undo on the toast restores them.
  const drop = (kind: string) => page.evaluate(async kind => {
    const nav = (window as any).labPanel.navigation
    const light = nav.rows.find((r: any) => r.control?.key === "light").control
    const action = nav.rows.find((r: any) => r.control?.key === "dropLight").control
    nav.set(light, kind)
    await action.run(document.createElement("button"))
  }, kind)
  await drop("spotlight")
  await drop("lamp")
  const lights = () => page.evaluate(() => ((window as any).labWorkbench.state().objects as { id: string }[]).filter(o => o.id.startsWith("light:")).map(o => o.id))
  const before = await lights()
  await invoke(page, "object.select", { id: before[0] })
  await invoke(page, "object.select", { id: before[1], additive: true })
  await canvas.focus()
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(500)
  const asked = await page.evaluate(() => document.querySelector(".knobs-layers>.knobs-confirm .knobs-confirm-title")?.textContent ?? null)
  await page.screenshot({ path: resolve(out, "confirm-delete.png") })
  await page.keyboard.press("Escape")
  await page.waitForTimeout(800)
  const kept = await lights()
  report.confirm = { before, asked, kept }
  await canvas.focus()
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(500)
  await page.locator(".knobs-confirm .knobs-confirm-ok").click()
  await page.waitForTimeout(400)
  const gone = await lights()
  const toastText = await page.evaluate(() => document.querySelector(".knobs-layers>.knobs-toast .knobs-toast-text")?.textContent ?? null)
  await page.screenshot({ path: resolve(out, "toast-deleted.png") })
  await page.locator(".knobs-toast .knobs-toast-action").click()
  await page.waitForTimeout(400)
  const restored = await lights()
  report.confirm = { before, asked, kept, gone, toastText, restored }
  assert(before.length >= 2, `two lights dropped (${before})`)
  assert(asked && /delete 2 objects/i.test(asked), `deleting two objects asks first (${asked})`)
  assert.deepEqual(kept, before, "Esc keeps them")
  assert(before.every(id => !gone.includes(id)), `Delete removes them (${gone})`)
  assert(toastText && /deleted 2 objects/i.test(toastText), `a toast says so (${toastText})`)
  assert(before.every(id => restored.includes(id)), `the toast's Undo brings them back (${restored})`)

  // Watch pins: readouts that change only when their setting does.
  const pinKey = "selectedPower"
  await invoke(page, "object.select", { id: before[0] })
  await page.waitForTimeout(300)
  await invoke(page, "watch.pin", { key: pinKey })
  await invoke(page, "watch.pin", { key: "light" })
  await page.waitForTimeout(500)
  const watchRows = () => page.evaluate(() => [...document.querySelectorAll(".lab-watch .knobs-row[data-field]")].map(r => ({ field: (r as HTMLElement).dataset.field, kind: (r as HTMLElement).dataset.kind, text: r.textContent?.trim() ?? "" })))
  const rows0 = await watchRows()
  // Idle: nothing in the Watch list changes for a second.
  const idleMutations = await page.evaluate(async () => {
    let n = 0
    const obs = new MutationObserver(list => (n += list.length))
    obs.observe(document.querySelector(".lab-watch")!, { subtree: true, childList: true, characterData: true, attributes: true })
    await new Promise(r => setTimeout(r, 1000))
    obs.disconnect()
    return n
  })
  await invoke(page, "scene.set-param", { key: pinKey, value: 3 })
  await page.waitForTimeout(700)
  const rows1 = await watchRows()
  const hud = await page.locator(".lab-viewport").boundingBox()
  if (hud) await page.screenshot({ path: resolve(out, "watch-readouts.png"), clip: { x: hud.x, y: hud.y + hud.height - 140, width: 320, height: 140 } })
  report.watch = { rows0, idleMutations, rows1 }
  assert(rows0.some(r => r.kind === "sparkline") && rows0.some(r => r.kind === "watch"), `a numeric pin is a sparkline, a choice a watch (${JSON.stringify(rows0)})`)
  assert.equal(idleMutations, 0, "an idle Watch list changes nothing")
  assert(JSON.stringify(rows1) !== JSON.stringify(rows0), `an edit reaches the pinned readout (${JSON.stringify(rows1)})`)

  // Frame time: shown from the status bar, with the cost of drawing it.
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  const busy = async (ms: number) => {
    const metric = async () => Object.fromEntries(((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map(m => [m.name, m.value]))
    const a = await metric()
    await page.waitForTimeout(ms)
    const b = await metric()
    return { taskMsPerS: Number((((b.TaskDuration! - a.TaskDuration!) * 1000) / (ms / 1000)).toFixed(1)), scriptMsPerS: Number((((b.ScriptDuration! - a.ScriptDuration!) * 1000) / (ms / 1000)).toFixed(1)) }
  }
  await page.mouse.move(700, 500)
  const hidden = await busy(3000)
  await page.locator('[data-readout="stats"]').click()
  await page.waitForTimeout(500)
  const visible = await busy(3000)
  const perf = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-lab-perf]")!
    return {
      hidden: el.hidden,
      graph: Boolean(el.querySelector('.knobs-row[data-kind="graph"] canvas')),
      meters: [...el.querySelectorAll('.knobs-row[data-kind="meter"]')].map(r => r.textContent?.trim() ?? ""),
      legend: el.querySelector(".knobs-rd-legend")?.textContent ?? "",
    }
  })
  const box = await page.locator("[data-lab-perf]").boundingBox()
  if (box) await page.screenshot({ path: resolve(out, "perf-readout.png"), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } })
  await page.screenshot({ path: resolve(out, "workbench.png") })
  const toggled = await invoke(page, "view.perf", { show: false })
  report.perf = { perf, cost: { hidden, visible }, toggled }
  assert(!perf.hidden && perf.graph && perf.meters.length === 2, `the frame-time readout shows a graph and two meters (${JSON.stringify(perf)})`)
  assert.deepEqual(toggled, { shown: false }, "view.perf hides it")
  await context.close()
  assert.deepEqual(errors.filter(e => !/WebGPU|adapter/i.test(e)), [], "no page errors")
} finally {
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  await server.close()
}
console.log(JSON.stringify(report, null, 2))
