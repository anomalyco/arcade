/// <reference types="@webgpu/types" />
// Headless proof for the Outliner on knobs/ui's tree: groups and folds, selection both ways, keys, lock and search.
//   hivemind run --kind browser -- bun scripts/lab/prove-outliner.ts
// Never opens a visible window and never plays sound (muted browser, AudioContext blocked).
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "../..")
const out = resolve(root, "captures/lab-outliner")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
if (!executablePath) throw new Error("Playwright Chromium binary required")

const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" })
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No dev server port")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

const failures: string[] = []
function check(ok: boolean, what: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}

type W = { labWorkbench: { invoke(id: string, args?: Record<string, unknown>): { ok: boolean; error?: string }; state(): { selection: { selectedIds: string[] }; layout?: { locked: string[] }; camera: { focus: number[] }; objects: { id: string; kind?: string }[] } } }
const state = (p: Page) => p.evaluate(() => {
  const s = (window as unknown as W).labWorkbench.state()
  return { selected: s.selection.selectedIds, locked: s.layout?.locked ?? [], focus: s.camera.focus, cones: s.objects.filter(o => o.kind === "cone").map(o => o.id) }
})
// Rows top to bottom as drawn (the tree recycles row elements, so DOM order isn't screen order).
const rows = (p: Page) => p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".lab-outliner .knobs-tree-row")]
  .filter(r => !r.hidden && r.getBoundingClientRect().height > 0)
  .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  .map(r => r.dataset.id!))
const row = (p: Page, id: string) => p.locator(`.lab-outliner .knobs-tree-row[data-id="${id}"]`)

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const p = await context.newPage()
  p.on("pageerror", e => failures.push(`pageerror: ${e.message}`))
  await p.addInitScript(() => {
    window.AudioContext = class { constructor() { throw new Error("Live audio is disabled") } } as unknown as typeof AudioContext
  })
  await p.goto(`http://127.0.0.1:${addr.port}/arcade/lab/?section=spawn`)
  await p.waitForFunction(() => Boolean((window as unknown as Partial<W>).labWorkbench), undefined, { timeout: 120000 })
  await p.waitForTimeout(1500)
  const placed = await p.evaluate(() => {
    const w = (window as unknown as W).labWorkbench
    return ["-3,2", "0,2", "3,2"].map(at => w.invoke("library.place", { id: "spawn-prop:cone", at })).concat(w.invoke("library.place", { id: "spawn-prop:hydrant", at: "0,-3" }))
  })
  check(placed.every(r => r.ok), `placed three cones and a hydrant (${placed.map(r => r.error ?? "ok").join(", ")})`)
  await p.waitForTimeout(800)

  let r = await rows(p)
  check(r.includes("group:props") && r.includes("fold:props:cone"), `Props shows a Cone fold (${r.join(", ")})`)
  check(!r.some(id => id.startsWith("obj:") && id.includes("cone")), "the fold starts shut")
  await p.screenshot({ path: resolve(out, "outliner.png"), clip: { x: 0, y: 0, width: 360, height: 600 } })

  await row(p, "fold:props:cone").click()
  await p.waitForTimeout(200)
  let s = await state(p)
  check(s.cones.length >= 3 && s.selected.length === s.cones.length && s.cones.every(id => s.selected.includes(id)), `clicking the fold selects every cone (${s.selected.length} of ${s.cones.length})`)

  await p.keyboard.press("ArrowRight")
  await p.waitForTimeout(400)
  r = await rows(p)
  const cones = r.filter(id => s.cones.some(c => `obj:${c}` === id))
  check(cones.length === s.cones.length && r.indexOf(cones[0]!) === r.indexOf("fold:props:cone") + 1, `→ opens the fold (${cones.join(", ")})`)
  await p.keyboard.press("ArrowDown")
  await p.waitForTimeout(200)
  s = await state(p)
  check(s.selected.length === 1 && `obj:${s.selected[0]}` === cones[0], `↓ selects the first cone (${s.selected.join(", ")})`)

  const before = (await state(p)).focus
  await p.keyboard.press("f")
  await p.waitForTimeout(600)
  const after = (await state(p)).focus
  const focused = await p.evaluate(() => Boolean(document.activeElement?.closest(".lab-outliner")))
  check(JSON.stringify(before) !== JSON.stringify(after) && focused, `F frames the selection from the Outliner and focus stays (${before.map(n => n.toFixed(1))} → ${after.map(n => n.toFixed(1))})`)

  await p.evaluate(() => (window as unknown as W).labWorkbench.invoke("object.select", { id: "prop:3" }))
  await p.waitForTimeout(300)
  const shown = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.lab-outliner .knobs-tree-row[aria-selected="true"]')].map(e => e.dataset.id))
  check(shown.length === 1 && shown[0] === "obj:prop:3", `a viewport selection shows on its row (${shown.join(", ")})`)

  const target = row(p, "obj:prop:3")
  await target.hover()
  await target.locator('.knobs-tree-toggle[data-toggle="locked"]').click()
  await p.waitForTimeout(200)
  s = await state(p)
  check(s.locked.includes("prop:3"), `the lock toggle locks the object (${s.locked.join(", ")})`)
  await p.screenshot({ path: resolve(out, "outliner-locked.png"), clip: { x: 0, y: 0, width: 360, height: 600 } })
  await target.locator('.knobs-tree-toggle[data-toggle="locked"]').click()
  s = await state(p)
  check(!s.locked.includes("prop:3"), "and again unlocks it")

  await p.locator('[data-control="outliner-search"]').fill("hydrant")
  await p.waitForTimeout(1000)
  r = await rows(p)
  check(r.length >= 3 && r[0] === "group:props" && r[1] === "fold:props:hydrant" && !r.includes("fold:props:cone"), `search keeps the hydrants, their fold and group (${r.join(", ")})`)
  await p.keyboard.press("Enter")
  await p.waitForTimeout(200)
  s = await state(p)
  check(s.selected.length === 1, `Enter in the search selects the first match (${s.selected.join(", ")})`)
  await p.keyboard.press("Escape")
  await p.keyboard.press("Escape")
  await p.waitForTimeout(200)
  const canvas = await p.evaluate(() => document.activeElement?.getAttribute("aria-label"))
  check(canvas === "Lab scene", `Esc from the tree goes back to the canvas (${canvas})`)
} finally {
  await browser.close()
  await server.close()
}
if (failures.length) {
  console.error(`\n${failures.length} failed:\n${failures.join("\n")}`)
  process.exit(1)
}
console.log(`\nall passed · stills in ${out}`)
