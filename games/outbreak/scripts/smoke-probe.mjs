// Usage (from games/outbreak): bun <this> <out.json> ; SMOKE_GPU=swiftshader for CI-like timings.
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const out = process.argv[2]
const prefix = "/arcade/outbreak/"
const root = resolve(process.argv[3] ?? "dist/arcade/outbreak")
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === `${prefix}api/stats`) return Response.json({ players: 0, games: 0 })
    if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const asset = Bun.file(file)
    return await asset.exists() ? new Response(asset) : new Response("Not found", { status: 404 })
  },
})
const metal = (process.env.SMOKE_GPU ?? "metal") === "metal"
const browser = await chromium.launch({
  headless: true,
  args: metal
    ? ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"]
    : ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--mute-audio"],
})
const t0 = Date.now()
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
await page.addInitScript(() => {
  const mods = new Map()
  const rec = { modules: [], pipes: [] }
  window.__pipes = rec
  const P = GPUDevice.prototype
  const csm = P.createShaderModule
  P.createShaderModule = function (d) {
    window.__dev = this
    const m = csm.call(this, d)
    mods.set(m, rec.modules.length)
    rec.modules.push({ label: d.label ?? "", code: d.code, at: performance.now() })
    if (rec.probeOn) probe(this, `module ${rec.modules.length - 1} ${d.label ?? ""} (${d.code.length})`)
    return m
  }
  rec.probes = []
  // The GPU process handles commands in order, so a work-done probe right after a creation call resolves once
  // that object has been compiled: successive probe times split the GPU process's time per object.
  const probe = (dev, what) => { const t = performance.now(); dev.queue.onSubmittedWorkDone().then(() => rec.probes.push({ what, t, done: performance.now() })) }
  if (new URLSearchParams(location.search).has("probe")) {
    const sub = GPUQueue.prototype.submit
    let n = 0
    GPUQueue.prototype.submit = function (b) { const r = sub.call(this, b); const t = performance.now(); const k = n++; this.onSubmittedWorkDone().then(() => rec.probes.push({ what: `submit ${k}`, t, done: performance.now() })); return r }
    rec.probeOn = true
  }
  const stage = s => s && { m: mods.get(s.module), e: s.entryPoint ?? "", c: s.constants ? JSON.stringify(s.constants) : "" }
  for (const k of ["createRenderPipeline", "createRenderPipelineAsync", "createComputePipeline", "createComputePipelineAsync"]) {
    const f = P[k]
    P[k] = function (d) {
      const t = performance.now()
      const r = f.call(this, d)
      rec.pipes.push({
        kind: k, label: d.label ?? "", at: t,
        v: stage(d.vertex), f: stage(d.fragment), c: stage(d.compute),
        key: JSON.stringify({ t: d.fragment?.targets, ds: d.depthStencil, ms: d.multisample, p: d.primitive, b: d.vertex?.buffers }),
      })
      if (rec.probeOn) probe(this, `pipe ${rec.pipes.length - 1} ${d.label ?? ""} ${stage(d.fragment)?.m ?? stage(d.compute)?.m}:${d.vertex?.entryPoint ?? ""}/${d.fragment?.entryPoint ?? "cs"}`)
      return r
    }
  }
})
const errors = []
page.on("pageerror", e => errors.push(e.message))
await page.goto(`http://127.0.0.1:${server.port}${prefix}${process.env.PROBE ? "?probe" : ""}`, { waitUntil: "load" })
await page.waitForFunction(() => window.__arcadeHarness?.ready, null, { timeout: 120_000, polling: 100 })
const readyAt = Date.now() - t0
const frames = await page.evaluate(() => new Promise(res => { const at = []; const f = () => (at.push(Math.round(performance.now())), at.length < 2 ? requestAnimationFrame(f) : res(at)); requestAnimationFrame(f) }))
const framesAt = Date.now() - t0
await page.waitForTimeout(Number(process.env.SETTLE ?? 0))
let idleAt = -1
if (process.env.IDLE) {
  // Stop the game's frame loop, then wait until the GPU process has finished everything already queued.
  await page.evaluate(() => { window.requestAnimationFrame = () => 0 })
  await page.evaluate(() => window.__dev?.queue.onSubmittedWorkDone())
  idleAt = Date.now() - t0
}
const rec = await page.evaluate(() => window.__pipes)
const c0 = Date.now()
await browser.close()
const closeMs = Date.now() - c0
server.stop(true)
await Bun.write(out, JSON.stringify({ readyAt, framesAt, frames, idleAt, closeMs, errors, ...rec }, null, 1))
console.log(`ready ${readyAt} ms, frames ${frames} (wall ${framesAt}), gpu idle ${idleAt}, close ${closeMs} ms, ${rec.modules.length} modules, ${rec.pipes.length} pipelines, wgsl ${rec.modules.reduce((a, m) => a + m.code.length, 0)} chars`)
if (rec.probes?.length) {
  const ps = rec.probes.sort((a, b) => a.done - b.done)
  let prev = 0
  for (const p of ps) { const dt = p.done - prev; prev = p.done; if (dt > 150 || (p.what.startsWith("submit") && Number(p.what.slice(7)) < 6)) console.log(`  ${String(Math.round(p.done)).padStart(6)} +${String(Math.round(dt)).padStart(5)}  ${p.what}`) }
}
