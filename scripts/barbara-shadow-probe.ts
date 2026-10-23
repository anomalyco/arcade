// One deterministic slow walk per removal probe, using BARBARA's production renderer.
// SHADOW_PROBES=baseline,sampling,leaf-motion,admission bun scripts/barbara-shadow-probe.ts
// Round 2: baseline,caster-cone,texel-grid,wind-match,taa-clip (baseline = current build, not shipped Today).
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { resolve, sep } from "node:path"
import { browserBudget } from "./browser-budget"
import { motionProbe } from "../games/barbara/scripts/autoresearch-motion"
import { temporalResponseProbe } from "./barbara-temporal-response"

const repo = resolve(import.meta.dir, ".."), root = resolve(repo, "games/barbara/dist/arcade/barbara"), prefix = "/arcade/barbara/"
const out = resolve(repo, process.env.SHADOW_OUT ?? "captures/barbara-shadow-pops")
const probes = (process.env.SHADOW_PROBES ?? "baseline,sampling,leaf-motion,admission").split(",")
assert(probes.every(p => ["baseline", "sampling", "leaf-motion", "admission", "candidate", "caster-cone", "texel-grid", "wind-match", "taa-clip"].includes(p)))
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
  "scripts/barbara-shadow-probe.ts", "scripts/barbara-temporal-response.ts", "games/barbara/scripts/autoresearch-motion.ts",
  "packages/kit/forest/view.ts", "packages/kit/forest/shaders.ts", "packages/kit/forest/settings.ts",
  "packages/kit/gpu/shadows/spot-shadows.ts", "packages/kit/gpu/lights/physical.ts", "packages/kit/gpu/temporal.ts",
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
      if (probe === "texel-grid") {
        let uniform: GPUBuffer | undefined, camera: GPUBuffer | undefined
        const bind = GPUDevice.prototype.createBindGroup
        GPUDevice.prototype.createBindGroup = function(d) {
          const entries = [...d.entries]
          for (const e of entries) if ("buffer" in e.resource) {
            if (e.binding === 22 && e.resource.buffer.size === 464) uniform = e.resource.buffer
            if (entries.length === 1 && e.binding === 0 && e.resource.size === 64 && e.resource.buffer.size === 1024) camera = e.resource.buffer
          }
          return bind.call(this, d)
        }
        const write = GPUQueue.prototype.writeBuffer
        const matrices = new Map<number, Float32Array<ArrayBuffer>>()
        GPUQueue.prototype.writeBuffer = function(buffer, offset, data, dataOffset, size) {
          const anchor = (window as any).__shadowAnchor
          if (anchor && buffer === uniform && data instanceof Float32Array) {
            const packed = new Float32Array(data)
            const trace = (window as any).__gridTrace ??= []
            for (let i = 0; i < packed[0]; i++) {
              const o = 4 + i * 28
              if (packed[o + 20] === 65000) continue // The lunar projection is a separate light.
              const m = packed.subarray(o, o + 16), n = packed[1]
              const clip = [0, 1, 3].map(r => m[r] * anchor[0] + m[r + 4] * anchor[1] + m[r + 8] * anchor[2] + m[r + 12])
              const x = clip[0] / clip[2], y = clip[1] / clip[2]
              const dx = Math.round(x * n / 2) * 2 / n - x, dy = Math.round(y * n / 2) * 2 / n - y
              if (!Number.isFinite(dx + dy) || Math.abs(clip[2]) < 0.1) throw new Error("invalid shadow snap anchor")
              for (let c = 0; c < 4; c++) { m[c * 4] += dx * m[c * 4 + 3]; m[c * 4 + 1] += dy * m[c * 4 + 3] }
              matrices.set(packed[o + 25], new Float32Array(m))
              trace.push({ x, y, dx, dy, near: packed[o + 19], far: packed[o + 24], size: n })
            }
            return write.call(this, buffer, offset, packed, dataOffset, size)
          }
          if (anchor && buffer === camera && matrices.has(offset / 256)) return write.call(this, buffer, offset, matrices.get(offset / 256)!)
          return write.call(this, buffer, offset, data, dataOffset, size)
        }
      }
      // Shadow geometry is already windless. Freeze only the forest's visible wind at the settling time,
      // leaving torch/camera motion, exposure, fog, foliage coverage and shadow admission unchanged.
      if (["leaf-motion", "wind-match", "taa-clip"].includes(probe)) {
        const shader = GPUDevice.prototype.createShaderModule
        GPUDevice.prototype.createShaderModule = function(d) {
          if (d.label === "forest scene" && probe !== "taa-clip") {
            const before = probe === "leaf-motion" ? "let t = F.cam.w;\n  let ph = phase01" : "let s = N.wind.z * max(g, 0.15);"
            if (d.code.split(before).length !== 2) throw new Error("wind clock patch must match once")
            d = { ...d, code: d.code.replace(before, probe === "leaf-motion" ? "let t = 12.0;\n  let ph = phase01" : "let s = 0.0;") }
          }
          if (d.label === "temporal resolve" && probe === "taa-clip") {
            const before = d.code.match(/let hy = [^\n]+;/)?.[0]
            if (!before || d.code.split(before).length !== 2) throw new Error("temporal clip patch must match once")
            d = { ...d, code: d.code.replace(before, "let hy = toYCoCg(hc);") }
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
      if (probe === "texel-grid") (window as any).__shadowAnchor = [w.world.camp.x + 8, w.world.height?.(w.world.camp.x + 8, w.world.camp.z - 60) ?? 0, w.world.camp.z - 60]
      if (probe === "sampling") { f.settings.shadowSize = 2048; f.quality = { ...f.quality } }
      const pass = renderer.passes.slots.opaque.find((p: any) => Array.isArray(p.draws) && Array.isArray(p.templates))
      if (!pass) throw new Error("forest pass missing")
      const original = pass.casters.bind(pass)
      const telemetry: { added: number; removed: number; instances: number; triangles: number; byKind: Record<string, { count: number; added: number; removed: number }> }[] = []
      const kinds = new Map<GPUBuffer, string>()
      for (const t of pass.templates) for (const lod of ["near", "far"]) for (const material of ["opaque", "masked"]) {
        const mesh = t[lod]?.[material]
        if (mesh) kinds.set(mesh.buffer, `${t.kind}.${lod}.${material}`)
      }
      const ids = new WeakMap<GPUBuffer, number>(); let nextId = 0, previous = new Set<string>()
      const id = (b: GPUBuffer) => { if (!ids.has(b)) ids.set(b, nextId++); return ids.get(b)! }
      let fixed: any[] | undefined
      const fixedData = new Map<GPUBuffer, Float32Array>()
      pass.casters = (pos: number[], reach: number, smallReach: number, mask: any) => {
        let casters = original(pos, reach, smallReach, mask)
        if (probe === "admission" || probe === "caster-cone") {
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
              if (distance < (probe === "caster-cone" ? w.look.torchReach + 16 : Math.min(70, reach))) for (const masked of [false, true]) {
                const mesh = masked ? chunk.near.masked : chunk.near.opaque
                if (mesh && (!masked || mask)) fixed.push({ buffer: mesh.buffer, count: mesh.count, stride: 32, ...(masked ? { mask } : {}) })
              }
              for (const g of chunk.groups) {
                const t = pass.templates[g.template]
                const near = t.kind === "tree" ? f.quality.near : t.kind === "fern" ? f.quality.fernNear : t.maxDist
                const limit = t.kind === "tree" || t.kind === "rock" ? reach : smallReach
                if (distance >= (probe === "caster-cone" ? w.look.torchReach + 16 : Math.min(near, limit))) continue
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
          const key = `${kinds.get(c.buffer) ?? "chunk"}/${id(c.buffer)}`
          triangles += c.count / 3 * (c.instances?.count ?? 1)
          if (!c.instances) members.add(String(key))
          else {
            const data = fixedData.get(c.instances.buffer) ?? pass.instanceData
            const start = (c.instances.first ?? 0) * 8
            for (let i = start; i < start + c.instances.count * 8; i += 8) members.add(`${key}:${data[i]},${data[i + 1]},${data[i + 2]}`)
          }
        }
        const added = [...members].filter(k => !previous.has(k)), removed = [...previous].filter(k => !members.has(k))
        const byKind: Record<string, { count: number; added: number; removed: number }> = {}
        for (const [keys, field] of [[members, "count"], [added, "added"], [removed, "removed"]] as const) for (const key of keys) {
          const kind = key.split("/")[0]!
          ;(byKind[kind] ??= { count: 0, added: 0, removed: 0 })[field]++
        }
        telemetry.push({ added: added.length, removed: removed.length, instances: members.size, triangles, byKind })
        previous = members
        return casters
      }
      w.__shadowTelemetry = telemetry
      return { look: { ...f.settings }, quality: { ...f.quality }, temporal: renderer.getTemporal(), adapter: (window as any).__adapter }
    }, probe)
    const { video, ...motion } = await page.evaluate(motionProbe, { frames: 180, fps: 30, speed: 0.7, video: probe === "baseline" || probe === "candidate" })
    const extra = await page.evaluate(async () => {
      const w = (window as any).woods
      return { casters: w.__shadowTelemetry.slice(-181), grid: (window as any).__gridTrace, shadowTextureSize: (window as any).__shadowTextureSize, gpu: await w.view.forest.measure(3) }
    })
    if (probe === "sampling") assert.equal(extra.shadowTextureSize[0], 2048, "sampling probe must change the actual GPU map")
    if (probe === "texel-grid") {
      assert(extra.grid?.length >= 181, "must snap the real shadow projection")
      assert.equal(new Set(extra.grid.map((f: any) => `${f.near}/${f.far}`)).size, 1, "near and far planes must remain fixed")
    }
    const response = probe === "candidate" ? await page.evaluate(temporalResponseProbe) : undefined
    assert.equal(errors.length, 0, errors.join("\n"))
    writeFileSync(resolve(out, `${probe}.json`), JSON.stringify({ probe, host: hostname(), sources, setup, motion, ...extra, response, errors }, null, 2))
    if (video) writeFileSync(resolve(out, `${probe}.h264`), Buffer.from(video, "base64"))
    console.log(`METRIC ${probe}.pops_per_frame=${motion.popsPerFrame} gpu_ms=${extra.gpu.median}`)
    await page.close()
  }
} finally { await browser.close(); server.stop(true) }
await budget.finish()
for (const probe of probes) {
  const raw = resolve(out, `${probe}.h264`)
  if (!await Bun.file(raw).exists()) continue
  const mux = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-r", "30", "-i", raw, "-c:v", "copy", "-movflags", "+faststart", resolve(out, `${probe}.mp4`)], { stdout: "inherit", stderr: "inherit" })
  assert.equal(await mux.exited, 0)
  await Bun.file(raw).delete()
}
