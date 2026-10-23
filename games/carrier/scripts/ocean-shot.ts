// Ocean and sky captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal, loading the live
// dev server with fixed views that match the concepts. For each view it writes render-<view>.png and
// compare-<view>.png (concept | render) into --out, after checking the adapter is not SwiftShader.
//
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun ocean-shot.ts --views=a,b --out=/tmp/carrier-ocean/out'
//
// Options: --base=URL  --views=a,b,c,d,e  --seed=1  --t=120  --size=1536x1024  --wait=4
//          --motion=a   (three frames 0.5 s apart, plus a 4 m pan, as motion-<view>-<i>.png)
//          --perf=a     (GPU time per frame from timestamp queries, median of 40 sampled frames)
//          --eval='js'  (run in the page before each capture, e.g. "carrier.ocean.look.glitter = 50")
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-ocean/out")
const seed = opt("seed", "1")
const t0 = Number(opt("t", "120"))
const wait = Number(opt("wait", "4"))
const evalJs = opt("eval", "")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

type Isle = { kind: string; x: number; z: number; radius: number }
/** cam = focus x, z, yaw, pitch (eye elevation from the focus), dist. Island views aim at islands of the live world. */
const VIEWS: Record<string, { cam: string | ((isles: Isle[]) => string); concept: string; note: string; setup?: string; wait?: number; t?: () => number }> = {
  a: { cam: "0,0,0,25,650", concept: "shot-5-fleet", note: "open sea, shot-5 framing" },
  b: {
    cam: (isles) => {
      const i = pick(isles, ["jungle", "volcanic"])
      return `${i.x},${i.z + i.radius * 1.1},0,32,${Math.max(700, i.radius * 3.2)}`
    },
    concept: "island-2-jungle-hero",
    note: "island reef shelf",
  },
  c: {
    cam: (isles) => {
      // From deep water on the windward side (up-swell), looking at the island where the surf breaks.
      const i = pick(isles, ["cliff", "rocky", "stacks", "volcanic"])
      const c = cliffCam ?? [i.x - swell[0] * (i.radius + 520), i.z - swell[1] * (i.radius + 520)]
      const yaw = (Math.atan2(i.x - c[0], -(i.z - c[1])) * 180) / Math.PI
      return `${c[0].toFixed(0)},${c[1].toFixed(0)},${yaw.toFixed(1)},8,66`
    },
    // Below the orbit camera's 8° limit: a 6 m eye, like the concept's camera in the swell.
    setup: "carrier.camera.pitch = (5 * Math.PI) / 180",
    concept: "island-4-cliffs-low",
    note: "6 m camera into the swell toward a cliff island",
    // The moment a set's crest stands 150-300 m in front of the camera, like the concept's shot.
    t: () => cliffT ?? t0,
  },
  d: { cam: "0,-1200,0,32,4000", concept: "island-5-archipelago", note: "high wide archipelago" },
  e: { cam: "300,300,32,9,320", concept: "shot-1-chase", note: "toward the sun: glitter path" },
  // Map-style zoom-outs over the centrepiece island group (the orbit camera caps at 4 km, so g lifts it directly).
  f: { cam: (isles) => `${isles[0]!.x},${isles[0]!.z + 400},0,60,2900`, concept: "island-5-archipelago", note: "2.5 km up over the island group" },
  // The ship under way for ~25 s (helm at 70%), the camera trailing it like shot-5: wake and bow wave.
  w: {
    cam: "0,0,0,24,620",
    setup:
      "{ const c = carrier; c.game.state.helm.order = 0.7; setInterval(() => { const s = c.game.state.ship; if (!s) return; c.camera.x = s.x + Math.sin(s.heading) * 60; c.camera.z = s.z - Math.cos(s.heading) * 60; c.camera.yaw = s.heading }, 30) }",
    concept: "shot-5-fleet",
    note: "ship under way: wake",
    wait: 25,
  },
  // The player's view: the chase camera behind the carrier (no ?cam, so the game drives the camera), under way.
  h: { cam: "", setup: "carrier.game.state.helm.order = 0.6", concept: "shot-5-fleet", note: "chase camera behind the carrier", wait: 14 },
  g: {
    cam: (isles) => `${isles[0]!.x},${isles[0]!.z},0,70,4000`,
    setup: "carrier.camera.dist = carrier.camera.targetDist = 6400",
    concept: "shot-4-topdown",
    note: "6 km up over the island group",
  },
}
function pick(isles: Isle[], kinds: string[]): Isle {
  for (const k of kinds) {
    const all = isles.filter((i) => i.kind === k).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))
    if (all.length) return all[0]!
  }
  return isles[0]!
}
let isles: Isle[] = []
let swell: [number, number] = [0, 1]
let cliffCam: [number, number] | null = null
let cliffT: number | null = null
const camOf = (v: string) => {
  const c = VIEWS[v]!.cam
  return typeof c === "string" ? c : c(isles)
}
const views = opt("views", "a,b,c,d,e,f,g,w,h").split(",").filter((v) => VIEWS[v])
const motion = opt("motion", "")
const perf = opt("perf", "")

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--enable-webgpu-developer-features"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
const logs: string[] = []
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
})
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))

