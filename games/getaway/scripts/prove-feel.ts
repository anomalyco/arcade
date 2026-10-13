import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Headless proof against the existing Nexus previews. No audio context is unlocked.
const out = join(import.meta.dir, "../../../captures/getaway-feel")
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const scenario = process.argv.find(a => a.startsWith("--scenario="))?.split("=")[1]
const scenarios = scenario ? [scenario] : process.argv.includes("--startup") ? ["startup"] : process.argv.includes("--brakes") ? ["brakes"] : ["smoke", "launch", "jump"]
const reports: unknown[] = []
try {
  for (const scenario of scenarios) for (const version of scenario === "startup" ? ["before", "after-off", "after"] : ["before", "after"]) {
    const host = version === "before" ? "getaway-before" : "arcade-getaway"
    const name = `${scenario}-${version}`
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    await page.addInitScript(() => {
      const callbacks: FrameRequestCallback[] = []
      window.requestAnimationFrame = (cb) => { callbacks.push(cb); return callbacks.length }
      Object.assign(window, { __advance: (t: number) => { const batch = callbacks.splice(0); for (const cb of batch) cb(t) } })
      // Prevent synthesized proof controls from unlocking any audio.
      const add = window.addEventListener.bind(window)
      window.addEventListener = ((type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
        if (options === true && ["pointerdown", "keydown", "touchend"].includes(type)) return
        add(type, listener, options)
      }) as typeof window.addEventListener
    })
    await page.goto(`http://${host}.localhost:1355/?solo&peaceful=1&seed=7&nohud${version === "after-off" ? "&vanilla=1" : ""}`)
    await page.waitForFunction(() => (window as any).__world, null, { polling: 100 })
    const adapter = await page.evaluate(async () => { const a = await (navigator as any).gpu.requestAdapter(); return { vendor: a.info.vendor, architecture: a.info.architecture } })
    if (adapter.vendor !== "apple" || !adapter.architecture.includes("metal")) throw new Error(`Expected Metal: ${JSON.stringify(adapter)}`)
    if (scenario !== "startup") await page.evaluate(async () => { await (window as any).__getawayBench?.ready })
    await page.evaluate(async () => {
      const url = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/render/renderer.ts")!.name
      const { Renderer } = await import(/* @vite-ignore */ url)
      const render = Renderer.prototype.render
      Renderer.prototype.render = function (opts: any) {
        const lights = []
        for (let i = 0; i < opts.frame[42]; i++) lights.push([...opts.lights.slice(i * 12, (i + 1) * 12)])
        let skids = 0, smoke = 0
        for (let i = 0; i < opts.sprites.alphaCount; i++) {
          if (opts.sprites.alpha[i * 12 + 8] === 4) skids++
          if (opts.sprites.alpha[i * 12 + 8] === 1) smoke++
        }
        ;(window as any).__lights = { count: opts.frame[42], bloom: opts.bloom, flash: opts.flash, rear: lights.find(l => l[3] === 7 && Math.abs(l[5] - 0.1) < 0.001), backfires: lights.filter(l => l[3] === 4 && Math.abs(l[4] - 0.45) < 0.001).length, glowCount: opts.sprites.addCount, skids, smoke }
        return render.call(this, opts)
      }
    })
    const start = await page.evaluate(({ scenario }) => {
      const w = (window as any).__world
      const c = w.carOf("me")
      if (scenario !== "startup") {
        const jump = scenario === "jump"
        // Existing straight street, same pose in both builds; AFTER's seeded ramp is at (342, 456).
        Object.assign(c.body, { x: jump ? 312 : 228, z: jump ? 456 : 145, h: jump ? Math.PI / 2 : 0, vx: 0, vz: 0, y: 0, vy: 0, airborne: false })
      }
      return performance.now()
    }, { scenario })
    let frame = 0
    const advance = async () => page.evaluate((t) => (window as any).__advance(t), start + frame++ * 1000 / 30)
    if (scenario !== "startup") for (let i = 0; i < 45; i++) await advance()
    if (scenario !== "startup") await page.evaluate(({ scenario }) => {
      const c = (window as any).__world.carOf("me")
      const key = (code: string, value: string) => dispatchEvent(new KeyboardEvent("keydown", { code, key: value }))
      key("ArrowUp", "ArrowUp")
      if (scenario === "jump") c.body.vx = 32
      else if (scenario === "smoke") { c.body.vz = 28; key("Space", " "); key("ArrowLeft", "ArrowLeft") }
      else if (scenario === "brakes") { c.body.vz = 23; key("ShiftLeft", "Shift") }
      else { c.body.vz = 9; key("ShiftLeft", "Shift") }
    }, { scenario })
    const states: unknown[] = []
    const total = scenario === "startup" ? 91 : scenario === "jump" || scenario === "brakes" ? 90 : 40
    for (let i = 0; i < total; i++) {
      await advance()
      if (scenario === "smoke" && i === 12) await page.evaluate(() => dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowLeft", key: "ArrowLeft" })))
      if (scenario === "brakes" && [30, 60].includes(i)) await page.evaluate((i) => {
        if (i === 30) {
          dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft", key: "Shift" }))
          dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowDown", key: "ArrowDown" }))
        } else dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowDown", key: "ArrowDown" }))
      }, i)
      if (scenario === "jump" && version === "after" || [0, 15, 30, 39, 60, 90].includes(i)) await page.screenshot({ path: join(out, `${name}-${String(i).padStart(3, "0")}.png`) })
      states.push(await page.evaluate(() => ({ ...(window as any).__world.carOf("me").body, lights: (window as any).__lights })))
    }
    const report = { scenario, version, adapter, errors, states }
    reports.push(report)
    console.log(name, adapter, "errors", errors.length, "maxY", Math.max(...states.map((s: any) => s.y ?? 0)))
    await page.close()
    if (errors.length) throw new Error(errors.join("\n"))
  }
  writeFileSync(join(out, `report-${scenarios[0]}.json`), JSON.stringify(reports, null, 2))
} finally { await browser.close() }
