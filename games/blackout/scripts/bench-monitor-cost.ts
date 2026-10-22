// Frozen-frame, same-device OFF/ON pairs resolve costs smaller than reload-to-reload GPU clock variance.
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostname } from "node:os"
import { findChromeExecutable, installGpuInstrumentation, verifyMonitorBounds } from "./compare"

await using budget = browserBudget()
const { chromium } = budget

const base = process.argv.find((s) => s.startsWith("--base="))?.slice(7)
const experiment = process.argv.find((s) => s.startsWith("--experiment="))?.slice(13) ?? "monitor-cost"
if (!base) throw new Error("--base required")
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const summary = (runs: number[]) => ({ median: median(runs), mad: median(runs.map((x) => Math.abs(x - median(runs)))), p95: [...runs].sort((a, b) => a - b)[Math.ceil(runs.length * 0.95) - 1], min: Math.min(...runs), max: Math.max(...runs), runs })
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await installGpuInstrumentation(page)
  const views = []
  for (const [id, x, y] of [["openplan_east", 45.2, 4.2], ["openplan_south", 46.8, 12.8]] as const) {
    await page.goto(`${base}/envlab.html?vanilla=1&monitors=1&seed=1&zoom=17&x=${x}&y=${y}&manualVideo=1`, { waitUntil: "networkidle" })
    await page.waitForFunction('typeof window.setMonitors === "function" && typeof window.gpuIdle === "function"')
    await page.evaluate(async () => {
      const w = window as any
      if (w.__gpuAdapterInfo.vendor !== "apple" || !w.__gpuAdapterInfo.hasTimestampQuery || w.__gpuAdapterInfo.isFallbackAdapter) throw new Error("Hardware timestamps required")
      for (let i = 0; i < 60; i++) await w.__stepManualVideo(1000 / 30)
    })
    const measure = (enabled: boolean) => page.evaluate(async (on) => {
      const w = window as any
      w.setMonitors(on)
      for (let i = 0; i < 4; i++) { await w.__stepManualVideo(0); await w.__gpuDrain() }
      w.__clearGpuSamples()
      for (let i = 0; i < 32; i++) { await w.__stepManualVideo(0); await w.__gpuDrain() }
      const samples = w.__gpuSamples.slice(-32) as { gpuHwMs: number; sceneMs: number; polarMs: number }[]
      if (samples.length !== 32) throw new Error(`Expected 32 GPU samples, got ${samples.length}`)
      const mean = (key: keyof typeof samples[number]) => samples.reduce((n, s) => n + s[key], 0) / samples.length
      return { gpu_hw_ms: mean("gpuHwMs"), scene_ms: mean("sceneMs"), polar_ms: mean("polarMs"), samples, counts: w.stats() }
    }, enabled)
    const pairs = []
    for (let run = 0; run < 8; run++) {
      const first = await measure(run % 2 !== 0)
      const second = await measure(run % 2 === 0)
      const [off, on] = run % 2 ? [second, first] : [first, second]
      if (on.counts.monitorLights < 1 || off.counts.monitorLights !== 0 || on.counts.shadowLights !== off.counts.shadowLights) throw new Error("Invalid monitor isolation")
      const pair = { run, warmup: run === 0, off, on, delta_ms: on.gpu_hw_ms - off.gpu_hw_ms, scene_delta_ms: on.scene_ms - off.scene_ms }
      pairs.push(pair)
      console.log(JSON.stringify({ id, run, warmup: pair.warmup, delta_ms: pair.delta_ms, scene_delta_ms: pair.scene_delta_ms }))
    }
    views.push({ id, gpu_delta_ms: summary(pairs.slice(1).map((p) => p.delta_ms)), scene_delta_ms: summary(pairs.slice(1).map((p) => p.scene_delta_ms)), pairs })
  }
  await verifyMonitorBounds(page)
  if (errors.length) throw new Error(errors.join("\n"))
  const dir = join(import.meta.dir, "../../../perf")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `blackout-${experiment}.json`), JSON.stringify({ target: "blackout", experiment, timestamp: new Date().toISOString(), machine: hostname(), warmup: 1, measured: 7, samplesPerBlock: 32, frozenTimeSeconds: 2, boundsPixelParity: true, views }, null, 2) + "\n")
  console.log(JSON.stringify(views.map(({ id, gpu_delta_ms }) => ({ id, ...gpu_delta_ms }))))
} finally {
  await browser.close()
}
