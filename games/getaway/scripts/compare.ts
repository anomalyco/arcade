import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { encode } from "../../../scripts/encode"
import { installMainHook } from "../../../packages/kit/getaway-main-hook"

type BenchStepResult = {
  cpuMs: number
  gpuMs: number
  stats: {
    cityVertsDrawn: number
    mainCityVertsDrawn: number
    shadowCityVertsDrawn: number
    chunksDrawn: number
    mainChunksDrawn: number
    shadowChunksDrawn: number
    totalChunks: number
  }
}

type StatSummary = {
  mean: number
  p50: number
  p95: number
  min: number
  max: number
}

type BenchReport = {
  machine?: string
  phase: "before" | "after"
  timestamp: string
  adapter: {
    vendor: string
    architecture: string
    device: string
    description: string
  }
  frames: number
  frame_ms: StatSummary
  gpu_ms: StatSummary
  cpu_ms: StatSummary
  city_verts_drawn: {
    mean: number
    main_mean: number
    shadow_mean: number
  }
  chunks_drawn: {
    mean: number
    main_mean: number
    shadow_mean: number
    total_chunks: number
  }
}

const BENCH_DIR = process.env.BENCH_DIR ?? join(import.meta.dir, "../../../captures/bench")
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? join(import.meta.dir, "../../../captures/preview")
const DESKTOP_DIR = PREVIEW_DIR
const KEYFRAMES = [12, 60, 135] as const
const TOTAL_FRAMES = 180

function summarize(values: number[]): StatSummary {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, n)
  const p50 = sorted[Math.floor(n * 0.5)] ?? 0
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0
  const round = (x: number) => Math.round(x * 1000) / 1000
  return {
    mean: round(mean),
    p50: round(p50),
    p95: round(p95),
    min: round(sorted[0] ?? 0),
    max: round(sorted[n - 1] ?? 0),
  }
}

function findChromeExecutable(): string {
  const candidates = [
    join(homedir(), "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    join(homedir(), "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(`No Chromium/Brave executable found. Checked:\n${candidates.join("\n")}`)
}

async function isViteUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800) })
    if (!res.ok) return false
    const text = await res.text()
    return text.includes("GETAWAY") || text.includes("src/main.ts")
  } catch {
    return false
  }
}

async function ensureViteServer(preferredPort = 5190): Promise<{ port: number; stop: () => void }> {
  if (await isViteUp(preferredPort)) {
    return { port: preferredPort, stop: () => {} }
  }
  throw new Error(`No preview on port ${preferredPort}; pass the existing Nexus preview port with --port.`)
}

async function runFfmpeg(args: string[]) {
  await encode(args)
}

