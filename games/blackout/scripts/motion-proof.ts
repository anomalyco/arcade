import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable, installGpuInstrumentation } from "./compare"

await using budget = browserBudget()
const { chromium } = budget

// Deterministic rendering fixture: real game geometry, camera pan and moving actor/vehicle instances.
// Replay identical transforms on both sides. Times cover polar compute through final composite.
const root = join(import.meta.dir, "../../..")
const out = join(root, "captures/blackout-motion")
mkdirSync(out, { recursive: true })
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
reserve.stop(true)
const server = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: join(root, "games/blackout"), stdout: "ignore", stderr: "inherit" })
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const base = `http://localhost:${port}`
  const until = Date.now() + 15000
  while (!await fetch(base).then(r => r.ok).catch(() => false)) {
    if (Date.now() > until) throw new Error("Vite failed")
    await Bun.sleep(100)
  }
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) errors.push(m.text()) })
  await installGpuInstrumentation(page)
  const report: any = { resolution: [2560, 1440], warmup: 1, pairs: 7, samplesPerBlock: 96, settlePerBlock: 32, target: "offscreen final composite (same format/size, excludes presentation contention)", views: [] }
  for (const view of ["office", "downtown", "lot"]) {
    await page.goto(`${base}/?${view === "office" ? "sandbox=1" : `practice&map=${view}`}&seed=4&manualVideo=1`, { waitUntil: "networkidle" })
    await page.waitForFunction("window.__gpuDevice && window.__stepManualVideo && document.querySelector('[data-lab]')")
    report.adapter = await page.evaluate(() => (window as any).__gpuAdapterInfo)
    if (report.adapter.vendor !== "apple" || !report.adapter.hasTimestampQuery || report.adapter.isFallbackAdapter) throw new Error("Apple hardware timestamps required")
    await page.evaluate(async view => {
      const w = window as any
      const path = "/src/render/renderer.ts"
      const { Renderer } = await import(/* @vite-ignore */ path)
      const render = Renderer.prototype.render
      Renderer.prototype.render = function(f: any) { w.__fixtureRenderer = this; w.__fixtureFrame = f; render.call(this, f) }
      if (view !== "office") {
        const world = w.practice
        world.botFill = 1
        const p = world.players.get("you")
        if (view === "lot") { p.x = 12; p.y = 9 }
        for (const p of world.players.values()) if (p.brain) p.brain = { think: () => ({ mx: 0, my: 0, aim: p.aim }) }
      }
      for (let i = 0; i < 120; i++) { await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone() }
      const source = w.__fixtureFrame
      w.__fixtureContext = w.__fixtureRenderer.context
      w.__fixtureOutput = w.__gpuDevice.createTexture({ size: [2560, 1440], format: navigator.gpu.getPreferredCanvasFormat(), usage: GPUTextureUsage.RENDER_ATTACHMENT })
      w.__sourceFrame = { ...source, frame: source.frame.slice(), batches: source.batches.map((b: any) => ({ ...b, data: b.data.slice() })) }
      w.__renderFixture = async (tick: number, motion: boolean, shadow: boolean, mode = "both") => {
        const source = w.__sourceFrame
        const f = { ...source, frame: source.frame.slice(), batches: source.batches.map((b: any) => ({ ...b, data: b.data.slice() })) }
        f.frame[45] = (f.frame[45] & ~1536) | (motion ? 1024 : 0) | (shadow ? 512 : 0)
        f.frame[19] = source.frame[19] + tick / 60
        if (mode !== "object") {
          const pan = Math.sin(tick * 0.12) * 1.8
          for (let row = 0; row < 4; row++) f.frame[12 + row] += f.frame[row] * pan
          f.frame[16] -= pan
        }
        if (mode !== "camera") for (const b of f.batches) for (let i = 0; i < b.count; i++) if (b.motionKeys?.[i]) {
          b.data[i * 12] += Math.sin(tick * 0.16) * 0.8
          b.data[i * 12 + 3] += Math.sin(tick * 0.09) * 0.3
        }
        w.__fixtureRenderer.render(f)
        await Promise.resolve()
        await w.__gpuDevice.queue.onSubmittedWorkDone()
        await w.__gpuDrain()
      }
    }, view)
    const measure = async (motion: boolean, shadow: boolean, mode = "both", present = false) => page.evaluate(async ({ motion, shadow, mode, present }) => {
      const w = window as any
      w.__fixtureRenderer.context = present ? w.__fixtureContext : { getCurrentTexture: () => w.__fixtureOutput }
      w.__fixtureRenderer.previousFrame = null
      const warmup = present ? 8 : 32, count = present ? 24 : 96
      for (let i = 0; i < warmup; i++) await w.__renderFixture(i, motion, shadow, mode)
      w.__clearGpuSamples()
      for (let i = warmup; i < warmup + count; i++) await w.__renderFixture(i, motion, shadow, mode)
      const samples = w.__gpuSamples as { gpuHwMs: number; ranges: number[][] }[]
      if (samples.length !== count || samples.some(s => !(s.gpuHwMs > 0) || s.ranges.some(r => r[1]! < r[0]!))) throw new Error("Invalid GPU samples")
      return { ms: samples.reduce((a, s) => a + s.gpuHwMs, 0) / samples.length, samples }
    }, { motion, shadow, mode, present })
    for (const effect of ["shadow", "motion"]) {
      const pairs = []
      for (let run = 0; run < 8; run++) {
        const block = (on: boolean) => measure(effect === "motion" && on, effect === "motion" || on)
        const a = await block(!!(run % 2)), b = await block(!(run % 2))
        const [off, on] = run % 2 ? [b, a] : [a, b]
        pairs.push({ run, warmup: run === 0, off, on, delta: on.ms - off.ms })
      }
      const deltas = pairs.slice(1).map(p => p.delta).sort((a, b) => a - b)
      const median = deltas[3]!, mad = deltas.map(d => Math.abs(d - median)).sort((a, b) => a - b)[3]!
      report.views.push({ view, effect, median, mad, pairs })
      console.log(JSON.stringify({ view, effect, median, mad }))
    }
    for (const mode of ["both", "camera", "object"]) for (const motion of [false, true]) {
      await measure(motion, true, mode, true)
      await page.screenshot({ path: join(out, `${view}-${mode}-${motion ? "on" : "off"}.png`) })
    }
    // The real Lab control and frame builder: moving, firing, projectile/flash identities, then a resize cut.
    await page.evaluate(() => {
      const input = document.querySelector("[data-lab]")!.shadowRoot!.querySelector<HTMLInputElement>('input[data-key="lookMotion"]')!
      if (input.checked) throw new Error("Motion must default off")
      input.checked = true; input.dispatchEvent(new Event("change"))
    })
    await page.mouse.move(1800, 650)
    await page.mouse.down()
    await page.keyboard.down("d")
    const live = await page.evaluate(async () => {
      const w = window as any
      let sprites = 0, parts = 0
      for (let i = 0; i < 24; i++) {
        await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone(); await w.__gpuDrain()
        sprites = Math.max(sprites, w.__fixtureFrame.addMotionKeys.filter(Boolean).length)
        parts = Math.max(parts, w.__fixtureFrame.batches.reduce((n: number, b: any) => n + (b.motionKeys?.filter(Boolean).length ?? 0), 0))
      }
      if (!sprites || !parts || !w.__fixtureRenderer.motionData[16]) throw new Error("Live motion history missing")
      return { sprites, parts }
    })
    await page.keyboard.up("d"); await page.mouse.up()
    await page.screenshot({ path: join(out, `${view}-live.png`) })
    await page.evaluate(async () => {
      const w = window as any, r = w.__fixtureRenderer
      r.resize(2558, 1440); r.resize(2560, 1440)
      await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone()
      if (r.motionData[16] !== 0) throw new Error("Resize must reset velocity")
    })
    report.views.push({ view, live })
  }
  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, "paired.json"), JSON.stringify(report, null, 2))
} finally { await browser.close(); server.kill(); await server.exited }
