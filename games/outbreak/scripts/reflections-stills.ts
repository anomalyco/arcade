/**
 * Stills and paired GPU cost of reflections (Look › Reflections), one headless run:
 *
 *   bun scripts/reflections-stills.ts --out <dir>      (via hivemind run --kind browser)
 *
 * Captures the crossroads east of Ash at 22:00 under its streetlamps, Today vs wet vs dry (potholes only), the burning
 * scene south of Ash (`fire.stage burning`) Today vs wet, Ash's mirror at night with the survivor in front and passing,
 * Today vs Reflections, the mirror unlit and by day, and Elm's cracked mirror. Then times paired frames with the
 * renderer's timestamp queries (3456×1894): Today vs wet and dry streets, Today vs reflections without mirrors inside
 * Ash, and mirrors off vs on. Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/reflections"))!)
const rounds = Number(arg("rounds", "6"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "reflections-stills-hooks",
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

type Shot = {
  name: string
  hour: number
  zoom: number
  x: number
  y: number
  aim: number
  flashlight: boolean
  fire?: boolean
  knobs: Record<string, number | boolean>
}
const TODAY = { reflections: 0 }
const WET = { reflections: 1, reflectWetness: 0.7 }
const DRY = { reflections: 1, reflectWetness: 0 }
// The crossroads east of Ash: streetlamps at (52, 39) and (52, 51), a pothole at (52.6, 44.6); the survivor stands just
// in front of the north lamp's image, so its reflection cuts the streak.
const LAMPS = { hour: 22, zoom: 26, x: 51.6, y: 40.8, aim: Math.PI / 2, flashlight: true }
// The burning scene south of Ash (`fire.stage burning` poses the survivor).
const FIRE = { hour: 22, zoom: 26, x: 0, y: 0, aim: Math.PI / 2, flashlight: true, fire: true }
// Ash's mirror (seed 7) leans on the inner wall's south face at x 30.4, z 29.7, beside the bedroom door.
const MIRROR = { hour: 21, zoom: 16, x: 30.2, y: 30.75, aim: -Math.PI / 2 + 0.25, flashlight: true }
const shots: Shot[] = [
  { name: "street-lamps-22h-wet-today", ...LAMPS, knobs: TODAY },
  { name: "street-lamps-22h-wet-reflections", ...LAMPS, knobs: WET },
  { name: "street-lamps-22h-dry-reflections", ...LAMPS, knobs: DRY },
  { name: "street-fire-22h-wet-today", ...FIRE, knobs: TODAY },
  { name: "street-fire-22h-wet-reflections", ...FIRE, knobs: WET },
  { name: "mirror-21h-today", ...MIRROR, knobs: TODAY },
  { name: "mirror-21h-reflections", ...MIRROR, knobs: { reflections: 1 } },
  { name: "mirror-21h-passing-reflections", ...MIRROR, x: 29.6, y: 30.55, aim: 0, knobs: { reflections: 1 } },
  { name: "mirror-21h-unlit-reflections", ...MIRROR, x: 33.4, y: 32.4, aim: 0, flashlight: false, knobs: { reflections: 1 } },
  { name: "mirror-13h-reflections", ...MIRROR, hour: 13, flashlight: false, knobs: { reflections: 1 } },
  // Elm's mirror (seed 7) is one of the rare cracked ones.
  { name: "mirror-cracked-elm-21h-reflections", ...MIRROR, x: 29.2, y: 60.7, knobs: { reflections: 1 } },
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/**
 * Same frozen frame for stills and timing: once to warm caches (props, rugs) until ready, then again from a fresh
 * reset with a fixed number of steps, so burning zombies and flames stand in the same place every time.
 */
async function setup(page: Page, s: Omit<Shot, "name">) {
  return page.evaluate(async s => {
    const h = (window as any).__arcadeHarness
    const stage = () => {
      h.freeze(true)
      h.reset(7)
      h.setQuality("high")
      h.setLab("timeScale", 0)
      h.lookPreset("today")
      for (const [key, v] of Object.entries(s.knobs)) h.setLab(key, v)
      h.setZoomRaw(s.zoom)
      const at = s.fire ? h.stageFire("burning") : { x: s.x, y: s.y }
      h.setLab("hour", s.hour)
      h.pose(at.x, at.y, s.aim)
      return at
    }
    let at = stage()
    const pin = () => Object.assign(h.state().player, { x: at.x, y: at.y, aim: s.aim, vx: 0, vy: 0, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    at = stage()
    for (let i = 0; i < 30; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    return { at, reflections: h.state().reflections, mirrors: h.mirrors?.().slice(0, 3) }
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
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  return page
}

const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }

/** Alternates knob sets A and B on one frame; second-fastest of 16 timed frames each (GPU clocks swing). */
async function paired(page: Page, base: Omit<Shot, "name" | "knobs">, A: Shot["knobs"], B: Shot["knobs"]) {
  const a: number[] = [], b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const second of r % 2 ? [true, false] : [false, true]) {
      await setup(page, { ...base, knobs: second ? B : A })
      const ms = await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const v: number[] = []
        for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
        return v.slice(2).sort((x: number, y: number) => x - y)[1]!
      })
      ;(second ? b : a).push(ms)
    }
  }
  const diffs = a.map((x, i) => b[i]! - x)
  return { a: med(a), b: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
}

try {
  const page = await open(1536, 1024, 1)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const shot of shots) {
    const info = await setup(page, shot)
    await page.screenshot({ path: resolve(out, `${shot.name}.png`) })
    ;(meta.shots as Record<string, unknown>)[shot.name] = { ...shot, info }
    console.log(shot.name, JSON.stringify(info))
  }
  await page.close()

  const gpuPage = await open(1728, 947, 2)
  meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
  const pairs = {
    "street lamps, wet: Today → Reflections": await paired(gpuPage, { ...LAMPS, zoom: 34 }, TODAY, WET),
    "street lamps, dry (potholes only): Today → Reflections": await paired(gpuPage, { ...LAMPS, zoom: 34 }, TODAY, DRY),
    "Ash interior: Today → Reflections without mirrors": await paired(gpuPage, { ...MIRROR, zoom: 34 }, TODAY, { reflections: 1, mirrors: 0 }),
    "Ash interior: mirrors off → on": await paired(gpuPage, { ...MIRROR, zoom: 34 }, { reflections: 1, mirrors: 0 }, { reflections: 1 }),
  }
  for (const [name, p] of Object.entries(pairs)) console.log(`GPU ${name}: ${p.a.toFixed(3)} → ${p.b.toFixed(3)} ms, paired Δ ${p.pairedDeltaMedian.toFixed(3)} ±${p.pairedDeltaMad.toFixed(3)} ms`)
  meta.gpu = pairs
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