// GPU timing: ask for timestamp-query and wrap every render pass of sampled frames.
await page.addInitScript(() => {
  const g = globalThis as unknown as { __gpuMs: number[]; __timing: boolean }
  g.__gpuMs = []
  g.__timing = false
  const req = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = async function (desc?: GPUDeviceDescriptor) {
    const want = this.features.has("timestamp-query") ? ["timestamp-query" as GPUFeatureName] : []
    const device = await req.call(this, { ...desc, requiredFeatures: [...(desc?.requiredFeatures ?? []), ...want] })
    if (!want.length) return device
    const qs = device.createQuerySet({ type: "timestamp", count: 64 })
    const res = device.createBuffer({ size: 512, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const reads = [0, 1, 2].map(() => device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }))
    const busy = [false, false, false]
    const create = device.createCommandEncoder.bind(device)
    device.createCommandEncoder = (d?: GPUCommandEncoderDescriptor) => {
      const enc = create(d)
      if (!g.__timing) return enc
      const slot = busy.indexOf(false)
      if (slot < 0) return enc
      let n = 0
      const begin = enc.beginRenderPass.bind(enc)
      enc.beginRenderPass = (pd: GPURenderPassDescriptor) => {
        if (n + 2 > 64) return begin(pd)
        const tw = { querySet: qs, beginningOfPassWriteIndex: n, endOfPassWriteIndex: n + 1 }
        n += 2
        return begin({ ...pd, timestampWrites: tw })
      }
      const finish = enc.finish.bind(enc)
      enc.finish = (fd?: GPUCommandBufferDescriptor) => {
        if (n) {
          enc.resolveQuerySet(qs, 0, n, res, 0)
          enc.copyBufferToBuffer(res, 0, reads[slot]!, 0, n * 8)
          busy[slot] = true
          const count = n
          queueMicrotask(() => {
            void device.queue.onSubmittedWorkDone().then(async () => {
              await reads[slot]!.mapAsync(GPUMapMode.READ)
              const v = new BigUint64Array(reads[slot]!.getMappedRange().slice(0, count * 8))
              reads[slot]!.unmap()
              busy[slot] = false
              let ns = 0n
              for (let i = 0; i < count; i += 2) ns += v[i + 1]! - v[i]!
              g.__gpuMs.push(Number(ns) / 1e6)
            })
          })
        }
        return finish(fd)
      }
      return enc
    }
    return device
  }
})

const info = async () =>
  page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
    return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
  })

