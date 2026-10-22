/// <reference types="@webgpu/types" />
/**
 * Before/after stills and the paired GPU cost of the kit's physical light model (`gpu/lights/physical.ts`) in the
 * Lab's Look and world section: preset "Night lamps" (Today) against "Night lamps, physical" and "Spot shadow maps"
 * (physical plus two spot shadow maps, `gpu/shadows/spot-shadows.ts`; maps re-render only on a slot change, so the
 * timed frame is the steady-state sampling cost), from the Lab's default
 * three-quarter camera and from street level, at 3456×1894 (1728×947 at DPR 2). Variants alternate on one page with
 * the clock frozen, each timed by the renderer's timestamp queries (`Renderer.measure`), so drift cancels out.
 *
 *   bun scripts/lab/prove-physical-lights.ts          (LIGHT_OUT=<dir>, LIGHT_ROUNDS=12)
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "../..")
const out = resolve(process.env.LIGHT_OUT ?? resolve(root, "captures/physical-lights"))
const rounds = Number(process.env.LIGHT_ROUNDS ?? 12)
mkdirSync(out, { recursive: true })

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2 : 0
}
const mad = (xs: number[]) => median(xs.map((x) => Math.abs(x - median(xs))))

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Playwright Chromium binary not found")

const server = await createServer({ root: resolve(root, "games/lab"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Scene = { name: string; camera?: { yaw: number; pitch: number; dist: number; focus: [number, number, number] } }
const scenes: Scene[] = [
  { name: "three-quarter" },
  { name: "street-level", camera: { yaw: 0.25, pitch: 0.12, dist: 8, focus: [1, 1.2, -2] } },
]
const variants = { today: "night-lamps", physical: "night-physical", shadowed: "spot-shadows" } as const
type Variant = keyof typeof variants
const names = Object.keys(variants) as Variant[]

try {
  const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  // Chrome reports uncaptured WebGPU validation errors as console warnings.
  page.on("console", (m) => { if (m.type() === "error" || (m.type() === "warning" && /WebGPU|GPU/.test(m.text()))) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/arcade/lab/?section=world&bench`)
  await page.waitForFunction(() => Boolean((window as any).lab && (window as any).fx?.stage))
  const adapter = await page.evaluate(() => (window as any).fx.adapter)

  const show = (scene: Scene, preset: string) => page.evaluate(async ({ scene, preset }) => {
    const lab = (window as any).lab
    const stage = (window as any).fx.stage
    lab.select("world")
    lab.workbench.invoke("world.preset", { preset })
    lab.workbench.invoke("world.set", { key: "playing", value: false })
    if (scene.camera) {
      stage.camYaw = scene.camera.yaw
      stage.camPitch = scene.camera.pitch
      stage.frameTarget(scene.camera.focus[0], scene.camera.focus[1], scene.camera.focus[2], scene.camera.dist)
    }
    for (let i = 0; i < 4; i++) lab.advance(1 / 60)
    await lab.render(false)
  }, { scene, preset })
  const time = () => page.evaluate(async () => {
    const lab = (window as any).lab
    const ms: number[] = []
    for (let i = 0; i < 6; i++) {
      const m = await lab.render(true)
      if (typeof m === "number") ms.push(m)
    }
    ms.sort((a, b) => a - b)
    return ms[Math.floor(ms.length / 2)] ?? null
  })

  const report: Record<string, unknown> = { recordedAt: new Date().toISOString(), adapter, size: [3456, 1894], rounds }
  const telemetry: Record<string, string | null> = {}
  report.telemetry = telemetry
  for (const scene of scenes) {
    for (const [name, preset] of Object.entries(variants)) {
      await show(scene, preset)
      await page.waitForTimeout(150)
      await page.locator("canvas").first().screenshot({ path: resolve(out, `${scene.name}-${name}.png`) })
      telemetry[`${scene.name}-${name}`] = await page.evaluate(() => (window as any).lab.context.world?.telemetry() ?? null)
    }
    const runs: Record<Variant, number[]> = { today: [], physical: [], shadowed: [] }
    for (let r = 0; r <= rounds; r++) {
      const order = names.map((_, i) => names[(i + r) % names.length]!)
      if (r % 2) order.reverse()
      for (const v of order) {
        await show(scene, variants[v])
        const ms = await time()
        if (r > 0 && ms !== null) runs[v].push(ms)
      }
    }
    const deltas = (v: Variant, base: Variant) => runs[base].map((t, i) => (runs[v][i] ?? t) - t)
    report[scene.name] = {
      todayMs: +median(runs.today).toFixed(3),
      physicalMs: +median(runs.physical).toFixed(3),
      shadowedMs: +median(runs.shadowed).toFixed(3),
      physicalDeltaMs: +median(deltas("physical", "today")).toFixed(3),
      physicalDeltaMadMs: +mad(deltas("physical", "today")).toFixed(3),
      spotShadowDeltaMs: +median(deltas("shadowed", "physical")).toFixed(3),
      spotShadowDeltaMadMs: +mad(deltas("shadowed", "physical")).toFixed(3),
    }
  }
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log("PHYSICAL_LIGHTS", JSON.stringify(report, null, 2))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