async function main() {
  const args = process.argv.slice(2)
  const phaseArg = args.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "before"
  if (phaseArg !== "before" && phaseArg !== "after") {
    throw new Error(`Usage: bun scripts/compare.ts --phase=before|after (got ${phaseArg})`)
  }
  const phase: "before" | "after" = phaseArg
  const portArg = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "5190")

  mkdirSync(BENCH_DIR, { recursive: true })
  mkdirSync(PREVIEW_DIR, { recursive: true })
  mkdirSync(DESKTOP_DIR, { recursive: true })

  const vite = await ensureViteServer(portArg)
  const exe = findChromeExecutable()

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--enable-features=Vulkan,WebGPU",
      "--ignore-gpu-blocklist",
      "--mute-audio",
    ],
  })

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    const sourceRoot = args.find((a) => a.startsWith("--source-root="))?.slice(14)
    if (sourceRoot) await installMainHook(page, sourceRoot)
    await page.routeWebSocket("**", (socket) => {
      const server = socket.connectToServer()
      server.onMessage((message) => {
        if (typeof message === "string" && /"type":"(?:update|full-reload)"/.test(message)) return
        socket.send(message)
      })
    })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon|woff|Failed to load resource/i.test(m.text())) errors.push(`console.error: ${m.text()}`)
    })

    const url = `http://localhost:${vite.port}/?solo&bench&vanilla=1`
    await page.goto(url, { waitUntil: "networkidle" })
    await page.waitForFunction(
      () => Boolean((window as unknown as { __getawayBench?: { ready?: unknown } }).__getawayBench),
      null,
      { timeout: 15_000 },
    )
    await page.evaluate(async () => {
      const b = (window as unknown as { __getawayBench: { ready: Promise<boolean> } }).__getawayBench
      await b.ready
    })

    const adapter = await page.evaluate(() => {
      return (window as unknown as {
        __getawayBench: {
          adapterInfo: { vendor: string; architecture: string; device: string; description: string }
        }
      }).__getawayBench.adapterInfo
    })

    if (/swiftshader|google/i.test(adapter.vendor) || /swiftshader/i.test(adapter.description)) {
      throw new Error(`Expected hardware Apple Metal WebGPU adapter, got SwiftShader: ${JSON.stringify(adapter)}`)
    }
    console.log(`[compare:${phase}] WebGPU adapter:`, adapter)

    // Warmup pass (20 frames) so pipelines & JIT settle.
    await page.evaluate(async () => {
      const b = (window as unknown as {
        __getawayBench: { reset(): void; step(i: number, dt: number, waitGpu: boolean): Promise<unknown> }
      }).__getawayBench
      b.reset()
      for (let i = 0; i < 20; i++) {
        await b.step(i, 1 / 30, true)
      }
    })

    // 1. Deterministic 180-frame GPU + CPU benchmark pass (without screenshot readback overhead).
    console.log(`[compare:${phase}] Running ${TOTAL_FRAMES}-frame benchmark pass...`)
    const rawMetrics = await page.evaluate(async (totalFrames: number) => {
      const b = (window as unknown as {
        __getawayBench: { reset(): void; step(i: number, dt: number, waitGpu: boolean): Promise<BenchStepResult> }
      }).__getawayBench
      b.reset()
      const out: BenchStepResult[] = []
      for (let i = 0; i < totalFrames; i++) {
        out.push(await b.step(i, 1 / 30, true))
      }
      return out
    }, TOTAL_FRAMES)

    if (errors.length) {
      throw new Error(`Browser errors during benchmark:\n${errors.join("\n")}`)
    }

    const cpuList = rawMetrics.map((m) => m.cpuMs)
    const gpuList = rawMetrics.map((m) => m.gpuMs)
    const frameList = rawMetrics.map((m) => m.cpuMs + m.gpuMs)
    const avg = (arr: number[]) => Math.round((arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length)) * 10) / 10

    const report: BenchReport = {
      phase,
      timestamp: new Date().toISOString(),
      machine: hostname(),
      adapter,
      frames: TOTAL_FRAMES,
      frame_ms: summarize(frameList),
      gpu_ms: summarize(gpuList),
      cpu_ms: summarize(cpuList),
      city_verts_drawn: {
        mean: avg(rawMetrics.map((m) => m.stats.cityVertsDrawn)),
        main_mean: avg(rawMetrics.map((m) => m.stats.mainCityVertsDrawn)),
        shadow_mean: avg(rawMetrics.map((m) => m.stats.shadowCityVertsDrawn)),
      },
      chunks_drawn: {
        mean: avg(rawMetrics.map((m) => m.stats.chunksDrawn)),
        main_mean: avg(rawMetrics.map((m) => m.stats.mainChunksDrawn)),
        shadow_mean: avg(rawMetrics.map((m) => m.stats.shadowChunksDrawn)),
        total_chunks: rawMetrics[0]?.stats.totalChunks ?? 1,
      },
    }

    const jsonPath = join(BENCH_DIR, `getaway-${phase}.json`)
    writeFileSync(jsonPath, JSON.stringify(report, null, 2))
    console.log(`[compare:${phase}] Saved metrics -> ${jsonPath}`)
    console.log(
      `[compare:${phase}] frame_ms p50=${report.frame_ms.p50.toFixed(2)}ms p95=${report.frame_ms.p95.toFixed(2)}ms mean=${report.frame_ms.mean.toFixed(2)}ms | gpu_ms mean=${report.gpu_ms.mean.toFixed(2)}ms | city_verts_drawn=${report.city_verts_drawn.mean} | chunks_drawn=${report.chunks_drawn.mean}/${report.chunks_drawn.total_chunks * 2}`,
    )

    // 2. Deterministic 180-frame 30 fps video recording pass.
    const mp4Path = join(BENCH_DIR, `getaway-${phase}.mp4`)
    console.log(`[compare:${phase}] Recording ${TOTAL_FRAMES}-frame 30fps video -> ${mp4Path}`)
    const framesDir = join(BENCH_DIR, `getaway-frames-${phase}`)
    mkdirSync(framesDir, { recursive: true })

    await page.evaluate(() => {
      ;(window as unknown as { __getawayBench: { reset(): void } }).__getawayBench.reset()
    })

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      await page.evaluate(async (idx: number) => {
        await (window as unknown as { __getawayBench: { step(i: number, dt: number, waitGpu: boolean): Promise<unknown> } }).__getawayBench.step(
          idx,
          1 / 30,
          false,
        )
      }, i)
      const png = await page.screenshot({ type: "png" })
      writeFileSync(join(framesDir, `f_${String(i).padStart(4, "0")}.png`), png)
      if ((KEYFRAMES as readonly number[]).includes(i)) {
        writeFileSync(join(BENCH_DIR, `getaway-${phase}-f${String(i).padStart(3, "0")}.png`), png)
      }
    }
    await encode(["-framerate", "30", "-i", join(framesDir, "f_%04d.png"), "-c:v", "h264_videotoolbox", "-profile:v", "high", "-q:v", "75", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path])

    // 3. When --phase=after, stitch side-by-side MP4 and 3-frame contact sheet!
    if (phase === "after") {
      const beforeJsonPath = join(BENCH_DIR, "getaway-before.json")
      const beforeMp4Path = join(BENCH_DIR, "getaway-before.mp4")
      if (!existsSync(beforeJsonPath) || !existsSync(beforeMp4Path)) {
        throw new Error(`Missing baseline artifacts (${beforeJsonPath} or ${beforeMp4Path}). Run --phase=before first!`)
      }
      const beforeReport = JSON.parse(readFileSync(beforeJsonPath, "utf8")) as BenchReport

      const comparable = beforeReport.machine !== undefined && beforeReport.machine === report.machine
      const metric = (name: string) => args.includes("--final-metrics") ? JSON.parse(readFileSync(join(import.meta.dir, `../../../perf/getaway-final-${name}.json`), "utf8")).metrics : null
      const beforeMetrics = metric("main"), afterMetrics = metric("integrated")
      const beforeLabel = comparable ? beforeMetrics ? `BEFORE · GPU ${beforeMetrics.gpu_hw_ms.median.toFixed(2)} ms · frame ${beforeMetrics.frame_ms.median.toFixed(2)} ms` : `BEFORE (${beforeReport.frame_ms.mean.toFixed(2)} ms | ${Math.round(beforeReport.city_verts_drawn.mean / 1000)}k verts)` : `BEFORE (archived | ${Math.round(beforeReport.city_verts_drawn.mean / 1000)}k verts)`
      const afterLabel = afterMetrics ? `AFTER · GPU ${afterMetrics.gpu_hw_ms.median.toFixed(2)} ms · frame ${afterMetrics.frame_ms.median.toFixed(2)} ms` : `AFTER (${report.frame_ms.mean.toFixed(2)} ms | ${Math.round(report.city_verts_drawn.mean / 1000)}k verts)`

      // Render crisp transparent PNG overlays in browser canvas (since Homebrew ffmpeg lacks drawtext).
      const { videoOverlayB64, rowOverlayB64 } = await page.evaluate(
        ({ bText, aText }) => {
          const drawBanner = (w: number, h: number, left: string, right: string, fontSize: number) => {
            const c = document.createElement("canvas")
            c.width = w
            c.height = h
            const ctx = c.getContext("2d")!
            ctx.font = `700 ${fontSize}px "Inter", -apple-system, BlinkMacSystemFont, sans-serif`
            ctx.textBaseline = "middle"
            const pill = (x: number, y: number, text: string, accent: string) => {
              const padX = 14
              const boxH = fontSize + 16
              const tw = ctx.measureText(text).width
              const boxW = tw + padX * 2 + 10
              ctx.fillStyle = "rgba(5, 7, 11, 0.82)"
              ctx.fillRect(x, y, boxW, boxH)
              ctx.fillStyle = accent
              ctx.fillRect(x, y, 4, boxH)
              ctx.fillStyle = "#eef1f6"
              ctx.fillText(text, x + padX + 6, y + boxH / 2 + 1)
            }
            pill(16, 14, left, "#ff5c47")
            pill(w / 2 + 16, 14, right, "#36f07a")
            // Subtle center divider line
            ctx.fillStyle = "rgba(255, 255, 255, 0.28)"
            ctx.fillRect(w / 2 - 1, 0, 2, h)
            return c.toDataURL("image/png").split(",")[1]!
          }
          return {
            videoOverlayB64: drawBanner(1920, 540, bText, aText, 20),
            rowOverlayB64: drawBanner(1440, 405, bText, aText, 16),
          }
        },
        { bText: beforeLabel, aText: afterLabel },
      )

      const videoOverlayPath = join(BENCH_DIR, "overlay-video.png")
      const rowOverlayPath = join(BENCH_DIR, "overlay-row.png")
      writeFileSync(videoOverlayPath, Buffer.from(videoOverlayB64, "base64"))
      writeFileSync(rowOverlayPath, Buffer.from(rowOverlayB64, "base64"))

      const previewMp4 = join(PREVIEW_DIR, "getaway-before-after.mp4")
      const desktopMp4 = join(DESKTOP_DIR, "getaway-before-after.mp4")
      await runFfmpeg([
        "-i",
        beforeMp4Path,
        "-i",
        mp4Path,
        "-i",
        videoOverlayPath,
        "-filter_complex",
        "[0:v]scale=960:540[b];[1:v]scale=960:540[a];[b][a]hstack=inputs=2[st];[st][2:v]overlay=0:0",
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
        previewMp4,
      ])
      console.log(`[compare:after] Stitched side-by-side video -> ${previewMp4} & ${desktopMp4}`)

      // Build 3-frame side-by-side contact sheet (1440x1215 <= 1500x1500).
      const rowPaths: string[] = []
      for (const f of KEYFRAMES) {
        const tag = String(f).padStart(3, "0")
        const bPng = join(BENCH_DIR, `getaway-before-f${tag}.png`)
        const aPng = join(BENCH_DIR, `getaway-after-f${tag}.png`)
        const rowPng = join(BENCH_DIR, `getaway-row-f${tag}.png`)
        await runFfmpeg([
          "-i",
          bPng,
          "-i",
          aPng,
          "-i",
          rowOverlayPath,
          "-filter_complex",
          "[0:v]scale=720:405[b];[1:v]scale=720:405[a];[b][a]hstack=inputs=2[st];[st][2:v]overlay=0:0",
          "-frames:v",
          "1",
          rowPng,
        ])
        rowPaths.push(rowPng)
      }
      const previewSheet = join(PREVIEW_DIR, "getaway-before-after-sheet.jpg")
      const desktopSheet = join(DESKTOP_DIR, "getaway-before-after-sheet.jpg")
      await runFfmpeg([
        "-i",
        rowPaths[0]!,
        "-i",
        rowPaths[1]!,
        "-i",
        rowPaths[2]!,
        "-filter_complex",
        "[0:v][1:v][2:v]vstack=inputs=3",
        "-q:v",
        "2",
        previewSheet,
      ])
      console.log(`[compare:after] Stitched 3-frame contact sheet (1440x1215) -> ${previewSheet} & ${desktopSheet}`)
    }
  } finally {
    await browser.close()
    vite.stop()
  }
}

await main()
