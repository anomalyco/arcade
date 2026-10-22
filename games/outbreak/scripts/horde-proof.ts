// Horde proof in headless Chromium (WebGPU/Metal, muted): GPU and CPU frame cost with a live horde of 0 / 500 / 1,000
// on screen, stills of each Lab scene, and a short top-down night clip of a horde flowing through the streets.
//
// Usage (via the fleet, artifacts copied back from $LEASE_OUT):
//   hivemind run --kind browser --fetch -- bun scripts/horde-proof.ts [--mode=gpu,stills,clip] [--sizes=0,500,1000]
//     [--clip-size=800] [--clip-seconds=14]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { type Browser, type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const wantVideo = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1"
const modes = new Set(arg("mode", wantVideo ? "gpu,stills,clip" : "gpu,stills").split(","))
const sizes = arg("sizes", "0,500,1000").split(",").map(Number)
const clipSize = Number(arg("clip-size", "800"))
const clipSeconds = Number(arg("clip-seconds", "14"))
const out = resolve(process.env.LEASE_OUT ?? resolve(root, "captures/horde-proof"))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "horde-proof-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render, session: () => session })")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Install Chromium before the horde proof")
// One browser per page: closing a WebGPU page can take the GPU process (and the browser) down with it.
const browsers: Browser[] = []

async function open(width: number, height: number, scale: number): Promise<{ page: Page; errors: string[] }> {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=user-gesture-required"],
  })
  browsers.push(browser)
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&peaceful=1&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  return { page, errors }
}

/** Night, frozen clock, survivor at the crossroads with a wide view; then a horde scene. */
async function stage(page: Page, scene: string, size: number, zoom: number) {
  return page.evaluate(
    async ({ scene, size, zoom }) => {
      const h = (window as any).__arcadeHarness
      h.freeze(true)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("zoom", zoom)
      h.setLab("cone", 180)
      h.setLab("range", 40)
      const res = h.stageHordes(scene, size)
      h.setLab("hour", 23)
      await h.step(1 / 60)
      return res
    },
    { scene, size, zoom },
  )
}

/** Steps `frames` frames, keeping the survivor alive (the proof watches the crowd, not the fight). */
async function advance(page: Page, frames: number, command: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ frames, command }) => {
      const h = (window as any).__arcadeHarness
      for (let i = 0; i < frames; i++) {
        const p = h.session().view.player
        p.health = p.maxHealth
        await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, ...command })
      }
    },
    { frames, command },
  )
}

const report: Record<string, unknown> = { date: new Date().toISOString() }
try {
  if (modes.has("gpu")) {
    const { page, errors } = await open(1728, 947, 2)
    report.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
    const rows: unknown[] = []
    for (const size of sizes) {
      await stage(page, "crossroads", size, 46)
      // Fixed tier and the survivor's own camera, so every size renders the same view at the same resolution.
      await page.evaluate(() => {
        const h = (window as any).__arcadeHarness
        h.setLab("quality", "high")
        h.setLab("hordes.hordeWatch", false)
        h.setLab("hideUnseenZombies", true)
        h.hordeNoise()
      })
      await advance(page, 600)
      const res = await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const gpu: number[] = []
        for (let i = 0; i < 12; i++) gpu.push(await h.renderer.measure(h.render))
        const cpu: number[] = []
        for (let i = 0; i < 90; i++) {
          const p = h.session().view.player
          p.health = p.maxHealth
          const t0 = performance.now()
          await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false })
          cpu.push(performance.now() - t0)
        }
        const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
        const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
        const s = h.state()
        return {
          gpuMs: +med(gpu.slice(2)).toFixed(3),
          stepMs: { p50: +med(cpu).toFixed(2), p95: +p95(cpu).toFixed(2) },
          members: s.hordes.members,
          zombies: h.session().view.zombies.filter((z: { state: string }) => z.state !== "dead").length,
        }
      })
      rows.push({ size, ...res })
      console.log(`gpu size=${size}`, JSON.stringify(res))
      await page.screenshot({ path: resolve(out, `gpu-${size}.jpg`), type: "jpeg", quality: 85 })
    }
    report.gpu = rows
    assert.deepEqual(errors, [])
  }

  const small = modes.has("stills") || modes.has("clip") ? await open(1280, 720, 1) : null
  if (modes.has("stills") && small) {
    const { page, errors } = small
    for (const [scene, size, frames, zoom] of [
      ["split", 120, 900, 55],
      ["funnel", 80, 1200, 46],
      ["barricade", 80, 900, 46],
      ["gunshot", 200, 600, 60],
      ["street", 800, 1500, 65],
      ["crossroads", 1000, 60, 65],
    ] as const) {
      await stage(page, scene, size, zoom)
      await page.evaluate(() => (window as any).__arcadeHarness.setLab("hordes.hordeFlowOverlay", true))
      await advance(page, frames)
      await page.screenshot({ path: resolve(out, `scene-${scene}.jpg`), type: "jpeg", quality: 88 })
      const st = await page.evaluate(() => (window as any).__arcadeHarness.state().hordes)
      console.log(`still ${scene}`, JSON.stringify(st.hordes))
    }
    assert.deepEqual(errors, [])
  }

  if (modes.has("clip") && small) {
    const { page, errors } = small
    await stage(page, "street", clipSize, 65)
    await page.evaluate(() => (window as any).__arcadeHarness.setLab("hordes.hordeFlowOverlay", false))
    // Start filming as the horde reaches the buildings north of the crossroads.
    await advance(page, 840)
    const frames = resolve(out, "_frames")
    rmSync(frames, { recursive: true, force: true })
    mkdirSync(frames, { recursive: true })
    // 30 fps capture of a 60 Hz sim: two steps per frame.
    const total = Math.round(clipSeconds * 30)
    for (let f = 0; f < total; f++) {
      await advance(page, 2)
      await page.screenshot({ path: resolve(frames, `frame-${String(f).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88 })
      if (f === Math.round(total * 0.55)) await page.screenshot({ path: resolve(out, "horde-still.jpg"), type: "jpeg", quality: 92 })
    }
    const ff = Bun.spawnSync(
      ["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(frames, "frame-%04d.jpg"), "-an", "-c:v", "libx264", "-crf", "24", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(out, "horde-night.mp4")],
      { stdout: "inherit", stderr: "inherit" },
    )
    assert.equal(ff.exitCode, 0, "ffmpeg failed")
    rmSync(frames, { recursive: true, force: true })
    assert.deepEqual(errors, [])
  }
  await Bun.write(resolve(out, "horde-proof.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const b of browsers) await b.close().catch(() => {})
  await server.close()
}
