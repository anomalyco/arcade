// Headless Metal proof, benchmark & capture script for the Style Playground ("Styles" station & section).
// Run via hivemind browser fleet:
//   hivemind run --kind browser --fetch captures/style-playground --fetch perf/style-playground.json -- bun games/lab/scripts/prove-styles.ts --serve
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { STYLE_LIST } from "../src/styles"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "../../..")
const outDir = resolve(root, "captures/style-playground")
const perfPath = resolve(root, "perf/style-playground.json")
mkdirSync(outDir, { recursive: true })
mkdirSync(resolve(root, "perf"), { recursive: true })

const port = String(5400 + Math.floor(Math.random() * 400))
const server = process.argv.includes("--serve")
  ? spawn("bun", ["scripts/dev.ts"], {
      cwd: root,
      env: { ...process.env, PORT: port, ARCADE_NO_GLOBAL_STATE: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    })
  : null

let base = `http://127.0.0.1:${port}`
if (server) {
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("dev server did not start in 60 s")), 60_000)
    server.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Arcade dev:")) {
        clearTimeout(timer)
        done()
      }
    })
  })
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const errors: string[] = []
type W = {
  stations: {
    snapshot(): { view: string; station: { id: string } | null; variant: { id: string } | null; section: string | null }
    open(id: string): Promise<boolean>
  }
  labPanel: {
    navigation: { settings: Record<string, unknown> }
  }
  labWorkbench: {
    invoke(id: string, args?: Record<string, unknown>): { ok: boolean; result?: unknown; error?: string }
    grid: { active: boolean; focusedTile: number | null }
  }
}

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

function mad(vals: number[], med: number): number {
  return median(vals.map(v => Math.abs(v - med)))
}

