// Run on a Metal host through hivemind. Owns one ephemeral loopback server and one headless browser.
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable } from "./compare"

await using budget = browserBudget()
const { chromium } = budget

const out = join(import.meta.dir, "../../../captures/blackout-anim")
mkdirSync(out, { recursive: true })
const video = process.argv.includes("--video")
const modes = process.argv.includes("--mode=new") ? ["new"] : ["old", "new"]
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing Vite port")
const base = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const samples: unknown[] = []
const times = [1, 3, 5, 7, 9, 11, 13.35, 14.65, 16.95, 17.1, 17.4, 17.85]
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 540 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  for (const zoom of video ? [24, 7] : [7]) for (const mode of modes) {
    const prefix = `${zoom === 24 ? "game" : "close"}-${mode}`
    const dir = join(out, prefix)
    mkdirSync(dir, { recursive: true })
    await page.goto(`${base}/anim.html?manual&only=proof&follow=proof&zoom=${zoom}&animation=${mode}`)
    await page.waitForFunction(() => (window as any).ready, null, { timeout: 30000 })
    const gpu = await page.evaluate(() => {
      const info = (window as any).animProof.adapter
      return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
    })
    if (!/metal/i.test(gpu.architecture) || /swiftshader/i.test(JSON.stringify(gpu))) throw new Error(`Not Metal: ${JSON.stringify(gpu)}`)
    let time = 0, sample = 0
    const count = video ? 540 : times.length
    for (let n = 0; n < count; n++) {
      const target = video ? (n + 1) / 30 : times[n]!
      await page.evaluate(ms => (window as any).advance(ms), (target - time) * 1000)
      time = target
      const path = join(dir, video ? `${String(n).padStart(4, "0")}.png` : `still-${n}.png`)
      await page.screenshot({ path })
      if (!video || sample < times.length && time >= times[sample]!) {
        if (video) await page.screenshot({ path: join(dir, `still-${sample}.png`) })
        samples.push(await page.evaluate(({ prefix, time }) => {
          const p = (window as any).animProof
          const a = p.game.avatars?.get("proof")
          return { prefix, time, alive: p.session.latest().snap.players[0].alive, corpses: p.game.corpses?.length,
            pelvis: a?.body?.pelvis.p, feet: a?.feet, phase: a?.phase }
        }, { prefix, time }))
        sample++
      }
    }
    console.log(`${prefix}: ${count} frames, ${gpu.architecture}`)
  }
  // Real sandbox, including keyboard/pointer-isolated Lab controls.
  await page.goto(`${base}/?sandbox=1&seed=7&bench=1&lab=1`)
  await page.waitForSelector('[data-lab]')
  await page.waitForTimeout(1500)
  const controlCount = await page.locator('[data-lab] [data-row="Animation"]').count()
  if (controlCount !== 1) throw new Error("Animation group missing in sandbox")
  const mode = page.locator('[data-lab] select[data-key="animationMode"]')
  await mode.selectOption("old")
  await page.screenshot({ path: join(out, "sandbox-old.png") })
  await mode.selectOption("new")
  await page.screenshot({ path: join(out, "sandbox-new.png") })
  const sliders = await page.locator('[data-lab] input[type=range]').count()
  if (sliders < 14) throw new Error(`Missing animation sliders: ${sliders}`)
  await page.keyboard.press("Backquote")
  await page.keyboard.down("KeyD")
  await page.waitForTimeout(750)
  await page.keyboard.up("KeyD")
  await page.screenshot({ path: join(out, "sandbox-game.png") })
  writeFileSync(join(out, "proof.json"), JSON.stringify({ capturedModes: modes, samples, errors, sandbox: { controlCount, sliders, modes: ["old", "new"] } }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
} finally {
  await browser.close()
  await server.close()
}
