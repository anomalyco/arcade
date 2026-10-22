// Fixed production-renderer captures. Run on mini through approved HiveMind browser admission.
// AUTORESEARCH_OUT=$LEASE_OUT bun games/woods/scripts/autoresearch.ts
// Optional AUTORESEARCH_VARIANTS JSON: [{id,look?,quality?}], AUTORESEARCH_SHOTS comma list.
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { hostname } from "node:os"
import { createHash } from "node:crypto"
import { chromium } from "playwright-core"
import { shots } from "./capture"
import { motionProbe } from "./autoresearch-motion"
import { makeWorld, standHeight } from "../shared/world"
import type { ForestFrameInput, ForestView } from "../../../packages/kit/forest/view"

const out = resolve(process.env.AUTORESEARCH_OUT ?? process.env.LEASE_OUT ?? "captures/woods-autoresearch")
const root = resolve(import.meta.dir, "../dist/arcade/woods"), prefix = "/arcade/woods/"
mkdirSync(out, { recursive: true })
const variants: { id: string; look?: Record<string, unknown>; quality?: Record<string, unknown> }[] = JSON.parse(process.env.AUTORESEARCH_VARIANTS ?? '[{"id":"baseline"}]')
const names = (process.env.AUTORESEARCH_SHOTS ?? "camp,beam,trail,marker,k1,k3,k4,k6,l0,l1,l2,l4,signal60,signal60off").split(",")
const signalX = -33.25 // Depth-calibrated gap; the original +14 m probe was behind a trunk.
const zeroConeDisabled = process.env.AUTORESEARCH_ZERO_CONE === "off"
const calibrationWorld = process.env.AUTORESEARCH_CALIBRATE ? makeWorld() : null
const signalCandidates = calibrationWorld ? Array.from({ length: 321 }, (_, i) => {
  const dx = -40 + i / 4, x = calibrationWorld.camp.x + 10 + dx, z = calibrationWorld.camp.z - 70 - Math.sqrt(3600 - dx * dx)
  const oldX = calibrationWorld.camp.x + 10 + signalX, oldZ = calibrationWorld.camp.z - 70 - Math.sqrt(3600 - signalX * signalX)
  return { dx, offset: [x - oldX, standHeight(calibrationWorld, x, z) - standHeight(calibrationWorld, oldX, oldZ), z - oldZ] }
}) : []
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  if (zeroConeDisabled && /\/assets\/index-[^/]+\.js$/.test(file)) {
    const code = await f.text(), guard = "if (cone == 0.0) { continue; }"
    assert.equal(code.split(guard).length, 2, "paired control requires exactly one zero-cone guard")
    return new Response(code.replace(guard, ""), { headers: { "content-type": "text/javascript" } })
  }
  return await f.exists() ? new Response(f) : new Response("no", { status: 404 })
} })