/** Grabs the next swapchain texture through the game's own device and returns PNG bytes; optionally a compare. */
async function grab(concept: string | null): Promise<{ png: Buffer; compare: Buffer | null }> {
  const r = await page.evaluate(async (concept) => {
    const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } } } }).carrier
    const device = c.renderer.context.device
    const ctx = (c.renderer as unknown as { canvas: GPUCanvasContext }).canvas
    const format = navigator.gpu.getPreferredCanvasFormat()
    ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    // Copy the swapchain texture right after the frame's own submit, in the same task, before it is presented.
    const w = (ctx.canvas as HTMLCanvasElement).width
    const h = (ctx.canvas as HTMLCanvasElement).height
    const row = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    // Skip a couple of frames so the reconfigure settles.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await new Promise<void>((resolve) => {
      const get = ctx.getCurrentTexture.bind(ctx)
      const submit = device.queue.submit.bind(device.queue)
      let tex: GPUTexture | null = null
      ctx.getCurrentTexture = () => {
        tex = get()
        ctx.getCurrentTexture = get
        return tex
      }
      device.queue.submit = (cbs: Iterable<GPUCommandBuffer>) => {
        submit(cbs)
        if (!tex) return
        device.queue.submit = submit
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h])
        submit([enc.finish()])
        resolve()
      }
    })
    await buf.mapAsync(GPUMapMode.READ)
    const src = new Uint8Array(buf.getMappedRange())
    const img = new ImageData(w, h)
    const bgra = format === "bgra8unorm"
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = y * row + x * 4
        const d = (y * w + x) * 4
        img.data[d] = src[s + (bgra ? 2 : 0)]!
        img.data[d + 1] = src[s + 1]!
        img.data[d + 2] = src[s + (bgra ? 0 : 2)]!
        img.data[d + 3] = 255
      }
    buf.unmap()
    const toB64 = async (cv: OffscreenCanvas) => {
      const blob = await cv.convertToBlob({ type: "image/png" })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ""
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(bin)
    }
    const one = new OffscreenCanvas(w, h)
    one.getContext("2d")!.putImageData(img, 0, 0)
    let compare: string | null = null
    if (concept) {
      const bmp = await createImageBitmap(await (await fetch(`./concept/${concept}.png`)).blob())
      const both = new OffscreenCanvas(w * 2, h)
      const g2 = both.getContext("2d")!
      g2.drawImage(bmp, 0, 0, w, h)
      g2.drawImage(one, w, 0)
      compare = await toB64(both)
    }
    return { png: await toB64(one), compare }
  }, concept)
  return { png: Buffer.from(r.png, "base64"), compare: r.compare ? Buffer.from(r.compare, "base64") : null }
}

async function load(cam: string, t: number): Promise<void> {
  // The dev server may HMR-reload mid-navigation while files change; retry a few times.
  for (let i = 0; ; i++) {
    try {
      await page.goto(`${base}?seed=${seed}&t=${t}${cam ? `&cam=${cam}` : ""}`, { waitUntil: "load" })
      break
    } catch (e) {
      if (i >= 3) throw e
      await page.waitForTimeout(1500)
    }
  }
  await page.waitForFunction(() => {
    const c = (globalThis as unknown as { carrier?: { ocean?: { tiles: number }; arch: unknown } }).carrier
    return !!c && !!c.arch && (c.ocean?.tiles ?? 0) > 0
  }, null, { timeout: 30_000 })
  if (setupJs) await page.evaluate(setupJs)
  if (evalJs) await page.evaluate(evalJs)
  await page.evaluate(() => Object.assign(globalThis, { __shotMark: true }))
  await page.waitForTimeout((viewWait ?? wait) * 1000)
  // A dev-server reload during the wait drops the setup and eval: fail so the caller retries.
  if (!(await page.evaluate(() => !!(globalThis as unknown as { __shotMark?: boolean }).__shotMark))) throw new Error("page reloaded during the wait")
}
let setupJs = ""
let viewWait: number | undefined

