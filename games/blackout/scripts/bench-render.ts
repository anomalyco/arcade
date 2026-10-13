import { chromium } from "playwright-core"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostname } from "node:os"
import { findChromeExecutable, installGpuInstrumentation, runSceneABenchmark, verifyMonitorBounds } from "./compare"
import { installMainHook } from "../../../packages/kit/getaway-main-hook"

const opt = (key: string, fallback: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const target = opt("game", "blackout")
const experiment = opt("experiment", "baseline")
const root = join(import.meta.dir, "../../..")
mkdirSync(join(root, "perf"), { recursive: true })
const median = (a: number[]) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)]!
const summary = (a: number[]) => ({ median: median(a), mad: median(a.map((x) => Math.abs(x - median(a)))), p95: [...a].sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1], runs: a })
const launch = () => chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
let browser = await launch()
try {
  const runs: Record<string, number>[] = []
  for (let run = 0; run < 8; run++) {
    if (run) browser = await launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: target === "blackout" ? 800 : 720 } })
    if (target === "getaway" && opt("source-root", "")) await installMainHook(page, opt("source-root", ""))
    if (target === "getaway" && process.argv.includes("--main-renderer")) {
      // Serve main's render code only to this isolated browser; never alter the running preview or its checkout.
      for (const file of ["renderer", "shaders"]) {
        const source = Bun.spawnSync(["git", "show", `main:games/getaway/src/render/${file}.ts`], { cwd: root })
        if (source.exitCode) throw new Error(source.stderr.toString())
        const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.stdout.toString()).replace(/from "(\.\.?\/[^".]+)"/g, 'from "$1.ts"')
        await page.route(`**/src/render/${file}.ts*`, (route) => route.fulfill({ contentType: "text/javascript", body: js }))
      }
    }
    // Benchmarks never use room sockets. Ignore dev-server HMR while measuring a loaded scene.
    await page.routeWebSocket("**", (socket) => {
      const server = socket.connectToServer()
      server.onMessage((message) => {
        if (typeof message === "string" && /"type":"(?:update|full-reload)"/.test(message)) return
        socket.send(message)
      })
    })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    if (target === "getaway") await page.addInitScript(() => {
      const w = window as unknown as { __shadowMatrices: Set<string> }
      w.__shadowMatrices = new Set()
      const write = GPUQueue.prototype.writeBuffer
      GPUQueue.prototype.writeBuffer = function (buffer, offset, data, dataOffset, size) {
        if (data instanceof Float32Array && data.length === 64) w.__shadowMatrices.add(Array.from(data.subarray(16, 32)).join(","))
        return write.call(this, buffer, offset, data, dataOffset, size)
      }
    })
    await installGpuInstrumentation(page)
    let result: Record<string, number> = {}
    if (target === "blackout") {
      const paired = process.argv.includes("--paired-monitors")
      const offFirst = run % 2 === 0
      const offBefore = paired && offFirst ? await runSceneABenchmark(page, "0") : null
      const report = await runSceneABenchmark(page, paired ? "1" : undefined)
      const off = paired ? offBefore ?? await runSceneABenchmark(page, "0") : null
      if (run === 7) writeFileSync(join(root, `perf/blackout-${experiment}-capture.json`), JSON.stringify(report, null, 2) + "\n")
      result = { gpu_hw_ms: report.averages.gpu_hw_ms, gpu_idle_ms: report.averages.gpu_idle_ms, frame_ms: report.averages.frame_ms, vertices: report.viewpoints.reduce((n, v) => n + v.vertices, 0) / report.viewpoints.length, chunks: report.viewpoints.reduce((n, v) => n + v.chunks, 0) / report.viewpoints.length, stress4_gpu_estimated_ms: report.stress4.gpu_hw_ms }
      for (const v of report.viewpoints) {
        result[`${v.id}_gpu_hw_ms`] = v.gpu_hw_ms
        result[`${v.id}_gpu_idle_ms`] = v.gpu_idle_ms
        result[`${v.id}_polar_pass_ms`] = v.polar_pass_ms
        if (off) {
          const control = off.viewpoints.find((p) => p.id === v.id)!
          result[`${v.id}_off_gpu_hw_ms`] = control.gpu_hw_ms
          result[`${v.id}_monitor_delta_ms`] = v.gpu_hw_ms - control.gpu_hw_ms
          result[`${v.id}_monitor_scene_delta_ms`] = v.scene_pass_ms - control.scene_pass_ms
          result[`${v.id}_monitor_polar_delta_ms`] = v.polar_pass_ms - control.polar_pass_ms
        }
      }
    } else {
      await page.goto(`${opt("base", "http://localhost:4828")}/?solo&bench&vanilla=1`, { waitUntil: "networkidle" })
      await page.waitForFunction("window.__getawayBench")
      result = await page.evaluate(async () => {
        const w = window as unknown as { __gpuDrain(): Promise<void>; __shadowMatrices: Set<string>; __getawayBench: { ready: Promise<boolean>; reset(): void; step(i: number, dt: number, wait: boolean): Promise<{ cpuMs: number; gpuMs: number; stats: { cityVertsDrawn: number; chunksDrawn: number } }> }; __gpuSamples: { gpuHwMs: number; vertices: number; passes: number[] }[]; __gpuAdapterInfo: { vendor: string; hasTimestampQuery: boolean; isFallbackAdapter: boolean } }
        await w.__getawayBench.ready
        if (w.__gpuAdapterInfo.vendor !== "apple" || !w.__gpuAdapterInfo.hasTimestampQuery || w.__gpuAdapterInfo.isFallbackAdapter) throw new Error("Hardware timestamp adapter required")
        for (let i = 0; i < 20; i++) await w.__getawayBench.step(i, 1 / 30, true)
        w.__getawayBench.reset()
        w.__gpuSamples.length = 0
        w.__shadowMatrices.clear()
        let cpu = 0, gpu = 0, cityVertices = 0, chunks = 0
        const views = [0, 0, 0]
        for (let i = 0; i < 180; i++) {
          const m = await w.__getawayBench.step(i, 1 / 30, true)
          await w.__gpuDrain()
          cpu += m.cpuMs
          gpu += m.gpuMs
          cityVertices += m.stats.cityVertsDrawn
          chunks += m.stats.chunksDrawn
          views[Math.floor(i / 60)]! += m.gpuMs / 60
        }
        if (!w.__gpuSamples.length) throw new Error("No hardware timestamp samples")
        const avg = (get: (s: typeof w.__gpuSamples[number]) => number) => w.__gpuSamples.reduce((n, s) => n + get(s), 0) / w.__gpuSamples.length
        return { cpu_ms: cpu / 180, gpu_idle_ms: gpu / 180, frame_ms: (cpu + gpu) / 180, gpu_hw_ms: avg(s => s.gpuHwMs), shadow_ms: avg(s => s.passes[0]!), main_post_ms: avg(s => s.gpuHwMs - s.passes[0]!), vertices: avg(s => s.vertices), city_vertices: cityVertices / 180, chunks: chunks / 180, unique_shadow_matrices: w.__shadowMatrices.size, view1_gpu_idle_ms: views[0]!, view2_gpu_idle_ms: views[1]!, view3_gpu_idle_ms: views[2]! }
      })
    }
    if (run === 7 && process.argv.includes("--verify-bounds")) await verifyMonitorBounds(page)
    if (errors.length) throw new Error(errors.join("\n"))
    console.log(JSON.stringify({ run, warmup: run === 0, ...result }))
    if (run) runs.push(result)
    await browser.close()
  }
  const metrics = Object.fromEntries(Object.keys(runs[0]!).map((k) => [k, summary(runs.map((r) => r[k]!))]))
  const record = { target, experiment, timestamp: new Date().toISOString(), machine: hostname(), warmup: 1, measured: 7, metrics }
  mkdirSync(join(root, "perf"), { recursive: true })
  appendFileSync(join(root, "perf/results.jsonl"), JSON.stringify(record) + "\n")
  writeFileSync(join(root, `perf/${target}-${experiment}.json`), JSON.stringify(record, null, 2) + "\n")
  console.log(`METRIC ${target}_gpu_hw_ms=${metrics.gpu_hw_ms!.median} MAD=${metrics.gpu_hw_ms!.mad}`)
} finally {
  await browser.close()
}
