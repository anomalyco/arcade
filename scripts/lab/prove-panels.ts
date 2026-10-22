/// <reference types="@webgpu/types" />
// Headless proof for the Lab's resizable panels, compact Library and Library keyboard navigation.
//   hivemind run --kind browser --fetch captures/lab-panels -- bun scripts/lab/prove-panels.ts
//   bun scripts/lab/prove-panels.ts --shots-only --out captures/lab-panels/before    screenshots + idle cost only
// Checks: drag handles resize and persist across reload (per layout, stations included), double-click resets,
// collapse to a rail and back, the canvas backing size follows the viewport at DPR 1 and 2 with no blank frames
// while dragging, a keyboard-only sequence applies the right Library items, and an idle Lab does no layout work.
// Never opens a visible window and never plays sound (muted browser, AudioContext blocked).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type BrowserContext, type Page } from "playwright-core"
import { browserBudget } from "../browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const root = resolve(import.meta.dir, "../..")
const out = resolve(root, arg("--out") ?? "captures/lab-panels")
const shotsOnly = process.argv.includes("--shots-only")
/** `--only keyboard` (or shots, resize, dpr) runs one part. */
const only = arg("--only")
const runs = (part: string) => !only || only === part
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

type Sizes = { width: number; height: number; dpr: number }
const SIZES: Sizes[] = [
  { width: 1440, height: 900, dpr: 1 },
  { width: 1728, height: 1117, dpr: 2 },
]
type Box = { x: number; y: number; w: number; h: number }

async function openLab(sizes: Sizes, context?: BrowserContext) {
  const ctx = context ?? (await browser.newContext({ viewport: { width: sizes.width, height: sizes.height }, deviceScaleFactor: sizes.dpr }))
  const page = await ctx.newPage()
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
  })
  // The Lab opens on Home; these checks are about the plain workbench behind it.
  await page.goto(`${base}/arcade/lab/?section=effects`)
  await page.waitForFunction(() => Boolean((window as any).labWorkbench), undefined, { timeout: 120000 })
  await page.waitForTimeout(800)
  return { context: ctx, page }
}

const invoke = (page: Page, id: string, args?: Record<string, unknown>) =>
  page.evaluate(async ([id, args]) => {
    const res = (window as any).labWorkbench.invoke(id, args)
    if (!res.ok) throw new Error(`${id}: ${res.error}`)
    return await res.result
  }, [id, args] as const)

const state = (page: Page) => page.evaluate(() => (window as any).labWorkbench.state())
const frames = (page: Page, n = 2) => page.evaluate(n => new Promise<void>(done => { let i = 0; const f = () => (++i >= n ? done() : requestAnimationFrame(f)); requestAnimationFrame(f) }), n)

async function boxes(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const b = document.querySelector(sel)?.getBoundingClientRect()
      return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null
    }
    const canvas = document.querySelector<HTMLCanvasElement>(".lab-viewport canvas")!
    return {
      outliner: r(".lab-outliner"), inspector: r(".lab-inspector"), library: r(".lab-library"), drawerBody: r(".lab-drawer-body"),
      viewport: r(".lab-viewport"), dock: r('[data-station-slot="dock"]'), tile: r(".lab-tile"),
      canvas: { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight }, dpr: devicePixelRatio,
    }
  })
}

/** The canvas backs its CSS box at min(DPR, 1.5) (the default resolution), exactly at DPR 1. */
function assertCanvasFits(b: Awaited<ReturnType<typeof boxes>>, label: string, scale = Math.min(b.dpr, 1.5)) {
  const ew = Math.round(b.canvas.cssW * scale), eh = Math.round(b.canvas.cssH * scale)
  assert(Math.abs(b.canvas.w - ew) <= 1 && Math.abs(b.canvas.h - eh) <= 1, `${label}: canvas ${b.canvas.w}×${b.canvas.h} backs ${b.canvas.cssW}×${b.canvas.cssH} CSS px at ${scale}× (expected ${ew}×${eh})`)
}

