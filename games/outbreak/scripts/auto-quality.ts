import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { AdaptiveQualityController, type QualityTier } from "@arcade/kit/quality"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"
import { OUTBREAK_QUALITY_PROFILES } from "../src/quality"

await using budget = browserBudget()
const { chromium } = budget

/**
 * What Auto quality settles on for this machine at a given display size, at night at the crossroads east of Ash and
 * in Ash's west yard:
 *
 * 1. Times the GPU (timestamp queries, frozen frame) at each tier and dynamic resolution step Auto can reach.
 * 2. Replays the real `AdaptiveQualityController` with Outbreak's tiers against those timings (a frame takes whole
 *    60 Hz ticks: CPU + GPU with one frame in flight, ±10 % jitter, a 1.5× spike every 40th frame): a cold start at
 *    the crossroads, then the yard, then back. It reports the tier and pixel ratio Auto settles on, the frame time
 *    and missed share there, and every change with its time.
 * 3. Shoots the crossroads at High and at Auto's pick.
 *
 * Live timing in a headless browser is no use here: with no display, the page's compositor copies a 4K canvas back
 * every frame and caps it near 5 fps whatever the GPU does, so the controller's inputs come from step 1 instead.
 *
 *   AQ_VIEWPORT=1920x1000 AQ_DPR=2 AQ_CPU_MS=3 bun scripts/auto-quality.ts --out <dir>   (via hivemind run --kind browser)
 *
 * The default size is a 4K monitor at macOS's default "looks like 1920×1080" scaling, browser full screen.
 */
