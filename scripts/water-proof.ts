/** Headless, muted Carrier checkpoint. Run through HiveMind on mini. */
import { createServer } from "vite"
import { chromium } from "playwright-core"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { writeBuildId } from "./build-id"
import { hostname } from "node:os"
import type { Renderer } from "../games/carrier/src/render/renderer"
import type { Ocean } from "../games/carrier/src/render/ocean"
import type { GpuPerf } from "../packages/kit/gpu-perf"

type WaterDebug = { carrier: { renderer: Renderer; ocean: Ocean; perf: GpuPerf }; waterSamples: number[]; waterSampling: boolean }
const compare = process.argv.includes("--compare")
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]! }

if (!hostname().startsWith("aak2-2")) throw Error("Water proof must run on mini; use HIVEMIND_STRICT_PIN=1")
const out = resolve(arg("--out", "captures/water"))
mkdirSync(out, { recursive: true })
writeBuildId(resolve("games/carrier"))
const server = await createServer({ root: "games/carrier", server: { host: "127.0.0.1", port: 0, strictPort: true } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw Error("Missing capture server port")
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && /gpu|wgsl|shader|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${address.port}/?seed=7&t=120&tod=15&cam=0,0,30,18,550&quality=high`)
  await page.waitForFunction(() => !!(globalThis as { carrier?: unknown }).carrier, null, { timeout: 90_000 })
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw Error("No GPU adapter")
    const { vendor, architecture, device, description } = adapter.info
    return { vendor, architecture, device, description, timestampQueries: adapter.features.has("timestamp-query") }
  })
  await page.evaluate(async () => {
    const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } } } }).carrier
    await c.renderer.context.device.queue.onSubmittedWorkDone()
  })
  await page.locator("canvas").first().screenshot({ path: `${out}/carrier-today.png` })
  const canvas = await page.locator("canvas").first().evaluate(c => ({ width: (c as HTMLCanvasElement).width, height: (c as HTMLCanvasElement).height }))
  await Bun.write(`${out}/baseline.json`, JSON.stringify({ hostname: hostname(), gpu, errors, url: page.url(), viewport: page.viewportSize(), canvas }, null, 2))
  if (compare) {
    const frames = async (n: number) => { await page.evaluate(async n => {
      for (let i = 0; i < n; i++) await new Promise<void>(r => requestAnimationFrame(() => r()))
      await (globalThis as unknown as WaterDebug).carrier.renderer.context.device.queue.onSubmittedWorkDone()
    }, n); if (errors.length) throw Error(errors[0]) }
    await frames(30)
    await page.locator("canvas").first().screenshot({ path: `${out}/carrier-today-control.png` })
    await page.evaluate(() => { (globalThis as unknown as WaterDebug).carrier.ocean.water.mode = "continuous" })
    await frames(60)
    await page.locator("canvas").first().screenshot({ path: `${out}/carrier-continuous.png` })
    await page.evaluate(() => { (globalThis as unknown as WaterDebug).carrier.ocean.water.mode = "today" })
    await frames(30)
    await page.locator("canvas").first().screenshot({ path: `${out}/carrier-today-restored.png` })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await frames(120)
    await page.evaluate(() => {
      const w = globalThis as unknown as WaterDebug
      if (w.carrier.perf.gpuKind !== "timestamp") throw Error("GPU timestamps unavailable")
      w.waterSamples = []
      w.waterSampling = false
      let last: number | null = null
      Object.defineProperty(w.carrier.perf, "gpuMs", {
        get: () => last,
        set: (value: number | null) => { last = value; if (w.waterSampling && value !== null) w.waterSamples.push(value) },
      })
    })
    const blocks = []
    const modes = Array.from({ length: 7 }, (_, i) => i % 2 ? ["continuous", "today"] as const : ["today", "continuous"] as const).flat()
    for (const mode of modes) {
      await page.evaluate(mode => { (globalThis as unknown as WaterDebug).carrier.ocean.water.mode = mode }, mode)
      await frames(120)
      await page.evaluate(() => { const w = globalThis as unknown as WaterDebug; w.waterSamples = []; w.waterSampling = true })
      await page.waitForFunction(() => (globalThis as unknown as WaterDebug).waterSamples.length >= 40, null, { timeout: 90_000 })
      const values = await page.evaluate(() => { const w = globalThis as unknown as WaterDebug; w.waterSampling = false; return w.waterSamples })
      values.sort((a, b) => a - b)
      blocks.push({ mode, samples: values, median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * 0.95)] })
    }
    const dimensions = await page.evaluate(() => { const r = (globalThis as unknown as WaterDebug).carrier.renderer; return { width: r.width, height: r.height } })
    if (errors.length) throw Error(errors[0])
    await Bun.write(`${out}/timing.json`, JSON.stringify({ hostname: hostname(), gpu, dimensions, method: "GpuPerf hardware first-pass-to-last-pass timestamps; seven alternating pairs, 120 warmup frames and 40 independent samples per block", blocks, errors }, null, 2))
  }
  if (errors.length) throw Error(errors.join("\n"))
  console.log(`Water checkpoint: ${out}`)
} finally {
  await browser.close()
  await server.close()
}