async function drag(page: Page, splitter: string, dx: number, dy: number, steps = 12) {
  const h = await page.locator(`.lab-splitter[data-splitter="${splitter}"]`).boundingBox()
  assert(h, `${splitter} handle is on screen`)
  // Grab the handle away from its centre so the collapse button isn't under the pointer.
  const x = h.x + h.width / 2 + (h.width > h.height ? h.width / 4 : 0), y = h.y + h.height / 2 + (h.height > h.width ? h.height / 4 : 0)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps)
    await frames(page, 1)
  }
  await page.mouse.up()
  await frames(page, 2)
}

/** CDP layout/style/script counters over an idle window, plus requestAnimationFrame callbacks per second. */
async function idleCost(page: Page, ms = 3000) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  await page.mouse.move(5, 5)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.waitForTimeout(500)
  const read = async () => Object.fromEntries(((await cdp.send("Performance.getMetrics")).metrics as { name: string; value: number }[]).map(m => [m.name, m.value]))
  await page.evaluate(() => {
    const w = window as any
    w.__rafCount = 0
    const orig = window.requestAnimationFrame.bind(window)
    if (!w.__rafWrapped) {
      w.__rafWrapped = true
      window.requestAnimationFrame = cb => orig(t => { w.__rafCount++; cb(t) })
    }
  })
  const a = await read()
  await page.waitForTimeout(ms)
  const b = await read()
  const raf = await page.evaluate(() => (window as any).__rafCount as number)
  const per = (k: string) => Number((((b[k] ?? 0) - (a[k] ?? 0)) / (ms / 1000)).toFixed(3))
  return { layoutsPerSec: per("LayoutCount"), styleRecalcsPerSec: per("RecalcStyleCount"), layoutMsPerSec: Number((per("LayoutDuration") * 1000).toFixed(3)), styleMsPerSec: Number((per("RecalcStyleDuration") * 1000).toFixed(3)), scriptMsPerSec: Number((per("ScriptDuration") * 1000).toFixed(2)), rafCallbacksPerSec: Number((raf / (ms / 1000)).toFixed(1)) }
}

