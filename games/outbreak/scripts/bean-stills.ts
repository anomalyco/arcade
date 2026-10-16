/**
 * Soft Bean prototype (Look › Hero › Soft Bean): stills and paired GPU cost against today's box survivor, one headless
 * run (via hivemind run --kind browser):
 *
 *   bun scripts/bean-stills.ts --out <dir>
 *
 * Captures the start house's bedroom and hall at 21:00 with the flashlight on, Today and Soft Bean, full frame and a
 * 2× crop around the survivor; a four-player lineup in the living room with flashlights on and off and in the unlit
 * entry hall, Today and Soft Bean; then labelled comparison sheets; then alternates Today and Soft Bean on the same frozen bedroom frame timing
 * each with the renderer's timestamp queries (3456×1894). Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"
import { SOFT_BEAN_STYLE } from "../src/look/hero"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/soft-bean"))!)
const rounds = Number(arg("rounds", "10"))
mkdirSync(out, { recursive: true })

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Mate = { x: number; y: number; aim: number }
type Shot = { name: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; mates?: Mate[] }
const BEDROOM = { x: 27.5, y: 27.2, aim: Math.PI * 0.8 }
const HALL = { x: 27.7, y: 34.3, aim: -Math.PI / 2 }
const FACE = Math.PI / 2
// Teammates are only drawn inside the local survivor's sight (its 2.5 m awareness covers the sides), so the local
// survivor stands second from the left.
const LINEUP = { x: 25, y: 32.6, aim: FACE, mates: [{ x: 24.15, y: 32.6, aim: FACE }, { x: 25.85, y: 32.6, aim: FACE }, { x: 26.7, y: 32.6, aim: FACE }] }
// The same four in a column down the unlit entry hall: what each keeps of its colour with no light on it.
const HALL_LINEUP = { x: 27.7, y: 32.3, aim: FACE, mates: [{ x: 27.7, y: 31.45, aim: FACE }, { x: 27.7, y: 33.15, aim: FACE }, { x: 27.7, y: 34.0, aim: FACE }] }
const shots: Shot[] = [
  { name: "bedroom-21h", hour: 21, zoom: 26, ...BEDROOM, flashlight: true },
  { name: "hall-21h", hour: 21, zoom: 26, ...HALL, flashlight: true },
  { name: "lineup-21h-lights", hour: 21, zoom: 18, ...LINEUP, flashlight: true },
  { name: "lineup-21h-lamps", hour: 21, zoom: 18, ...LINEUP, flashlight: false },
  { name: "lineup-21h-dark", hour: 21, zoom: 18, ...HALL_LINEUP, flashlight: false },
]
const STYLES = [{ id: "today", style: 0, label: "Today" }, { id: "bean", style: SOFT_BEAN_STYLE, label: "Soft Bean" }] as const
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/** Same frozen frame for stills and timing: style, pose, hour, zoom, teammates placed by hand, props settled. */
async function setup(page: Page, s: Omit<Shot, "name">, style: number) {
  return page.evaluate(async ({ s, style }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("heroStyle", style)
    h.pose(s.x, s.y, s.aim)
    const sim = h.session().sim
    const mates = (s.mates ?? []).map((m: { x: number; y: number; aim: number }, i: number) => ({ m, slot: sim.addSurvivor(`mate-${i + 1}`, i + 1) }))
    const place = () => {
      const p = h.state().player
      p.flashlightOn = s.flashlight
      p.flashlightOutput = s.flashlight ? 1 : 0
      for (const { m, slot } of mates) Object.assign(slot.survivor, { x: m.x, y: m.y, aim: m.aim, vx: 0, vy: 0, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    }
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      place()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    for (let i = 0; i < 30; i++) {
      place()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    // The lineup crops on the middle of the four, everything else on the survivor.
    const all = [{ x: s.x, y: s.y }, ...(s.mates ?? [])]
    const mid: [number, number, number] = [all.reduce((t, m) => t + m.x, 0) / all.length, 0.9, all.reduce((t, m) => t + m.y, 0) / all.length]
    const rect = h.resolveTargetRect(s.mates ? { world: mid } : { objectId: "player" })
    return { look: h.state().look, rect, mates: mates.length }
  }, { s, style })
}

async function open(width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  return page
}

const W = 1536
const H = 1024
const img = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`

/** A labelled sheet of tiles, rendered in a blank page of the same browser. */
async function sheet(page: Page, file: string, title: string, rows: { label: string; file: string }[][], tileW: number) {
  const cols = Math.max(...rows.map(r => r.length))
  await page.setViewportSize({ width: cols * (tileW + 12) + 12, height: 200 })
  await page.setContent(`<body style="margin:0;padding:12px;background:#111;color:#ddd;font:15px -apple-system,sans-serif">
    <div style="font-size:18px;margin:0 0 10px">${title}</div>
    ${rows.map(r => `<div style="display:flex;gap:12px;margin-bottom:12px">${r.map(t => `<figure style="margin:0;width:${tileW}px">
      <img src="${img(t.file)}" style="width:${tileW}px;display:block"><figcaption style="margin-top:6px">${t.label}</figcaption></figure>`).join("")}</div>`).join("")}
  </body>`)
  await page.waitForFunction(() => [...document.images].every(i => i.complete))
  await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 90 })
}

try {
  const page = await open(W, H, 1)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  const files: Record<string, string> = {}
  for (const shot of shots) {
    for (const st of STYLES) {
      const info = await setup(page, shot, st.style)
      const name = `${shot.name}-${st.id}`
      files[name] = resolve(out, `${name}.png`)
      await page.screenshot({ path: files[name] })
      if (info.rect) {
        // 2× crop centred on the survivor, or the middle of the lineup.
        const cx = info.rect.x + info.rect.width / 2
        const cy = info.rect.y + info.rect.height / 2
        const clip = { x: Math.max(0, Math.min(W / 2, cx - W / 4)), y: Math.max(0, Math.min(H / 2, cy - H / 4)), width: W / 2, height: H / 2 }
        files[`${name}-close`] = resolve(out, `${name}-close.png`)
        await page.screenshot({ path: files[`${name}-close`], clip })
      }
      ;(meta.shots as Record<string, unknown>)[name] = { ...shot, style: st.style, ...info }
      console.log(name, JSON.stringify(info.look))
    }
  }

  const sheetPage = await browser.newPage()
  const pair = (shot: string, close = false) => STYLES.map(st => ({ label: st.label, file: files[`${shot}-${st.id}${close ? "-close" : ""}`]! }))
  await sheet(sheetPage, resolve(out, "compare-bedroom.jpg"), "Bedroom, 21:00, flashlight on", [pair("bedroom-21h", true), pair("bedroom-21h")], 760)
  await sheet(sheetPage, resolve(out, "compare-hall.jpg"), "Entry hall, 21:00, flashlight on", [pair("hall-21h", true), pair("hall-21h")], 760)
  await sheet(sheetPage, resolve(out, "lineup.jpg"), "Four players at 21:00: living room with flashlights on, by lamplight alone, and unlit in the entry hall", [
    pair("lineup-21h-lights", true), pair("lineup-21h-lamps", true), pair("lineup-21h-dark", true),
  ], 760)
  await sheet(sheetPage, resolve(out, "compare.jpg"), "Soft Bean prototype: Today vs Soft Bean at 21:00", [
    pair("bedroom-21h", true), pair("hall-21h", true), pair("lineup-21h-dark", true),
  ], 640)
  await sheetPage.close()

  // Paired GPU cost at the bench resolution on the bedroom frame: alternate Today and Soft Bean, second-fastest of 16
  // timed frames each (the Studio's GPU clock swings between two states; this compares like with like).
  await page.close()
  const gpuPage = await open(1728, 947, 2)
  meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
  const a: number[] = [], b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const bean of r % 2 ? [true, false] : [false, true]) {
      await setup(gpuPage, { hour: 21, zoom: 26, ...BEDROOM, flashlight: true }, bean ? SOFT_BEAN_STYLE : 0)
      const ms = await gpuPage.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const v: number[] = []
        for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
        return v.slice(2).sort((x: number, y: number) => x - y)[1]!
      })
      ;(bean ? b : a).push(ms)
    }
  }
  const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
  const diffs = a.map((x, i) => b[i]! - x)
  meta.gpu = { scene: "bedroom 21:00 zoom 26, flashlight on", today: med(a), bean: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
  console.log(`GPU today=${med(a).toFixed(3)} ms bean=${med(b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms`)
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
