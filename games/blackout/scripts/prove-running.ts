// Headless Metal evidence. Run through hivemind; one browser and one ephemeral loopback server.
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable } from "./compare"

const label = process.env.RUN_LABEL ?? "early"
const out = join(import.meta.dir, `../../../captures/running/${label}`)
mkdirSync(out, { recursive: true })
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing port")
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const video = process.argv.includes("--video")
const phaseStudy = process.argv.includes("--phase")
const routes = ["run", "sprint", "diagonal", "acceleration", "braking"]
const requestedViews = process.argv.find(arg => arg.startsWith("--views="))?.slice(8).split(",")
const views = requestedViews ?? (process.argv.includes("--quick") ? ["three"] : ["game", "side", "three"])
const evidence: unknown[] = requestedViews && existsSync(join(out, "evidence.json"))
  ? JSON.parse(readFileSync(join(out, "evidence.json"), "utf8")).evidence.filter((row: { view: string }) => !views.includes(row.view)) : []
const variants = label === "refined" ? ["refined"] : label === "early" ? ["old", "current"] : ["old", "current", "refined"]
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  for (const view of views) for (const route of routes) for (const variant of variants) {
    const mode = variant === "old" ? "old" : "new"
    const dir = join(out, `${view}-${route}-${variant}`)
    mkdirSync(dir, { recursive: true })
    const camera = view === "game" ? "zoom=24" : `zoom=6&side=${view === "side" ? 0 : 35}&elev=14`
    const url = `http://127.0.0.1:${address.port}/anim.html?manual&only=running&runRoute=${route}&animation=${mode}&runPosture=${variant === "current" ? 0 : 0.18}&${camera}`
    const open = async () => {
      await page.goto(url)
      await page.waitForFunction(() => (window as any).ready, null, { timeout: 30000 })
    }
    await open()
    const gpu = await page.evaluate(() => ({ architecture: (window as any).animProof.adapter.architecture }))
    if (!/metal/i.test(gpu.architecture)) throw new Error(`Not Metal: ${JSON.stringify(gpu)}`)
    const samples: unknown[] = []
    const ticks = video ? Array.from({ length: 72 }, (_, n) => (n + 1) * 2) : [30, 48, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 114, 126, 144]
    let previous = 0
    for (const tick of ticks) {
      await page.evaluate(ms => (window as any).advance(ms), (tick - previous) * 1000 / 60)
      previous = tick
      const sample = await page.evaluate(() => (window as any).animProof.sample())
      samples.push({ tick, ...sample })
      await page.screenshot({ path: join(dir, `${String(tick).padStart(4, "0")}.png`) })
    }
    const settings = await page.evaluate(() => ({ ...(window as any).animProof.animation }))
    evidence.push({ label, view, route, mode: variant, camera, gpu, settings, samples })
    writeFileSync(join(out, "evidence.json"), JSON.stringify({ errors, evidence }, null, 2))
    console.log(`${label}: ${view} ${route} ${variant}, ${ticks.length} frames`)
    if (phaseStudy && ["run", "sprint", "diagonal"].includes(route)) {
      await open()
      const cycle = await page.evaluate(() => {
        const p = (window as any).animProof
        const contacts: number[] = []
        let planted = true
        for (let tick = 1; tick <= 180; tick++) {
          p.step(1 / 60)
          const sample = p.sample()
          const next = sample.feet[0].planted
          if (tick > 60 && !planted && next) contacts.push(tick)
          planted = next
        }
        if (contacts.length < 2) throw new Error("No complete left-foot cycle")
        return { start: contacts[0]!, end: contacts[1]! }
      })
      await open()
      const phaseSamples: unknown[] = []
      let previous = 0
      mkdirSync(join(dir, "phase"), { recursive: true })
      for (let index = 0; index < 10; index++) {
        const tick = Math.round(cycle.start + (cycle.end - cycle.start) * index / 10)
        await page.evaluate(ms => (window as any).advance(ms), (tick - previous) * 1000 / 60)
        previous = tick
        phaseSamples.push({ index, cycleFraction: index / 10, actualFraction: (tick - cycle.start) / (cycle.end - cycle.start), tick,
          ...await page.evaluate(() => (window as any).animProof.sample()) })
        await page.screenshot({ path: join(dir, "phase", `${index}.png`) })
      }
      // Physical cycles are normalized for posture diagnosis only. Never retime the real-time film.
      writeFileSync(join(dir, "phase.json"), JSON.stringify({ view, route, variant, cycle, samples: phaseSamples }, null, 2))
    }
  }
  if (label === "comparison") {
    await page.goto(`http://127.0.0.1:${address.port}/?sandbox=1&seed=7&bench=1&lab=1`)
    const control = page.locator('[data-lab] [data-row="runPosture"]')
    await control.waitFor()
    await control.click()
    await page.keyboard.press("Enter")
    await page.getByRole("textbox", { name: "Exact Run posture · rad" }).fill("0.27")
    await page.keyboard.press("Enter")
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as any).copiedAnimation = JSON.parse(text) },
    } }))
    await page.keyboard.press("c")
    await page.waitForFunction(() => (window as any).copiedAnimation?.runPosture === 0.27)
    const copied = await page.evaluate(() => (window as any).copiedAnimation)
    await page.keyboard.press("Enter")
    await page.getByRole("textbox", { name: "Exact Run posture · rad" }).fill("0.18")
    await page.keyboard.press("Enter")
    await page.screenshot({ path: join(out, "lab.png") })
    writeFileSync(join(out, "lab.json"), JSON.stringify({ copied, exactKeyboardEdit: true, errors }, null, 2))
  }
  if (errors.length) throw new Error(errors.join("\n"))
} finally { await browser.close(); await server.close() }
