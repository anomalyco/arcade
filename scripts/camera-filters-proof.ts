/**
 * Camera filters (iPhone, VHS camcorder, CRT TV, body cam) in Night Shift, the lot and Outbreak: a still per look and
 * game, each filter's own GPU time (timestamp queries around its passes, 1920×1080), and three short clips for the
 * moving parts (the phone's exposure hunt, VHS tracking, body-cam sway on a 30 fps virtual clock). Headless Metal
 * Chromium, muted:
 *
 *   hivemind run --kind browser --browser-approval "…" -- bun scripts/camera-filters-proof.ts [--games nightshift,lot,outbreak] [--no-clips] [--no-timing]
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer } from "vite"
import { serveDist } from "../games/lot/scripts/serve-dist"

const repo = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const out = resolve(arg("out", process.env.LEASE_OUT ?? resolve(repo, "captures/camera-filters"))!)
const games = (arg("games", "nightshift,lot,outbreak")!).split(",")
mkdirSync(out, { recursive: true })
const W = 1920, H = 1080
const errors: string[] = []
const report: Record<string, unknown> = { viewport: [W, H], gpu: "metal", stills: {}, timing: {}, clips: {}, errors }

type Filter = { settings: Record<string, unknown>; measure(): Promise<number | null>; preset(look: string, id: string): boolean }
declare global { interface Window { cameraFilter: Filter; nightshift: any; lot: any; __arcadeHarness: any; __clock: { on: boolean; t: number }; __tick(ms: number): Promise<void> } }

async function serve(game: string): Promise<{ server: { close(): unknown }; url: string }> {
  // The lot loads its Ashwood painter from public/ at runtime, which only a production build serves.
  if (game === "lot") {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: resolve(repo, "games/lot"), stdout: "ignore", stderr: "pipe" })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString())
    const server = serveDist(resolve(repo, "games/lot/dist"))
    return { server: { close: () => server.stop(true) }, url: `http://127.0.0.1:${server.port}/arcade/lot/` }
  }
  if (game === "outbreak") Bun.spawnSync(["bun", "scripts/build-id.ts"], { cwd: resolve(repo, "games/outbreak") })
  const root = resolve(repo, "games", game)
  const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } } })
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  const base = server.config.base === "./" ? "/" : server.config.base
  return { server, url: `http://127.0.0.1:${port}${base}` }
}

function chromiumPath(): string {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const p = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
  if (!p) throw new Error("Headless Chromium shell is missing")
  return p
}

async function open(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(180_000)
  // Outbreak opens its own device: ask for timestamp queries everywhere so the filter can time itself.
  await page.addInitScript(() => {
    // Opt-in virtual clock for clips: while on, animation frames run only on __tick, at exact steps.
    const raf = window.requestAnimationFrame.bind(window)
    let queued: FrameRequestCallback[] = []
    const clock = { on: false, t: 0 }
    window.requestAnimationFrame = cb => clock.on ? queued.push(cb) : raf(cb)
    Object.assign(window, {
      __clock: clock,
      __tick: async (ms: number) => {
        clock.t += ms
        const q = queued
        queued = []
        for (const cb of q) cb(clock.t)
        await new Promise(r => raf(r))
      },
    })
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(`${url}: ${e.message}`))
  page.on("console", m => { if (m.type() === "error" || /wgsl|validation/i.test(m.text())) errors.push(`${url}: ${m.text()}`) })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 600_000 })
  return page
}

const HIDE = "#hud,#credits,#title,#prompt,#subtitle,#reticle,[data-lab-panel],#status,#hotbar,#stamina,#battery,.callouts,.callout,.hud,#markers,.coop-tag,.ob-hud,[data-callout-layer],.ob-callout-layer{visibility:hidden!important}"

/** A game driver: `ready` waits for the first frames, `advance` renders n more (live loop or harness steps). */
type Driver = { page: Page; advance(n: number): Promise<void>; freeze(on: boolean): Promise<void> }

async function nightshift(browser: Browser, url: string): Promise<Driver> {
  const page = await open(browser, url)
  await page.waitForFunction(() => window.nightshift?.ready && window.nightshift.frames > 40, undefined, { timeout: 180_000 })
  await page.evaluate(() => window.nightshift.setCamera("wide"))
  return {
    page,
    advance: n => page.evaluate(async n => { const f = window.nightshift.frames; while (window.nightshift.frames < f + n) await new Promise(r => setTimeout(r, 8)) }, n),
    freeze: on => page.evaluate(async on => { window.nightshift.paused = on; if (on) await window.nightshift.renderer.passContext.device.queue.onSubmittedWorkDone() }, on),
  }
}

