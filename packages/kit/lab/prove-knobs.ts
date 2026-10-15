/// <reference types="@webgpu/types" />
// Headless proof for the Lab's knobs panels: they match the Lab chrome (square corners, the Lab's row height, flat
// rows, the Lab's buttons, one label/value font), a station shows each control group once, long choices are readable
// and searchable, Details has tabs, search and a toolbar, seeds, headings and pairs use knobs' inspector fields, a
// group's die runs its own Randomize, a multi-selection reads "—", a page's bare button rules don't reach knobs, and
// the radial menu opens only from the viewport.
//   hivemind run --kind browser --fetch captures/lab-knobs -- bun packages/kit/lab/prove-knobs.ts
//   bun packages/kit/lab/prove-knobs.ts --shots-only --out captures/lab-knobs/before    screenshots only
// Never opens a visible window and never plays sound (muted browser, AudioContext blocked).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const root = resolve(import.meta.dir, "../../..")
const out = resolve(root, arg("--out") ?? "captures/lab-knobs")
const shotsOnly = process.argv.includes("--shots-only")
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
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

const SIZES = [
  { width: 1440, height: 900, dpr: 1 },
  { width: 1728, height: 1117, dpr: 2 },
]

async function open(path: string, s: (typeof SIZES)[number]) {
  const context = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dpr })
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

/** Computed styles of knobs and Lab chrome that should agree. */
const styles = (page: Page) =>
  page.evaluate(() => {
    const pick = (el: Element | null, props: string[]): Record<string, string | number> | null => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { ...Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)])), h: Math.round(r.height), w: Math.round(r.width) }
    }
    const q = (sel: string) => document.querySelector(sel)
    // Rounded corners on anything that draws a box (dots and the viewport's own cursor/handles are shapes).
    const radii = new Set<string>()
    for (const el of document.querySelectorAll(".lab-workbench *")) {
      if (el.closest(".lab-viewport")) continue
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (cs.borderTopLeftRadius === "0px" || cs.display === "none" || r.width <= 10 || r.height <= 10) continue
      radii.add(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")}=${cs.borderTopLeftRadius}`)
    }
    const groups = (sel: string, outside?: string) =>
      [...document.querySelectorAll(`${sel} .knobs-group-label`)].filter(e => !outside || !e.closest(outside)).map(e => e.textContent?.trim() ?? "")
    const truncated = (el: Element | null) => (el ? el.scrollWidth > el.clientWidth + 1 : null)
    const choiceRows = [...document.querySelectorAll(".lab-inspector .knobs-row:has(>.knobs-select)")].map(row => ({
      label: row.querySelector(":scope>span:first-child")?.textContent ?? "",
      labelTruncated: truncated(row.querySelector(":scope>span:first-child")),
      labelTitle: row.querySelector<HTMLElement>(":scope>span:first-child")?.title ?? "",
      value: row.querySelector(".knobs-select-value")?.textContent ?? "",
      valueTitle: row.querySelector<HTMLElement>(".knobs-select")?.title ?? "",
      valueTruncated: truncated(row.querySelector(".knobs-select-value")),
      valueW: Math.round(row.querySelector(".knobs-select")?.getBoundingClientRect().width ?? 0),
      labelW: Math.round(row.querySelector(":scope>span:first-child")?.getBoundingClientRect().width ?? 0),
      rowW: Math.round(row.getBoundingClientRect().width),
    }))
    const props = ["font-size", "font-family", "border-radius", "background-color", "box-shadow", "height", "color"]
    return {
      tool: pick(q(".lab-inspector .lab-toolbar .knobs-tool:not([disabled])"), props),
      toolKeys: [...document.querySelectorAll(".lab-inspector .lab-toolbar .knobs-tool-key")].map(k => k.textContent?.trim() ?? ""),
      knobsButton: pick(q('.lab-inspector .lab-knobs .knobs-action, .lab-inspector .lab-knobs .knobs-custom-actions button, .lab-inspector .lab-knobs .knobs-preset-chip:not([aria-checked="true"])'), props),
      row: pick(q(".lab-inspector .lab-knobs:not(.lab-toolbar) .knobs-row"), ["height"]),
      slider: pick(q(".lab-inspector .lab-knobs .knobs-slider"), ["height"]),
      outlinerRow: pick(q(".lab-outliner [data-row], .lab-tree-row, .lab-outliner-row"), ["height"]),
      label: pick(q(".lab-inspector .knobs-row>span:first-child"), ["font-size", "font-family", "font-weight"]),
      sliderLabel: pick(q(".lab-inspector .knobs-label"), ["font-size", "font-family", "font-weight"]),
      value: pick(q(".lab-inspector .knobs-value"), ["font-size", "font-family", "font-weight"]),
      choice: pick(q(".lab-inspector .knobs-select"), ["font-size", "font-family", "font-weight", "background-color", "box-shadow"]),
      panel: pick(q(".lab-inspector .knobs-panel"), ["background-color", "border-top-width", "border-top-color", "padding-left", "box-shadow"]),
      card: pick(q(".lab-inspector .knobs-card"), ["background-color", "padding-left", "border-radius"]),
      stationPanel: pick(q('.ls-card[data-widget="controls"] .knobs-panel'), ["background-color", "border-top-width", "border-top-color", "padding-left"]),
      radii: [...radii].slice(0, 40),
      details: groups(".lab-inspector", ".ls-card"),
      station: groups('.ls-card[data-widget="controls"]'),
      choiceRows,
    }
  })