try {
  // ── Idle cost only: three 6 s windows per size, Library open on Foliage (works on any branch). ─────────────────
  if (only === "idle") {
    for (const s of SIZES) {
      const { context, page } = await openLab(s)
      await invoke(page, "library.toggle", { open: true, category: "foliage" })
      await page.waitForTimeout(1500)
      const samples = []
      for (let i = 0; i < 3; i++) samples.push(await idleCost(page, 6000))
      report[`idle-${s.width}x${s.height}@${s.dpr}x`] = samples
      await context.close()
    }
    throw "done"
  }
  // ── Screenshots of Kit's view (Library open on Foliage) and the idle cost, at both sizes. ─────────────────
  for (const s of runs("shots") ? SIZES : []) {
    const tag = `${s.width}x${s.height}@${s.dpr}x`
    const { context, page } = await openLab(s)
    if (!shotsOnly) await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("arcade.lab.panels") || k.startsWith("arcade.lab.library")) localStorage.removeItem(k) })
    if (!shotsOnly) await page.reload(), await page.waitForFunction(() => Boolean((window as any).labWorkbench), undefined, { timeout: 120000 }), await page.waitForTimeout(800)
    await invoke(page, "library.toggle", { open: true, category: "foliage" })
    await page.waitForTimeout(300)
    report[`idle-${tag}`] = await idleCost(page)
    if (!shotsOnly) {
      // Previews for the Foliage items, rendered offline through the Lab viewport.
      const t0 = Date.now()
      const previews = (await invoke(page, "library.previews")) as { rendered: string[]; missing: string[]; previews: number }
      report[`previews-${tag}`] = { ms: Date.now() - t0, rendered: previews.rendered.length, missing: previews.missing, readback: (await state(page)).layout.library.readback }
      assert(previews.rendered.length >= 10, `rendered previews for the Foliage presets (${previews.rendered.length}, missing ${previews.missing.join(", ")})`)
      await invoke(page, "library.toggle", { open: true, category: "foliage" })
      await page.waitForTimeout(400)
    }
    await page.screenshot({ path: resolve(out, `foliage-${tag}.png`) })
    const b = await boxes(page)
    report[`layout-${tag}`] = b
    if (!shotsOnly) {
      assertCanvasFits(b, `default layout ${tag}`)
      assert(b.drawerBody && b.drawerBody.h <= 170, `Library body is compact by default (${b.drawerBody?.h} px)`)
      assert(b.tile && b.tile.h <= 40, `tiles are dense (${b.tile?.h} px tall)`)
      const thumbs = await page.locator('.lab-tile-art[data-thumb="true"]').count()
      assert(thumbs >= 10, `Foliage tiles show rendered previews (${thumbs})`)
      await invoke(page, "library.view", { view: "list" })
      await page.waitForTimeout(200)
      await page.screenshot({ path: resolve(out, `foliage-list-${tag}.png`) })
      await invoke(page, "library.view", { view: "tiles" })
      await invoke(page, "library.toggle", { open: true, category: "effects" })
      await page.waitForTimeout(300)
      await page.screenshot({ path: resolve(out, `effects-${tag}.png`) })
    }
    await context.close()
  }
  if (shotsOnly) throw "done"

  // ── Resize, persist across reload, reset, collapse (1440×900). ───────────────────────────────────────────────
  if (runs("resize")) {
    const { context, page } = await openLab(SIZES[0]!)
    await invoke(page, "library.toggle", { open: true, category: "foliage" })
    await frames(page, 3)
    const before = await boxes(page)
    // Watch every frame during the drags: the canvas backing size may trail the CSS box by one frame at most, and
    // the viewport never presents a blank frame.
    await page.evaluate(() => {
      const w = window as any
      const canvas = document.querySelector<HTMLCanvasElement>(".lab-viewport canvas")!
      w.__frameLog = []
      const tick = () => {
        if (!w.__frameWatch) return
        const v = w.labViewport.get()
        w.__frameLog.push({ w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight, roW: v.width, roH: v.height, t: Math.round(performance.now()) })
        requestAnimationFrame(tick)
      }
      w.__frameWatch = true
      requestAnimationFrame(tick)
    })
    await drag(page, "left", 90, 0)
    await drag(page, "right", -70, 0)
    await drag(page, "drawer", 0, -60)
    const log = (await page.evaluate(() => { const w = window as any; w.__frameWatch = false; return w.__frameLog })) as { w: number; h: number; cssW: number; cssH: number }[]
    // Lag: how many frames old the CSS size is that each frame's backing size matches (0 = current).
    let maxLag = 0, stale = 0
    log.forEach((f, i) => {
      let lag = 0
      while (lag <= i && (log[i - lag]!.cssW !== f.w || log[i - lag]!.cssH !== f.h)) lag++
      if (lag) stale++
      maxLag = Math.max(maxLag, lag)
    })
    await frames(page, 4)
    const after = await boxes(page)
    report.resize = { before, after, frames: log.length, framesWithStaleBacking: stale, maxLagFrames: maxLag }
    assert(maxLag <= 2, `canvas backing trails the CSS box by at most two frames while dragging (max lag ${maxLag})`)
    assert(Math.abs(after.outliner!.w - before.outliner!.w - 90) <= 2, `Outliner grew by the drag (${before.outliner!.w} → ${after.outliner!.w})`)
    assert(Math.abs(after.inspector!.w - before.inspector!.w - 70) <= 2, `Details grew by the drag (${before.inspector!.w} → ${after.inspector!.w})`)
    assert(Math.abs(after.drawerBody!.h - before.drawerBody!.h - 60) <= 2, `Library grew by the drag (${before.drawerBody!.h} → ${after.drawerBody!.h})`)
    assert(after.canvas.w === before.canvas.w - 160 && after.canvas.h === before.canvas.h - 60, `canvas shrank with the viewport (${before.canvas.w}×${before.canvas.h} → ${after.canvas.w}×${after.canvas.h})`)
    assertCanvasFits(after, "after drags")
    const stored = (await state(page)).layout.panels
    assert.equal(stored.layout, "workbench")
    await page.screenshot({ path: resolve(out, "resized-1440x900@1x.png") })

    // Mid-drag blank-frame check: hold a drag and read the presented frame several times.
    {
      const h = (await page.locator('.lab-splitter[data-splitter="left"]').boundingBox())!
      const x = h.x + h.width / 2, y = h.y + h.height * 0.75
      await page.mouse.move(x, y)
      await page.mouse.down()
      const lit: number[] = []
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(x - i * 6, y)
        await frames(page, 1)
        // What the compositor shows: a screenshot of the viewport, decoded in the page.
        const vp = (await page.locator(".lab-viewport").boundingBox())!
        const png = (await page.screenshot({ clip: { x: vp.x, y: vp.y, width: vp.width, height: vp.height } })).toString("base64")
        lit.push(await page.evaluate(async png => {
          const img = new Image()
          img.src = `data:image/png;base64,${png}`
          await img.decode()
          const o = new OffscreenCanvas(64, 40), g = o.getContext("2d")!
          g.drawImage(img, 0, 0, 64, 40)
          const d = g.getImageData(0, 0, 64, 40).data
          let n = 0
          for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 24) n++
          return n / (64 * 40)
        }, png))
      }
      await page.mouse.move(x, y)
      await frames(page, 1)
      await page.mouse.up()
      await frames(page, 2)
      report.midDragLitFraction = lit
      assert(lit.every(v => v > 0.2), `no blank viewport frames mid-drag (${lit.map(v => v.toFixed(2)).join(", ")})`)
    }

    // Reload: sizes come back.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).labWorkbench), undefined, { timeout: 120000 })
    await page.waitForTimeout(800)
    await invoke(page, "library.toggle", { open: true, category: "foliage" })
    await frames(page, 3)
    const reloaded = await boxes(page)
    report.reloaded = reloaded
    assert.equal(reloaded.outliner!.w, after.outliner!.w, "Outliner width persisted across reload")
    assert.equal(reloaded.inspector!.w, after.inspector!.w, "Details width persisted across reload")
    assert.equal(reloaded.drawerBody!.h, after.drawerBody!.h, "Library height persisted across reload")
    assert.equal(reloaded.canvas.w, after.canvas.w, "canvas width matches the restored layout")
    assert.equal(reloaded.canvas.h, after.canvas.h, "canvas height matches the restored layout")

    // Double-click resets one panel.
    await page.locator('.lab-splitter[data-splitter="left"]').dblclick({ position: { x: 3, y: 40 } })
    await frames(page, 2)
    const reset = await boxes(page)
    assert.equal(reset.outliner!.w, before.outliner!.w, "double-click resets the Outliner to its default width")
    assertCanvasFits(reset, "after reset")

    // Collapse Details to a rail with the handle's button, survive a reload, expand from the rail.
    await page.locator('.lab-splitter[data-splitter="right"]').hover({ position: { x: 3, y: 40 } })
    await page.waitForTimeout(250)
    await page.locator('.lab-splitter[data-splitter="right"] .lab-splitter-btn').click()
    await frames(page, 2)
    const collapsed = await boxes(page)
    assert(collapsed.inspector!.w <= 24, `Details collapsed to a thin bar (${collapsed.inspector!.w} px)`)
    assert(await page.locator('.lab-rail[data-rail="right"]').isVisible(), "the Details rail is visible")
    assertCanvasFits(collapsed, "Details collapsed")
    await page.screenshot({ path: resolve(out, "collapsed-details-1440x900@1x.png") })
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).labWorkbench), undefined, { timeout: 120000 })
    await page.waitForTimeout(800)
    assert((await boxes(page)).inspector!.w <= 24, "collapsed Details persisted across reload")
    await page.locator('.lab-rail[data-rail="right"]').click()
    await frames(page, 2)
    assert.equal((await boxes(page)).inspector!.w, after.inspector!.w, "expanding from the rail restores the dragged width")

    // Keyboard resizing on a focused handle.
    await page.locator('.lab-splitter[data-splitter="drawer"]').focus()
    const d0 = (await boxes(page)).drawerBody!.h
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Shift+ArrowUp")
    await frames(page, 2)
    const d1 = (await boxes(page)).drawerBody!.h
    assert.equal(d1, d0 + 80, `↑ and ⇧↑ on the Library handle grow it by 16 + 64 px (${d0} → ${d1})`)
    await page.keyboard.press("Escape")

    // Stations keep their own layout: resize the dock in a station, then the workbench sizes are untouched.
    const wbState = (await state(page)).layout.panels
    const opened = await page.evaluate(() => (window as any).stations.open("weather"))
    assert(opened, "weather station opened")
    await page.waitForTimeout(1200)
    const st0 = await boxes(page)
    assert(st0.dock && st0.dock.h > 0, "the station dock is showing")
    assert.equal((await state(page)).layout.panels.layout, "weather", "station layout key")
    await drag(page, "dock", 0, -50)
    const st1 = await boxes(page)
    assert(Math.abs(st1.dock!.h - st0.dock!.h - 50) <= 2, `station dock grew by the drag (${st0.dock!.h} → ${st1.dock!.h})`)
    assertCanvasFits(st1, "station dock resized")
    await page.screenshot({ path: resolve(out, "station-dock-resized-1440x900@1x.png") })
    await page.evaluate(() => (window as any).stations.close())
    await page.waitForTimeout(600)
    const back = (await state(page)).layout.panels
    assert.equal(back.layout, "workbench")
    assert.deepEqual(back.sizes, wbState.sizes, "closing the station restores the workbench sizes")
    await page.evaluate(() => (window as any).stations.open("weather"))
    await page.waitForTimeout(1200)
    const st2 = await boxes(page)
    assert.equal(st2.dock!.h, st1.dock!.h, "reopening the station restores its dock height")
    report.station = { dockBefore: st0.dock!.h, dockAfter: st1.dock!.h, reopened: st2.dock!.h, workbenchSizes: back.sizes }
    await page.evaluate(() => (window as any).stations.close())
    await context.close()
  }

  // ── DPR 2: canvas follows the device-pixel box at each resolution setting. ──────────────────────────────────
  if (runs("dpr")) {
    const { context, page } = await openLab(SIZES[1]!)
    await invoke(page, "layout.panels", { reset: true })
    await frames(page, 3)
    const auto = await boxes(page)
    assertCanvasFits(auto, "DPR 2 auto", 1.5)
    await page.locator('[data-action="more"]').click()
    await page.locator('[data-resolution="device"]').click()
    await frames(page, 3)
    const dev = await boxes(page)
    assertCanvasFits(dev, "DPR 2 device", 2)
    await drag(page, "left", 120, 0)
    const dev2 = await boxes(page)
    assertCanvasFits(dev2, "DPR 2 device after drag", 2)
    await page.screenshot({ path: resolve(out, "device-pixels-1728x1117@2x.png") })
    await page.locator('[data-action="more"]').click()
    await page.locator('[data-resolution="auto"]').click()
    report.dpr2 = { auto: auto.canvas, device: dev.canvas, deviceAfterDrag: dev2.canvas }
    await context.close()
  }

  // ── Keyboard navigation in the Library (1440×900). ──────────────────────────────────────────────────────────
  if (runs("keyboard")) {
    const { context, page } = await openLab(SIZES[0]!)
    await invoke(page, "layout.panels", { reset: true })
    await page.evaluate(() => localStorage.removeItem("arcade.lab.library-view"))
    await invoke(page, "library.toggle", { open: true, category: "foliage" })
    await invoke(page, "library.view", { view: "tiles", group: "" })
    const active = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { id: el?.dataset.catalogId ?? null, cls: el?.className ?? "", tag: el?.tagName ?? "", group: el?.dataset.group ?? null, cat: el?.dataset.cat ?? null }
    })
    const muted0 = await page.evaluate(() => (window as any).labSound?.telemetry?.().muted ?? null)
    const seq: unknown[] = []
    report.keyboard = { sequence: seq }
    await page.locator(".lab-viewport > canvas").click({ position: { x: 300, y: 200 } })
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+Space") // closes (it was open)
    await page.keyboard.press("Control+Space") // opens and focuses search
    assert.equal((await active()).tag, "INPUT", "Ctrl+Space focuses Search library")
    await page.keyboard.press("ArrowDown")
    let a = await active()
    seq.push(["ArrowDown from search", a.id])
    assert.equal(a.id, "foliage:vegetation-tool:tree", "↓ from search focuses the first item")
    await page.keyboard.press("ArrowRight")
    a = await active()
    seq.push(["ArrowRight", a.id])
    assert.equal(a.id, "foliage:vegetation-tool:bush")
    await page.keyboard.press("ArrowDown")
    a = await active()
    seq.push(["ArrowDown", a.id])
    assert.equal(a.id, "foliage:vegetation-preset:tree:maple", "↓ keeps the column across a group heading")
    await page.screenshot({ path: resolve(out, "keyboard-focus-1440x900@1x.png") })
    const retrig0 = (await state(page)).transport
    await page.keyboard.press("Enter")
    await page.waitForTimeout(300)
    let st = await state(page)
    seq.push(["Enter", st.section, st.settings?.tool, st.settings?.treePreset])
    assert.equal(st.section, "foliage")
    assert.equal(st.settings.treePreset, "maple", "Enter applied the Maple preset")
    assert.equal((await active()).id, "foliage:vegetation-preset:tree:maple", "focus stays on the applied item")
    // Type to filter, then Space applies.
    await page.keyboard.type("pi")
    a = await active()
    assert.equal(a.tag, "INPUT", "typing in the grid moves to Search with the typed text")
    assert.equal(await page.locator('[data-control="library-search"]').inputValue(), "pi")
    await page.keyboard.press("ArrowDown")
    a = await active()
    seq.push(["type pi, ArrowDown", a.id])
    assert.equal(a.id, "foliage:vegetation-preset:tree:pine", "the filter leaves Pine first")
    await page.keyboard.press(" ")
    await page.waitForTimeout(300)
    st = await state(page)
    seq.push(["Space", st.settings?.treePreset])
    assert.equal(st.settings.treePreset, "pine", "Space applied the Pine preset")
    void retrig0
    // Shift+Tab reaches the collections list; ↓ picks the next collection.
    await page.keyboard.press("Escape")
    await invoke(page, "library.toggle", { open: true, category: "foliage", query: "" })
    await invoke(page, "library.view", { focus: true })
    await page.keyboard.press("Shift+Tab")
    a = await active()
    seq.push(["Shift+Tab", a.cls, a.group])
    if (a.cls.includes("lab-drawer-previews")) await page.keyboard.press("Shift+Tab"), (a = await active())
    assert(a.cls.includes("lab-drawer-group"), `Shift+Tab from the grid reaches the collections (${a.cls})`)
    await page.keyboard.press("ArrowDown")
    a = await active()
    seq.push(["ArrowDown in collections", a.group, (await state(page)).layout.library])
    assert.equal(a.group, "Tools", "↓ selects the Tools collection")
    await page.keyboard.press("ArrowRight")
    a = await active()
    assert.equal(a.id, "foliage:vegetation-tool:tree", "→ from the collections enters the grid")
    // Letters belong to the filter in the Library: M doesn't mute.
    await page.keyboard.press("Escape")
    await invoke(page, "library.view", { focus: true })
    await page.keyboard.press("m")
    const muted1 = await page.evaluate(() => (window as any).labSound?.telemetry?.().muted ?? null)
    assert.equal(muted1, muted0, "M typed in the Library filters instead of toggling mute")
    // Esc returns focus to the viewport.
    await page.keyboard.press("Escape") // search: clears
    await page.keyboard.press("Escape") // search: exits
    a = await active()
    assert.equal(a.tag, "CANVAS", "Esc returns focus to the viewport")
    // Play mode keeps its keys: with the canvas focused in Play, typing never reaches the Library.
    await invoke(page, "library.toggle", { open: true, category: "objects", query: "" })
    await page.locator(".lab-viewport > canvas").focus()
    await invoke(page, "mode.play").catch(() => null)
    const mode = (await state(page)).mode
    await page.keyboard.press("o")
    await page.keyboard.press("ArrowLeft")
    const lib = (await state(page)).layout.library
    assert.equal(lib.query, "", "Play-mode keys never type into the Library")
    assert.equal(lib.focused, false, "the Library stays unfocused in Play")
    report.keyboard = { sequence: seq, playMode: mode }
    await page.keyboard.press("Escape")
    await context.close()
  }
} catch (e) {
  if (e !== "done") throw e
} finally {
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  await server.close()
}
if (!shotsOnly && only !== "idle") assert.deepEqual(errors.filter(e => !/WebGPU|GPU adapter|unavailable/i.test(e)), [], "no page errors")