async function lot(browser: Browser, url: string): Promise<Driver> {
  const page = await open(browser, url)
  await page.waitForFunction(() => window.lot?.ready && window.lot.frames > 40, undefined, { timeout: 600_000 })
  return {
    page,
    advance: n => page.evaluate(async n => { const f = window.lot.frames; while (window.lot.frames < f + n) await new Promise(r => setTimeout(r, 8)) }, n),
    freeze: on => page.evaluate(async on => { window.lot.paused = on; if (on) await window.lot.renderer.passContext.device.queue.onSubmittedWorkDone() }, on),
  }
}

async function outbreak(browser: Browser, url: string): Promise<Driver> {
  const page = await open(browser, `${url}?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => window.__arcadeHarness?.ready, undefined, { timeout: 180_000 })
  // The street outside the start house at 21:00, flashlight on (the blood-lights proof's night street).
  await page.evaluate(async () => {
    const h = window.__arcadeHarness
    h.freeze(true); h.reset(7); h.setQuality("high"); h.setLab("timeScale", 0); h.setZoomRaw(38); h.lookPreset("today"); h.setLab("hour", 21)
    const x = 27.7, y = 41.2, aim = -Math.PI / 2
    h.pose(x, y, aim)
    const pin = () => Object.assign(h.state().player, { x, y, vx: 0, vy: 0, flashlightOn: true, flashlightOutput: 1 })
    const t0 = performance.now()
    while (performance.now() - t0 < 20_000) {
      pin(); await h.step(1 / 60, { mx: 0, my: 0, aim })
      if (h.state().props?.ready && performance.now() - t0 > 200) break
    }
  })
  return {
    page,
    advance: n => page.evaluate(async n => { const h = window.__arcadeHarness; for (let i = 0; i < n; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2 }) }, n),
    freeze: async () => {},
  }
}

const setFilter = (page: Page, patch: Record<string, unknown>) => page.evaluate(p => Object.assign(window.cameraFilter.settings, p), patch)

/** Looks per game: `mode` or `mode-preset`. Body cam only where the game offers it (Night Shift, the lot). */
const LOOKS: Record<string, string[]> = {
  nightshift: ["today", "iphone", "vhs", "crt-tv", "crt-pvm", "bodycam-patrol", "bodycam-night"],
  lot: ["today", "iphone", "vhs", "crt-arcade", "bodycam-patrol"],
  outbreak: ["today", "iphone", "vhs", "crt-portable"],
}
async function setLook(page: Page, look: string) {
  const [mode, preset] = look.split("-") as [string, string | undefined]
  await page.evaluate(({ mode, preset }) => {
    window.cameraFilter.settings.mode = mode
    if (preset && !window.cameraFilter.preset(mode, preset)) throw new Error(`no preset ${mode}-${preset}`)
  }, { mode, preset })
}

async function stills(game: string, d: Driver) {
  await d.page.addStyleTag({ content: HIDE })
  const shots: Record<string, string> = {}
  for (const look of LOOKS[game]!) {
    await setLook(d.page, look)
    const mode = look.split("-")[0]!
    await d.advance(mode === "iphone" || mode === "bodycam" ? 150 : 40)
    await d.freeze(true)
    const file = `${game}-${look}.jpg`
    await d.page.screenshot({ path: resolve(out, file), type: "jpeg", quality: 92, timeout: 180_000 })
    await d.freeze(false)
    shots[look] = file
    console.log("still", file)
  }
  ;(report.stills as Record<string, unknown>)[game] = shots
}

async function timing(game: string, d: Driver) {
  const result: Record<string, unknown> = {}
  for (const look of LOOKS[game]!.filter(l => l !== "today" && !l.endsWith("-night") && l !== "crt-pvm")) {
    const mode = look.split("-")[0]!
    await setLook(d.page, look)
    await d.advance(20)
    const samples: number[] = []
    for (let i = 0; i < 40; i++) {
      const p = d.page.evaluate(() => window.cameraFilter.measure())
      await d.advance(2)
      const ms = await p
      if (ms != null) samples.push(ms)
    }
    samples.sort((a, b) => a - b)
    // Shared workers' GPU work and clock drops only ever add time: the low tail is the estimate, the median is context.
    const q = (p: number) => +samples[Math.floor((samples.length - 1) * p)]!.toFixed(3)
    result[mode] = samples.length ? { min: q(0), p10: q(0.1), p50: q(0.5), n: samples.length } : null
  }
  await setFilter(d.page, { mode: "today" })
  ;(report.timing as Record<string, unknown>)[game] = result
  console.log("timing", game, JSON.stringify(result))
}

function encode(dir: string, fps: number, file: string) {
  const run = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(fps), "-i", `${dir}/%04d.jpg`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", resolve(out, file)])
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  rmSync(dir, { recursive: true, force: true })
}

/** Night Shift on a fixed 30 fps clock: look into the dark, pan to the troffer pool, flashlight on and off. */
async function exposureClip(d: Driver) {
  const dir = resolve(out, "frames-iphone")
  mkdirSync(dir, { recursive: true })
  await setFilter(d.page, { mode: "iphone" })
  await d.page.addStyleTag({ content: HIDE })
  const yaw0 = await d.page.evaluate(() => window.nightshift.camera.yaw as number)
  const N = 210
  for (let i = 0; i < N; i++) {
    const t = i / 30
    const turn = t < 1.2 ? 1 : t < 2 ? 1 - (t - 1.2) / 0.8 : 0
    const s = turn * turn * (3 - 2 * turn)
    await d.page.evaluate(({ t, yaw }) => {
      const n = window.nightshift
      n.time = 10 + t
      n.camera.yaw = yaw
      n.camera.flashlight = t > 4 && t < 5.6
    }, { t, yaw: yaw0 + Math.PI * 0.85 * s })
    await d.advance(2)
    await d.page.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 })
  }
  encode(dir, 30, "nightshift-iphone-exposure.mp4")
  ;(report.clips as Record<string, unknown>).iphone = { file: "nightshift-iphone-exposure.mp4", seconds: N / 30, script: "0–1.2 s facing the dark side, 1.2–2 s pan to the desk and troffer, 4–5.6 s flashlight on" }
}

/** Night Shift on a fixed 60 fields/s clock with tracking turned up so a band crosses in a few seconds. */
async function trackingClip(d: Driver, game: string) {
  const dir = resolve(out, "frames-vhs")
  mkdirSync(dir, { recursive: true })
  await setFilter(d.page, { mode: "vhs", vhsTracking: 1.6 })
  await d.page.addStyleTag({ content: HIDE })
  const N = 240
  for (let i = 0; i < N; i++) {
    await d.page.evaluate(t => { if (window.nightshift) window.nightshift.time = t }, 30 + i / 60)
    await d.advance(1)
    await d.page.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 })
  }
  await setFilter(d.page, { vhsTracking: 0.6 })
  encode(dir, 60, `${game}-vhs-tracking.mp4`)
  ;(report.clips as Record<string, unknown>).vhs = { file: `${game}-vhs-tracking.mp4`, seconds: N / 60, note: "Tracking errors 1.6× (default 0.6×) so a band crosses within the clip" }
}

/** Night Shift, chest body cam on a 30 fps virtual clock: stand, walk, flick the view 70° (the torso lags and swings past), walk on, stop. */
async function swayClip(d: Driver) {
  const dir = resolve(out, "frames-bodycam")
  mkdirSync(dir, { recursive: true })
  await setLook(d.page, "bodycam-patrol")
  await d.page.addStyleTag({ content: HIDE })
  await d.advance(60)
  await d.page.evaluate(() => { window.nightshift.time = 40; window.__clock.t = performance.now(); window.__clock.on = true })
  await d.page.evaluate(() => window.__tick(1000 / 30))
  const yaw0 = await d.page.evaluate(() => window.nightshift.camera.yaw as number)
  const N = 180
  for (let i = 0; i < N; i++) {
    const t = i / 30
    const flick = Math.min(1, Math.max(0, (t - 2.6) / 0.25))
    await d.page.evaluate(({ t, yaw, walk }) => {
      const n = window.nightshift
      n.time = 40 + t
      n.camera.yaw = yaw
      const keys = n.camera.keys as Set<string>
      if (walk) keys.add("KeyW"); else keys.delete("KeyW")
    }, { t, yaw: yaw0 + 1.22 * flick * flick * (3 - 2 * flick), walk: (t > 0.7 && t < 2.6) || (t > 3.1 && t < 4.9) })
    await d.page.evaluate(() => window.__tick(1000 / 30))
    await d.page.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 })
  }
  await d.page.evaluate(() => { (window.nightshift.camera.keys as Set<string>).clear(); window.__clock.on = false; return window.__tick(0) })
  encode(dir, 30, "nightshift-bodycam-sway.mp4")
  ;(report.clips as Record<string, unknown>).bodycam = { file: "nightshift-bodycam-sway.mp4", seconds: N / 30, script: "stand 0.7 s, walk to 2.6 s, flick the view 70° in 0.25 s, walk 3.1–4.9 s, stop; 30 fps virtual clock" }
}

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  for (const game of games) {
    const { server, url } = await serve(game)
    try {
      const d = await (game === "nightshift" ? nightshift : game === "lot" ? lot : outbreak)(browser, url)
      await stills(game, d)
      if (!flag("no-timing")) await timing(game, d)
      if (!flag("no-clips") && game === "nightshift") {
        await exposureClip(d)
        await trackingClip(d, game)
        await swayClip(d)
      }
      await d.page.close()
    } finally {
      await server.close()
    }
  }
} finally {
  await browser.close()
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ errors }, null, 2))
}
if (errors.length) process.exitCode = 1