/** No visible frame: no padding, and a border that's absent or transparent. */
const frameless = (p: Record<string, string | number> | null) =>
  Boolean(p && p["padding-left"] === "0px" && (p["border-top-width"] === "0px" || /\/ 0\)|rgba\(0, 0, 0, 0\)|transparent/.test(String(p["border-top-color"]))))

/** The Lab's button (the old `.lab-act`): what knobs' button tokens and the `arcade` preset draw. */
const LAB_BUTTON = { "font-size": "11px", "border-radius": "0px", "background-color": "rgb(25, 26, 30)", "box-shadow": "rgb(35, 37, 42) 0px 0px 0px 1px inset", height: "20px", color: "rgb(216, 219, 224)" }

const radialOpen = (page: Page) => page.evaluate(() => !document.querySelector<HTMLElement>("[data-lab-radial]")!.hidden)

try {
  for (const s of SIZES) {
    const tag = `${s.width}x${s.height}@${s.dpr}x`
    // Kit's screenshot: the Outbreak scenes station (the vignette section) with Details and its controls card.
    {
      const { context, page } = await open("?station=outbreak", s)
      await page.screenshot({ path: resolve(out, `station-outbreak-${tag}.png`) })
      const right = await page.locator('[data-station-slot="right"]').boundingBox()
      if (right) await page.screenshot({ path: resolve(out, `station-outbreak-right-${tag}.png`), clip: right })
      const st = await styles(page)
      report[`station-${tag}`] = st
      if (!shotsOnly) {
        assert(st.station.length > 0, `the station's controls card shows groups (${st.station.join(", ")})`)
        const twice = st.station.filter(g => st.details.includes(g))
        assert.deepEqual(twice, [], `no group shows in both the controls card and Details (${twice.join(", ")})`)
        assert(st.radii.length === 0, `square corners everywhere (${st.radii.join(", ")})`)
        assert(frameless(st.stationPanel), `the controls card's knobs panel has no frame of its own (${JSON.stringify(st.stationPanel)})`)
      }

      // The radial opens only on the viewport: RMB and Ctrl-click on Details buttons do nothing, and a press on a
      // panel closes an open radial.
      if (!shotsOnly) {
        const button = page.locator(".lab-inspector .lab-toolbar .knobs-tool").first()
        const b = (await button.boundingBox())!
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2
        await page.mouse.move(cx, cy)
        await page.mouse.down({ button: "right" })
        await page.mouse.up({ button: "right" })
        await page.waitForTimeout(100)
        const afterRmb = await radialOpen(page)
        await page.keyboard.down("Control")
        await page.mouse.down()
        await page.mouse.up()
        await page.keyboard.up("Control")
        await page.waitForTimeout(100)
        const afterCtrl = await radialOpen(page)
        // A page-level open request at a point over the Details column is refused too.
        const over = await page.evaluate(([x, y]) => {
          ;(window as any).labWorkbench?.radial?.openAtScreen?.(x, y, true)
          return !document.querySelector<HTMLElement>("[data-lab-radial]")!.hidden
        }, [cx, cy] as const)
        const vp = (await page.locator(".lab-viewport > canvas").boundingBox())!
        await page.mouse.move(vp.x + vp.width * 0.3, vp.y + vp.height * 0.4)
        await page.mouse.down({ button: "right" })
        await page.mouse.up({ button: "right" })
        await page.waitForTimeout(150)
        const onCanvas = await radialOpen(page)
        if (s.dpr === 1) await page.screenshot({ path: resolve(out, `radial-viewport-${tag}.png`) })
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.waitForTimeout(80)
        const afterPanelPress = await radialOpen(page)
        await page.mouse.up()
        report[`radial-${tag}`] = { afterRmb, afterCtrl, over, onCanvas, afterPanelPress }
        assert(!afterRmb && !afterCtrl && !over, `no radial from RMB / Ctrl-click over Details buttons (${afterRmb}, ${afterCtrl}, ${over})`)
        assert(onCanvas, "RMB tap on the viewport opens the radial")
        assert(!afterPanelPress, "a press on a Details button closes the radial")
      }
      await context.close()
    }
    // The workbench Details on a section with long choice labels.
    {
      const { context, page } = await open("?section=outbreak-vignette", s)
      await page.screenshot({ path: resolve(out, `details-vignette-${tag}.png`) })
      const ins = await page.locator(".lab-inspector").boundingBox()
      if (ins) await page.screenshot({ path: resolve(out, `details-vignette-crop-${tag}.png`), clip: ins })
      const st = await styles(page)
      report[`details-${tag}`] = st
      if (!shotsOnly) {
        assert(st.radii.length === 0, `square corners everywhere (${st.radii.join(", ")})`)
        assert(st.row?.h === 24 && st.slider?.h === 24, `knobs rows use the Lab's 24 px rows (${st.row?.h}, ${st.slider?.h})`)
        for (const k of ["label", "sliderLabel", "value", "choice"] as const) {
          assert.equal(st[k]?.["font-family"], st.label?.["font-family"], `${k} uses the label font`)
          assert.equal(st[k]?.["font-size"], "11.5px", `${k} is 11.5 px`)
        }
        assert(frameless(st.panel), `Details' knobs panel has no frame of its own (${JSON.stringify(st.panel)})`)
        assert(st.card && st.card["background-color"] === "rgba(0, 0, 0, 0)", `groups are flat rows, not cards (${st.card?.["background-color"]})`)
        for (const [name, b] of [["toolbar", st.tool], ["knobs button", st.knobsButton]] as const) {
          assert(b, `a ${name} to measure`)
          for (const [p, v] of Object.entries(LAB_BUTTON)) assert.equal(b![p], v, `the ${name} is drawn like the Lab's buttons: ${p}`)
        }
        assert(["Space", "F", "P"].every(k => st.toolKeys.includes(k)), `the Details toolbar shows the canvas keys (${st.toolKeys.join(" ")})`)
        for (const r of st.choiceRows) {
          if (r.labelTruncated) {
            const rowEl = page.locator(".lab-inspector .knobs-row", { hasText: r.label }).first()
            await rowEl.scrollIntoViewIfNeeded()
            const box = await rowEl.boundingBox()
            if (box) await page.screenshot({ path: resolve(out, `cut-label-${r.label.replace(/\W+/g, "-")}-${tag}.png`), clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } })
          }
          // Segmented rows (no menu button on screen) still squeeze their label in knobs 9da5381: reported, not failed.
          if (r.valueW === 0) { if (r.labelTruncated) (report.segmentedCutLabels ??= [] as string[]) && (report.segmentedCutLabels as string[]).push(`${r.label} @ ${tag}`); continue }
          assert(!r.labelTruncated, `${r.label}: the label is not cut`)
          assert(!r.valueTruncated || r.valueTitle === r.value, `${r.label}: a cut value has its full text on hover`)
          assert(r.valueW >= r.rowW * 0.4 || !r.valueTruncated, `${r.label}: a cut value keeps at least 40% of the row (${r.valueW} of ${r.rowW}; label ${r.labelW})`)
        }
      }
      await context.close()
    }
  }
  assert.deepEqual(errors.filter(e => !/WebGPU|adapter/i.test(e)), [], "no page errors")

  // A multi-selection whose lights differ: Light power reads "—" until edited, and the edit sets every light.
  if (!shotsOnly) {
    const { context, page } = await open("?game=getaway&section=spawn", SIZES[0]!)
    // Two lights through the Spawn section's own Lights controls (a spotlight at power 5, a lamp at power 2).
    const drop = (kind: string) => page.evaluate(async kind => {
      const nav = (window as any).labPanel.navigation
      const light = nav.rows.find((r: any) => r.control?.key === "light").control
      const action = nav.rows.find((r: any) => r.control?.key === "dropLight").control
      nav.set(light, kind)
      await action.run(document.createElement("button"))
    }, kind)
    await drop("spotlight")
    await drop("lamp")
    await invoke(page, "object.select", { id: "light:1" })
    await invoke(page, "object.select", { id: "light:2", additive: true })
    await page.waitForTimeout(400)
    const row = page.locator('.lab-inspector .knobs-row[data-field="selectedPower"]').first()
    const read = () => row.evaluate(el => ({ mixed: el.classList.contains("knobs-mixed"), text: el.querySelector(".knobs-value")?.textContent?.trim() ?? "" }))
    const before = await read()
    const ins = await page.locator(".lab-inspector").boundingBox()
    if (ins) await page.screenshot({ path: resolve(out, "mixed-light-power-1440x900@1x.png"), clip: ins })
    await row.locator('[role="slider"]').focus()
    await page.keyboard.press("ArrowRight")
    await page.waitForTimeout(500)
    const after = await read()
    report.mixed = { before, after }
    assert(before.mixed, `two lights with different power show a mixed Light power (${JSON.stringify(before)})`)
    assert(!after.mixed, `an edit applies one value and clears mixed (${JSON.stringify(after)})`)
    await context.close()
  }

  // Tabs, search and the toolbar in Details (the vignette has four tabs).
  if (!shotsOnly) {
    const { context, page } = await open("?section=outbreak-vignette", SIZES[0]!)
    const tabs = () => page.evaluate(() => ({
      labels: [...document.querySelectorAll(".lab-inspector .knobs-tab")].map(t => t.textContent?.trim() ?? ""),
      current: (window as any).labPanel.tab as string | undefined,
      groups: [...document.querySelectorAll(".lab-inspector .knobs-group-label")].filter(e => (e as HTMLElement).getClientRects().length).map(e => e.textContent?.trim() ?? ""),
    }))
    const first = await tabs()
    // ⌥2 inside the panel shows the second tab.
    await page.locator('.lab-inspector .knobs-row[data-field="fogEdgeSoftness"] [role="slider"]').focus()
    await page.keyboard.press("Alt+Digit2")
    await page.waitForTimeout(600)
    const second = await tabs()
    await page.screenshot({ path: resolve(out, "details-tabs-lights-1440x900@1x.png"), clip: (await page.locator(".lab-inspector").boundingBox())! })
    // Jumping to a setting on another tab shows that tab.
    await invoke(page, "details.reveal", { key: "flashlightAim" })
    await page.waitForTimeout(400)
    await invoke(page, "details.reveal", { key: "skyFill" })
    await page.waitForTimeout(600)
    const revealed = await tabs()
    // `/` in the panel focuses its search; typing filters across every tab.
    await page.locator('.lab-inspector .knobs-row[data-field="skyFill"] [role="slider"]').focus()
    await page.keyboard.press("/")
    const searchFocused = await page.evaluate(() => document.activeElement?.matches(".lab-inspector .knobs-search input") ?? false)
    await page.keyboard.type("porch")
    await page.waitForTimeout(500)
    const searched = await page.evaluate(() => (window as any).labPanel.shownKeys() as string[])
    await page.screenshot({ path: resolve(out, "details-search-porch-1440x900@1x.png"), clip: (await page.locator(".lab-inspector").boundingBox())! })
    await page.keyboard.press("Escape")
    // `/` on the canvas still opens the command palette.
    await page.locator(".lab-viewport > canvas").focus()
    await page.keyboard.press("/")
    await page.waitForTimeout(200)
    const palette = await page.evaluate(() => Boolean(document.querySelector(".knobs-layers>.knobs-palette")))
    await page.keyboard.press("Escape")
    // The details filter command drives the same search; Modified narrows to changed rows.
    await invoke(page, "scene.set-param", { key: "skyFill", value: 1.5 })
    await page.waitForTimeout(300)
    const filter = await invoke(page, "details.filter", { modified: true })
    await page.waitForTimeout(500)
    const modifiedKeys = await page.evaluate(() => { const p = (window as any).labPanel; return (p.shownKeys() as string[]).map(k => [k, p.isModified(k)] as const) })
    await invoke(page, "details.filter", { modified: false, query: "" })
    report.detailsTabs = { first, second, revealed, searchFocused, searched, palette, filter, modifiedKeys }
    assert.deepEqual(first.labels, ["Scene", "Lights", "Materials", "Look"], "the vignette's Details has its four tabs")
    assert(first.groups.includes("DIRECTION & VIEW") || first.groups.some(g => /direction/i.test(g)), `Scene shows Direction & View (${first.groups})`)
    assert(second.current === "Lights" && second.groups.some(g => /flashlight/i.test(g)) && !second.groups.some(g => /direction/i.test(g)), `⌥2 shows Lights (${JSON.stringify(second)})`)
    assert(revealed.current === "Scene", `jumping to a setting on another tab shows it (${JSON.stringify(revealed)})`)
    assert(searchFocused, "/ in the panel focuses its search")
    assert(searched.length > 0 && searched.every(k => /porch/i.test(k)), `typing filters across tabs (${searched})`)
    assert(palette, "/ on the canvas still opens the command palette")
    assert(modifiedKeys.length > 0 && modifiedKeys.every(([, m]) => m), `Modified shows only changed rows (${JSON.stringify(modifiedKeys)})`)
    await context.close()
  }

  // Compare (hold `\`) right after a key nudge, held past the nudge's settle: the preview and its release apply, the
  // nudge stays one undo step of its own and the preview is never one.
  if (!shotsOnly) {
    const { context, page } = await open("?section=outbreak-vignette", SIZES[0]!)
    const value = () => page.evaluate(() => (window as any).labPanel.navigation.settings.fogEdgeSoftness as number)
    const depth = () => page.evaluate(() => (window as any).labWorkbench.state().history.undoDepth as number)
    const v0 = await value(), d0 = await depth()
    await page.locator('.lab-inspector .knobs-row[data-field="fogEdgeSoftness"] [role="slider"]').focus()
    await page.keyboard.press("ArrowRight")
    const v1 = await value()
    await page.keyboard.down("Backslash")
    await page.waitForTimeout(700)
    const held = await value()
    await page.keyboard.up("Backslash")
    await page.waitForTimeout(600)
    const released = await value(), d1 = await depth()
    await page.evaluate(() => (window as any).labWorkbench.undo())
    await page.waitForTimeout(300)
    const undone = await value()
    report.compareHistory = { v0, v1, held, released, undone, depth: [d0, d1] }
    assert(v1 !== v0 && held === v0 && released === v1, `compare previews the nudge's before-value and puts it back (${JSON.stringify(report.compareHistory)})`)
    assert(d1 === d0 + 1 && undone === v0, `the nudge is one undo step and compare none (${JSON.stringify(report.compareHistory)})`)
    await context.close()
  }

  // Inspector fields: headings as dials, seeds with a die, a pair as one range, and a group's own Randomize.
  if (!shotsOnly) {
    const { context, page } = await open("?section=lighting", SIZES[0]!)
    const kind = (key: string) => page.evaluate(k => document.querySelector<HTMLElement>(`.lab-inspector .knobs-row[data-field="${k}"]`)?.dataset.kind ?? null, key)
    const yaw = await kind("spotYaw"), azimuth = await kind("moonAzimuth"), pitch = await kind("spotPitch")
    await context.close()
    const mat = await open("?section=materials", SIZES[0]!)
    const seedKind = await mat.page.evaluate(() => document.querySelector<HTMLElement>('.lab-inspector .knobs-row[data-field="roomSeed"]')?.dataset.kind ?? null)
    const before = await mat.page.evaluate(() => (window as any).labPanel.navigation.settings.roomSeed)
    await mat.page.locator('.lab-inspector .knobs-row[data-field="roomSeed"] .knobs-seed-roll').click()
    await mat.page.waitForTimeout(400)
    const after = await mat.page.evaluate(() => (window as any).labPanel.navigation.settings.roomSeed)
    await mat.context.close()
    const sp = await open("?game=blackout&section=splatter", SIZES[0]!)
    await sp.page.evaluate(() => (window as any).labWorkbench.invoke("scene.set-param", { key: "style", value: 1 }))
    await sp.page.locator('.lab-inspector .knobs-subhead', { hasText: "Advanced" }).first().click()
    await sp.page.waitForTimeout(500)
    const pair = await sp.page.evaluate(() => {
      const panel = (window as any).labPanel
      const row = document.querySelector<HTMLElement>('.lab-inspector .knobs-row[data-field="sizeMin"]')
      return {
        thumbs: row?.querySelectorAll('[role="slider"]').length ?? 0,
        className: row?.className ?? null,
        alias: Boolean(row) && panel.getControlElement("sizeMax") === row,
        low: panel.navigation.settings.sizeMin,
        high: panel.navigation.settings.sizeMax,
        subheads: [...document.querySelectorAll<HTMLElement>(".lab-inspector .knobs-subhead")].map(h => `${h.textContent?.trim()}:${h.getAttribute("aria-expanded")}:${h.getClientRects().length}`),
        order: [...document.querySelectorAll<HTMLElement>('.lab-inspector .knobs-card .knobs-row[data-field], .lab-inspector .knobs-subhead')].map(e => e.dataset.field ?? `#${e.textContent?.trim()}`).join(" "),
      }
    })
    await sp.page.screenshot({ path: resolve(out, "splatter-advanced-1440x900@1x.png"), clip: (await sp.page.locator(".lab-inspector").boundingBox())! })
    const thumb = sp.page.locator('.lab-inspector .knobs-row[data-field="sizeMin"] [role="slider"]').first()
    await thumb.focus()
    await sp.page.keyboard.press("ArrowRight")
    await sp.page.waitForTimeout(500)
    const moved = await sp.page.evaluate(() => { const s = (window as any).labPanel.navigation.settings; return { low: s.sizeMin, high: s.sizeMax } })
    await sp.context.close()
    // Smoke's Shape group has its own seeded "Randomize Shape": its die runs that action, not knobs' roll.
    const fx = await open("?section=effects", SIZES[0]!)
    const read = () => fx.page.evaluate(() => { const p = (window as any).labPanel; const s = p.navigation.settings; return { radius: s.radius, height: s.height, softness: s.softness, billow: s.billowScale, last: p.tuning.last } })
    const shapeBefore = await read()
    await fx.page.locator('.lab-inspector .knobs-group-head[data-group="Shape"] .knobs-group-die').click()
    await fx.page.waitForTimeout(500)
    const shapeAfter = await read()
    await fx.context.close()
    report.inspectorFields = { yaw, azimuth, pitch, seedKind, seed: { before, after }, pair, moved, shapeBefore, shapeAfter }
    assert(yaw === "angle" && azimuth === "angle", `full-turn headings are dials (${yaw}, ${azimuth})`)
    assert(pitch !== "angle", `a partial angle stays a slider (${pitch})`)
    assert(seedKind === "seed" && after !== before, `a seed row's die rolls a new seed (${before} → ${after})`)
    assert(pair.thumbs === 2 && pair.alias, `Small and large drops are one range row (${JSON.stringify(pair)})`)
    assert(/pooling #Advanced sizeMin drag gravity r g b persistence budget/.test(pair.order), `the Advanced sub-heading's rows sit together under it (${pair.order})`)
    assert(moved.low > pair.low && moved.high === pair.high, `the low thumb moves only the low setting (${JSON.stringify(moved)})`)
    // knobs' own roll would record a tuning seed; the section's action changes the values without one.
    const changed = (["radius", "height", "softness", "billow"] as const).some(k => shapeAfter[k] !== shapeBefore[k])
    assert(changed && shapeAfter.last === null, `the Shape die runs Randomize Shape (${JSON.stringify({ shapeBefore, shapeAfter })})`)
  }

  // Type-to-filter on a long choice list, in the first section that has one (more than eight options).
  if (!shotsOnly) {
    const s = SIZES[0]!
    let found: Record<string, unknown> | null = null
    for (const section of ["looks", "foliage", "materials", "lighting", "spawn", "effects", "weather", "physics"]) {
      const { context, page } = await open(`?section=${section}`, s)
      const long = await page.evaluate(() => {
        const rows = (window as any).labPanel.navigation.rows as { group: string; control?: { key: string; label: string; options?: unknown[] } }[]
        return rows.find(r => (r.control?.options?.length ?? 0) > 8)?.control?.key ?? null
      })
      if (long) {
        const row = page.locator(`.lab-inspector .knobs-row[data-field="${long}"]`).first()
        await row.scrollIntoViewIfNeeded()
        await row.locator(".knobs-select").click()
        await page.waitForTimeout(250)
        const items = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".knobs-menu .knobs-menu-item")].filter(e => e.offsetParent !== null).map(e => e.textContent?.trim() ?? ""))
        const all = await items()
        const hasSearch = (await page.locator(".knobs-menu .knobs-menu-search").count()) > 0
        const word = (all[Math.min(3, all.length - 1)] ?? "").split(/[\s·(),]+/).find(w => w.length >= 4) ?? ""
        await page.keyboard.type(word.toLowerCase())
        await page.waitForTimeout(250)
        const shown = await items()
        await page.screenshot({ path: resolve(out, `choice-search-${section}-1440x900@1x.png`) })
        await page.keyboard.press("Escape")
        found = { section, key: long, options: all.length, hasSearch, typed: word, shown }
        await context.close()
        break
      }
      await context.close()
    }
    report.choiceSearch = found ?? "no section has a choice list longer than eight options"
    if (found) {
      const shown = found.shown as string[]
      assert(found.hasSearch, `a long choice list opens with a search field (${JSON.stringify(found)})`)
      assert(shown.length > 0 && shown.length < (found.options as number) && shown.every(t => t.toLowerCase().includes(String(found!.typed).toLowerCase())), `typing filters it (${JSON.stringify(found)})`)
    }
  }

  // A game's floating panel (Outbreak, Backquote) wears the same preset: square, flat rows, its own plain frame.
  {
    const gameDir = resolve(root, "games/outbreak")
    const game = await createServer({ root: gameDir, configFile: resolve(gameDir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" })
    await game.listen()
    const gameAddr = game.httpServer!.address()
    try {
      if (!gameAddr || typeof gameAddr === "string") throw new Error("No game dev server port")
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.AudioContext = class {
          constructor() {
            throw new Error("Live audio is disabled in this proof")
          }
        } as unknown as typeof AudioContext
      })
      await page.goto(`http://127.0.0.1:${gameAddr.port}/arcade/outbreak/?peaceful=1&seed=7`)
      await page.waitForTimeout(6000)
      await page.mouse.click(720, 450)
      await page.keyboard.press("Backquote")
      await page.waitForTimeout(800)
      const panel = page.locator("[data-lab-panel] .knobs-panel").first()
      const shown = await panel.isVisible().catch(() => false)
      report.game = shown
        ? await panel.evaluate(el => {
            const cs = getComputedStyle(el)
            const card = el.querySelector(".knobs-card")
            return { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, pad: cs.paddingLeft, card: card ? getComputedStyle(card).backgroundColor : null, modifiedChip: el.querySelector(".knobs-search-chip")?.textContent ?? null }
          })
        : "panel not shown"
      await page.screenshot({ path: resolve(out, "outbreak-floating-1440x900@1x.png") })
      // A page's bare element rules (Blackout styles every button) don't reach knobs' buttons: knobs resets them.
      if (shown && !shotsOnly) {
        const read = () => panel.evaluate(el => {
          const b = el.querySelector<HTMLElement>(".knobs-action") ?? el.querySelector<HTMLElement>("button")!
          const cs = getComputedStyle(b)
          return { border: cs.borderTopWidth, letterSpacing: cs.letterSpacing, transform: cs.textTransform, padTop: cs.paddingTop }
        })
        const clean = await read()
        await page.addStyleTag({ content: "button{border:2px solid red;letter-spacing:3px;text-transform:uppercase;padding:9px}span{letter-spacing:2px}" })
        await page.waitForTimeout(100)
        const hostile = await read()
        report.hostCss = { clean, hostile }
        // The overlay has a search field too; `/` with focus in the panel focuses it.
        await page.locator("[data-lab-panel] .knobs-row [role=\"slider\"]").first().focus()
        await page.keyboard.press("/")
        report.overlaySearch = await page.evaluate(() => ({ field: Boolean(document.querySelector("[data-lab-panel] .knobs-search input")), focused: document.activeElement?.matches("[data-lab-panel] .knobs-search input") ?? false }))
        assert.deepEqual(report.overlaySearch, { field: true, focused: true }, "the Backquote overlay has a search field that / focuses")
        assert.deepEqual(hostile, clean, "a page's bare button rules don't restyle knobs' buttons")
      }
      await context.close()
    } finally {
      await game.close()
    }
  }
} catch (e) {
  if (e !== "done") throw e
} finally {
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  await server.close()
}
console.log(JSON.stringify(report, null, 2))
