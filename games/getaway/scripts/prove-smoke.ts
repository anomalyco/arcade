/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Sequential, silent Metal captures of a fixed 30 Hz launch/turn. Requires the named Nexus preview.
const out = join(import.meta.dir, "../../../captures/getaway-smoke")
mkdirSync(out, { recursive: true })
const video = process.argv.includes("--video")
const styles = process.argv.find(a => a.startsWith("--styles="))?.slice(9).split(",").map(Number) ?? [0, 1, 2, 3, 4, 5]
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const proof: unknown[] = []
let referencePoses: string | undefined
try {
  const page = await browser.newPage({ viewport: video ? { width: 720, height: 1280 } : { width: 960, height: 640 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  for (const style of styles) {
    await page.goto(`http://getaway-smoke.localhost:1355/?solo&peaceful=1&seed=7&bench&nohud&smoke=${style}`)
    await page.waitForFunction(() => (window as any).__getawayBench, { timeout: 30000 })
    const adapter = await page.evaluate(async () => { const b = (window as any).__getawayBench; await b.ready; b.reset(true); return b.adapterInfo })
    if (!adapter.architecture.includes("metal") || /swiftshader/i.test(JSON.stringify(adapter))) throw new Error(JSON.stringify(adapter))
    console.log("Style", style, adapter)
    if (video) await page.evaluate((style) => {
      const names = ["Current", "Faceted puffs", "Soft volume", "Cel smoke", "Flame & wisps", "Ribbon trails"]
      const label = document.createElement("div")
      label.textContent = `${style} / 5  ·  ${names[style]}`
      label.style.cssText = "position:fixed;top:90px;left:32px;right:32px;font:600 30px system-ui;color:#fff;background:#10151ed9;padding:18px 22px;border-radius:12px;z-index:9999"
      document.body.append(label)
    }, style)
    const poses: unknown[] = []
    const samples: unknown[] = []
    for (let i = 0; i < 110; i++) {
      const result = await page.evaluate(async i => (window as any).__getawayBench.step(i, 1 / 30, true), i)
      poses.push(result.pose)
      samples.push({ frame: i, ...result.smoke, ...result.stats })
      if (video) {
        if (i % 2 === 0) await page.screenshot({ path: join(out, `phone-${style}-${String(i / 2).padStart(3, "0")}.jpg`), type: "jpeg", quality: 91 })
      } else if ([18, 64, 92].includes(i)) {
        console.log(i, result.pose, result.smoke)
        await page.screenshot({ path: join(out, `style-${style}-${i}.png`) })
      }
    }
    const serialized = JSON.stringify(poses)
    if (referencePoses && serialized !== referencePoses) throw new Error(`Style ${style} changed the simulation route`)
    referencePoses = serialized
    proof.push({ style, adapter, poses, samples })
  }
  // The compact selector changes the live emitter without reloading the page.
  await page.evaluate(() => {
    const select = document.querySelector("[data-lab]")!.shadowRoot!.querySelector("select")!
    select.value = "2"
    select.dispatchEvent(new Event("change"))
    ;(window as any).__getawayBench.reset(true)
  })
  let selected: any
  for (let i = 0; i < 20; i++) selected = await page.evaluate(async i => (window as any).__getawayBench.step(i, 1 / 30, true), i)
  if (selected.smoke.puffs !== 0 || selected.smoke.sprites === 0 || !page.url().includes("smoke=2")) throw new Error("Live smoke selector failed")
  writeFileSync(join(out, video ? "phone-proof.json" : "proof.json"), JSON.stringify({ errors, runs: proof }, null, 2))
  if (errors.length) throw new Error(errors.slice(0, 8).join("\n"))
} finally { await browser.close() }
