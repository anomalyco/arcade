/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const out = process.env.CLUTTER_OUT ?? join(import.meta.dir, "../../../perf/clutter/proof")
mkdirSync(out, { recursive: true })
const fixture = process.argv.includes("--fixture") ? await (await import("vite")).createServer({ root: join(import.meta.dir, ".."), server: { host: "127.0.0.1", port: 0 }, configFile: join(import.meta.dir, "../vite.config.ts") }) : null
await fixture?.listen()
const address = fixture?.httpServer?.address()
const host = typeof address === "object" && address ? `http://localhost:${address.port}` : process.env.CLUTTER_URL ?? "http://getaway-clutter.localhost:1355"
const mode = process.argv[2] ?? "stills"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync) ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: mode === "video" ? { width: 720, height: 1100 } : { width: 1000, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) { errors.push(m.text()); console.error(m.text()) } })
  await page.addInitScript(() => {
    const samples: number[] = []
    ;(window as any).__totalGpu = samples
    const original = GPUBuffer.prototype.getMappedRange
    GPUBuffer.prototype.getMappedRange = function(offset = 0, size?: number) {
      const result = original.call(this, offset, size)
      if (this.size === 512 && size && size >= 32 && size % 16 === 0) {
        const times = new BigUint64Array(result)
        // One enclosing frame interval. Never sum overlapping render-pass ranges.
        samples.push(Number(times[times.length - 1]! - times[0]!) / 1e6)
      }
      return result
    }
  })
  await page.goto(`${host}/?solo&peaceful=1&seed=7&bench&nohud`)
  await page.waitForFunction(() => (window as any).__getawayBench?.clutter, null, { timeout: 30000 })
  const adapter = await page.evaluate(async () => {
    const b = (window as any).__getawayBench
    await b.ready
    document.querySelector<HTMLElement>("[data-lab]")?.remove()
    return b.adapterInfo
  })
  if (JSON.stringify(adapter).toLowerCase().includes("swiftshader") || !adapter.architecture.includes("metal")) throw new Error(`Not Metal: ${JSON.stringify(adapter)}`)
  console.log("adapter", adapter)
  const evidence: any[] = []
  if (mode === "paired") {
    for (const scene of ["city", "stress"]) {
      await page.evaluate(scene => (window as any).__getawayBench.clutter.setup(scene), scene)
      for (let i = 0; i < (scene === "stress" ? 10 : 1); i++) await page.evaluate(() => (window as any).__getawayBench.clutter.step())
      for (let run = -1; run < 7; run++) {
        const pair = await page.evaluate(async run => {
          const w = window as any, b = w.__getawayBench.clutter, on: number[] = [], off: number[] = []
          for (let pair = 0; pair < 12; pair++) for (const enabled of (pair + run) % 2 ? [true, false] : [false, true]) {
            b.enabled(enabled)
            const before = w.__totalGpu.length
            for (let i = 0; i < 30 && w.__totalGpu.length === before; i++) {
              await b.step(0)
              // Wait for pending mapped readback, not only queue submission.
              await new Promise(resolve => setTimeout(resolve, 0))
            }
            if (w.__totalGpu.length === before) throw new Error("No completed timestamp readback")
            ;(enabled ? on : off).push(w.__totalGpu.at(-1))
          }
          return { on, off }
        }, run)
        evidence.push({ scene, run, warmup: run < 0, ...pair })
        console.log(scene, run, pair)
      }
    }
  } else {
    let videoFrame = 0
    if (mode === "stills") {
      await page.evaluate(async () => { const b = (window as any).__getawayBench.clutter; b.setup("city"); await b.step(0) })
      await page.screenshot({ path: join(out, "city.png") })
    }
    for (const name of ["cones", "furniture", "hydrant", "explosion"]) {
      const placement = await page.evaluate(name => (window as any).__getawayBench.clutter.setup(name), name)
      if (mode === "video") await page.evaluate(name => {
        const label = document.getElementById("clutter-label") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "clutter-label" }))
        label.textContent = ({ cones: "Cones & barriers", furniture: "Bins & benches", hydrant: "Hydrant", explosion: "Chain reaction" } as Record<string, string>)[name]!
        label.style.cssText = "position:fixed;top:24px;left:24px;color:#eee;background:#101521c9;padding:8px 12px;font:500 20px system-ui;border-radius:8px;z-index:1000"
      }, name)
      const states = []
      for (let frame = 0; frame < (mode === "video" ? 105 : 85); frame++) {
        const state = await page.evaluate(() => (window as any).__getawayBench.clutter.step())
        states.push(state)
        if (mode === "video") await page.screenshot({ path: join(out, `phone-${String(videoFrame++).padStart(4, "0")}.png`) })
        else if ([0, 15, 22, 30, 45, 75].includes(frame)) await page.screenshot({ path: join(out, `${name}-${frame}.png`) })
      }
      const hits = Math.max(...states.map(s => s.hits)), explosions = Math.max(...states.map(s => s.explosions))
      if (!hits || name === "explosion" && explosions < 2) throw new Error(`Missing ${name} reactions: hits=${hits}, explosions=${explosions}`)
      evidence.push({ name, placement, states })
      console.log(name, { hits, explosions, maxParticles: Math.max(...states.map(s => s.particles)), maxAwake: Math.max(...states.map(s => s.awake)) })
    }
  }
  writeFileSync(join(out, `${mode}.json`), JSON.stringify({ adapter, errors, gpuMetric: "first pass beginning to final pass end; completed readback", evidence }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
} finally { await browser.close(); await fixture?.close() }
