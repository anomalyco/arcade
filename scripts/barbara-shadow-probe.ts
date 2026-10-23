// One deterministic slow walk per removal probe, using BARBARA's production renderer.
// SHADOW_PROBES=baseline,sampling,leaf-motion,admission bun scripts/barbara-shadow-probe.ts
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { resolve, sep } from "node:path"
import { browserBudget } from "./browser-budget"
import { motionProbe } from "../games/barbara/scripts/autoresearch-motion"

const repo = resolve(import.meta.dir, ".."), root = resolve(repo, "games/barbara/dist/arcade/barbara"), prefix = "/arcade/barbara/"
const out = resolve(repo, process.env.SHADOW_OUT ?? "captures/barbara-shadow-pops")
const probes = (process.env.SHADOW_PROBES ?? "baseline,sampling,leaf-motion,admission").split(",")
assert(probes.every(p => ["baseline", "sampling", "leaf-motion", "admission", "candidate"].includes(p)))
assert(!hostname().includes("Studio"), "render probes belong on a worker")
mkdirSync(out, { recursive: true })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return await f.exists() ? new Response(f) : new Response("no", { status: 404 })
} })
const sources = Object.fromEntries(await Promise.all([
  "scripts/barbara-shadow-probe.ts", "games/barbara/scripts/autoresearch-motion.ts",
  "packages/kit/forest/view.ts", "packages/kit/forest/shaders.ts", "packages/kit/forest/settings.ts",
  "packages/kit/gpu/shadows/spot-shadows.ts", "packages/kit/gpu/lights/physical.ts",
].map(async p => [p, createHash("sha256").update(await Bun.file(resolve(repo, p)).text()).digest("hex")])))
await using budget = browserBudget()
const browser = await budget.chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  for (const probe of probes) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
    page.on("console", m => { if (m.type() === "error") { errors.push(m.text()); console.error(m.text()) } })
    await page.addInitScript(({ probe }) => {
      const configure = GPUCanvasContext.prototype.configure
      GPUCanvasContext.prototype.configure = function(c) { return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC }) }
      const create = GPUDevice.prototype.createTexture
      GPUDevice.prototype.createTexture = function(d) {
        if (d.label === "spot shadows") (window as any).__shadowTextureSize = d.size
        return create.call(this, d.label === "temporal previous depth" ? { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC } : d)
      }
      const request = GPUAdapter.prototype.requestDevice
      GPUAdapter.prototype.requestDevice = function(d) {
        Object.assign(window, { __adapter: { vendor: this.info.vendor, architecture: this.info.architecture } })
        return request.call(this, d)
      }
      // Shadow geometry is already windless. Freeze only the forest's visible wind at the settling time,
      // leaving torch/camera motion, exposure, fog, foliage coverage and shadow admission unchanged.
      if (probe === "leaf-motion") {
        const shader = GPUDevice.prototype.createShaderModule
        GPUDevice.prototype.createShaderModule = function(d) {
          if (d.label === "forest scene") {
            const before = "let t = F.cam.w;\n  let ph = phase01"
            if (d.code.split(before).length !== 2) throw new Error("wind clock patch must match once")
            d = { ...d, code: d.code.replace(before, "let t = 12.0;\n  let ph = phase01") }
          }
          return shader.call(this, d)
        }
      }
    }, { probe })
    await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`)
    await page.waitForFunction(() => (window as any).woods?.frames > 2, null, { timeout: 120000 })
    await page.addStyleTag({ content: "body > :not(#view){visibility:hidden!important} canvas:not(#view){visibility:hidden!important} #view{visibility:visible!important}" })
    const setup = await page.evaluate(probe => {
      const w = (window as any).woods, f = w.view.forest, renderer = f.renderer, device: GPUDevice = renderer.passContext.device
      if (w.world.params.seed !== 1987) throw new Error("seed must be 1987")
      if (/swiftshader/i.test(JSON.stringify((window as any).__adapter))) throw new Error("hardware GPU required")
      w.paused = true; w.session.tick = () => {}
      let time = 12
      w.__putTime = (t: number) => { time = t; w.state.t = t }
      const update = f.update
      f.update = (input: any) => { w.__input = { ...input, time }; update(w.__input) }
      if (probe === "sampling") { f.settings.shadowSize = 2048; f.quality = { ...f.quality } }
      const pass = renderer.passes.slots.opaque.find((p: any) => Array.isArray(p.draws) && Array.isArray(p.templates))
      if (!pass) throw new Error("forest pass missing")
      const original = pass.casters.bind(pass)
      const telemetry: { added: number; removed: number; instances: number; triangles: number }[] = []
      const ids = new WeakMap<GPUBuffer, number>(); let nextId = 0, previous = new Set<string>()
      const id = (b: GPUBuffer) => { if (!ids.has(b)) ids.set(b, nextId++); return ids.get(b)! }
      let fixed: any[] | undefined
      const fixedData = new Map<GPUBuffer, Float32Array>()
      pass.casters = (pos: number[], reach: number, smallReach: number, mask: any) => {
        let casters = original(pos, reach, smallReach, mask)
        if (probe === "admission") {
          if (!fixed) {
            // One conservative union around the entire 4.2 m walk. Independent of camera frustum,
            // raster LOD and mutable raster instance storage; only shadow membership is held fixed.
            fixed = []
            const x = w.world.camp.x + 8, z0 = w.world.camp.z - 48, z1 = z0 - 4.2
            const grouped = new Map<number, number[]>()
            for (const chunk of pass.chunks) {
              const dx = Math.max(Math.abs(x - chunk.cx) - 8, 0)
              const dz = Math.max(z1 - chunk.cz - 8, chunk.cz - 8 - z0, 0)
              const distance = Math.hypot(dx, dz)
              if (distance < Math.min(70, reach)) for (const masked of [false, true]) {
                const mesh = masked ? chunk.near.masked : chunk.near.opaque
                if (mesh && (!masked || mask)) fixed.push({ buffer: mesh.buffer, count: mesh.count, stride: 32, ...(masked ? { mask } : {}) })
              }
              for (const g of chunk.groups) {
                const t = pass.templates[g.template]
                const near = t.kind === "tree" ? f.quality.near : t.kind === "fern" ? f.quality.fernNear : t.maxDist
                const limit = t.kind === "tree" || t.kind === "rock" ? reach : smallReach
                if (distance >= Math.min(near, limit)) continue
                let data = grouped.get(g.template)
                if (!data) grouped.set(g.template, data = [])
                for (const v of g.data) data.push(v)
              }
            }
            for (const [template, data] of grouped) {
              const values = new Float32Array(data)
              const buffer = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
              device.queue.writeBuffer(buffer, 0, values)
              fixedData.set(buffer, values)
              for (const masked of [false, true]) {
                const mesh = masked ? pass.templates[template].near.masked : pass.templates[template].near.opaque
                if (mesh && (!masked || mask)) fixed.push({ buffer: mesh.buffer, count: mesh.count, stride: 32, instances: { buffer, count: data.length / 8 }, ...(masked ? { mask } : {}) })
              }
            }
          }
          casters = fixed
        }
        const members = new Set<string>(); let triangles = 0
        for (const c of casters) {
          const key = id(c.buffer)
          triangles += c.count / 3 * (c.instances?.count ?? 1)
          if (!c.instances) members.add(String(key))
          else {
            const data = fixedData.get(c.instances.buffer) ?? pass.instanceData
            const start = (c.instances.first ?? 0) * 8
            for (let i = start; i < start + c.instances.count * 8; i += 8) members.add(`${key}:${data[i]},${data[i + 1]},${data[i + 2]}`)
          }
        }
        telemetry.push({ added: [...members].filter(k => !previous.has(k)).length, removed: [...previous].filter(k => !members.has(k)).length, instances: members.size, triangles })
        previous = members
        return casters
      }
      w.__shadowTelemetry = telemetry
      return { look: { ...f.settings }, quality: { ...f.quality }, adapter: (window as any).__adapter }
    }, probe)
    const { video, ...motion } = await page.evaluate(motionProbe, { frames: 180, fps: 30, speed: 0.7, video: probe === "baseline" || probe === "candidate" })
    const extra = await page.evaluate(async () => {
      const w = (window as any).woods
      return { casters: w.__shadowTelemetry.slice(-181), shadowTextureSize: (window as any).__shadowTextureSize, gpu: await w.view.forest.measure(3) }
    })
    if (probe === "sampling") assert.equal(extra.shadowTextureSize[0], 2048, "sampling probe must change the actual GPU map")
    assert.equal(errors.length, 0, errors.join("\n"))
    writeFileSync(resolve(out, `${probe}.json`), JSON.stringify({ probe, host: hostname(), sources, setup, motion, ...extra, errors }, null, 2))
    if (video) writeFileSync(resolve(out, `${probe}.h264`), Buffer.from(video, "base64"))
    console.log(`METRIC ${probe}.pops_per_frame=${motion.popsPerFrame} gpu_ms=${extra.gpu.median}`)
    await page.close()
  }
} finally { await browser.close(); server.stop(true) }
await budget.finish()
for (const probe of ["baseline", "sampling", "leaf-motion", "admission", "candidate"]) {
  const raw = resolve(out, `${probe}.h264`)
  if (!await Bun.file(raw).exists()) continue
  const mux = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-r", "30", "-i", raw, "-c:v", "copy", "-movflags", "+faststart", resolve(out, `${probe}.mp4`)], { stdout: "inherit", stderr: "inherit" })
  assert.equal(await mux.exited, 0)
  await Bun.file(raw).delete()
}
