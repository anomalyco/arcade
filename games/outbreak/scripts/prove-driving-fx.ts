import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Driving FX proof (skid marks, tyre smoke and dust, per-wheel slip) in headless Metal Chromium, muted, no window:
 *   hivemind run --kind browser --fetch captures/driving-fx -- bun games/outbreak/scripts/prove-driving-fx.ts
 * `--before <dist>` serves another build (e.g. origin/main's `dist/arcade/outbreak`) and only captures the shared
 * drift so the stills pair up. The after run also captures both Lab station stunts, a muted drift clip, telemetry and
 * a paired GPU A/B of the marks with 4,096 segments on screen. Writes captures/driving-fx/{proof.json,*.png,*.mp4}.
 */
const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/driving-fx")
mkdirSync(out, { recursive: true })
const beforeAt = process.argv.indexOf("--before")
const before = beforeAt > 0 ? resolve(process.argv[beforeAt + 1]!) : null
const phase = before ? "before" : "after"

let url: string, close: () => Promise<void>
if (before) {
  const fixture = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const file = Bun.file(join(before, path === "/" ? "index.html" : path))
      return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  url = `http://127.0.0.1:${fixture.port}`
  close = async () => { fixture.stop() }
} else {
  const server = await createServer({ root: game, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  close = () => server.close()
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Install Chromium for Playwright")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { phase }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  await page.goto(`${url}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)
  report.adapter = adapter

  const shot = (name: string) => page.screenshot({ path: join(out, `${phase}-${name}.png`) })
  type Cmd = { mx: number; my: number; sprint?: boolean } | null
  const drive = (n: number, cmd: Cmd) => page.evaluate(async ({ n, cmd }) => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < n; i++) await (cmd ? h.step(1 / 60, cmd) : h.step(1 / 60))
    const v = h.state().vehicles.find((x: any) => x.seats[0] === "player")
    const a = h.audio?.().vehicle
    return { speed: v?.speed, x: v?.x, y: v?.y, h: v?.h, fx: h.vehicleFx?.() ?? null, screech: a?.screech, chirps: a?.chirps }
  }, { n, cmd })
  const stage = (scene: string, hour?: number) => page.evaluate(({ scene, hour }) => {
    const h = (window as any).__arcadeHarness
    h.reset(7); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.stageVehicle(scene)
    if (hour !== undefined) h.setLab("hour", hour)
  }, { scene, hour })

  // 1. The same scripted handbrake turn on both builds (night-headlights exists on main).
  await stage("night-headlights")
  report.shared = {
    accel: await drive(260, { mx: 0, my: -1 }),
    midDrift: await drive(35, { mx: 1, my: -1, sprint: true }),
  }
  await shot("drift-mid")
  ;(report.shared as Record<string, unknown>).end = await drive(90, { mx: 0, my: 0 })
  await shot("drift-end")

  if (!before) {
    // 2. Lab station stunts: handbrake drift at night (headlights end on the marks) and a burnout.
    await stage("drift-night")
    const wantVideo = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1"
    const frames = join(out, "clip-frames")
    if (wantVideo) {
      rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true })
    }
    const drift: unknown[] = []
    for (let i = 0; i < 105; i++) {
      drift.push(await drive(2, null))
      if (wantVideo) await page.screenshot({ path: join(frames, `${String(i).padStart(3, "0")}.png`) })
      if (i === 28) await shot("station-drift-mid")
    }
    await shot("station-drift-end")
    const driftFx = (drift.at(-1) as { fx: { skidsWritten: number; smoke: number } }).fx
    assert(driftFx.skidsWritten > 60, `drift laid ${driftFx.skidsWritten} mark segments`)
    report.stationDrift = {
      last: drift.at(-1), peakSmoke: Math.max(...drift.map((d: any) => d.fx.smoke)),
      // Screech level against the loudest wheel slip, every 2 frames: the audio follows the marks.
      screech: drift.map((d: any) => [Math.max(...d.fx.slip.slice(0, 4)).toFixed(2), (d.screech ?? 0).toFixed(2)].join("/")).join(" "),
      chirps: (drift.at(-1) as any).chirps,
    }
    assert(Math.max(...drift.map((d: any) => d.screech ?? 0)) > 0.5, "the drift screeches")
    if (wantVideo) {
      const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", join(frames, "%03d.png"), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", join(out, "station-drift.mp4")])
      report.clip = ff.exitCode === 0 ? "station-drift.mp4" : `ffmpeg unavailable (${ff.exitCode}); frames in clip-frames/`
    }

    await stage("burnout-night")
    const burn = await drive(120, null)
    await shot("station-burnout-mid")
    const launch = await drive(90, null)
    await shot("station-burnout-end")
    assert(burn.fx.smoke > 40, "burnout smokes")
    report.stationBurnout = { burn, launch }

    // 3. Hard stop: brake lock marks on asphalt.
    await stage("night-headlights")
    await drive(240, { mx: 0, my: -1 })
    const brake = await drive(50, { mx: 0, my: 1 })
    report.hardStop = brake
    assert(brake.fx.skidsWritten > 20, "hard stop locks and marks")

    // 4. Paired GPU A/B of the decal draw with the ring buffer full and on screen.
    report.gpu = await page.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      h.freeze(true)
      const v = h.state().vehicles.find((x: any) => x.seats[0] === "player")
      const marks = h.drivingFx().marks
      for (let i = 0; i < marks.capacity; i++) {
        const a = (i / marks.capacity) * Math.PI * 24, r = 2 + (i % 512) / 512 * 9
        const ax = v.x + Math.cos(a) * r, az = v.y + Math.sin(a) * r
        marks.segment(ax, 0.02, az, ax + Math.cos(a + 1.57) * 0.3, 0.02, az + Math.sin(a + 1.57) * 0.3, 0.8, i % 3)
      }
      await h.step(1 / 60, { mx: 0, my: 0 })
      const time = async () => {
        const xs: number[] = []
        for (let i = 0; i < 8; i++) xs.push(await h.renderer.measure(h.render))
        return xs.slice(2).sort((p, q) => p - q)[3]!
      }
      const on: number[] = [], off: number[] = []
      for (let r = 0; r < 14; r++) {
        for (const visible of r % 2 ? [false, true] : [true, false]) {
          await h.step(1 / 60, { mx: 0, my: 0 })
          h.render.skidsVisible = visible
          ;(visible ? on : off).push(await time())
        }
      }
      const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
      const deltas = on.map((x, i) => x - off[i]!)
      return { segments: marks.count, onMs: med(on), offMs: med(off), pairedDeltaMs: med(deltas), on, off }
    })
    await shot("gpu-marks-full")
  }
  assert.deepEqual(errors, [])
  report.ok = true
} finally {
  writeFileSync(join(out, `${phase}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, (k, v) => (k === "on" || k === "off" ? undefined : v), 2))
  await browser.close()
  await close()
}
