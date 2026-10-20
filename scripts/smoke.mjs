// Run from a game directory after `bun run check` has built its production bundle.
import assert from "node:assert/strict"
import { basename, resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const game = basename(process.cwd())
assert(["blackout", "getaway", "outbreak", "carrier", "lab", "brawl", "archers", "walkers"].includes(game), `Unknown game: ${game}`)
const prefix = `/arcade/${game}/`
const root = resolve(`dist/arcade/${game}`)
assert(await Bun.file(resolve(root, "index.html")).exists(), "Build the game before running smoke")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    // This is a static-bundle check; optional lobby data needs no Worker.
    if (path === `${prefix}api/stats`) return Response.json({ players: 0, games: 0 })
    if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const asset = Bun.file(file)
    return await asset.exists() ? new Response(asset) : new Response("Not found", { status: 404 })
  },
})
let browser
// The workflow step allows 60 s. On SwiftShader the GPU process compiles every render pipeline on one thread before it
// presents a frame (Outbreak, Oct 20: 22–36 s, ~1 s per scene-shader pipeline), and the page's main thread can block
// behind it, so readiness and the first frames share one budget rather than a separate 20 s readiness limit.
const READY_MS = 40_000
const deadline = setTimeout(() => {
  console.error(`${game}: smoke exceeded 55 seconds`)
  process.exit(1)
}, 55_000)
// CI (Linux) has no GPU and uses SwiftShader. On macOS the real Metal adapter renders ~80x faster and must actually
// start: there the "needs WebGPU" fallback counts as a failure.
// SMOKE_GPU=swiftshader reproduces CI on a Mac.
const metal = (process.env.SMOKE_GPU ?? (process.platform === "darwin" ? "metal" : "swiftshader")) === "metal"
try {
  browser = await chromium.launch({
    headless: true,
    timeout: 10_000,
    args: metal
      ? ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"]
      : [
          "--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
          // Carrier and Outbreak draw behind the menu and need WebGPU presentation, not merely adapter creation.
          "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--mute-audio",
          ...(process.platform === "linux" ? ["--disable-vulkan-surface"] : []),
        ],
  })
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
  // Milliseconds since navigation: DOMContentLoaded, load, the game's own `performance.mark("<game>:…")` phases, now.
  const bootTimeline = () => page.evaluate(game => {
    const nav = performance.getEntriesByType("navigation")[0]
    const phases = [["dom", nav?.domContentLoadedEventEnd], ["load", nav?.loadEventEnd]]
    for (const m of performance.getEntriesByType("mark")) if (m.name.startsWith(`${game}:`)) phases.push([m.name.slice(game.length + 1), m.startTime])
    phases.push(["now", performance.now()])
    return phases.map(([name, ms]) => `${name} ${Math.round(ms ?? 0)}`).join(" · ")
  }, game)
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  // The Lab's bench mode exposes window.lab after its first frame and keeps audio locked.
  const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}${game === "lab" ? "?bench" : ""}`, { waitUntil: "load", timeout: 15_000 })
  assert.equal(response.status(), 200)
  // Require JS-created UI, not the static HTML shell. A missing GPU is an explicit
  // supported outcome for these WebGPU-only games, never a blanket error waiver. Interval polling, not the default
  // requestAnimationFrame: rAF polls stall while a software GPU is busy compiling or drawing.
  const ready = await page.waitForFunction(game => {
    if (game === "lab") {
      const notice = document.querySelector("[data-lab-notice]")?.textContent
      if (notice && /needs WebGPU/.test(notice)) return notice
      return window.lab ? `Lab ready (${window.lab.sections.length} sections)` : false
    }
    if (game === "outbreak") {
      const status = document.querySelector("#status")?.textContent
      if (status && /needs WebGPU|No WebGPU adapter is available/.test(status)) return status
      return window.__arcadeHarness?.ready ? "local session ready" : false
    }
    const sel = {
      blackout: ["#menu .notice", '#menu [data-act="practice"]'],
      brawl: ["#menu .notice", '#menu [data-act="practice"]'],
      archers: ["#hud .notice", "#hud .strip .slot"],
      getaway: ["#overlay .nogpu p", '#overlay [data-act="solo"]'],
      carrier: ["#hud .notice", '.mn [data-act="quick"]'],
      // Canvas 2D and Web Workers, no WebGPU: ready once the first generation has been scored.
      walkers: ["#toast", '#app[data-ready] #stats b'],
    }[game]
    const failure = document.querySelector(sel[0])?.textContent
    if (failure && /needs WebGPU|No WebGPU adapter is available|WebGPU could not start/.test(failure)) return failure
    return document.querySelector(sel[1]) ? "lobby ready" : false
  }, game, { timeout: READY_MS, polling: 100 }).catch(async error => {
    const status = await page.evaluate(() => document.querySelector("#status, .notice")?.textContent ?? "").catch(() => "")
    console.error(`${game}: not ready after ${READY_MS / 1000} s; status ${JSON.stringify(status)}; boot ${await bootTimeline().catch(() => "?")}; browser errors ${JSON.stringify(errors)}`)
    throw error
  })
  console.log(`${game}: boot ${await bootTimeline()}`)
  // Let initialization promises and the first presentation frames report errors. On SwiftShader the wait for these
  // two frames is most of the smoke's time.
  const frames = await page.evaluate(() => new Promise(resolve => {
    const at = []
    const frame = () => (at.push(Math.round(performance.now())), at.length < 2 ? requestAnimationFrame(frame) : resolve(at))
    requestAnimationFrame(frame)
  }))
  console.log(`${game}: presented frames at ${frames.join(", ")} ms`)
  assert.deepEqual(errors, [], `${game}: browser errors`)
  const outcome = await ready.jsonValue()
  if (metal) assert.match(outcome, /ready/, `${game}: WebGPU did not start on Metal (${outcome})`)
  console.log(`${game}: production smoke passed (${outcome}${metal ? ", Metal" : ""})`)
} finally {
  await browser?.close()
  server.stop(true)
  clearTimeout(deadline)
}
