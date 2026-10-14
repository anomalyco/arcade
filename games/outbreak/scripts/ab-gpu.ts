import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * Paired in-page GPU cost of Lab settings at 3456×1894: alternates variants A and B on the same page, same frozen
 * state, timing each with the renderer's timestamp queries, so cross-run drift on a shared machine cancels out.
 * AB_A / AB_B are JSON Lab overrides; AB_ROUNDS alternations (default 12) × 6 timed frames per variant per round.
 */
const root = resolve(import.meta.dir, "..")
const A: Record<string, number> = JSON.parse(process.env.AB_A ?? "{}")
const B: Record<string, number> = JSON.parse(process.env.AB_B ?? "{}")
const rounds = Number(process.env.AB_ROUNDS ?? 12)
// Optional diagnostic hack applied to variant B after setup (e.g. "h.render.shadowLightCount = 0"); never shipped.
const hackB = process.env.AB_HACK_B ?? ""
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "ab-gpu-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code.replace("const harness = {", "const harness = { renderer, render,")
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const scenes = [
    { name: "street", x: 30, y: 41, zoom: 46, hour: 18 },
    { name: "interior", x: 27.7, y: 31, zoom: 34, hour: 19 },
  ]
  const out: Record<string, unknown> = {}
  for (const scene of scenes) {
    const res = await page.evaluate(async ({ scene, A, B, rounds, hackB }) => {
      const h = (window as any).__arcadeHarness
      const hack = new Function("h", hackB)
      const setup = async (lab: Record<string, number>) => {
        h.freeze(true); h.reset(7); h.setLab("timeScale", 0); h.setLab("zoom", scene.zoom); h.setLab("hour", scene.hour)
        for (const [k, v] of Object.entries(lab)) h.setLab(k, v)
        h.pose(scene.x, scene.y, -Math.PI / 2)
        await h.step(1 / 60)
      }
      const time = async () => {
        const v: number[] = []
        for (let i = 0; i < 8; i++) v.push(await h.renderer.measure(h.render))
        return v.slice(2).sort((a, b) => a - b)[3]!
      }
      const a: number[] = []
      const b: number[] = []
      for (let r = 0; r < rounds; r++) {
        const run = async (variant: "a" | "b") => {
          await setup(variant === "a" ? A : B)
          if (variant === "b") hack(h)
          ;(variant === "a" ? a : b).push(await time())
        }
        if (r % 2) { await run("b"); await run("a") } else { await run("a"); await run("b") }
      }
      return { a, b }
    }, { scene, A, B, rounds, hackB })
    const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
    const diffs = res.a.map((x, i) => res.b[i]! - x)
    out[scene.name] = { a: med(res.a), b: med(res.b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: res }
    console.log(`AB ${scene.name} A=${med(res.a).toFixed(3)} ms B=${med(res.b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms (MAD ${med(diffs.map(d => Math.abs(d - med(diffs)))).toFixed(3)})`)
  }
  assert.deepEqual(errors, [])
  if (process.env.AB_OUT) await Bun.write(process.env.AB_OUT, JSON.stringify({ A, B, rounds, out }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