await page.goto(`${base}?seed=${seed}&t=${t0}`, { waitUntil: "load" })
const adapter = await info()
console.log(`adapter: ${adapter}`)
await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { arch: unknown } }).carrier?.arch, null, { timeout: 30_000 })
await page.waitForFunction(() => ((globalThis as unknown as { carrier?: { ocean?: { tiles: number } } }).carrier?.ocean?.tiles ?? 0) > 0, null, { timeout: 30_000 })
swell = await page.evaluate(() => [...(globalThis as unknown as { carrier: { ocean: { swell: [number, number] } } }).carrier.ocean.swell] as [number, number])
cliffCam = await page.evaluate(async (sw) => {
  // The dev server serves the shared modules, so the camera can be placed over deep water up-swell of the island.
  const path = "/shared/islands.ts"
  const { terrainHeight } = (await import(/* @vite-ignore */ path)) as typeof import("../shared/islands")
  const arch = (globalThis as unknown as { carrier: { arch: import("../shared/islands").Archipelago } }).carrier.arch
  const kinds = ["cliff", "rocky", "stacks", "volcanic"]
  const near = (k: string) => arch.islands.filter((i) => i.kind === k).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]
  const i = kinds.map(near).find((x) => x) ?? arch.islands[0]!
  for (let a = 0; a <= 120; a += 10)
    for (const s of a ? [1, -1] : [1]) {
      const ang = Math.atan2(-sw[1], -sw[0]) + (s * a * Math.PI) / 180
      const fx = i.x + Math.cos(ang) * (i.radius + 280)
      const fz = i.z + Math.sin(ang) * (i.radius + 280)
      let ok = true
      for (let r = -80; r <= 80 && ok; r += 40) for (let q = -80; q <= 80 && ok; q += 40) if (terrainHeight(arch, fx + r, fz + q) > -18) ok = false
      if (ok) return [fx, fz] as [number, number]
    }
  return null
}, swell)
cliffT = await page.evaluate(async ([cam, t0]) => {
  if (!cam) return null
  const path = "/shared/sea.ts"
  const { seaHeight } = (await import(/* @vite-ignore */ path)) as typeof import("../shared/sea")
  const c = globalThis as unknown as { carrier: { game: { state: { sea: import("../shared/sea").Sea | null } }; arch: import("../shared/islands").Archipelago } }
  const sea = c.carrier.game.state.sea
  if (!sea) return null
  const kinds = ["cliff", "rocky", "stacks", "volcanic"]
  const near = (k: string) => c.carrier.arch.islands.filter((i) => i.kind === k).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]
  const isle = kinds.map(near).find((x) => x) ?? c.carrier.arch.islands[0]!
  const dx = isle.x - cam[0]
  const dz = isle.z - cam[1]
  const l = Math.hypot(dx, dz)
  let best = t0
  let score = -Infinity
  for (let t = t0; t < t0 + 300; t += 0.5) {
    let crest = -Infinity
    for (let d = 140; d <= 300; d += 10) crest = Math.max(crest, seaHeight(sea, cam[0] + (dx / l) * d, cam[1] + (dz / l) * d, t))
    const v = crest - seaHeight(sea, cam[0], cam[1], t)
    if (v > score) {
      score = v
      best = t
    }
  }
  return best
}, [cliffCam, t0] as const)
isles = await page.evaluate(() => (globalThis as unknown as { carrier: { arch: { islands: Isle[] } } }).carrier.arch.islands.map((i) => ({ kind: i.kind, x: i.x, z: i.z, radius: i.radius })))
if (/swiftshader/i.test(adapter)) {
  console.log("SwiftShader adapter: refusing to trust these captures")
  await budget.exit(2)
}

