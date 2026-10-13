// Automated Before/After Video + WebGPU Benchmark Harness for Blackout.
// Usage:
//   bun scripts/compare.ts --phase=before
//   bun scripts/compare.ts --phase=after
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { encode } from "../../../scripts/encode"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const phase = opt("phase", "before") as "before" | "after"
if (phase !== "before" && phase !== "after") {
  throw new Error(`Expected --phase=before or --phase=after, got: ${phase}`)
}

const PORT = 5191
const BASE_URL = opt("base", `http://localhost:${PORT}`)
const MONITORS = opt("monitors", "0")
const BENCH_DIR = process.env.BENCH_DIR ?? join(import.meta.dir, "../../../captures/bench")
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? join(import.meta.dir, "../../../captures/preview")

mkdirSync(BENCH_DIR, { recursive: true })
mkdirSync(PREVIEW_DIR, { recursive: true })

const VIEWPORTS = [
  { id: "corridor_doorway", label: "Corridor Doorway Wedge & Lift Core", x: 27.5, y: 16.5, zoom: 17 },
  { id: "openplan_east", label: "Open-Plan Cubicles, Desk Lamp & Monitors", x: 45.2, y: 4.2, zoom: 17 },
  { id: "openplan_south", label: "Open-Plan Foyer, Lab & Cubicle Aisles", x: 46.8, y: 12.8, zoom: 17 },
  { id: "meeting_glass", label: "Meeting Room Glass & Pendant Table", x: 29.7, y: 31.8, zoom: 17 },
  { id: "breakroom_vending", label: "Breakroom Vending Machine & Corridor", x: 3.6, y: 20.0, zoom: 17 },
  { id: "cafeteria_tables", label: "Cafeteria Long Tables & Vending", x: 44.5, y: 29.5, zoom: 17 },
] as const

const SHEET_VIEWS = [
  { id: "v1_openplan_monitors", title: "1. Open-Plan Cubicles & Monitors", scene: "envlab", x: 11.8, y: 5.4, zoom: 12.5, timeSec: 2.0 },
  { id: "v2_east_lamp_sofas", title: "2. East Cubicles, Desk Lamp, Chair Shadows & Lounge Sofas", scene: "envlab", x: 44.8, y: 3.8, zoom: 12.5, timeSec: 2.0 },
  { id: "v3_breakroom_cutaway", title: "3. Breakroom Vending Cone, Table Chairs & Wall Cutaway", scene: "envlab", x: 3.8, y: 19.5, zoom: 14.0, timeSec: 2.0 },
  { id: "v4_anim_combat", title: "4. Soldiers Strafing, Firing & Casting Shadows (anim.html)", scene: "anim", x: 15.0, y: 11.0, zoom: 12.0, timeSec: 2.4 },
] as const

type ViewMetric = {
  id: string
  label: string
  x: number
  y: number
  chunks: number
  vertices: number
  frame_ms: number
  frame_p95_ms: number
  gpu_idle_ms: number
  gpu_hw_ms: number
  scene_pass_ms: number
  polar_pass_ms: number
  post_pass_ms: number
  visibleLights?: number
  shadowLights?: number
  monitorLights?: number
}

type BenchResult = {
  machine?: string
  phase: "before" | "after"
  timestamp: string
  adapter: {
    vendor: string
    architecture: string
    device: string
    description: string
    isFallbackAdapter: boolean
    hasTimestampQuery: boolean
  }
  viewpoints: ViewMetric[]
  averages: {
    frame_ms: number
    gpu_idle_ms: number
    gpu_hw_ms: number
    scene_pass_ms: number
    polar_pass_ms: number
    post_pass_ms: number
  }
  stress4: {
    frame_ms: number
    gpu_idle_ms: number
    gpu_hw_ms: number
    scene_pass_ms: number
    polar_pass_ms: number
    post_pass_ms: number
  }
}

async function ensureViteServer(): Promise<(() => void) | null> {
  try {
    const res = await fetch(`${BASE_URL}/envlab.html`)
    if (res.ok) return null
  } catch {}
  throw new Error(`No preview at ${BASE_URL}; pass the existing Nexus preview URL with --base.`)
}