try {
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on("pageerror", e => {
    console.error("[pageerror]", e.message)
    errors.push(e.message)
  })
  page.on("console", m => {
    if (m.type() === "error" && !/favicon|status of (404|503)/.test(m.text())) {
      console.error("[console.error]", m.text())
      errors.push(m.text())
    }
  })

  await page.goto(`${base}/arcade/lab/?station=styles`)
  await page.waitForFunction(
    () => (window as unknown as W).stations?.snapshot().station?.id === "styles" && (window as unknown as W).stations?.snapshot().section === "styles",
    undefined,
    { timeout: 35_000 },
  )

  const gpuInfo = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    const info = adapter?.info
    return {
      vendor: info?.vendor ?? "unknown",
      architecture: info?.architecture ?? "unknown",
      device: info?.device ?? "unknown",
      hasTimestamps: Boolean(adapter?.features.has("timestamp-query")),
    }
  })
  assert.equal(gpuInfo.vendor, "apple", `Expected Apple Metal WebGPU adapter, got ${gpuInfo.vendor}`)

  // Pause simulation at hero combat tick (loopTime = 1.42s, tick 85) so all 9 styles show the exact same moment
  await page.evaluate(() => {
    const w = window as unknown as W
    w.labWorkbench.invoke("style.set", { key: "playing", value: false })
    w.labWorkbench.invoke("style.set", { key: "loopTime", value: 1.42 })
  })
  await page.waitForTimeout(800)

  // 1. Capture the 3×3 synchronized Variation Grid inside the Styles station
  const gridView = await page.evaluate(() => document.querySelector<HTMLElement>("[data-lab-grid-overlay]:not([hidden])")?.dataset.view ?? null)
  assert.equal(gridView, "grid", "Styles station opens with 3×3 variation grid active")
  await page.screenshot({ path: resolve(outDir, "00-station-3x3-grid.jpg"), type: "jpeg", quality: 92 })

  // Measure 3×3 Variation Grid frame cost across 9 frames
  const gridFrameSamples: number[] = []
  for (let i = 0; i < 9; i++) {
    const ms = await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const el = document.querySelector("[data-grid-cost]")?.textContent ?? ""
      const m = /([\d.]+)\s*ms/.exec(el)
      return m ? Number(m[1]) : 0
    })
    if (ms > 0) gridFrameSamples.push(ms)
  }

  // 2. Focus each style 1..9 with number keys Digit1..Digit9, capture clean frame & measure GPU ms
  const styleResults: Record<
    string,
    {
      index: number
      name: string
      file: string
      stylePassGpuMedianMs: number
      stylePassGpuMadMs: number
      rawStylePassSamplesMs: number[]
      scalingVerdict: string
    }
  > = {}

  for (let i = 0; i < STYLE_LIST.length; i++) {
    const mod = STYLE_LIST[i]!
    const num = i + 1
    // Press Digit1..Digit9 on the canvas to focus tile 1..9
    await page.locator('canvas[aria-label="Lab scene"]').click({ position: { x: 400, y: 300 } })
    if (i > 0) {
      // Return to grid first so Digit<num> tests focusing from grid
      await page.evaluate(() => (window as unknown as W).labWorkbench.invoke("grid.focus", { tile: 0 }))
      await page.waitForTimeout(100)
    }
    await page.keyboard.press(`Digit${num}`)
    await page.waitForTimeout(250)

    const focused = await page.evaluate(() => ({
      view: document.querySelector<HTMLElement>("[data-lab-grid-overlay]")?.dataset.view ?? null,
      badge: document.querySelector(".lab-grid-focus-badge")?.textContent ?? "",
      activeStyle: (window as unknown as W).labPanel.navigation.settings.style,
    }))
    assert.equal(focused.view, "focused", `Digit${num} focuses tile ${num}`)
    assert.equal(focused.badge, `${num}/9`, `Digit${num} shows badge ${num}/9`)
    assert.equal(focused.activeStyle, mod.id, `Tile ${num} sets active style to ${mod.id}`)

    // Ensure hero combat moment (loopTime = 1.42s) and default peopleStyle for this style
    await page.evaluate(
      ({ people }) => {
        const w = window as unknown as W
        w.labWorkbench.invoke("style.set", { key: "peopleStyle", value: people })
        w.labWorkbench.invoke("style.set", { key: "loopTime", value: 1.42 })
      },
      { people: mod.defaultPeople },
    )
    await page.waitForTimeout(300)

    // Hide workbench chrome + grid focus bar briefly to capture clean 1536×1024 style frame matching concept targets
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("[data-lab-workbench]")!.dataset.chromeHidden = "true"
      const hud = document.querySelector<HTMLElement>(".lab-viewport-hud")
      if (hud) hud.style.visibility = "hidden"
    })
    // Warm up 5 frames so scene G-buffer cache is warm and isolated style pass timestamps settle
    await page.waitForTimeout(260)

    const fileName = `0${num}-${mod.id}.jpg`
    await page.locator('canvas[aria-label="Lab scene"]').screenshot({
      path: resolve(outDir, fileName),
      type: "jpeg",
      quality: 92,
    })

    // Collect 9 GPU timestamp samples for this style
    const samples: number[] = []
    for (let s = 0; s < 9; s++) {
      await page.waitForTimeout(55)
      const ms = await page.evaluate(() => {
        const stats = document.querySelector('[data-readout="stats"]')?.textContent ?? ""
        const m = /style GPU ([\d.]+) ms/.exec(stats)
        return m ? Number(m[1]) : null
      })
      if (ms !== null && ms > 0) samples.push(ms)
    }

    await page.evaluate(() => {
      delete document.querySelector<HTMLElement>("[data-lab-workbench]")!.dataset.chromeHidden
      const hud = document.querySelector<HTMLElement>(".lab-viewport-hud")
      if (hud) hud.style.visibility = ""
    })

    const med = Number(median(samples).toFixed(3))
    const spread = Number(mad(samples, med).toFixed(3))
    styleResults[mod.id] = {
      index: num,
      name: mod.name,
      file: fileName,
      stylePassGpuMedianMs: med,
      stylePassGpuMadMs: spread,
      rawStylePassSamplesMs: samples,
      scalingVerdict: mod.scaling.verdict,
    }
  }

  // 3. Verify all 4 minimal people shapes (blocky, capsule, pawn, rig) and knob mutations
  const peopleCheck: string[] = []
  for (const pMode of ["blocky", "capsule", "pawn", "rig"] as const) {
    const res = await page.evaluate(mode => (window as unknown as W).labWorkbench.invoke("style.set", { key: "peopleStyle", value: mode }), pMode)
    assert(res.ok, `peopleStyle=${pMode} succeeded`)
    await page.waitForTimeout(120)
    peopleCheck.push(pMode)
  }

  // Return to 3×3 grid with live playback enabled
  await page.evaluate(() => {
    const w = window as unknown as W
    w.labWorkbench.invoke("style.set", { key: "peopleStyle", value: "blocky" })
    w.labWorkbench.invoke("grid.focus", { tile: 0 })
  })
  await page.waitForTimeout(400)
  // Capture clean 3×3 canvas-only grid
  await page.locator('canvas[aria-label="Lab scene"]').screenshot({
    path: resolve(outDir, "3x3-styles-canvas.jpg"),
    type: "jpeg",
    quality: 92,
  })

  assert.deepEqual(errors, [], `Unexpected console/page errors: ${errors.join("; ")}`)

  const summary = {
    date: new Date().toISOString(),
    hardware: gpuInfo,
    viewport: [1536, 1024],
    heroTick: 85,
    heroLoopTimeSec: 1.42,
    grid3x3MedianWallMs: Number(median(gridFrameSamples).toFixed(2)),
    peopleModesVerified: peopleCheck,
    styles: styleResults,
  }
  writeFileSync(perfPath, JSON.stringify(summary, null, 2) + "\n")
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser.close()
  server?.kill()
}
