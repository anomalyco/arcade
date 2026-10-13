import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "vite"

// Same 640x480 canvas / 30 captures / 60ms interval as the original flash probe.
const out = resolve("../../captures/preview/startup")
mkdirSync(out, { recursive: true })
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, configFile: false })
await server.listen()
const base = process.env.PROOF_URL ?? server.resolvedUrls!.local[0]!.replace(/\/$/, "")
const cache = join(homedir(), "Library/Caches/ms-playwright")
const exe = readdirSync(cache).filter(n => n.startsWith("chromium-")).reverse().map(n => join(cache, n, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find(existsSync)!
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const results: unknown[] = []
try {
  for (const cfg of ["default"]) {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => { throw e })
    const draws: unknown[] = []
    page.on("console", msg => { if (msg.text().startsWith("DRAW ")) draws.push(JSON.parse(msg.text().slice(5))) })
    await page.route("**/src/game/scene.ts", async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace("this.animate(view, dt, focus?.id ?? null);", "this.animate(view, dt, focus?.id ?? null); if(this.time < 2) console.log('DRAW '+JSON.stringify({time:this.time,dt,cars:view.cars,vis:[...this.vis.values()],hitStop:this.hitStop}));")
      await route.fulfill({ response, body })
    })
    await page.route("**/src/main.ts", async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace("let last = null", "window.__scene = scene; window.__cam = cam; let last = null")
      await route.fulfill({ response, body })
    })
    await page.addInitScript(() => {
      const win = window as any
      win.__impacts = []
      const frame = requestAnimationFrame
      window.requestAnimationFrame = (cb) => frame(t => {
        cb(t)
        if (win.__view && win.__impacts.length < 180) win.__impacts.push(win.__view.cars.map((c: any) => ({ impact: c.impact, x: c.x, z: c.z, vx: c.vx, vz: c.vz, shake: win.__scene?.shake, hitStop: win.__scene?.hitStop, vis: { ...win.__scene?.vis.get(c.id) }, cam: win.__cam?.shake })))
      })
    })
    await page.goto(`${base}/?solo&peaceful=1&seed=7&nohud&${cfg}`)
    await page.waitForFunction(() => Boolean((window as any).__view))
    const adapter = await page.evaluate(() => (window as any).__getawayBench.adapterInfo)
    if (/swiftshader/i.test(JSON.stringify(adapter))) throw new Error("Software adapter")
    for (let i = 0; i < 30; i++) {
      await page.locator("canvas#view").screenshot({ path: join(out, `${cfg.replace(/[^a-z]/g, "_")}-${String(i).padStart(2, "0")}.png`) })
      await page.waitForTimeout(60)
    }
    if (!draws.length || draws.some((d: any) => d.dt < 0 || d.hitStop !== 0 || d.vis.some((v: any) => v.crash !== 0 || v.braking || v.boosting))) throw new Error(`False startup effect: ${cfg}`)
    results.push({ cfg, adapter, draws, impacts: await page.evaluate(() => (window as any).__impacts) })
    await page.close()
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } })
  await page.goto(`${base}/compare.html?before=${encodeURIComponent(base)}&after=${encodeURIComponent(base)}&seed=7`)
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2)
  await page.waitForTimeout(3000)
  await page.getByRole("button", { name: /reset seed/i }).click()
  await page.waitForTimeout(300)
  for (let i = 0; i < 10; i++) {
    await page.screenshot({ path: join(out, `reset-${String(i).padStart(2, "0")}.png`) })
    await page.waitForTimeout(60)
  }
  results.push({ reset: await Promise.all(page.frames().slice(1).map(f => f.evaluate(() => (window as any).__view?.cars))) })
  writeFileSync(join(out, "proof.json"), JSON.stringify(results, null, 2))
  console.log("Startup and Reset Seed captured", results.map((r: any) => ({ cfg: r.cfg, adapter: r.adapter, maxImpact: r.impacts ? Math.max(...r.impacts.flat().map((c: any) => c.impact)) : undefined, reset: r.reset })))
} finally {
  await browser.close()
  await server.close()
}
