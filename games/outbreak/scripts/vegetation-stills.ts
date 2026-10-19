/**
 * Stills, wind clips and paired GPU cost of Outbreak's vegetation (Backquote › Vegetation), one headless run:
 *
 *   bun scripts/vegetation-stills.ts --out <dir> [--label before|after] [--clip] [--gpu] [--look today|lively]
 *
 * Stills: the start house's front yard and the woodland trees beside it at zoom 38 by day (13:00), at dusk (19:30) and
 * at night (23:00, flashlight on the trees), plus a closer zoom-22 crop of one tree. `--clip` records 4 s of wind (sim
 * time, 30 fps) at night with the flashlight sweeping the canopies and by day, encoded with ffmpeg. `--gpu` alternates
 * Vegetation "Today" and "Lively" on the same frozen frame (3456×1894 bench viewport), timed with the
 * renderer's timestamp queries. Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const out = resolve(arg("out", resolve(root, "../../captures/vegetation"))!)
const label = arg("label", "after")!
const look = arg("look") as "today" | "lively" | undefined
const rounds = Number(arg("rounds", "8"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "vegetation-stills-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render })")
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Shot = { name: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean }
// Front walk of origin house 0 (rect 22..37 × 24..35.5): woodland trees and the driveway hedge to the west, the yard
// tree and corner shrubs to the east, street trees across the road.
const YARD = { x: 26.5, y: 40.5 }
const shots: Shot[] = [
  { name: "yard-13h-z38", hour: 13, zoom: 38, ...YARD, aim: Math.PI, flashlight: false },
  { name: "yard-1930h-z38", hour: 19.5, zoom: 38, ...YARD, aim: Math.PI, flashlight: true },
  { name: "yard-23h-z38", hour: 23, zoom: 38, ...YARD, aim: Math.PI * 0.93, flashlight: true },
  { name: "tree-13h-z22", hour: 13, zoom: 22, x: 19.5, y: 39, aim: Math.PI, flashlight: false },
  { name: "tree-23h-z22", hour: 23, zoom: 22, x: 20.5, y: 39.5, aim: Math.PI * 0.9, flashlight: true },
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #lab-panel, .knobs-root"
const errors: string[] = []
const meta: Record<string, unknown> = { label, look: look ?? null, shots: {} }

async function setup(page: Page, s: Omit<Shot, "name">, vegLook?: string) {
  await page.evaluate(async ({ s, vegLook }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    if (vegLook) h.setLab("vegLook", vegLook === "today" ? 0 : 1)
    h.setZoomRaw(s.zoom)
    h.pose(s.x, s.y, s.aim)
    const p = h.state().player
    p.flashlightOn = s.flashlight
    p.flashlightOutput = s.flashlight ? 1 : 0
    for (let i = 0; i < 40; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
  }, { s, vegLook })
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

/** 4 s of sim-time wind at 30 fps; at night the aim sweeps slowly across the woodland canopies. */
async function clip(page: Page, name: string, s: Omit<Shot, "name">, sweep: number) {
  const dir = resolve(out, `${name}-frames`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await setup(page, s, look)
  const frames = 120
  for (let f = 0; f < frames; f++) {
    const aim = s.aim + Math.sin((f / frames) * Math.PI * 2) * sweep
    await page.evaluate(async aim => {
      const h = (window as any).__arcadeHarness
      await h.step(1 / 30, { mx: 0, my: 0, aim })
    }, aim)
    await page.screenshot({ path: resolve(dir, `${String(f).padStart(4, "0")}.png`) })
  }
  const mp4 = resolve(out, `${name}.mp4`)
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(dir, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-an", mp4])
  if (r.status !== 0) errors.push(`ffmpeg ${name}: ${r.stderr}`)
  else rmSync(dir, { recursive: true, force: true })
  console.log(mp4)
}

try {
  const page = await open(1536, 1024, 1)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  for (const shot of shots) {
    await setup(page, shot, look)
    await page.screenshot({ path: resolve(out, `${label}-${shot.name}.png`) })
    ;(meta.shots as Record<string, unknown>)[shot.name] = shot
    console.log(shot.name)
  }
  if (flag("clip")) {
    await page.setViewportSize({ width: 1280, height: 720 })
    await clip(page, `${label}-wind-night`, { hour: 23, zoom: 38, ...YARD, aim: Math.PI * 0.95, flashlight: true }, 0.35)
    await clip(page, `${label}-wind-day`, { hour: 13, zoom: 38, ...YARD, aim: Math.PI, flashlight: false }, 0)
  }
  await page.close()

  if (flag("gpu")) {
    const gpuPage = await open(1728, 947, 2)
    meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
    const scenes = [
      { name: "yard night", hour: 23, zoom: 38, ...YARD, aim: Math.PI * 0.93, flashlight: true },
      { name: "yard day", hour: 13, zoom: 38, ...YARD, aim: Math.PI, flashlight: false },
    ]
    const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
    const gpu: Record<string, unknown> = {}
    for (const scene of scenes) {
      const a: number[] = [], b: number[] = []
      for (let r = 0; r < rounds; r++) {
        for (const on of r % 2 ? [true, false] : [false, true]) {
          await setup(gpuPage, scene, on ? "lively" : "today")
          const ms = await gpuPage.evaluate(async () => {
            const h = (window as any).__arcadeHarness
            const v: number[] = []
            for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
            return v.slice(2).sort((x: number, y: number) => x - y)[1]!
          })
          ;(on ? b : a).push(ms)
        }
      }
      const diffs = a.map((x, i) => b[i]! - x)
      gpu[scene.name] = { today: med(a), look: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
      console.log(`GPU ${scene.name}: today=${med(a).toFixed(3)} ms look=${med(b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms`)
    }
    meta.gpu = gpu
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, `${label}-meta.json`), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
