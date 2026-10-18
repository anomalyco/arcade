/**
 * Captures before/after v7 stills at the start house (Ash) and other houses (Elm, Oak),
 * computes pixel diffs and image stats, and renders a side-by-side comparison sheet (`AR-51`).
 *
 *   bun scripts/shader-coords-proof.ts --phase before|after [--out <dir>]
 *
 * Headless Metal Chromium, muted, no visible window. Run through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const phase = arg("phase", "after")!
const out = resolve(arg("out", resolve(root, "../../captures/outbreak-shader-coords-cleanup"))!)
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(root, "../..")] } },
  plugins: [
    {
      name: "shader-coords-proof-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render })")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath)
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Scene = {
  name: string
  label: string
  hour: number
  zoom: number
  x: number
  y: number
  aim: number
  flashlight: boolean
}

const SCENES: Scene[] = [
  { name: "street-day-14h", label: "Start House (Ash) · Street Day 14:00", hour: 14, zoom: 46, x: 27.7, y: 41.0, aim: -Math.PI / 2, flashlight: false },
  { name: "street-dusk-18h30", label: "Start House (Ash) · Street Dusk 18:30", hour: 18.5, zoom: 46, x: 27.7, y: 41.0, aim: -Math.PI / 2, flashlight: true },
  { name: "street-night-21h", label: "Start House (Ash) · Street Night 21:00", hour: 21, zoom: 46, x: 27.7, y: 41.0, aim: -Math.PI / 2, flashlight: true },
  { name: "interior-night-21h", label: "Start House (Ash) · Interior Night 21:00", hour: 21, zoom: 46, x: 27.7, y: 31.8, aim: -Math.PI / 2, flashlight: true },
  { name: "elm-dusk-18h30", label: "214 Elm (South-West House) · Street Dusk 18:30", hour: 18.5, zoom: 46, x: 26.7, y: 70.5, aim: -Math.PI / 2, flashlight: true },
  { name: "oak-dusk-18h30", label: "310 Oak (South-East House) · Street Dusk 18:30", hour: 18.5, zoom: 46, x: 62.5, y: 72.5, aim: -Math.PI / 2, flashlight: true },
]

const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
const errors: string[] = []

async function open(width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`, { waitUntil: "domcontentloaded", timeout: 90000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  return page
}

async function setup(page: Page, s: Scene) {
  return page.evaluate(async s => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("propsOn", true)
    h.lookPreset("today")
    h.pose(s.x, s.y, s.aim)
    const pin = () => {
      const p = h.state().player
      p.x = s.x
      p.y = s.y
      p.aim = s.aim
      p.flashlightOn = s.flashlight
      p.flashlightOutput = s.flashlight ? 1 : 0
    }
    pin()
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if (props?.ready && (rugs?.settled ?? true) && performance.now() - t0 > 120) break
      await new Promise(r => setTimeout(r, 15))
    }
    for (let i = 0; i < 12; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
  }, s)
}

async function diffPngs(page: Page, beforeFile: string, afterFile: string) {
  const bUrl = `data:image/png;base64,${readFileSync(beforeFile).toString("base64")}`
  const aUrl = `data:image/png;base64,${readFileSync(afterFile).toString("base64")}`
  return page.evaluate(
    async ({ bUrl, aUrl }) => {
      const load = async (u: string) => {
        const img = new Image()
        img.src = u
        await img.decode()
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext("2d")!
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height)
      }
      const b = await load(bUrl)
      const a = await load(aUrl)
      let sumAbs = 0
      let changedgt2 = 0
      let changedgt8 = 0
      const pixels = b.data.length / 4
      for (let i = 0; i < b.data.length; i += 4) {
        const dr = Math.abs(b.data[i]! - a.data[i]!)
        const dg = Math.abs(b.data[i + 1]! - a.data[i + 1]!)
        const db = Math.abs(b.data[i + 2]! - a.data[i + 2]!)
        const m = Math.max(dr, dg, db)
        sumAbs += (dr + dg + db) / (3 * 255)
        if (m > 2) changedgt2++
        if (m > 8) changedgt8++
      }
      return {
        meanAbsDiffPct: +((sumAbs / pixels) * 100).toFixed(3),
        changedGt2Pct: +((changedgt2 / pixels) * 100).toFixed(3),
        changedGt8Pct: +((changedgt8 / pixels) * 100).toFixed(3),
      }
    },
    { bUrl, aUrl },
  )
}

async function sheet(page: Page, file: string, title: string, tiles: { label: string; file: string }[], columns = 2) {
  const img = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`
  await page.setViewportSize({ width: columns * 760 + 36, height: Math.ceil(tiles.length / columns) * 545 + 64 })
  await page.setContent(`<body style="margin:0;padding:16px;background:#0e1013;color:#e6e8ec;font:600 15px -apple-system,BlinkMacSystemFont,sans-serif">
    <div style="font-size:19px;margin:0 0 12px;letter-spacing:-0.01em">${title}</div>
    <div style="display:grid;grid-template-columns:repeat(${columns},748px);gap:14px">
    ${tiles.map(t => `<figure style="margin:0;background:#171a20;border:1px solid #282d37;border-radius:6px;overflow:hidden"><img src="${img(t.file)}" style="width:748px;height:498px;object-fit:cover;display:block"><figcaption style="padding:7px 10px;font-size:14px;color:#cfd4dc">${t.label}</figcaption></figure>`).join("")}
    </div></body>`)
  await page.locator("body").screenshot({ path: file })
}

try {
  const page = await open(1536, 1024, 1)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  const summary: Record<string, unknown> = { phase, diffs: {}, gpuMs: {} }
  for (const s of SCENES) {
    await setup(page, s)
    const file = resolve(out, `${phase}-${s.name}.png`)
    await page.screenshot({ path: file })
    const gpuMs = await page.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      const v: number[] = []
      for (let i = 0; i < 12; i++) v.push(await h.renderer.measure(h.render))
      const sorted = v.slice(2).sort((x: number, y: number) => x - y)
      return +sorted[Math.floor(sorted.length / 2)]!.toFixed(3)
    })
    ;(summary.gpuMs as Record<string, number>)[s.name] = gpuMs
    console.log("captured", `${phase}-${s.name}.png`, `gpu=${gpuMs}ms`)
    if (phase === "after") {
      const beforeFile = resolve(out, `before-${s.name}.png`)
      if (existsSync(beforeFile)) {
        const d = await diffPngs(page, beforeFile, file)
        ;(summary.diffs as Record<string, unknown>)[s.name] = d
        console.log("diff", s.name, JSON.stringify(d))
      }
    }
  }
  assert.equal(errors.length, 0, `Shader/page errors:\n${errors.join("\n")}`)
  if (phase === "after") {
    const tiles: { label: string; file: string }[] = []
    for (const s of SCENES) {
      const bFile = resolve(out, `before-${s.name}.png`)
      const aFile = resolve(out, `after-${s.name}.png`)
      if (existsSync(bFile) && existsSync(aFile)) {
        const d = (summary.diffs as Record<string, any>)[s.name]
        tiles.push({ label: `Before (main @ 36d6fbf6) · ${s.label}`, file: bFile })
        tiles.push({
          label: `After (AR-51 data-driven) · ${s.label}${d ? ` (mean Δ ${d.meanAbsDiffPct}%)` : ""}`,
          file: aFile,
        })
      }
    }
    if (tiles.length > 0) {
      const sheetPage = await browser.newPage({ deviceScaleFactor: 1 })
      await sheet(
        sheetPage,
        resolve(out, "sheet-shader-coords-cleanup.png"),
        "Outbreak Shader World-Coordinates Cleanup (AR-51) · Before (main) vs After (Data-Driven)",
        tiles,
        2,
      )
      await sheetPage.close()
      console.log("wrote sheet-shader-coords-cleanup.png")
    }
    writeFileSync(resolve(out, "summary.json"), JSON.stringify(summary, null, 2))
  }
  await page.close()
} finally {
  await browser.close()
  await server.close()
}
