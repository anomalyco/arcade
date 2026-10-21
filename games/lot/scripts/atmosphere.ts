import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { build } from "vite"

/**
 * Paired in-page GPU cost and title-camera stills of the lot's atmosphere (fog bank, fog-depth blur, lit cloud deck),
 * headless and muted. Each round alternates every variant on the same page with the drift frozen (`?time=8`), timing
 * ATMO_FRAMES frames each with the renderer's timestamp queries, so drift on a shared machine cancels out. Run through
 * HiveMind browser admission:
 *
 *   hivemind run --kind browser --browser-approval "<Kit's request>" -- bun games/lot/scripts/atmosphere.ts
 *
 * ATMO_OUT=<dir> (default captures/lot-atmosphere at the repo root) gets `atmosphere.json` and `<variant>.png` stills.
 * ATMO_GPU=swiftshader times CI's software adapter by wall clock over the running frame loop instead; ATMO_VIEWPORT=WxH.
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.ATMO_OUT ?? resolve(root, "../../captures/lot-atmosphere"))
mkdirSync(out, { recursive: true })
const rounds = Number(process.env.ATMO_ROUNDS ?? 8)
const frames = Number(process.env.ATMO_FRAMES ?? 6)
const gpu = process.env.ATMO_GPU ?? "metal"
const software = gpu === "swiftshader"
const viewport = (process.env.ATMO_VIEWPORT ?? (software ? "640x360" : "1920x1080")).split("x").map(Number) as [number, number]
const stills = process.env.ATMO_STILLS !== "0"

const OFF = { bank: "today", blur: "today", clouds: "today" }
const variants: Record<string, Record<string, string>> = {
  today: OFF,
  bank: { ...OFF, bank: "drift" },
  blur: { ...OFF, blur: "depth" },
  clouds: { ...OFF, clouds: "lit" },
  all: { bank: "drift", blur: "depth", clouds: "lit" },
}

// The atlas painter in public/ is imported at runtime, which only the production build serves.
await build({ root, logLevel: "error" })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname)
  if (pathname.includes("..")) return new Response("Bad path", { status: 400 })
  const file = Bun.file(`${root}/dist${pathname}${pathname.endsWith("/") ? "index.html" : ""}`)
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const port = server.port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "headless Chromium is missing")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", `--use-angle=${gpu}`, ...(software ? ["--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"] : []), "--ignore-gpu-blocklist", "--mute-audio"],
})
const report: Record<string, unknown> = { gpu, viewport, rounds, frames, captured: new Date().toISOString() }
try {
  const page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: 1 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/arcade/lot/?time=8`, { timeout: 240_000 })
  // Fail on the first page error rather than waiting out the readiness timeout.
  let poll: ReturnType<typeof setInterval> | undefined
  try {
    await Promise.race([
      page.waitForFunction(() => (window as any).lot?.ready && (window as any).lot.frames > 8, undefined, { timeout: 600_000 }),
      new Promise((_, reject) => { poll = setInterval(() => { if (errors.length) reject(new Error(errors.join("\n"))) }, 500) }),
    ])
  } finally {
    clearInterval(poll)
  }
  await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
  report.adapter = await page.evaluate(async () => {
    const info = (await navigator.gpu.requestAdapter())?.info
    return info ? { vendor: info.vendor, architecture: info.architecture, description: info.description } : null
  })
  console.log("adapter", JSON.stringify(report.adapter))
  report.deviceLost = await page.evaluate(() => new Promise<string>((done) => {
    ;(window as any).lot.renderer.passContext.device.lost.then((i: GPUDeviceLostInfo) => done(`${i.reason}: ${i.message}`))
    setTimeout(() => done(""), 200)
  }))
  if (report.deviceLost) throw new Error(`GPU device lost: ${report.deviceLost}`)

  const settle = (variant: Record<string, string>, count: number) => page.evaluate(async ({ variant, count }) => {
    const lot = (window as any).lot
    Object.assign(lot.fog.settings, variant)
    lot.paused = false
    const start = lot.frames
    while (lot.frames < start + count) await new Promise((r) => requestAnimationFrame(r))
    lot.paused = true
    await lot.renderer.passContext.device.queue.onSubmittedWorkDone()
  }, { variant, count })

  const time = (count: number) => page.evaluate(async ({ count, software }) => {
    const lot = (window as any).lot
    const device: GPUDevice = lot.renderer.passContext.device
    const ms: number[] = []
    for (let i = 0; i < count; i++) {
      if (software) {
        // Software GPU timestamps are unreliable: time the running frame loop by wall clock instead.
        await device.queue.onSubmittedWorkDone()
        lot.paused = false
        const start = lot.frames
        const t = performance.now()
        while (lot.frames < start + 4) await new Promise((r) => requestAnimationFrame(r))
        await device.queue.onSubmittedWorkDone()
        lot.paused = true
        ms.push((performance.now() - t) / 4)
      } else {
        ms.push(await lot.measureFrame())
      }
    }
    return ms
  }, { count, software })

  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!
  const names = Object.keys(variants)
  const samples: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
  const all: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
  const deltas: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
  for (let r = 0; r < rounds; r++) {
    const order = names.map((_, i) => names[(i + r) % names.length]!)
    const round: Record<string, number> = {}
    for (const name of order) {
      await settle(variants[name]!, software ? 2 : 12)
      const ms = await time(frames)
      all[name]!.push(...ms)
      round[name] = median(ms)
      samples[name]!.push(round[name]!)
    }
    for (const name of names) deltas[name]!.push(round[name]! - round.today!)
    console.log(`round ${r + 1}/${rounds}`, JSON.stringify(round))
  }
  const mad = (v: number[]) => { const m = median(v); return median(v.map((x) => Math.abs(x - m))) }
  // On a shared worker the lower envelope (10th percentile of every timed frame) is the steadier estimate of cost.
  const p10 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.1)]!
  report.results = Object.fromEntries(names.map((n) => [n, {
    median: median(samples[n]!), delta: median(deltas[n]!), deltaMad: mad(deltas[n]!), p10: p10(all[n]!), p10Delta: p10(all[n]!) - p10(all.today!),
  }]))
  console.log(JSON.stringify(report.results, null, 2))

  if (stills && !software) {
    for (const name of names) {
      await settle(variants[name]!, 64)
      await page.screenshot({ path: resolve(out, `${name}.png`), timeout: 60_000 })
    }
  }
  report.errors = errors
  if (errors.length) throw new Error(errors.join("\n"))
} finally {
  writeFileSync(resolve(out, "atmosphere.json"), JSON.stringify(report, null, 2))
  await browser.close()
  server.stop(true)
}
