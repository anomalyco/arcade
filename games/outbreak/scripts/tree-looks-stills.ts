/**
 * Stills, night wind clips and paired GPU cost of the D-41 tree looks (Backquote › Vegetation › Tree look), one
 * headless run:
 *
 *   bun scripts/tree-looks-stills.ts --out <dir> [--clip] [--gpu] [--rounds 6] [--shots name,…|none] [--clips c,b]
 *
 * Stills (1536×1024, zoom 38 unless noted) for Today (Lively, #273), A Deadwood, B Fluffy and C Darkwood: the start
 * house's front yard by day, the yard at night with the flashlight on the woodland trees, the west street lamp at night
 * beside a street tree, and standing under the woodland trees at night (zoom 30). `--clip` records 4 s of sim-time wind
 * at 30 fps for C and B at night with the flashlight sweeping. `--gpu` alternates each look against Today on the same
 * frozen frame (3456×1894 bench viewport). Headless Metal Chromium, muted, no visible window.
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
const out = resolve(arg("out", resolve(root, "../../captures/tree-looks"))!)
const rounds = Number(arg("rounds", "6"))
const only = arg("shots")
mkdirSync(out, { recursive: true })

const LOOKS = [
  { label: "today", treeLook: 0 },
  { label: "a-deadwood", treeLook: 1 },
  { label: "b-fluffy", treeLook: 2 },
  { label: "c-darkwood", treeLook: 3 },
] as const

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "tree-looks-hooks",
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
// Origin house 0 is rect 22..37 × 24..35.5; the woodland trees stand west of it (15.4, 35.8) and (16.4, 32.6). The
// west street lamp at (8, 51) lights the street tree at (13.8, 49.2).
const YARD = { x: 22, y: 41 }
const AT_WOODS = -2.25
const shots: Shot[] = [
  { name: "1-yard-day", hour: 13, zoom: 38, ...YARD, aim: AT_WOODS, flashlight: false },
  { name: "2-street-night-flashlight", hour: 23, zoom: 38, x: 21, y: 40.5, aim: AT_WOODS, flashlight: true },
  { name: "3-under-lamp", hour: 22.5, zoom: 32, x: 11.2, y: 50.4, aim: -0.37, flashlight: false },
  { name: "4-under-tree", hour: 19.5, zoom: 30, x: 16.4, y: 34.6, aim: Math.PI, flashlight: true },
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #lab-panel, .knobs-root"
const errors: string[] = []
const meta: Record<string, unknown> = { shots, looks: LOOKS }

/** Switches the tree look (rebuilds the level when it changes) and lets the world settle. */
async function useLook(page: Page, treeLook: number) {
  await page.evaluate(async treeLook => {
    const h = (window as any).__arcadeHarness
    h.setLab("vegLook", 1)
    h.setLab("vegTreeLook", treeLook)
    for (let i = 0; i < 30; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: 0 })
  }, treeLook)
  await page.waitForTimeout(1500)
}

async function setup(page: Page, s: Omit<Shot, "name">) {
  await page.evaluate(async s => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    // Steady sodium lamps, so the lamp shot isn't caught in a dying lamp's dim phase.
    h.setLab("nlSodiumFlicker", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.pose(s.x, s.y, s.aim)
    const p = h.state().player
    p.flashlightOn = s.flashlight
    p.flashlightOutput = s.flashlight ? 1 : 0
    for (let i = 0; i < 40; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
  }, s)
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
  await page.evaluate(() => (window as any).__arcadeHarness.reset(7))
  return page
}

/** 4 s of sim-time wind at 30 fps at night, the aim sweeping across the woodland canopies. */
async function clip(page: Page, name: string, treeLook: number) {
  const dir = resolve(out, `${name}-frames`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await useLook(page, treeLook)
  const s = { hour: 23, zoom: 30, x: 20, y: 40.5, aim: -2.3, flashlight: true }
  await setup(page, s)
  const frames = 120
  for (let f = 0; f < frames; f++) {
    const aim = s.aim + Math.sin((f / frames) * Math.PI * 2) * 0.38
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
  for (const look of only === "none" ? [] : LOOKS) {
    await useLook(page, look.treeLook)
    for (const shot of shots) {
      if (only && !only.split(",").some((n) => shot.name.includes(n))) continue
      await setup(page, shot)
      await page.screenshot({ path: resolve(out, `${look.label}-${shot.name}.png`) })
      console.log(look.label, shot.name)
    }
  }
  if (flag("clip")) {
    await page.setViewportSize({ width: 1280, height: 720 })
    const clips = arg("clips", "c,b")!.split(",")
    if (clips.includes("c")) await clip(page, "c-darkwood-night-wind", 3)
    if (clips.includes("b")) await clip(page, "b-fluffy-night-wind", 2)
  }
  await page.close()

  if (flag("gpu")) {
    const gpuPage = await open(1728, 947, 2)
    meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
    const scenes = [
      { name: "street night", hour: 23, zoom: 38, x: 21, y: 40.5, aim: AT_WOODS, flashlight: true },
      { name: "yard day", hour: 13, zoom: 38, ...YARD, aim: AT_WOODS, flashlight: false },
    ]
    const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
    const measure = () => gpuPage.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      const v: number[] = []
      for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
      return v.slice(2).sort((x: number, y: number) => x - y)[1]!
    })
    const gpu: Record<string, unknown> = {}
    for (const look of LOOKS.slice(1)) {
      for (const scene of scenes) {
        const a: number[] = [], b: number[] = []
        for (let r = 0; r < rounds; r++) {
          for (const on of r % 2 ? [true, false] : [false, true]) {
            await useLook(gpuPage, on ? look.treeLook : 0)
            await setup(gpuPage, scene)
            ;(on ? b : a).push(await measure())
          }
        }
        const diffs = a.map((x, i) => b[i]! - x)
        const key = `${look.label} · ${scene.name}`
        gpu[key] = { today: med(a), look: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
        console.log(`GPU ${key}: today=${med(a).toFixed(3)} ms look=${med(b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms`)
      }
    }
    meta.gpu = gpu
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