export function findChromeExecutable(): string | undefined {
  const candidates = [
    chromium.executablePath(),
    join(homedir(), "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    join(homedir(), "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ]
  return candidates.find((p) => existsSync(p))
}

export async function installGpuInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Deterministic PRNG when manualVideo=1 or manual mode is active so before/after frames match identically.
    const params = new URLSearchParams(location.search)
    if (params.has("manualVideo") || params.has("manual")) {
      let seed = 0x12345678
      Math.random = () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    if (params.has("manualVideo")) {
      let virtualNow = 1000
      const origPerfNow = performance.now.bind(performance)
      performance.now = () => virtualNow
      let savedTick: ((now: number) => void) | null = null
      const origRaf = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        savedTick = cb
        return 1
      }
      ;(window as unknown as Record<string, unknown>).__stepManualVideo = async (dtMs: number, x?: number, y?: number) => {
        const w = window as unknown as { goto?: (x: number, y: number) => void; gpuIdle?: () => Promise<number> }
        if (x !== undefined && y !== undefined && w.goto) {
          w.goto(x, y)
        }
        virtualNow += dtMs
        const cb = savedTick
        if (cb) cb(virtualNow)
        await Promise.resolve()
        await Promise.resolve()
        if (w.gpuIdle) await w.gpuIdle()
        await new Promise((r) => origRaf(() => r(undefined)))
      }
      void origPerfNow
    }

    const origReqAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
    navigator.gpu.requestAdapter = async function (options?: GPURequestAdapterOptions) {
      const adapter = await origReqAdapter(options)
      if (adapter) {
        ;(window as unknown as Record<string, unknown>).__gpuAdapterInfo = {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          device: adapter.info.device,
          description: adapter.info.description,
          isFallbackAdapter: adapter.info.isFallbackAdapter,
          hasTimestampQuery: adapter.features.has("timestamp-query"),
        }
      }
      return adapter
    }

    const origReqDevice = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function (desc?: GPUDeviceDescriptor) {
      const features = new Set<GPUFeatureName>(desc?.requiredFeatures ?? [])
      const hasTs = this.features.has("timestamp-query")
      if (hasTs) features.add("timestamp-query")
      const dev = await origReqDevice.call(this, { ...desc, requiredFeatures: [...features] })
      ;(window as unknown as Record<string, unknown>).__gpuDevice = dev

      const MAX_Q = 32
      const qs = hasTs ? dev.createQuerySet({ type: "timestamp", count: MAX_Q }) : null
      const qbuf = hasTs ? dev.createBuffer({ size: MAX_Q * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null
      const rbuf = hasTs ? dev.createBuffer({ size: MAX_Q * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null
      let qIdx = 0
      let busy = false
      let pending = Promise.resolve()
      ;(window as unknown as Record<string, unknown>).__gpuDrain = () => pending
      let lastFrameAt = performance.now()

      const samples: {
        frameMs: number
        gpuIdleMs: number
        gpuHwMs: number
        sceneMs: number
        polarMs: number
        postMs: number
        passes: number[]
        ranges: number[][]
        vertices: number
      }[] = []
      ;(window as unknown as Record<string, unknown>).__gpuSamples = samples
      ;(window as unknown as Record<string, unknown>).__clearGpuSamples = () => {
        samples.length = 0
        lastFrameAt = performance.now()
      }

      const origCreateEnc = dev.createCommandEncoder.bind(dev)
      const origSubmit = dev.queue.submit.bind(dev.queue)
      let extraCmdBufs: GPUCommandBuffer[] = []

      dev.createCommandEncoder = function (d?: GPUCommandEncoderDescriptor) {
        const stress = Math.max(1, Number(new URLSearchParams(location.search).get("stress") ?? "1"))
        const enc = origCreateEnc(d)
        qIdx = 0
        let hasCompute = false
        let vertices = 0
        const log: { kind: "cp" | "rp"; desc: unknown; ops: [string, unknown[]][] }[] = []

        const origCP = enc.beginComputePass.bind(enc)
        enc.beginComputePass = function (cd?: GPUComputePassDescriptor) {
          hasCompute = true
          const ops: [string, unknown[]][] = []
          if (stress > 1) log.push({ kind: "cp", desc: cd, ops })
          const pass =
            qs && !busy && qIdx + 2 <= MAX_Q
              ? origCP({
                  ...cd,
                  timestampWrites: { querySet: qs, beginningOfPassWriteIndex: qIdx++, endOfPassWriteIndex: qIdx++ },
                })
              : origCP(cd)
          if (stress > 1) {
            for (const m of ["setPipeline", "setBindGroup", "dispatchWorkgroups", "end"] as const) {
              const orig = (pass as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(pass)
              ;(pass as unknown as Record<string, (...a: unknown[]) => unknown>)[m] = (...a: unknown[]) => {
                ops.push([m, a])
                return orig(...a)
              }
            }
          }
          return pass
        }

        const origRP = enc.beginRenderPass.bind(enc)
        enc.beginRenderPass = function (rd: GPURenderPassDescriptor) {
          const ops: [string, unknown[]][] = []
          if (stress > 1) log.push({ kind: "rp", desc: rd, ops })
          const pass =
            qs && !busy && qIdx + 2 <= MAX_Q
              ? origRP({
                  ...rd,
                  timestampWrites: { querySet: qs, beginningOfPassWriteIndex: qIdx++, endOfPassWriteIndex: qIdx++ },
                })
              : origRP(rd)
          const draw = pass.draw.bind(pass)
          pass.draw = (count, instances = 1, first = 0, firstInstance = 0) => {
            vertices += count * instances
            draw(count, instances, first, firstInstance)
          }
          if (stress > 1) {
            for (const m of ["setPipeline", "setBindGroup", "setVertexBuffer", "draw", "end"] as const) {
              const orig = (pass as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(pass)
              ;(pass as unknown as Record<string, (...a: unknown[]) => unknown>)[m] = (...a: unknown[]) => {
                ops.push([m, a])
                return orig(...a)
              }
            }
          }
          return pass
        }

        const origFinish = enc.finish.bind(enc)
        enc.finish = function (fd?: GPUCommandBufferDescriptor) {
          const count = qIdx
          const now = performance.now()
          const frameMs = now - lastFrameAt
          lastFrameAt = now
          const firstBuf = origFinish(fd)
          extraCmdBufs = []
          for (let k = 1; k < stress; k++) {
            const e2 = origCreateEnc(d)
            for (const item of log) {
              const p2 =
                item.kind === "cp"
                  ? e2.beginComputePass(item.desc as GPUComputePassDescriptor | undefined)
                  : e2.beginRenderPass(item.desc as GPURenderPassDescriptor)
              for (const [m, a] of item.ops) {
                ;(p2 as unknown as Record<string, (...args: unknown[]) => void>)[m]!(...a)
              }
            }
            extraCmdBufs.push(e2.finish(fd))
          }
          if (qs && qbuf && rbuf && !busy && count >= 4) {
            busy = true
            const rEnc = origCreateEnc()
            rEnc.resolveQuerySet(qs, 0, count, qbuf, 0)
            rEnc.copyBufferToBuffer(qbuf, 0, rbuf, 0, count * 8)
            extraCmdBufs.push(rEnc.finish())
            pending = Promise.resolve().then(() => {
              const w = window as unknown as { gpuIdle?: () => Promise<number> }
              const idlePromise =
                typeof w.gpuIdle === "function"
                  ? w.gpuIdle()
                  : (async () => {
                      const t0 = performance.now()
                      await dev.queue.onSubmittedWorkDone()
                      return performance.now() - t0
                    })()
              return idlePromise
                .then(async (gpuIdleMs: number) => {
                  await rbuf.mapAsync(GPUMapMode.READ)
                  const u64 = new BigUint64Array(rbuf.getMappedRange(0, count * 8))
                  const t0 = u64[0]!
                  const polarMs = hasCompute ? Number(BigInt.asIntN(64, u64[1]! - t0)) / 1e6 : 0
                  const sIdx = hasCompute ? 2 : 0
                  const sceneMs = Number(BigInt.asIntN(64, u64[sIdx + 1]! - u64[sIdx]!)) / 1e6
                  const postMs = Number(BigInt.asIntN(64, u64[count - 1]! - u64[sIdx + 1]!)) / 1e6
                  const gpuHwMs = Number(BigInt.asIntN(64, u64[count - 1]! - t0)) / 1e6
                  const passes = Array.from({ length: count / 2 }, (_, i) => Number(BigInt.asIntN(64, u64[i * 2 + 1]! - u64[i * 2]!)) / 1e6)
                  const ranges = Array.from({ length: count / 2 }, (_, i) => [Number(u64[i * 2]! - t0) / 1e6, Number(u64[i * 2 + 1]! - t0) / 1e6])
                  rbuf.unmap()
                  samples.push({
                    frameMs,
                    gpuIdleMs,
                    gpuHwMs: gpuHwMs * stress,
                    sceneMs: sceneMs * stress,
                    polarMs: polarMs * stress,
                    postMs: postMs * stress,
                    passes,
                    ranges,
                    vertices,
                  })
                  busy = false
                })
                .catch((error) => {
                  busy = false
                  throw error
                })
            })
          }
          return firstBuf
        }
        return enc
      }

      dev.queue.submit = function (bufs: Iterable<GPUCommandBuffer>) {
        const all = extraCmdBufs.length ? [...bufs, ...extraCmdBufs] : bufs
        extraCmdBufs = []
        return origSubmit(all)
      }
      return dev
    }
  })
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The bounds shortcut must produce exactly the same pixels as evaluating every monitor. */
export async function verifyMonitorBounds(page: Page): Promise<void> {
  const images = new Map<string, Buffer>()
  for (const bounds of [true, false]) {
    if (!bounds) await page.route("**/src/render/shaders.ts*", async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      if (!body.includes("u32(F.focus.w) < count")) throw new Error("Monitor bounds shader not found")
      await route.fulfill({ response, body: body.replace("u32(F.focus.w) < count", "false") })
    })
    for (const view of VIEWPORTS.filter((v) => v.id.startsWith("openplan"))) {
      await page.goto(`${BASE_URL}/envlab.html?vanilla=1&monitors=1&seed=1&zoom=17&x=${view.x}&y=${view.y}&manualVideo=1`, { waitUntil: "networkidle" })
      await page.waitForFunction('typeof window.gpuIdle === "function" && typeof window.__stepManualVideo === "function"')
      await page.evaluate(async ([x, y]) => {
        document.getElementById("info")!.style.display = "none"
        const w = window as unknown as { __stepManualVideo(dt: number, x: number, y: number): Promise<void> }
        for (let i = 0; i < 60; i++) await w.__stepManualVideo(1000 / 30, x!, y!)
      }, [view.x, view.y])
      const image = await page.screenshot({ path: join(PREVIEW_DIR, `monitor-bounds-${bounds ? "on" : "off"}-${view.id}.png`) })
      if (bounds) images.set(view.id, image)
      else if (!images.get(view.id)!.equals(image)) throw new Error(`Monitor bounds changed pixels: ${view.id}`)
    }
  }
  console.log("Monitor bounds pixel parity: both open-plan views identical")
}
const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const p95 = (arr: number[]) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}

export async function runSceneABenchmark(page: Page, monitors = MONITORS): Promise<BenchResult> {
  console.log(`[compare:${phase}] Running Scene A (envlab.html?seed=1&zoom=17) across 6 office viewpoints...`)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${BASE_URL}/envlab.html?vanilla=1&monitors=${monitors}&seed=1&zoom=17&x=45.2&y=4.2`, { waitUntil: "networkidle" })
  await page.waitForFunction('typeof window.gpuIdle === "function" && typeof window.goto === "function"')

  const adapter = await page.evaluate(() => {
    const info = (window as unknown as Record<string, unknown>).__gpuAdapterInfo as BenchResult["adapter"] | undefined
    return (
      info ?? {
        vendor: "unknown",
        architecture: "unknown",
        device: "",
        description: "",
        isFallbackAdapter: false,
        hasTimestampQuery: false,
      }
    )
  })
  console.log(
    `[compare:${phase}] WebGPU Adapter: vendor=${adapter.vendor} arch=${adapter.architecture} fallback=${adapter.isFallbackAdapter} timestampQuery=${adapter.hasTimestampQuery}`,
  )
  if (adapter.vendor !== "apple" || adapter.isFallbackAdapter) {
    throw new Error(`Expected Apple Metal hardware WebGPU adapter, got: ${JSON.stringify(adapter)}`)
  }

  const viewpoints: ViewMetric[] = []
  for (const vp of VIEWPORTS) {
    if (opt("views", "") && !opt("views", "").split(",").includes(vp.id)) continue
    await page.evaluate(
      ([x, y]) => {
        ;(window as unknown as { goto(x: number, y: number): void }).goto(x!, y!)
      },
      [vp.x, vp.y],
    )
    // Warm up at this viewpoint
    await page.waitForTimeout(250)
    await page.evaluate(() => (window as unknown as { __clearGpuSamples(): void }).__clearGpuSamples())
    await page.waitForFunction("(window.__gpuSamples?.length ?? 0) >= 28", null, { timeout: 15000 })
    const raw = await page.evaluate(() => {
      const s = ((window as unknown as Record<string, unknown>).__gpuSamples as {
        frameMs: number
        gpuIdleMs: number
        gpuHwMs: number
        sceneMs: number
        polarMs: number
        postMs: number
        vertices: number
      }[]).slice(-25)
      const st = (window as unknown as { stats(): { chunks: number; visibleLights?: number; shadowLights?: number; monitorLights?: number } }).stats()
      return { samples: s, ...st }
    })
    const m: ViewMetric = {
      id: vp.id,
      label: vp.label,
      x: vp.x,
      y: vp.y,
      chunks: raw.chunks,
      vertices: round3(avg(raw.samples.map((s) => s.vertices))),
      visibleLights: raw.visibleLights,
      shadowLights: raw.shadowLights,
      monitorLights: raw.monitorLights,
      frame_ms: round3(avg(raw.samples.map((s) => s.frameMs))),
      frame_p95_ms: round3(p95(raw.samples.map((s) => s.frameMs))),
      gpu_idle_ms: round3(avg(raw.samples.map((s) => s.gpuIdleMs))),
      gpu_hw_ms: round3(avg(raw.samples.map((s) => s.gpuHwMs))),
      scene_pass_ms: round3(avg(raw.samples.map((s) => s.sceneMs))),
      polar_pass_ms: round3(avg(raw.samples.map((s) => s.polarMs))),
      post_pass_ms: round3(avg(raw.samples.map((s) => s.postMs))),
    }
    viewpoints.push(m)
    if (process.argv.includes("--capture-views")) await page.screenshot({ path: join(PREVIEW_DIR, `monitor-${monitors === "1" ? "on" : "off"}-${vp.id}.png`) })
    console.log(
      `  - ${vp.id.padEnd(18)} chunks=${String(m.chunks).padStart(2)} | frame=${m.frame_ms.toFixed(2)}ms | gpuIdle=${m.gpu_idle_ms.toFixed(2)}ms | gpuHw=${m.gpu_hw_ms.toFixed(2)}ms (scene=${m.scene_pass_ms.toFixed(2)}ms, polar=${m.polar_pass_ms.toFixed(3)}ms, post=${m.post_pass_ms.toFixed(2)}ms)`,
    )
  }

  console.log(`[compare:${phase}] Running Scene A stress=4 GPU timing (envlab.html?seed=1&zoom=17&stress=4)...`)
  await page.goto(`${BASE_URL}/envlab.html?vanilla=1&monitors=${monitors}&seed=1&zoom=17&x=45.2&y=4.2&stress=4`, { waitUntil: "networkidle" })
  await page.waitForFunction('typeof window.gpuIdle === "function"')
  await page.waitForTimeout(300)
  await page.evaluate(() => (window as unknown as { __clearGpuSamples(): void }).__clearGpuSamples())
  await page.waitForFunction("(window.__gpuSamples?.length ?? 0) >= 16", null, { timeout: 20000 })
  const stressRaw = await page.evaluate(() => {
    return ((window as unknown as Record<string, unknown>).__gpuSamples as {
      frameMs: number
      gpuIdleMs: number
      gpuHwMs: number
      sceneMs: number
      polarMs: number
      postMs: number
    }[]).slice(-14)
  })
  const stress4 = {
    frame_ms: round3(avg(stressRaw.map((s) => s.frameMs))),
    gpu_idle_ms: round3(avg(stressRaw.map((s) => s.gpuIdleMs))),
    gpu_hw_ms: round3(avg(stressRaw.map((s) => s.gpuHwMs))),
    scene_pass_ms: round3(avg(stressRaw.map((s) => s.sceneMs))),
    polar_pass_ms: round3(avg(stressRaw.map((s) => s.polarMs))),
    post_pass_ms: round3(avg(stressRaw.map((s) => s.postMs))),
  }
  console.log(
    `  - stress=4           frame=${stress4.frame_ms.toFixed(2)}ms | gpuIdle=${stress4.gpu_idle_ms.toFixed(2)}ms | estimated gpuHw=${stress4.gpu_hw_ms.toFixed(2)}ms (estimated scene=${stress4.scene_pass_ms.toFixed(2)}ms)`,
  )

  return {
    phase,
    timestamp: new Date().toISOString(),
    machine: hostname(),
    adapter,
    viewpoints,
    averages: {
      frame_ms: round3(avg(viewpoints.map((v) => v.frame_ms))),
      gpu_idle_ms: round3(avg(viewpoints.map((v) => v.gpu_idle_ms))),
      gpu_hw_ms: round3(avg(viewpoints.map((v) => v.gpu_hw_ms))),
      scene_pass_ms: round3(avg(viewpoints.map((v) => v.scene_pass_ms))),
      polar_pass_ms: round3(avg(viewpoints.map((v) => v.polar_pass_ms))),
      post_pass_ms: round3(avg(viewpoints.map((v) => v.post_pass_ms))),
    },
    stress4,
  }
}

async function captureSheetViews(page: Page): Promise<void> {
  console.log(`[compare:${phase}] Capturing 4 deterministic comparison views...`)
  const viewsDir = join(BENCH_DIR, `views-${phase}`)
  mkdirSync(viewsDir, { recursive: true })
  await page.setViewportSize({ width: 960, height: 540 })

  for (const v of SHEET_VIEWS) {
    if (v.scene === "envlab") {
      await page.goto(`${BASE_URL}/envlab.html?vanilla=1&monitors=${MONITORS}&seed=1&zoom=${v.zoom}&x=${v.x}&y=${v.y}&manualVideo=1`, {
        waitUntil: "networkidle",
      })
      await page.waitForFunction('typeof window.__stepManualVideo === "function" && typeof window.gpuIdle === "function"')
      await page.evaluate(() => {
        const info = document.getElementById("info")
        if (info) info.style.display = "none"
      })
      const steps = Math.round(v.timeSec * 30)
      for (let i = 0; i < steps; i++) {
        await page.evaluate(
          ([dt, x, y]) => (window as unknown as { __stepManualVideo(dt: number, x: number, y: number): Promise<void> }).__stepManualVideo(dt!, x!, y!),
          [1000 / 30, v.x, v.y],
        )
      }
    } else {
      await page.goto(`${BASE_URL}/anim.html?vanilla=1&manual&zoom=${v.zoom}&x=${v.x}&y=${v.y}`, { waitUntil: "networkidle" })
      await page.waitForFunction("window.ready === true")
      await page.evaluate(() => {
        const info = document.getElementById("info")
        if (info) info.style.display = "none"
      })
      await page.evaluate(async (ms) => {
        await (window as unknown as { advance(ms: number): Promise<void> }).advance(ms)
        const dev = (window as unknown as { __gpuDevice?: GPUDevice }).__gpuDevice
        if (dev) await dev.queue.onSubmittedWorkDone()
      }, v.timeSec * 1000)
    }
    await page.screenshot({ path: join(viewsDir, `${v.id}.png`) })
  }
}

async function recordSceneBVideo(page: Page, outMp4: string): Promise<void> {
  console.log(`[compare:${phase}] Recording Scene B deterministic 6s 30fps (180-frame) video...`)
  const framesDir = join(BENCH_DIR, `frames-${phase}`)
  mkdirSync(framesDir, { recursive: true })
  await page.setViewportSize({ width: 960, height: 600 })

  // Part 1 (Frames 0..89, 3.0s): Deterministic camera pan across open-plan cubicles, glowing monitors, chairs & lamp in envlab.html
  await page.goto(`${BASE_URL}/envlab.html?vanilla=1&monitors=${MONITORS}&seed=1&zoom=14.0&x=41.0&y=3.8&manualVideo=1`, { waitUntil: "networkidle" })
  await page.waitForFunction('typeof window.__stepManualVideo === "function" && typeof window.gpuIdle === "function"')
  await page.evaluate(() => {
    const info = document.getElementById("info")
    if (info) info.style.display = "none"
  })
  // Warm up 10 frames so camera & lights settle
  for (let w = 0; w < 10; w++) {
    await page.evaluate(
      ([dt, x, y]) => (window as unknown as { __stepManualVideo(dt: number, x: number, y: number): Promise<void> }).__stepManualVideo(dt!, x!, y!),
      [1000 / 30, 41.0, 3.8],
    )
  }
  for (let i = 0; i < 90; i++) {
    const u = i / 89
    const s = u * u * (3 - 2 * u)
    const cx = 41.0 + s * 5.2
    const cy = 3.8 + Math.sin(u * Math.PI) * 0.6
    await page.evaluate(
      ([dt, x, y]) => (window as unknown as { __stepManualVideo(dt: number, x: number, y: number): Promise<void> }).__stepManualVideo(dt!, x!, y!),
      [1000 / 30, cx, cy],
    )
    const fPath = join(framesDir, `f_${String(i).padStart(4, "0")}.jpg`)
    await page.screenshot({ path: fPath, type: "jpeg", quality: 92 })
  }

  // Part 2 (Frames 90..179, 3.0s): Deterministic 30fps combat, strafe/backpedal & dynamic shadows in anim.html
  await page.goto(`${BASE_URL}/anim.html?vanilla=1&manual&zoom=13.0&x=15.0&y=11.0`, { waitUntil: "networkidle" })
  await page.waitForFunction("window.ready === true")
  await page.evaluate(() => {
    const info = document.getElementById("info")
    if (info) info.style.display = "none"
  })
  await page.evaluate(async () => {
    await (window as unknown as { advance(ms: number): Promise<void> }).advance(1200)
    const dev = (window as unknown as { __gpuDevice?: GPUDevice }).__gpuDevice
    if (dev) await dev.queue.onSubmittedWorkDone()
  })
  for (let i = 90; i < 180; i++) {
    await page.evaluate(async (dt) => {
      await (window as unknown as { advance(ms: number): Promise<void> }).advance(dt)
      const dev = (window as unknown as { __gpuDevice?: GPUDevice }).__gpuDevice
      if (dev) await dev.queue.onSubmittedWorkDone()
    }, 1000 / 30)
    const fPath = join(framesDir, `f_${String(i).padStart(4, "0")}.jpg`)
    await page.screenshot({ path: fPath, type: "jpeg", quality: 92 })
  }

  // Encode with Apple VideoToolbox hardware H.264 encoder
  await encode([
    "-framerate",
    "30",
    "-i",
    join(framesDir, "f_%04d.jpg"),
    "-c:v",
    "h264_videotoolbox",
    "-profile:v",
    "high",
    "-q:v",
    "75",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outMp4,
  ])
  console.log(`[compare:${phase}] Wrote ${outMp4}`)
}

async function stitchBeforeAfter(page: Page, beforeJson: BenchResult, afterJson: BenchResult): Promise<void> {
  console.log(`[compare:after] Stitching side-by-side comparison video and 4-view sheet...`)
  const beforeMp4 = join(BENCH_DIR, "blackout-before.mp4")
  const afterMp4 = join(BENCH_DIR, "blackout-after.mp4")
  if (!existsSync(beforeMp4)) {
    throw new Error(`Missing baseline video ${beforeMp4}. Run with --phase=before first!`)
  }

  // 1. Render transparent 1920x600 overlay PNG with BEFORE / AFTER labels and benchmark summary
  const overlayPng = join(BENCH_DIR, "overlay-1920x600.png")
  const comparable = beforeJson.machine !== undefined && beforeJson.machine === afterJson.machine
  const metrics = (name: string) => args.includes("--final-metrics") ? JSON.parse(readFileSync(join(import.meta.dir, `../../../perf/blackout-final-${name}.json`), "utf8")).metrics : null
  const beforeMetrics = metrics("main"), afterMetrics = metrics("integrated")
  const bGpu = comparable ? (beforeMetrics?.gpu_hw_ms.median ?? beforeJson.averages.gpu_hw_ms).toFixed(2) : "n/a"
  const aGpu = (afterMetrics?.gpu_hw_ms.median ?? afterJson.averages.gpu_hw_ms).toFixed(2)
  const bIdle = comparable ? (beforeMetrics?.gpu_idle_ms.median ?? beforeJson.averages.gpu_idle_ms).toFixed(2) : "n/a"
  const aIdle = (afterMetrics?.gpu_idle_ms.median ?? afterJson.averages.gpu_idle_ms).toFixed(2)
  const bStress = comparable ? (beforeMetrics?.stress4_gpu_estimated_ms.median ?? beforeJson.stress4.gpu_hw_ms).toFixed(2) : "n/a"
  const aStress = (afterMetrics?.stress4_gpu_estimated_ms.median ?? afterJson.stress4.gpu_hw_ms).toFixed(2)

  const overlayDataUrl = await page.evaluate(
    ({ bGpu, aGpu, bIdle, aIdle, bStress, aStress }) => {
      const c = document.createElement("canvas")
      c.width = 1920
      c.height = 600
      const g = c.getContext("2d")!
      g.clearRect(0, 0, 1920, 600)

      // Center divider
      g.fillStyle = "rgba(255,255,255,0.4)"
      g.fillRect(959, 0, 2, 600)

      const badge = (x: number, title: string, sub: string, accent: string) => {
        g.fillStyle = "rgba(8, 12, 20, 0.82)"
        g.beginPath()
        g.roundRect(x, 16, 520, 56, 8)
        g.fill()
        g.strokeStyle = accent
        g.lineWidth = 2
        g.stroke()

        g.fillStyle = accent
        g.font = "bold 20px 'IBM Plex Mono', monospace"
        g.fillText(title, x + 16, 41)

        g.fillStyle = "#d8e2ef"
        g.font = "13px 'IBM Plex Mono', monospace"
        g.fillText(sub, x + 16, 61)
      }

      badge(20, "BEFORE", `GPU ${bGpu}ms | wait ${bIdle}ms | 4x estimate ${bStress}ms`, "#ff6b4a")
      badge(980, "AFTER", `GPU ${aGpu}ms | wait ${aIdle}ms | 4x estimate ${aStress}ms`, "#38e89c")
      return c.toDataURL("image/png")
    },
    { bGpu, aGpu, bIdle, aIdle, bStress, aStress },
  )
  writeFileSync(overlayPng, Buffer.from(overlayDataUrl.split(",")[1]!, "base64"))

  const outMp4Preview = join(PREVIEW_DIR, "blackout-before-after.mp4")

  await encode([
    "-i",
    beforeMp4,
    "-i",
    afterMp4,
    "-i",
    overlayPng,
    "-filter_complex",
    "[0:v][1:v]hstack=inputs=2[bg];[bg][2:v]overlay=0:0:format=auto",
    "-c:v",
    "h264_videotoolbox",
    "-profile:v",
    "high",
    "-q:v",
    "75",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outMp4Preview,
  ])
  console.log(`[compare:after] Stitched video -> ${outMp4Preview}`)

  // 2. Build 4-view comparison sheet (1440x1440 <= 1500x1500)
  const pairs = SHEET_VIEWS.map((v) => {
    const bPath = join(BENCH_DIR, "views-before", `${v.id}.png`)
    const aPath = join(BENCH_DIR, "views-after", `${v.id}.png`)
    return {
      title: v.title,
      beforeUrl: `data:image/png;base64,${readFileSync(bPath).toString("base64")}`,
      afterUrl: `data:image/png;base64,${readFileSync(aPath).toString("base64")}`,
    }
  })

  const sheetDataUrl = await page.evaluate(
    async ({ pairs, bGpu, aGpu, bIdle, aIdle, bStress, aStress }) => {
      const W = 1440
      const H = 1440
      const c = document.createElement("canvas")
      c.width = W
      c.height = H
      const g = c.getContext("2d")!
      g.fillStyle = "#080b12"
      g.fillRect(0, 0, W, H)

      // Header
      g.fillStyle = "#101624"
      g.fillRect(0, 0, W, 68)
      g.fillStyle = "#f0f6ff"
      g.font = "bold 20px 'IBM Plex Mono', monospace"
      g.fillText("BLACKOUT · BEFORE / AFTER", 24, 30)
      g.fillStyle = "#9ab0c8"
      g.font = "14px 'IBM Plex Mono', monospace"
      g.fillText(
        `Capture run, 6-view mean GPU: ${bGpu}ms → ${aGpu}ms | Wait: ${bIdle}ms → ${aIdle}ms | 4x estimate: ${bStress}ms → ${aStress}ms`,
        24,
        54,
      )

      const loadImg = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = reject
          img.src = src
        })

      const rowH = 340
      const imgW = 688
      const imgH = 304
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i]!
        const y0 = 74 + i * rowH
        g.fillStyle = "#d6e4f5"
        g.font = "bold 14px 'IBM Plex Mono', monospace"
        g.fillText(p.title, 24, y0 + 18)

        const [bImg, aImg] = await Promise.all([loadImg(p.beforeUrl), loadImg(p.afterUrl)])
        const bx = 20
        const ax = 732
        const iy = y0 + 26

        // Draw cropped/scaled 16:9 -> 688x304
        const sh = Math.floor(bImg.width * (imgH / imgW))
        const sy = i === 3 ? 6 : Math.floor((bImg.height - sh) * 0.5)
        g.drawImage(bImg, 0, sy, bImg.width, sh, bx, iy, imgW, imgH)
        g.drawImage(aImg, 0, sy, aImg.width, sh, ax, iy, imgW, imgH)

        g.strokeStyle = "#ff6b4a"
        g.lineWidth = 1.5
        g.strokeRect(bx + 0.5, iy + 0.5, imgW - 1, imgH - 1)

        g.strokeStyle = "#38e89c"
        g.lineWidth = 1.5
        g.strokeRect(ax + 0.5, iy + 0.5, imgW - 1, imgH - 1)

        // Corner labels
        g.fillStyle = "rgba(8, 12, 20, 0.8)"
        g.fillRect(bx + 8, iy + 8, 76, 22)
        g.fillStyle = "#ff6b4a"
        g.font = "bold 12px 'IBM Plex Mono', monospace"
        g.fillText("BEFORE", bx + 16, iy + 23)

        g.fillStyle = "rgba(8, 12, 20, 0.8)"
        g.fillRect(ax + 8, iy + 8, 68, 22)
        g.fillStyle = "#38e89c"
        g.font = "bold 12px 'IBM Plex Mono', monospace"
        g.fillText("AFTER", ax + 16, iy + 23)
      }

      return c.toDataURL("image/jpeg", 0.92)
    },
    { pairs, bGpu, aGpu, bIdle, aIdle, bStress, aStress },
  )

  const outSheetPreview = join(PREVIEW_DIR, "blackout-before-after-sheet.jpg")
  const sheetBuf = Buffer.from(sheetDataUrl.split(",")[1]!, "base64")
  writeFileSync(outSheetPreview, sheetBuf)
  console.log(`[compare:after] Wrote 4-view comparison sheet (1440x1440) -> ${outSheetPreview}`)
}

async function main(): Promise<void> {
  const assembleOnly = args.includes("--assemble-only")
  const stopVite = assembleOnly ? null : await ensureViteServer()
  const exe = findChromeExecutable()
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--enable-features=Vulkan,WebGPU",
      "--ignore-gpu-blocklist",
    ],
  })

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    if (assembleOnly) {
      const before = JSON.parse(readFileSync(join(BENCH_DIR, "blackout-before.json"), "utf8")) as BenchResult
      const after = JSON.parse(readFileSync(join(BENCH_DIR, "blackout-after.json"), "utf8")) as BenchResult
      await stitchBeforeAfter(page, before, after)
      return
    }
    await page.routeWebSocket("**", (socket) => {
      const server = socket.connectToServer()
      server.onMessage((message) => {
        if (typeof message === "string" && /"type":"(?:update|full-reload)"/.test(message)) return
        socket.send(message)
      })
    })
    await installGpuInstrumentation(page)

    const benchResult = await runSceneABenchmark(page)
    const jsonPath = join(BENCH_DIR, `blackout-${phase}.json`)
    writeFileSync(jsonPath, JSON.stringify(benchResult, null, 2))
    console.log(`[compare:${phase}] Saved benchmark metrics -> ${jsonPath}`)

    await captureSheetViews(page)

    const mp4Path = join(BENCH_DIR, `blackout-${phase}.mp4`)
    await recordSceneBVideo(page, mp4Path)

    if (phase === "after") {
      const beforeJsonPath = join(BENCH_DIR, "blackout-before.json")
      if (!existsSync(beforeJsonPath)) {
        throw new Error(`Missing baseline JSON ${beforeJsonPath}. Run with --phase=before first!`)
      }
      const beforeJson = JSON.parse(readFileSync(beforeJsonPath, "utf8")) as BenchResult
      await stitchBeforeAfter(page, beforeJson, benchResult)

      if (!beforeJson.machine || beforeJson.machine !== benchResult.machine) {
        console.log("[compare:summary] Archived BEFORE hardware is different or unrecorded; visual comparison only. AFTER timing is recorded in JSON.")
        return
      }

      const speedupHw = ((1 - benchResult.averages.gpu_hw_ms / beforeJson.averages.gpu_hw_ms) * 100).toFixed(1)
      const speedupScene = ((1 - benchResult.averages.scene_pass_ms / beforeJson.averages.scene_pass_ms) * 100).toFixed(1)
      const speedupStress = ((1 - benchResult.stress4.gpu_hw_ms / beforeJson.stress4.gpu_hw_ms) * 100).toFixed(1)
      console.log(
        `\n[compare:summary] GPU HW Avg: ${beforeJson.averages.gpu_hw_ms}ms -> ${benchResult.averages.gpu_hw_ms}ms (${speedupHw}% faster)`,
      )
      console.log(
        `[compare:summary] Scene Pass Avg: ${beforeJson.averages.scene_pass_ms}ms -> ${benchResult.averages.scene_pass_ms}ms (${speedupScene}% faster)`,
      )
      console.log(
        `[compare:summary] Stress=4 GPU HW estimate: ${beforeJson.stress4.gpu_hw_ms}ms -> ${benchResult.stress4.gpu_hw_ms}ms (${speedupStress}% reduction)`,
      )
    }
  } finally {
    await browser.close()
    stopVite?.()
  }
}

if (import.meta.main) await main()