for (const v of views) {
  const view = VIEWS[v]!
  // Other agents' edits can HMR-reload the page mid-capture: retry the view.
  let shot: { png: Buffer; compare: Buffer | null } | null = null
  for (let attempt = 0; !shot; attempt++) {
    try {
      setupJs = view.setup ?? ""
      viewWait = view.wait
      await load(camOf(v), view.t?.() ?? t0)
      shot = await grab(view.concept)
    } catch (e) {
      if (attempt >= 8) throw e
        await page.waitForTimeout(2000)
    }
  }
  const { png, compare } = shot
  writeFileSync(join(out, `render-${v}.png`), png)
  if (compare) writeFileSync(join(out, `compare-${v}.png`), compare)
  const stats = await page.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { ocean: { tiles: number }; clouds: { count: number } } }).carrier
    return `tiles ${c.ocean.tiles}, clouds ${c.clouds.count}`
  }).catch(() => "stats unavailable (page reloaded)")
  console.log(`${v}: ${view.note} cam=${camOf(v)} (${stats})`)
}

if (motion && VIEWS[motion]) {
  const cam = camOf(motion)
  const [x, z, ...rest] = cam.split(",")
  const frames: [string, number][] = [
    [cam, t0],
    [cam, t0 + 0.5],
    [cam, t0 + 1.0],
    [[Number(x) + 4, z, ...rest].join(","), t0],
  ]
  for (let i = 0; i < frames.length; i++) {
    for (let attempt = 0; ; attempt++) {
      try {
        await load(frames[i]![0], frames[i]![1])
        writeFileSync(join(out, `motion-${motion}-${i}.png`), (await grab(null)).png)
        break
      } catch (e) {
        if (attempt >= 8) throw e
        await page.waitForTimeout(2000)
      }
    }
  }
  console.log(`motion ${motion}: 3 frames 0.5 s apart + a 4 m pan`)
}

if (perf && VIEWS[perf]) {
  await load(camOf(perf), t0)
  await page.evaluate(() => {
    const g = globalThis as unknown as { __gpuMs: number[]; __timing: boolean }
    g.__gpuMs = []
    g.__timing = true
  })
  await page.waitForTimeout(4000)
  const ms = await page.evaluate(() => (globalThis as unknown as { __gpuMs: number[] }).__gpuMs.slice())
  ms.sort((a, b) => a - b)
  const med = ms[Math.floor(ms.length / 2)]
  console.log(ms.length ? `gpu ${perf}: median ${med!.toFixed(2)} ms, p10 ${ms[Math.floor(ms.length * 0.1)]!.toFixed(2)}, p90 ${ms[Math.floor(ms.length * 0.9)]!.toFixed(2)} over ${ms.length} frames` : "gpu: no timestamp samples (timestamp-query unavailable?)")
}

// Throughput: 300 frames encoded back to back (the GPU stays at full clock), wall time per frame. Apple GPUs clock
// down under a light vsync'd load, which inflates per-pass timestamps; this measures what the frame costs flat out.
const bench = opt("bench", "")
if (bench && VIEWS[bench]) {
  await load(camOf(bench), t0)
  const ms = await page.evaluate(async () => {
    const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } }; frame: Float32Array; grade: unknown } }).carrier
    const r = c.renderer as unknown as { draw(f: Float32Array, g: unknown): void; context: { device: GPUDevice } }
    const dev = r.context.device
    const run = async (n: number) => {
      await dev.queue.onSubmittedWorkDone()
      const t = performance.now()
      for (let i = 0; i < n; i++) {
        r.draw(c.frame, c.grade)
        if (i % 20 === 19) await dev.queue.onSubmittedWorkDone()
      }
      await dev.queue.onSubmittedWorkDone()
      return (performance.now() - t) / n
    }
    await run(30)
    const out: number[] = []
    for (let k = 0; k < 5; k++) out.push(await run(60))
    return out.sort((a, b) => a - b)
  })
  console.log(`bench ${bench}: ${ms.map((m) => m.toFixed(2)).join(" ")} ms/frame (5 runs of 60 back-to-back frames)`)
}

console.log([...new Set(logs)].slice(0, 12).join("\n"))
await browser.close()
