// Temporary probe: SwiftShader GPU time of one ?smoke frame with parts of the frame removed.
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const prefix = "/arcade/lot/"
const root = resolve("dist/arcade/lot")
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
  const path = new URL(r.url).pathname
  if (!path.startsWith(prefix)) return new Response("nf", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("nf", { status: 404 })
  const a = Bun.file(file); return await a.exists() ? new Response(a) : new Response("nf", { status: 404 })
} })
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--mute-audio", ...(process.platform === "linux" ? ["--disable-vulkan-surface"] : [])] })
const [vw, vh] = (process.env.SMOKE_VIEWPORT ?? "640x360").split("x").map(Number)
const page = await browser.newPage({ viewport: { width: vw, height: vh } })
page.on("console", m => console.log("page:", m.text()))
page.on("pageerror", e => console.log("pageerror:", e.message))
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => raf(t => { if (window.lot && !window.__held) { window.__held = true; window.lot.paused = true } cb(t) })
})
const t0 = Date.now()
await page.goto(`http://127.0.0.1:${server.port}${prefix}?smoke`)
await page.waitForFunction(() => window.lot?.ready, null, { timeout: 300_000, polling: 200 })
console.log("ready", Date.now() - t0, "frames", await page.evaluate(() => window.lot.frames))
console.log("opaque passes", await page.evaluate(() => window.lot.renderer.passes.slots.opaque.map(p => p.constructor.name + (p.primitives ? `(${p.primitives.length})` : "")).join(", ")))
for (const variant of (process.env.PROBE ?? "base").split(",")) {
  const r = await page.evaluate(async variant => {
    const l = window.lot, R = l.renderer
    const q = R.passContext.device.queue
    await q.onSubmittedWorkDone()
    const orig = R.drawTo
    const restore = []
    const swap = (obj, key, value) => { const old = obj[key]; obj[key] = value; restore.push(() => { obj[key] = old }) }
    let mod = f => f
    const m = /^dropOpaque(\d+)$/.exec(variant)
    if (m) swap(R.passes.slots, "opaque", R.passes.slots.opaque.filter((_, i) => i !== Number(m[1])))
    if (variant === "noOpaque") swap(R.passes.slots, "opaque", [])
    if (variant === "noAlpha") swap(R.passes.slots, "alpha", [])
    if (variant === "noLevel") swap(R, "chunks", [])
    if (variant === "noVolumes") swap(R, "volumes", [])
    if (variant === "noShadowLights") mod = f => ({ ...f, shadowLightCount: 0 })
    if (variant === "noLights") mod = f => ({ ...f, lightCount: 0, shadowLightCount: 0 })
    if (variant === "noTaa") swap(R, "temporal", null)
    if (variant === "noFogBlur") mod = f => ({ ...f, fogBlur: undefined })
    R.drawTo = (f, v) => orig.call(R, mod(f), v)
    const a = performance.now()
    try { l.step(16) } finally { R.drawTo = orig }
    const b = performance.now()
    await q.onSubmittedWorkDone()
    const c = performance.now()
    for (const undo of restore.reverse()) undo()
    return [Math.round(b - a), Math.round(c - b)]
  }, variant)
  console.log(`PROBE ${vw}x${vh} ${variant}: cpu ${r[0]} ms, gpu ${r[1]} ms`)
}
await Promise.race([browser.close(), Bun.sleep(2000)])
server.stop(true)
process.exit(0)
