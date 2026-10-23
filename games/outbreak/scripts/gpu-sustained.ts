import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Sustained frame cost at 3456×1894: the GPU kept busy the way play keeps it (one frame in flight, back to back), so
 * Apple GPU clocks ramp as they do in a real session instead of idling between isolated timestamp probes. Per scene
 * it reports the serial frame (sim + draw CPU + GPU to queue completion, what the game's one-in-flight pacing waits
 * on), the draw() CPU alone, and the hardware timestamp envelope sampled right after the load.
 *
 *   SUSTAIN_LAB='{"quality":"high"}' SUSTAIN_FRAMES=120 bun scripts/gpu-sustained.ts
 */
const root = resolve(import.meta.dir, "..")
const lab: Record<string, number | string> = JSON.parse(process.env.SUSTAIN_LAB ?? "{}")
const frames = Number(process.env.SUSTAIN_FRAMES ?? 120)
const passes = Number(process.env.SUSTAIN_PASSES ?? 3)
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "sustain-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code
        .replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render })")
        .replace("function draw(dt: number) {", "function draw(dt: number) { const __t0 = performance.now(); try { return __draw(dt) } finally { ((window as any).__drawMs ??= []).push(performance.now() - __t0) } }\n  function __draw(dt: number) {")
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
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
  // SUSTAIN_SCENES='[{"name":"lot","x":130,"y":45,"zoom":46,"hour":18}]' poses elsewhere (streamed lots settle longer).
  const scenes: { name: string; x: number; y: number; zoom: number; hour: number }[] = JSON.parse(process.env.SUSTAIN_SCENES ?? "null") ?? [
    { name: "street", x: 30, y: 41, zoom: 46, hour: 18 },
    { name: "interior", x: 27.7, y: 31, zoom: 34, hour: 19 },
  ]
  const result: Record<string, unknown> = {}
  for (let pass = 0; pass < passes; pass++) for (const scene of scenes) {
    const r = await page.evaluate(async ({ scene, lab, frames }) => {
      const w = window as any
      const h = w.__arcadeHarness
      h.freeze(true); h.reset(7); h.setLab("timeScale", 0); h.setLab("zoom", scene.zoom); h.setLab("hour", scene.hour)
      for (const [k, v] of Object.entries(lab)) h.setLab(k, v)
      h.pose(scene.x, scene.y, -Math.PI / 2)
      for (let i = 0; i < 30; i++) await h.step(1 / 60, { mx: 0, my: 0 })
      // Streamed lots compile on a worker: wait until the window has re-centred on the pose.
      for (let i = 0; i < 40 && Math.hypot(scene.x - 48, scene.y - 48) > 60; i++) {
        await new Promise(r => setTimeout(r, 50))
        await h.step(1 / 60, { mx: 0, my: 0 })
      }
      w.__drawMs = []
      const serial: number[] = []
      for (let i = 0; i < frames; i++) {
        const t0 = performance.now()
        await h.step(1 / 60, { mx: 0, my: 0 })
        serial.push(performance.now() - t0)
      }
      const drawMs = w.__drawMs.slice()
      const gpu: number[] = []
      for (let i = 0; i < 10; i++) gpu.push(await h.renderer.measure(h.render))
      const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]! }
      const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)]! }
      const canvas = document.querySelector<HTMLCanvasElement>("#game")!
      return { serialMs: med(serial), serialP90: p90(serial), drawCpuMs: med(drawMs), gpuTimestampMs: med(gpu.slice(2)), lights: h.render.lightCount, chunks: h.renderer.drawnChunks, stream: h.state().world?.isStreamWindow, canvas: [canvas.width, canvas.height] }
    }, { scene, lab, frames })
    const key = scene.name
    const list = ((result[key] as unknown[]) ??= []) as unknown[]
    list.push(r)
    console.log(`SUSTAIN ${key} pass ${pass} serial=${r.serialMs.toFixed(2)} p90=${r.serialP90.toFixed(2)} drawCpu=${r.drawCpuMs.toFixed(2)} gpuTs=${r.gpuTimestampMs.toFixed(2)} lights=${r.lights} chunks=${r.chunks} stream=${r.stream} canvas=${r.canvas.join("x")}`)
  }
  assert.deepEqual(errors, [])
  if (process.env.SUSTAIN_OUT) await Bun.write(process.env.SUSTAIN_OUT, JSON.stringify({ lab, frames, result }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