const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/auto-quality")))
mkdirSync(out, { recursive: true })
const [vw, vh] = (process.env.AQ_VIEWPORT ?? "1920x1000").split("x").map(Number) as [number, number]
const dpr = Number(process.env.AQ_DPR ?? 2)
const cpuMs = Number(process.env.AQ_CPU_MS ?? 3)
const TICK = 1000 / 60
const SCENES = {
  crossroads: { x: 45, y: 46, aim: Math.PI / 2, hour: 22, zoom: 30 },
  yard: { x: 22.5, y: 42.2, aim: -2.2, hour: 23, zoom: 38 },
} as const
type SceneName = keyof typeof SCENES
/** Every pixel scale Auto can reach on each tier (0.05 steps from 1 down to the tier's `minScale`, coarser below). */
const GRID: Record<QualityTier, number[]> = {
  high: [1, 0.95, 0.9, 0.85],
  balanced: [1, 0.9, 0.8, 0.7, 0.6],
  low: [1, 0.8, 0.6, 0.5],
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "auto-quality-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code.replace("async function main() {", ";(globalThis as any).__aqController = qualityController\nasync function main() {")
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
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0 }

/** Pins the controller to a tier and pixel scale (as Auto would hold them) and renders the scene there. */
async function pin(page: Page, scene: SceneName, tier: QualityTier, scale: number, settle: number) {
  await page.evaluate(async ({ s, tier, scale, settle }) => {
    const h = (window as any).__arcadeHarness
    const q = (globalThis as any).__aqController
    q.setMode("auto")
    Object.assign(q, { activeTier: tier, resolutionScale: scale, startupResolved: true })
    h.freeze(true)
    h.setLab("timeScale", 0)
    h.setZoomRaw(s.zoom)
    h.setLab("hour", s.hour)
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < settle; i++) await h.step(1 / 60)
  }, { s: SCENES[scene], tier, scale, settle })
}

try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&peaceful&quality=auto`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 240_000 })
  await page.addStyleTag({ content: "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues { visibility: hidden !important; }" })
  await page.evaluate(() => (window as any).__arcadeHarness.reset(7))

  // 1. GPU per tier and scale.
  const gpu: Record<SceneName, Record<QualityTier, [number, number, number][]>> = { crossroads: { high: [], balanced: [], low: [] }, yard: { high: [], balanced: [], low: [] } }
  for (const scene of Object.keys(SCENES) as SceneName[]) {
    for (const tier of Object.keys(GRID) as QualityTier[]) {
      for (const scale of GRID[tier]) {
        await pin(page, scene, tier, scale, 12)
        const r = await page.evaluate(async () => {
          const h = (window as any).__arcadeHarness
          const v: number[] = []
          for (let i = 0; i < 10; i++) v.push(await h.renderer.measure(h.render))
          const q = (globalThis as any).__aqController
          return { ms: v.slice(2).sort((a, b) => a - b)[4]!, pr: q.effectivePixelRatio(devicePixelRatio), size: [h.renderer.width, h.renderer.height] }
        })
        gpu[scene][tier].push([r.pr, +r.ms.toFixed(2), r.size[0] * r.size[1]])
        console.log(`GPU ${scene} ${tier} ${r.pr.toFixed(2)}× ${r.size.join("×")}: ${r.ms.toFixed(2)} ms`)
      }
    }
  }

  // 2. The controller against those timings.
  const gpuAt = (scene: SceneName, tier: QualityTier, pr: number) => {
    const pts = gpu[scene][tier].slice().sort((a, b) => a[0] - b[0])
    if (pr <= pts[0]![0]) return pts[0]![1] * (pr / pts[0]![0]) ** 2
    for (let i = 1; i < pts.length; i++) {
      const [p0, g0] = pts[i - 1]!, [p1, g1] = pts[i]!
      if (pr <= p1) return g0 + ((pr * pr - p0 * p0) / (p1 * p1 - p0 * p0)) * (g1 - g0)
    }
    return pts[pts.length - 1]![1]
  }
  const ctrl = new AdaptiveQualityController({ mode: "auto", profiles: OUTBREAK_QUALITY_PROFILES })
  let seed = 7
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  let now = 0
  let frame = 0
  const changes: string[] = []
  const phases: Record<string, unknown>[] = []
  for (const [scene, seconds] of [["crossroads", 30], ["yard", 30], ["crossroads", 30]] as [SceneName, number][]) {
    const start = now
    const intervals: [number, number, number][] = []
    while (now - start < seconds * 1000) {
      const st = ctrl.state(dpr)
      const g = gpuAt(scene, st.activeTier, st.pixelRatio) * (1 + (rand() - 0.5) * 0.2) * (++frame % 40 === 0 ? 1.5 : 1)
      const interval = Math.max(1, Math.ceil((cpuMs + g + 0.6) / TICK - 1e-6)) * TICK
      now += interval
      intervals.push([now - start, interval, g])
      const before = `${st.activeTier} ${st.pixelRatio.toFixed(2)}×`
      if (ctrl.recordFrame(interval, g, now)) {
        const after = ctrl.state(dpr)
        changes.push(`${(now / 1000).toFixed(1)} s (${scene}): ${before} → ${after.activeTier} ${after.pixelRatio.toFixed(2)}×`)
      }
    }
    const tail = intervals.filter(f => f[0] >= seconds * 1000 - 10_000)
    const st = ctrl.state(dpr)
    phases.push({
      scene,
      settled: `${st.activeTier} ${st.pixelRatio.toFixed(2)}×`,
      gpuMs: +med(tail.map(f => f[2])).toFixed(2),
      frameMs: +med(tail.map(f => f[1])).toFixed(2),
      missed: +(tail.filter(f => f[1] > TICK + 0.5).length / tail.length).toFixed(3),
    })
  }
  const settled = ctrl.state(dpr)

  // 3. Stills: High against Auto's pick at the crossroads.
  const shoot = async (tier: QualityTier, scale: number, name: string) => {
    await pin(page, "crossroads", tier, scale, 40)
    await page.screenshot({ path: `${out}/crossroads-${name}.png` })
  }
  await shoot("high", 1, "high")
  await shoot(settled.activeTier, settled.resolutionScale, "auto")

  const result = { viewport: [vw, vh], dpr, cpuMs, gpu, phases, changes, adaptations: settled.adaptations, auto: { tier: settled.activeTier, scale: settled.resolutionScale, pixelRatio: settled.pixelRatio }, errors }
  writeFileSync(`${out}/auto-quality.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ phases, changes, adaptations: settled.adaptations, errors }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
