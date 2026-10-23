import { browserBudget } from "../../../scripts/browser-budget"
import { writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { findChromeExecutable, installGpuInstrumentation } from "./compare"

await using budget = browserBudget()
const { chromium } = budget

const opt = (key: string, fallback: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const base = opt("base", "")
const variant = opt("variant", "moon-facing")
const changes: Record<string, [string, string][]> = {
  "moon-facing": [["let sh = shadow(world, n, ndl);", "var sh = 1.0; if (ndl > 0.0) { sh = shadow(world, n, ndl); }"]],
  "position-first": [["let li = lights[i];", "let pos = lights[i].pos;"], ["let d = li.pos.xyz - world;", "let d = pos.xyz - world;"], ["let r = li.pos.w;", "let r = pos.w;"], ["let invDist = inverseSqrt(max(d2, 1e-6));", "let li = lights[i]; let invDist = inverseSqrt(max(d2, 1e-6));"]],
}
if (!changes[variant]) throw new Error("Unknown variant")
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const pairs: any[] = []
const images = new Map<string, Buffer>()
try {
  for (let run = 0; run < 8; run++) {
    const pair: Record<string, unknown> = { run, warmup: run === 0 }
    for (const candidate of run % 2 ? [true, false] : [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      if (candidate) await page.route("**/src/render/shaders.ts*", async route => {
        const response = await route.fetch()
        let body = await response.text()
        for (const [from, to] of changes[variant]!) {
          if (!body.includes(from)) throw new Error(`Missing shader anchor: ${from}`)
          body = body.replace(from, to)
        }
        await route.fulfill({ response, body })
      })
      await installGpuInstrumentation(page)
      await page.goto(`${base}/?solo&bench&vanilla=1`, { waitUntil: "networkidle" })
      await page.waitForFunction("window.__getawayBench")
      const result = await page.evaluate(async () => {
        const w = window as any
        if (w.__gpuAdapterInfo.vendor !== "apple" || !w.__gpuAdapterInfo.hasTimestampQuery) throw new Error("Hardware timestamps required")
        const b = w.__getawayBench
        await b.ready
        for (let i = 0; i < 30; i++) { await b.step(i, 1/30, true); await w.__gpuDrain() }
        b.reset()
        w.__clearGpuSamples()
        const scene = (await import(/* @vite-ignore */ String("/src/game/scene.ts"))).Scene.prototype
        const draw = scene.draw
        let sceneCpu = 0
        scene.draw = function(...args: any[]) { const start = performance.now(); const out = draw.apply(this, args); sceneCpu += performance.now()-start; return out }
        let cpu = 0, idle = 0
        for (let i = 0; i < 180; i++) {
          const frame = await b.step(i, 1/30, true)
          cpu += frame.cpuMs; idle += frame.gpuMs
          await w.__gpuDrain()
        }
        const samples = w.__gpuSamples as {gpuHwMs: number; passes: number[]; ranges: number[][]}[]
        if (samples.length !== 180) throw new Error(`Expected 180 timestamps, got ${samples.length}`)
        const avg = (fn: (s: typeof samples[number]) => number) => samples.reduce((n, s) => n + fn(s), 0)/samples.length
        return { gpu_ms: avg(s=>s.gpuHwMs), cpu_ms: cpu/180, scene_cpu_ms: sceneCpu/180, frame_ms: (cpu+idle)/180, shadow_ms: avg(s=>s.passes[0]!), main_post_ms: avg(s=>s.gpuHwMs-s.passes[0]!), overlapping_samples: samples.filter(s=>s.ranges.some((r,i)=>i>0 && r[0]! < s.ranges[i-1]![1]!)).length }
      })
      if (run === 7) images.set(candidate ? "candidate" : "control", await page.screenshot())
      if (errors.length) throw new Error(errors.join("\n"))
      pair[candidate ? "candidate" : "control"] = result
      await page.close()
    }
    pairs.push(pair)
    console.log(JSON.stringify(pair))
  }
  const median = (xs: number[]) => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!
  const summary = (xs: number[]) => ({median:median(xs), mad:median(xs.map(x=>Math.abs(x-median(xs)))), p95:Math.max(...xs), runs:xs})
  const metrics = Object.fromEntries(Object.keys(pairs[1].control).map(key=>[key, {control:summary(pairs.slice(1).map(p=>p.control[key])), candidate:summary(pairs.slice(1).map(p=>p.candidate[key])), delta:summary(pairs.slice(1).map(p=>p.candidate[key]-p.control[key]))}]))
  const pixelParity = images.get("control")!.equals(images.get("candidate")!)
  const record = {target:"getaway", experiment:variant, machine:hostname(), timestamp:new Date().toISOString(), warmup:1, measured:7, pixelParity, metrics, pairs}
  writeFileSync(join(import.meta.dir, `../../../perf/getaway-${variant}.json`), JSON.stringify(record,null,2)+"\n")
  console.log(JSON.stringify({variant,pixelParity,metrics}))
} finally { await browser.close() }