// This is a probe-only interface. No production code or simulation rules change.
type Probe = {
  frames: number; paused: boolean; state: any; world: any; session: any; camera: any; debug: any
  look: Record<string, unknown>; view: { forest: ForestView }
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  __initial: string; __look: string; __quality: string; __input: ForestFrameInput
  __putTime(t: number): void
}
declare const woods: Probe
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(() => {
    const configure = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function(c) { return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC }) }
    const create = GPUDevice.prototype.createTexture
    GPUDevice.prototype.createTexture = function(d) { return create.call(this, d.label === "temporal previous depth" ? { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC } : d) }
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function(d) {
      Object.assign(window, { __adapter: { vendor: this.info.vendor, architecture: this.info.architecture, device: this.info.device, description: this.info.description } })
      return request.call(this, d)
    }
  })
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`)
  await page.waitForFunction(() => (window as any).woods?.frames > 2, null, { timeout: 180000 })
  await page.addStyleTag({ content: "body > :not(#view){visibility:hidden!important} canvas:not(#view){visibility:hidden!important} #view{visibility:visible!important}" })
  const adapter = await page.evaluate(() => (window as any).__adapter)
  assert(adapter && !/swiftshader/i.test(JSON.stringify(adapter)), "hardware GPU required")
  await page.evaluate(() => {
    woods.paused = true
    assertSeed()
    function assertSeed() { if (woods.world.params.seed !== 1987) throw new Error("capture requires seed 1987") }
    woods.__initial = JSON.stringify(woods.state)
    woods.__look = JSON.stringify(woods.look)
    woods.__quality = JSON.stringify(woods.view.forest.quality)
    // Fixed poses and lights: bot steering and signal answers must not change a shot during settling.
    woods.session.tick = () => {}
    const forest = woods.view.forest, update = forest.update
    let fixedTime = 12
    woods.__putTime = t => { fixedTime = t; woods.state.t = t }
    forest.update = f => { woods.__input = { ...f, time: fixedTime }; update(woods.__input) }
  })
  const sources = Object.fromEntries(await Promise.all(["packages/kit/gpu/fog-scatter.ts", "packages/kit/forest/settings.ts"].map(async p => [p, createHash("sha256").update(await Bun.file(p).text()).digest("hex")])))
  const report: any = { version: 2, host: hostname(), sources, zeroConeDisabled, signalX, seed: 1987, time: 12, viewport: [1600, 900], adapter, overrides: variants, variants: {}, errors }
  for (const variant of variants) {
    const dir = resolve(out, variant.id); mkdirSync(dir, { recursive: true })
    const records: any = {}
    for (const name of names) {
      await page.evaluate(({ look, quality }) => {
        for (const key of Object.keys(look)) if (!(key in woods.look)) throw new Error(`unknown look setting: ${key}`)
        for (const key of Object.keys(quality)) if (!(key in woods.view.forest.quality)) throw new Error(`unknown quality setting: ${key}`)
        Object.assign(woods.state, JSON.parse(woods.__initial))
        Object.assign(woods.look, JSON.parse(woods.__look), look)
        woods.view.forest.quality = { ...JSON.parse(woods.__quality), ...quality }
        woods.debug.dark = []; woods.camera.flashlight = true; woods.__putTime(12)
        woods.view.forest.renderer.resetTemporalHistory()
        // Exposure settles on the real meter; only its initial adaptation state is reset.
        Object.assign(woods.view.forest.camera, { exposure: 1, stops: 0 })
      }, { look: variant.look ?? {}, quality: variant.quality ?? {} })
      const setup = name.startsWith("signal60") ? shots.beam! : shots[name]!
      assert(setup, `unknown shot ${name}`)
      await setup(page)
      await page.evaluate(({ name, signalX }) => {
        for (const b of woods.state.brains) {
          const p = woods.state.players.find((p: any) => p.id === b.id)
          p.yaw = b.heading; p.pitch = b.mode === "signal" ? 1.3 : -0.2; p.light = true
        }
        if (name.startsWith("signal60")) {
          const c = woods.world.camp, x = c.x + 10, z = c.z - 70
          const p = woods.state.players[2]
          // Exactly 60 m in plan; depth checks which shaft points are clear. Its off frame is the background.
          p.x = x + signalX; p.z = z - Math.sqrt(60 * 60 - signalX * signalX); p.yaw = 0; p.pitch = 1.3
          woods.debug.dark = woods.state.players.filter((q: any) => q.id !== p.id || name.endsWith("off")).map((q: any) => q.id)
        }
        woods.state.players[0].light = woods.camera.flashlight
        woods.state.players[0].yaw = woods.camera.yaw; woods.state.players[0].pitch = woods.camera.pitch
      }, { name, signalX })
      // Drain each frame so exposure readbacks have a fixed number of opportunities to land.
      await page.evaluate(async () => {
        const device = woods.view.forest.renderer.passContext.device
        for (let i = 0; i < 240; i++) {
          woods.step(1000 / 60)
          await device.queue.onSubmittedWorkDone()
          if (i % 8 === 7) await new Promise(r => setTimeout(r, 0))
        }
      })
      await page.locator("#view").screenshot({ path: resolve(dir, `${name}.png`) })
      const data = await page.evaluate(async () => {
        const f = woods.view.forest
        await f.measure(1) // warm-up, discarded
        const gpu = await f.measure(9)
        return { gpu, stats: f.stats(), look: { ...f.settings }, quality: { ...f.quality }, eye: woods.__input.eye, viewProj: Array.from(woods.__input.viewProj), torches: woods.__input.torches, players: woods.state.players.map((p: any) => ({ id: p.id, x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, light: p.light })) }
      })
      if (name === "signal60") Object.assign(data, { signalDepth: await page.evaluate(async candidates => {
        const f = woods.view.forest, renderer = f.renderer as any, device: GPUDevice = renderer.passContext.device
        const tex: GPUTexture = renderer.temporal.prevLin, row = Math.ceil(tex.width * 4 / 256) * 256
        const buffer = device.createBuffer({ size: row * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        try {
          const enc = device.createCommandEncoder()
          enc.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow: row }, [tex.width, tex.height])
          device.queue.submit([enc.finish()]); await buffer.mapAsync(GPUMapMode.READ)
          const depth = new Float32Array(buffer.getMappedRange()), vp = woods.__input.viewProj
          const torch = woods.__input.torches.find(t => t.kind === "remote")!
          const probe = (pos: readonly number[]) => Array.from({ length: 80 }, (_, i) => {
            const d = 3 + 20 * i / 79, p = pos.map((v, j) => v + torch.dir[j]! * d)
            const clip = [0, 1, 2, 3].map(r => vp[r]! * p[0]! + vp[r + 4]! * p[1]! + vp[r + 8]! * p[2]! + vp[r + 12]!)
            const x = Math.floor((clip[0]! / clip[3]! * 0.5 + 0.5) * tex.width)
            const y = Math.floor((0.5 - clip[1]! / clip[3]! * 0.5) * tex.height)
            const scene = x >= 0 && x < tex.width && y >= 0 && y < tex.height ? depth[y * row / 4 + x]! : 0
            return { d, x, y, scene, shaft: clip[3], visible: clip[3]! > 0 && scene >= clip[3]! - 0.1 }
          })
          return { points: probe(torch.pos), candidates: candidates.map(c => ({ dx: c.dx, visible: probe(torch.pos.map((v, i) => v + c.offset[i]!)).filter(p => p.visible).length })).sort((a, b) => b.visible - a.visible) }
        } finally { buffer.destroy() }
      }, signalCandidates) })
      records[name] = data
      console.log(`METRIC ${variant.id}.${name}.gpu_ms=${data.gpu?.median}`)
      assert.equal(errors.length, 0, errors.join("\n"))
    }
    if (process.env.AUTORESEARCH_MOTION !== "0") {
      records.motion = await page.evaluate(motionProbe)
      console.log(`METRIC ${variant.id}.pops_per_frame=${records.motion.popsPerFrame}`)
    }
    assert.equal(errors.length, 0, errors.join("\n"))
    report.variants[variant.id] = records
    writeFileSync(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
  }
} finally { await browser.close(); server.stop(true) }
