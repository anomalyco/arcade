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
import { exposureProbe } from "./autoresearch-exposure"
import { resetProbe } from "./autoresearch-reset"
import { profileProbe } from "./autoresearch-profile"
import { depthProbe } from "./autoresearch-depth"
import { makeWorld, standHeight } from "../shared/world"
import type { ForestFrameInput, ForestView } from "../../../packages/kit/forest/view"

const repo = resolve(import.meta.dir, "../../..")
if (process.env.AUTORESEARCH_HOST) assert(hostname().includes(process.env.AUTORESEARCH_HOST), `wrong benchmark host: ${hostname()}`)
const out = resolve(repo, process.env.AUTORESEARCH_OUT ?? process.env.LEASE_OUT ?? "captures/woods-autoresearch")
const root = resolve(import.meta.dir, "../dist/arcade/woods"), prefix = "/arcade/woods/"
mkdirSync(out, { recursive: true })
type Variant = { id: string; look?: Record<string, unknown>; quality?: Record<string, unknown>; debug?: Record<string, boolean> }
const inputs: Variant[] = JSON.parse(process.env.AUTORESEARCH_VARIANTS ?? '[{"id":"baseline"}]')
const rounds = Number(process.env.AUTORESEARCH_ROUNDS ?? 1)
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 9, "rounds must be 1–9")
// Alternate order between rounds to expose drift within the same GPU lease.
const variants = Array.from({ length: rounds }, (_, r) => (r % 2 ? [...inputs].reverse() : inputs).map(v => ({ ...v, id: rounds === 1 ? v.id : `${v.id}-r${r + 1}` }))).flat()
const names = (process.env.AUTORESEARCH_SHOTS ?? "camp,beam,trail,marker,k1,k3,k4,k6,l0,l1,l2,l4,signal60,signal60off").split(",")
const settleFrames = Number(process.env.AUTORESEARCH_SETTLE_FRAMES ?? 240)
assert(Number.isInteger(settleFrames) && settleFrames >= 240, "settling must include at least the standard 240 frames")
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
  look: Record<string, unknown>; view: { forest: ForestView; setWorld(world: any): void }
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  __initial: string; __look: string; __quality: string; __debug: string; __input: ForestFrameInput
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
    woods.__debug = JSON.stringify(woods.view.forest.debug)
    // Fixed poses and lights: bot steering and signal answers must not change a shot during settling.
    woods.session.tick = () => {}
    const forest = woods.view.forest, update = forest.update
    let fixedTime = 12
    woods.__putTime = t => { fixedTime = t; woods.state.t = t }
    forest.update = f => { woods.__input = { ...f, time: fixedTime }; update(woods.__input) }
  })
  const sources = Object.fromEntries(await Promise.all(["games/woods/src/world-view.ts", "games/woods/src/held-map/index.ts", "games/woods/scripts/autoresearch.ts", "packages/kit/gpu/shaders.ts", "packages/kit/gpu/look-shaders.ts", "packages/kit/gpu/fog-scatter.ts", "packages/kit/gpu/lights/beam.ts", "packages/kit/forest/build.ts", "packages/kit/forest/settings.ts", "packages/kit/forest/exposure.ts", "packages/kit/forest/post.ts", "packages/kit/forest/view.ts", "packages/kit/forest/shaders.ts", "packages/kit/forest/index-mesh.ts"].map(async p => [p, createHash("sha256").update(await Bun.file(resolve(repo, p)).text()).digest("hex")])))
  const report: any = { version: 3, host: hostname(), sources, zeroConeDisabled, signalX, settleFrames, seed: 1987, time: 12, viewport: [1600, 900], adapter, overrides: variants, variants: {}, errors }
  if (process.env.AUTORESEARCH_RESET === "1") report.reset = await page.evaluate(resetProbe)
  for (const variant of variants) {
    if (variants.some(v => ["smoothTrunks", "litter", "campDetail"].some(key => key in (v.look ?? {})))) await page.evaluate(look => {
      Object.assign(woods.look, JSON.parse(woods.__look), look)
      woods.view.setWorld(woods.world)
    }, variant.look ?? {})
    const dir = resolve(out, variant.id); mkdirSync(dir, { recursive: true })
    const records: any = {}
    report.variants[variant.id] = records
    for (const name of names) {
      await page.evaluate(({ look, quality, debug }) => {
        for (const key of Object.keys(look)) if (!(key in woods.look)) throw new Error(`unknown look setting: ${key}`)
        for (const key of Object.keys(quality)) if (!(key in woods.view.forest.quality)) throw new Error(`unknown quality setting: ${key}`)
        Object.assign(woods.state, JSON.parse(woods.__initial))
        Object.assign(woods.look, JSON.parse(woods.__look), look)
        woods.view.forest.quality = { ...JSON.parse(woods.__quality), ...quality }
        Object.assign(woods.view.forest.debug, JSON.parse(woods.__debug), debug)
        woods.debug.dark = []; woods.camera.flashlight = true; woods.__putTime(12)
        woods.view.forest.renderer.resetTemporalHistory()
        // Dropping history does not reset Halton phase; align it for actual pixel comparisons.
        const temporal = (woods.view.forest.renderer as any).temporal
        if (temporal) temporal.frameIndex = 0
        woods.view.forest.resetExposure()
      }, { look: variant.look ?? {}, quality: variant.quality ?? {}, debug: variant.debug ?? {} })
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
        if (name === "glare") {
          const p = woods.state.players[1], self = woods.state.players[0]
          p.yaw = Math.atan2(p.x - self.x, p.z - self.z)
          p.pitch = 0.02
        }
        woods.state.players[0].light = woods.camera.flashlight
        woods.state.players[0].yaw = woods.camera.yaw; woods.state.players[0].pitch = woods.camera.pitch
      }, { name, signalX })
      // Drain each frame so exposure readbacks have a fixed number of opportunities to land.
      await page.evaluate(async settleFrames => {
        const device = woods.view.forest.renderer.passContext.device
        for (let i = 0; i < settleFrames; i++) {
          woods.step(1000 / 60)
          await device.queue.onSubmittedWorkDone()
          if (i % 8 === 7) await new Promise(r => setTimeout(r, 0))
        }
      }, settleFrames)
      // The deterministic clock is paused; locator screenshots wait for RAF-based
      // element stability. The canvas fills this fixed viewport, so capture it directly.
      await page.screenshot({ path: resolve(dir, `${name}.png`) })
      assert.equal(errors.length, 0, errors.join("\n"))
      const timing = !process.env.AUTORESEARCH_TIMING || process.env.AUTORESEARCH_TIMING === `${variant.id}:${name}`
      const data = await page.evaluate(async timing => {
        const f = woods.view.forest
        if (timing) await f.measure(1) // warm-up, discarded
        const gpu = timing ? await f.measure(9) : null
        return { gpu, stats: f.stats(), meter: f.renderer.sceneMeter, look: { ...f.settings }, quality: { ...f.quality }, eye: woods.__input.eye, viewProj: Array.from(woods.__input.viewProj), torches: woods.__input.torches, players: woods.state.players.map((p: any) => ({ id: p.id, x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, light: p.light })) }
      }, timing)
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
      if (process.env.AUTORESEARCH_DEPTH === "1") Object.assign(data, { trunkDepth: await page.evaluate(depthProbe) })
      writeFileSync(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
      if (data.gpu) console.log(`METRIC ${variant.id}.${name}.gpu_ms=${data.gpu.median}`)
      else console.log(`CAPTURE ${variant.id}.${name}`)
      assert.equal(errors.length, 0, errors.join("\n"))
    }
    if (process.env.AUTORESEARCH_MOTION !== "0") {
      const slow = process.env.AUTORESEARCH_MOTION === "slow"
      const { video, ...motion } = await page.evaluate(motionProbe, slow ? { frames: 180, fps: 30, speed: 0.7, video: true } : {})
      records.motion = motion
      if (video) {
        const raw = resolve(dir, "walk.h264"), mp4 = resolve(dir, "walk.mp4")
        writeFileSync(raw, Buffer.from(video, "base64"))
        const mux = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-r", String(motion.fps), "-i", raw, "-c:v", "copy", "-movflags", "+faststart", mp4], { stdout: "inherit", stderr: "inherit" })
        assert.equal(await mux.exited, 0, "walk mux failed")
        await Bun.file(raw).delete()
      }
      console.log(`METRIC ${variant.id}.pops_per_frame=${records.motion.popsPerFrame}`)
    }
    if (process.env.AUTORESEARCH_EXPOSURE === "1") {
      await shots.l4!(page)
      records.adaptation = await page.evaluate(exposureProbe)
      console.log(`METRIC ${variant.id}.max_exposure_step=${records.adaptation.maxFrameStep}`)
    }
    if (process.env.AUTORESEARCH_PROFILE === "1") records.profile = await page.evaluate(profileProbe)
    assert.equal(errors.length, 0, errors.join("\n"))
    report.variants[variant.id] = records
    writeFileSync(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
  }
} finally { await browser.close(); server.stop(true) }
