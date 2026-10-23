// Run from a game directory after `bun run check` has built its production bundle.
import assert from "node:assert/strict"
import { basename, resolve, sep } from "node:path"
import { browserBudget } from "./browser-budget.ts"

await using budget = browserBudget()
const { chromium } = budget

const game = basename(process.cwd())
assert(["blackout", "getaway", "outbreak", "carrier", "lab", "brawl", "archers", "walkers", "lot", "nightshift", "barbara", "timber"].includes(game), `Unknown game: ${game}`)
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
let bootTimeline = async () => "not loaded"
// Most games allow 55 s; Lot allows 75 s for loading its dense imported exterior (ready at 18–32 s on CI, Oct 21).
// On SwiftShader the GPU process compiles every render pipeline on one thread before it
// presents a frame (Outbreak, Oct 21: 20–36 s for its 25 boot pipelines; the kit renderer builds unused ones only on
// first use, which took 3–7 s off), and the page's main thread can block
// behind it, so readiness and the first frames share one budget rather than a separate 20 s readiness limit.
const READY_MS = game === "lot" ? 60_000 : 40_000
// Barbara waits for its forest frames to finish on the GPU: 9 s under SwiftShader on a Mac, past 45 s on CI (Oct 22).
const DEADLINE_MS = game === "lot" ? 75_000 : game === "barbara" ? 140_000 : 55_000
const CLOSE_MS = 3_000
let passed = false
const deadline = setTimeout(async () => {
  const boot = await Promise.race([bootTimeline().catch(() => "?"), Bun.sleep(1_000).then(() => "page unresponsive")])
  console.error(`${game}: smoke exceeded ${DEADLINE_MS / 1000} seconds; boot ${boot}`)
  await budget.exit(1)
}, DEADLINE_MS)
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
  bootTimeline = () => page.evaluate(game => {
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
  const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}${game === "lab" ? "?bench" : game === "lot" || game === "nightshift" || game === "outbreak" || game === "barbara" ? "?smoke" : ""}`, { waitUntil: "load", timeout: 15_000 })
  assert.equal(response.status(), 200)
  // Require JS-created UI, not the static HTML shell. A missing GPU is an explicit
  // supported outcome for these WebGPU-only games, never a blanket error waiver. Interval polling, not the default
  // requestAnimationFrame: rAF polls stall while a software GPU is busy compiling or drawing.
  const ready = await page.waitForFunction(game => {
    if (game === "barbara") {
      const status = document.querySelector("#hud")?.textContent
      if (status && /needs WebGPU|No WebGPU adapter is available|WebGPU could not start/.test(status)) return status
      // Under ?smoke the woods draw two frames at low trunk density, then pause.
      return window.woods?.ready && window.woods.frames >= 2 ? "barbara ready" : false
    }
    if (game === "nightshift") {
      const status = document.querySelector("#hud")?.textContent
      if (status && /needs WebGPU|No WebGPU adapter is available|WebGPU could not start/.test(status)) return status
      return window.nightshift?.ready && window.nightshift.frames >= 2 ? "nightshift ready" : false
    }
    if (game === "lot") {
      const status = document.querySelector("#hud")?.textContent
      if (status && /needs WebGPU|No WebGPU adapter is available|WebGPU could not start/.test(status)) return status
      // Under ?smoke the Lot submits exactly two frames, then pauses.
      return window.lot?.ready && window.lot.frames >= 2 ? "lot ready" : false
    }
    if (game === "timber") {
      const status = document.querySelector("#hud")?.textContent
      if (status && /needs WebGPU|No WebGPU adapter is available|WebGPU could not start/.test(status)) return status
      return document.querySelector(".arcade-shell") && window.timber?.frames >= 2 ? "timber ready" : false
    }
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
      // Games on the kit game shell are ready once `.arcade-shell` exists (hidden under automation, the game behind it).
      blackout: ["#menu .notice", '#menu [data-act="practice"], .arcade-shell'],
      brawl: ["#menu .notice", '#menu [data-act="practice"], .arcade-shell'],
      archers: ["#hud .notice", "#hud .strip .slot"],
      getaway: ["#overlay .nogpu p", '#overlay [data-act="solo"], .arcade-shell'],
      carrier: ["#hud .notice", '.mn [data-act="quick"], .arcade-shell'],
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
  if (game === "lot") {
    // Lot has already submitted its two real frames (offscreen) and paused. An empty error-scope round trip returns
    // once the GPU process has validated them (their errors reach the console first), without waiting for SwiftShader
    // to rasterize them: the dense scene takes over three minutes a frame there (CI, Oct 21), which proves nothing more.
    await page.evaluate(async () => {
      const device = window.lot?.renderer.passContext.device
      device.pushErrorScope("validation")
      await device.popErrorScope()
    })
    console.log(`lot: ${await page.evaluate(() => window.lot?.frames)} frames validated; boot ${await bootTimeline()}`)
  } else {
    // Let initialization promises and the first presentation frames report errors.
    const frames = await page.evaluate(() => new Promise(resolve => {
      const at = []
      const frame = () => (at.push(Math.round(performance.now())), at.length < 2 ? requestAnimationFrame(frame) : resolve(at))
      requestAnimationFrame(frame)
    }))
    console.log(`${game}: presented frames at ${frames.join(", ")} ms`)
  }
  if (game === "barbara") {
    const exposure = await page.evaluate(() => {
      const w = window.woods, forest = w.view.forest, s = forest.settings
      if (w.renderer.sceneMeterStatus !== "off") throw new Error("smoke unexpectedly enabled the meter")
      let input
      const update = forest.update
      forest.update = f => { input = f; update(f) }
      try { w.step(1000 / 60) } finally { forest.update = update }
      const saved = { sky: s.sky, exposureModel: s.exposureModel }
      const samples = []
      try {
        // Reference law from before 0c2cdc70: no reading meant taking the fallback target every frame.
        for (const model of ["robust", "metered"]) for (const on of [true, false]) for (const sky of [0, 1]) {
          s.exposureModel = model; s.sky = sky
          const f = { ...input, torches: input.torches.map(t => ({ ...t, on })), dt: 1 / 60 }
          update(f)
          const local = f.torches.find(t => t.kind !== "remote" && t.on)
          const coverage = Math.min(1, (Math.tan(s.torchAngle * Math.PI / 180 * 1.3) / Math.tan(f.fovY / 2)) ** 2)
          const spot = local ? s.torchPower * 5 * 0.2 / (Math.PI * Math.max(forest.camera.hit, 0.4) ** 2) * coverage : 0
          const key = Math.max(spot + 0.004 * s.sky + 0.0005, 1e-6)
          const stops = model === "metered" ? -Math.log2(key / 0.09) * 0.55 : s.nightStops - Math.log2(key / Math.max(s.nightKey, 1e-6)) * s.nightStrength
          const expected = Math.pow(2, s.autoExposure ? Math.max(-s.adaptRange, Math.min(s.adaptLift, stops)) : 0)
          if (forest.camera.exposure !== expected) throw new Error(`smoke exposure ${forest.camera.exposure} != pre-hold ${expected}`)
          samples.push({ model, on, sky, exposure: expected })
        }
      } finally { Object.assign(s, saved); update(input) }
      return samples
    })
    console.log(`barbara: pre-0c2cdc70 smoke exposure parity (${exposure.length} exact matches)`)
    await page.evaluate(() => window.woods?.renderer.passContext.device.queue.onSubmittedWorkDone())
  }
  if (game === "nightshift") {
    await page.evaluate(() => window.nightshift?.renderer.passContext.device.queue.onSubmittedWorkDone())
  }
  assert.deepEqual(errors, [], `${game}: browser errors`)
  const outcome = await ready.jsonValue()
  if (metal) assert.match(outcome, /ready/, `${game}: WebGPU did not start on Metal (${outcome})`)
  console.log(`${game}: production smoke passed (${outcome}${metal ? ", Metal" : ""})`)
  passed = true
} finally {
  // Shutdown is not under test. Chromium's close waits for SwiftShader to finish the frames still queued (Outbreak
  // on CI, Oct 21: 0.3–17 s after a pass, several seconds a frame), so after CLOSE_MS the browser is killed: Playwright's
  // exit hook SIGKILLs its process group.
  const closed = await Promise.race([browser ? browser.close().then(() => true) : true, Bun.sleep(CLOSE_MS).then(() => false)])
  server.stop(true)
  clearTimeout(deadline)
  if (!closed) {
    console.log(`${game}: browser still closing after ${CLOSE_MS / 1000} s; killing it`)
    if (passed) await budget.exit(0)
  }
}
