/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const out = join(import.meta.dir, "../../../captures/getaway-smoke-real")
mkdirSync(out, { recursive: true })
const video = process.argv.includes("--video"), timing = process.argv.includes("--timing")
// Bounded private fixture for fleet GPU measurements; interactive review uses Nexus.
const fixture = process.argv.includes("--fixture") ? await (await import("vite")).createServer({ configFile: join(import.meta.dir,"../vite.config.ts"), server: { host: "127.0.0.1", port: 0 } }) : null
await fixture?.listen()
const address = fixture?.httpServer?.address()
const host = typeof address === "object" && address ? `http://localhost:${address.port}` : "http://getaway-smoke.localhost:1355"
const styles = process.argv.find(a => a.startsWith("--styles="))?.slice(9).split(",").map(Number) ?? (video || timing ? [6,7,8] : [0,1,6,7,8])
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--disable-dawn-features=timestamp_quantization"] })
const errors: string[] = []
const proof: any[] = []
let referencePoses: string | undefined
const median = (a: number[]) => { const s = a.toSorted((a,b) => a-b); return s[Math.floor(s.length/2)]! }
try {
  const page = await browser.newPage({ viewport: video ? { width: 720, height: 1280 } : { width: 960, height: 640 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) { errors.push(m.text()); console.error(m.text().slice(0,500)) } })
  await page.goto(`${host}/?solo&peaceful=1&seed=7&bench&nohud&smoke=6${timing ? "&smoketiming" : ""}`)
  await page.waitForFunction(() => (window as any).__getawayBench, null, { timeout: 30000 })
  const adapter = await page.evaluate(async () => { const b = (window as any).__getawayBench; await b.ready; return b.adapterInfo })
  if (!adapter.architecture.includes("metal") || /swiftshader/i.test(JSON.stringify(adapter))) throw new Error(JSON.stringify(adapter))
  console.log("Adapter", adapter)
  for (const style of [0,6,7,8]) {
    await page.locator('select[aria-label="Smoke style"]').selectOption(String(style), { force: true })
    if (new URL(page.url()).searchParams.get("smoke") !== String(style)) throw new Error(`Smoke selector failed for ${style}`)
  }
  const reset = async (style: number, visible = true) => page.evaluate(({style,visible}) => { const b = (window as any).__getawayBench; b.smoke(style,visible); b.distance(38); b.reset(true) }, {style,visible})
  const step = async (i: number) => page.evaluate(async i => (window as any).__getawayBench.step(i, 1/30, true), i)
  if (timing) {
    // Warm every pipeline and route before the paired samples (including volume uploads).
    for (const style of styles) { await reset(style); for (let i=0;i<110;i++) await step(i) }
    for (const style of styles) {
      const pairs: any[] = []
      // Freeze each representative pose after the normal seeded simulation. One warm-up pair,
      // nine measured pairs, eight GPU frames per member. Alternate order on each pair.
      for (const frame of [18,64,92]) {
        await reset(style)
        for (let i=0;i<=frame;i++) await step(i)
        for (let pair = -1; pair < 9; pair++) {
          const runs: any = {}
          for (const visible of pair % 2 === 0 ? [true,false] : [false,true]) {
            await page.evaluate(({style,visible}) => (window as any).__getawayBench.smoke(style,visible),{style,visible})
            const frames: number[] = [], cpu: number[] = [], poses: any[] = []
            for (let repeat=0;repeat<8;repeat++) {
              const result = await page.evaluate(async frame => (window as any).__getawayBench.step(frame,0,true),frame)
              frames.push(result.totalGpuMs); cpu.push(result.cpuMs); poses.push(result.pose)
            }
            runs[visible ? "on" : "off"] = { frames, cpu, median: median(frames), poses }
          }
          if (JSON.stringify(runs.on.poses) !== JSON.stringify(runs.off.poses)) throw new Error("Paired route mismatch")
          if (pair >= 0) pairs.push({ frame, index: pair, on: runs.on, off: runs.off, delta: runs.on.median-runs.off.median })
        }
        console.log("timing", style, frame, median(pairs.filter(p=>p.frame===frame).map(p=>p.delta)))
      }
      const deltas = pairs.map(p=>p.delta), delta = median(deltas)
      proof.push({ style, pairs, delta, mad: median(deltas.map(x=>Math.abs(x-delta))), on: median(pairs.map(p=>p.on.median)), off: median(pairs.map(p=>p.off.median)) })
    }
  } else for (const style of styles) {
    await reset(style)
    if (video) await page.evaluate((style) => {
      const names: Record<number,string> = {6:"Advected billows",7:"Directional billows",8:"Raymarched cloud"}
      let label = document.getElementById("smoke-label")
      if (!label) { label = document.createElement("div"); label.id = "smoke-label"; document.body.append(label) }
      label.textContent = `${style} · ${names[style]}`
      label.style.cssText = "position:fixed;top:80px;left:28px;right:28px;font:600 28px system-ui;color:#fff;background:#10151ed9;padding:16px 20px;border-radius:10px;z-index:9999"
    }, style)
    const poses: any[] = [], samples: any[] = []
    for (let i = 0; i < (video ? 195 : 110); i++) {
      const result = await step(i)
      poses.push(result.pose); samples.push({ frame:i, ...result.smoke })
      if (video && i % 2 === 0) await page.screenshot({ path: join(out,`phone-${style}-${String(i/2).padStart(3,"0")}.jpg`),type:"jpeg",quality:92 })
      if (!video && [18,64,92].includes(i)) await page.screenshot({ path: join(out,`style-${style}-${i}.png`) })
    }
    if (!video) {
      await reset(style)
      await page.evaluate(() => (window as any).__getawayBench.distance(24))
      for (let i=0;i<=72;i++) await step(i)
      await page.screenshot({ path: join(out,`style-${style}-close.png`) })
    }
    const serialized = JSON.stringify(poses)
    if (referencePoses && serialized !== referencePoses) throw new Error(`Style ${style} changed route`)
    referencePoses = serialized
    proof.push({ style, poses, samples })
    console.log("Captured",style,"max",Math.max(...samples.map(s=>s.connected)))
  }
  writeFileSync(join(out,timing?"timings.json":video?"phone-proof.json":"proof.json"),JSON.stringify({ adapter, errors, method: "first-shadow-begin through dependent load/store of the same composite target; marker overhead in both members; no pass summation; 960x640; nine alternating pairs of eight frozen GPU frames at each of 18/64/92 after warmup", runs:proof },null,2))
  if (errors.length) throw new Error(errors.slice(0,5).join("\n"))
} finally { await browser.close(); await fixture?.close() }
