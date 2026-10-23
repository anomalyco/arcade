import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-ai-phase3")
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
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
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
  const wantVideo = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1"
  const captureFrame = async (stillName?: string) => {
    const padded = String(frameIndex++).padStart(4, "0")
    if (wantVideo) {
      const framePath = resolve(framesDir, `frame-${padded}.jpg`)
      await page.screenshot({ path: framePath, type: "jpeg", quality: 90 })
    }
    if (stillName) {
      await page.screenshot({ path: resolve(out, `${stillName}.jpg`), type: "jpeg", quality: 92 })
    }
  }

  // Beat 1: Dusk street with wandering zombies + AI debug overlay showing green WANDER cones (flashlight initially off)
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("timeScale", 0)
    h.setLab("hour", 19.1)
    h.setLab("zoom", 38)
    h.pose(29.5, 43.2, 0)
    if (h.state().flashlight.on) {
      await h.step(1 / 60, { flashlight: true })
    }
    h.setZombieState("wander")
    h.spawnZombie(35.2, 42.6, "wander", 0.25)
    h.spawnZombie(36.0, 44.1, "wander", -0.35)
    h.spawnZombie(34.4, 44.8, "wander", 0.7)
    await h.step(1 / 60)
  })

  for (let f = 0; f < 35; f++) {
    if (f === 10) {
      await page.evaluate(() => (window as any).__arcadeHarness.setLab("aiDebugOverlay", true))
    }
    await page.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      await h.step(1 / 60, { mx: 0, my: 0, aim: 0 })
      await h.step(1 / 60, { mx: 0, my: 0, aim: 0 })
    })
    await captureFrame(f === 22 ? "01-wander-debug" : undefined)
  }

  // Beat 2: Turn on flashlight (F) & fire pistol at zombie pack -> muzzle flash, blood splatter, limb detach, gunshot noise ring!
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    await h.step(1 / 60, { flashlight: true, aim: -0.08 })
  })
  for (let f = 0; f < 65; f++) {
    const shouldFire = f === 4 || f === 14 || f === 26 || f === 38
    const shouldReload = f === 48
    await page.evaluate(
      async ({ shouldFire, shouldReload, f }) => {
        const h = (window as any).__arcadeHarness
        const p = h.state().player
        const living = h
          .state()
          .zombies.filter((z: any) => z.state !== "dead" && Math.hypot(z.x - p.x, z.y - p.y) < 12)
        const target = living[0]
        const aim = target ? Math.atan2(target.y - p.y, target.x - p.x) : 0
        const mx = f > 20 && f < 45 ? -0.45 : 0
        await h.step(1 / 60, { mx, my: 0, aim, fire: shouldFire, reload: shouldReload })
        await h.step(1 / 60, { mx, my: 0, aim })
      },
      { shouldFire, shouldReload, f },
    )
    await captureFrame(
      f === 4 ? "02-pistol-muzzle-flash" : f === 28 ? "03-splatter-and-gunshot-ring" : undefined,
    )
  }

  const splatterStats = await page.evaluate(() => (window as any).__arcadeHarness.state().splatter)
  assert(splatterStats && (splatterStats.decals > 0 || splatterStats.particles > 0), "Expected blood splatter from pistol hits")

  // Beat 3: Scavenge inside Ash house for 9mm ammo & planks, then board up the south-west window and watch zombies bash the planks!
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("aiDebugOverlay", true)
    h.setLab("hour", 18.4)
    h.setLab("zoom", 32)
    // First scavenge kitchen counter inside Ash house
    h.pose(35.3, 33.5, 0)
    await h.step(1 / 60, { interact: true })
    for (let i = 0; i < 55; i++) await h.step(1 / 60)
    // Move outside the south-west window [23.5..25.5, 35.28..35.5] where planks are clearly visible to the camera
    h.pose(24.5, 36.25, -Math.PI / 2)
    await h.step(1 / 60, { barricade: true })
  })

  for (let f = 0; f < 55; f++) {
    const secondPlank = f === 24
    await page.evaluate(
      async ({ secondPlank }) => {
        const h = (window as any).__arcadeHarness
        await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2, barricade: secondPlank })
        await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2 })
      },
      { secondPlank },
    )
    if (f === 26) {
      // Spawn chasing zombies to bash the barricaded window
      await page.evaluate(() => {
        const h = (window as any).__arcadeHarness
        h.pose(24.5, 33.8, Math.PI / 2)
        const z1 = h.spawnZombie(24.2, 36.2, "chase", -Math.PI / 2)
        const z2 = h.spawnZombie(24.9, 36.3, "chase", -Math.PI / 2)
        z1.targetX = 24.5
        z1.targetY = 33.8
        z2.targetX = 24.5
        z2.targetY = 33.8
      })
    }
    await captureFrame(f === 23 ? "04-barricaded-door" : f === 50 ? "05-zombies-bashing-barricade" : undefined)
  }

  assert.deepEqual(errors, [])

  if (wantVideo) {
    const videoPath = resolve(out, "zombie-ai-complete.mp4")
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
  }
  console.log(`Complete survival stills${wantVideo ? " & video" : ""} saved to ${out}`)
} finally {
  await browser.close()
  fixture.stop(true)
}
