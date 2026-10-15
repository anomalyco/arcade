import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.PERF_OUT ?? "captures/outbreak-performance")
mkdirSync(out, { recursive: true })
let variant = "before"
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "performance-baseline", enforce: "pre", transform(code, id) {
    if (variant === "before" && id === resolve(root,"src/level.ts")) return code.replace("chunks([...meshes,...props],true)","chunks([...meshes,...props],false)")
    if (variant === "before" && id === resolve(root,"src/shaders.ts")) return code.replace('solidCutaway: "",','')
    if (id !== resolve(root, "src/main.ts")) return
    return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render, vision: () => vision })")
  },
}] })
await server.listen()
const address = server.httpServer!.address() as { port: number }
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const reports: any[] = []
try {
  const gpu = (await (await browser.newBrowserCDPSession()).send("SystemInfo.getInfo")).gpu
  for (let pair = 0; pair < 8; pair++) for (const name of pair % 2 ? ["after", "before"] : ["before", "after"]) {
    variant = name
    server.moduleGraph.invalidateAll()
    const page = await browser.newPage({ viewport: { width: 1728, height: 1003 }, deviceScaleFactor: 2 })
    await page.addInitScript(() => {
      const request = GPUAdapter.prototype.requestDevice
      GPUAdapter.prototype.requestDevice = function(desc = {}) {
        return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
      }
    })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.goto(`http://127.0.0.1:${address.port}/?seed=7&bench`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
    const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
    assert.match(adapter.architecture, /metal/)
    for (const scene of [{ name: "street", x: 30, y: 41, zoom: 46, hour: 18 }, { name: "interior", x: 27.7, y: 31, zoom: 34, hour: 19 }]) {
      const result = await page.evaluate(async scene => {
        const h = (window as any).__arcadeHarness
        h.reset(7); h.setLab("timeScale", 0); h.setLab("zoom", scene.zoom); h.setLab("hour", scene.hour); h.pose(scene.x, scene.y, -Math.PI / 2)
        const cpu: number[] = [], vision: number[] = [], queue: number[] = []
        const v = h.vision(), update = v.update.bind(v), render = h.renderer.render.bind(h.renderer)
        let start = 0
        v.update = (...args: any[]) => { const t = performance.now(); const r = update(...args); vision.push(performance.now() - t); return r }
        h.renderer.render = (...args: any[]) => { cpu.push(performance.now() - start); return render(...args) }
        for (let i = 0; i < 24; i++) { start = performance.now(); await h.step(1 / 60, { mx: i < 12 ? 1 : -1 }); queue.push(performance.now() - start) }
        const gpu: number[] = []
        for (let i = 0; i < 8; i++) gpu.push(await h.renderer.measure(h.render))
        return { cpu, vision, queue, gpu, state: h.state(), lightCount: h.render.lightCount, occluders: h.render.occluderCount, slices: Array.from(h.render.lights.slice(0, h.render.lightCount * 16)) }
      }, scene)
      if (pair === 1) await page.screenshot({ path: resolve(out, `${name}-${scene.name}.png`) })
      reports.push({ pair, variant: name, scene: scene.name, adapter, ...result })
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
  await Bun.write(resolve(out, "paired.json"), JSON.stringify({ gpu, resolution: [3456, 2006], reports }, null, 2))
  for (const scene of ["street", "interior"]) for (const variant of ["before", "after"]) {
    const med = (xs: number[]) => { xs.sort((a,b)=>a-b); return (xs[Math.floor((xs.length-1)/2)]!+xs[Math.floor(xs.length/2)]!)/2 }
    const runs = reports.filter(r => r.pair > 0 && r.scene === scene && r.variant === variant).map(r => med(r.queue.slice(4)))
    console.log(`METRIC ${scene}_${variant}_queue_ms=${med(runs)} runs=${JSON.stringify(runs)}`)
  }
} finally { await browser.close(); await server.close() }
