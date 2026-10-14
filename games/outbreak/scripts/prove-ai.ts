import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-ai-phase2")
const framesDir = resolve(out, "frames")
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })

const build = Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" })
assert.equal(build.exitCode, 0)

const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Install Chromium before the Metal proof")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  let frameIndex = 0
  const captureFrame = async (stillName?: string) => {
    const padded = String(frameIndex++).padStart(4, "0")
    const framePath = resolve(framesDir, `frame-${padded}.jpg`)
    await page.screenshot({ path: framePath, type: "jpeg", quality: 90 })
    if (stillName) {
      await page.screenshot({ path: resolve(out, `${stillName}.jpg`), type: "jpeg", quality: 92 })
    }
  }

  // Setup Beat 1: Dusk street with wandering zombie cluster in view (facing away/across street, calm WANDER state)
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("hour", 19.2)
    h.setLab("zoom", 42)
    h.pose(29.5, 43.2, 0)
    h.setZombieState("wander")
    h.spawnZombie(36.8, 42.2, "wander", 0.25)
    h.spawnZombie(37.6, 44.3, "wander", -0.35)
    h.spawnZombie(35.2, 45.4, "wander", 0.8)
    await h.step(1 / 60)
  })

  // 45 frames: calm wandering shamblers, turn on AI debug overlay at frame 12 (green WANDER cones), then toggle flashlight at frame 30
  for (let f = 0; f < 45; f++) {
    if (f === 12) {
      await page.evaluate(() => (window as any).__arcadeHarness.setLab("aiDebugOverlay", true))
    }
    const toggleFl = f === 30
    await page.evaluate(
      async ({ toggleFl }) => {
        const h = (window as any).__arcadeHarness
        await h.step(1 / 60, { mx: 0, my: 0, aim: -0.05, toggleFlashlight: toggleFl })
        await h.step(1 / 60, { mx: 0, my: 0, aim: -0.05 })
      },
      { toggleFl },
    )
    await captureFrame(f === 8 ? "01-wandering-dusk" : f === 22 ? "02-debug-overlay-wander" : undefined)
  }

  // Beat 2: Emit noise & sprint -> zombies transition to INVESTIGATE -> ALERT -> CHASE
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    const p = h.state().player
    h.makeNoise(p.x, p.y, 16, "sprint")
  })
  for (let f = 0; f < 65; f++) {
    await page.evaluate(
      async ({ f }) => {
        const h = (window as any).__arcadeHarness
        const sprint = f < 28
        const mx = f < 35 ? -0.7 : 0
        const my = f < 25 ? -0.7 : 0
        await h.step(1 / 60, { mx, my, sprint, aim: 0.25 })
        await h.step(1 / 60, { mx, my, sprint, aim: 0.25 })
      },
      { f },
    )
    await captureFrame(f === 8 ? "03-noise-investigate" : f === 42 ? "04-chase-pack" : undefined)
  }

  // Beat 3: Survivor retreats behind Ash front door; zombies bash the closed door open
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.pose(27.7, 33.4, Math.PI / 2)
    const z1 = h.spawnZombie(27.7, 36.2, "chase", -Math.PI / 2)
    const z2 = h.spawnZombie(28.4, 36.5, "chase", -Math.PI / 2)
    z1.targetX = 27.7
    z1.targetY = 33.4
    z2.targetX = 27.7
    z2.targetY = 33.4
  })
  for (let f = 0; f < 50; f++) {
    await page.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      await h.step(1 / 60, { mx: 0, my: 0, aim: Math.PI / 2 })
      await h.step(1 / 60, { mx: 0, my: 0, aim: Math.PI / 2 })
    })
    await captureFrame(f === 18 ? "05-door-bash" : f === 46 ? "06-door-breached" : undefined)
  }

  assert.deepEqual(errors, [])

  const videoPath = resolve(out, "zombie-ai-phase2.mp4")
  const ff = Bun.spawnSync(
    [
      "ffmpeg",
      "-y",
      "-framerate",
      "30",
      "-i",
      resolve(framesDir, "frame-%04d.jpg"),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  assert.equal(ff.exitCode, 0)
  console.log(`Phase 2 video & stills saved to ${out}`)
} finally {
  await browser.close()
  fixture.stop(true)
}
