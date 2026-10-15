import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const outDir = process.env.UNSEEN_OUT
  ? resolve(process.env.UNSEEN_OUT)
  : resolve(root, "../../captures/outbreak-unseen")
mkdirSync(outDir, { recursive: true })

const MODES = [
  { id: 0, slug: "mode-0-off", label: "Off (today)" },
  { id: 1, slug: "mode-1-acid-knife", label: "Acid Knife glitch" },
  { id: 2, slug: "mode-2-warp-wobble", label: "Warp wobble" },
  { id: 3, slug: "mode-3-dark-shroud", label: "Dark shroud" },
  { id: 4, slug: "mode-4-stale-memory", label: "Stale memory" },
  { id: 5, slug: "mode-5-noise-film", label: "Noise film" },
  { id: 6, slug: "mode-6-shroud-noise", label: "Combo: Shroud + Noise" },
  { id: 7, slug: "mode-7-memory-warp", label: "Combo: Memory + Warp" },
  { id: 8, slug: "mode-8-edge-glitch-shroud", label: "Combo: Edge glitch + Shroud" },
] as const

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Chromium executable not found in ~/Library/Caches/ms-playwright")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

try {
  // 1. Full-Retina (3456×1894) GPU & CPU benchmark
  const benchPage = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
  await benchPage.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, {
        ...desc,
        requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [],
      })
    }
  })
  const errors: string[] = []
  benchPage.on("pageerror", (e) => errors.push(e.message))
  benchPage.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await benchPage.goto(`http://127.0.0.1:${port}/?seed=7&bench`, { waitUntil: "networkidle" })
  await benchPage.waitForFunction(() => (window as any).__arcadeHarness?.ready)

  const benchResult = await benchPage.evaluate(async (modes) => {
    const h = (window as any).__arcadeHarness
    const setupInterior = async (mode: number) => {
      h.freeze(true)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", 22)
      h.setLab("zoom", 35)
      h.setLab("unseenMode", mode)
      h.setLab("unseenStrength", 1.0)
      h.setLab("unseenNightScale", 0.75)
      h.setLab("unseenEdgeSoftness", 0.85)
      h.setLab("unseenUpdateRate", 10)
      h.setLab("hideUnseenZombies", true)
      const st = h.state()
      for (const d of st.town.doors) {
        if (d.id.startsWith("0-")) d.open = true
      }
      // Pre-explore the house interior
      for (const [vx, vy, va] of [
        [25.2, 32.5, -1.57],
        [33.5, 32.5, 0],
        [27.7, 26.8, -1.57],
      ] as const) {
        h.pose(vx, vy, va)
        await h.step(1 / 60)
      }
      h.pose(27.7, 31.4, -0.45)
      for (let i = 0; i < 4; i++) await h.step(1 / 60)
    }

    const measureGpu = async () => {
      const samples: number[] = []
      for (let i = 0; i < 8; i++) {
        samples.push(await h.renderer.measure(h.render))
      }
      const sorted = samples.slice(2).sort((a, b) => a - b)
      return (sorted[2]! + sorted[3]!) * 0.5
    }

    await setupInterior(1)
    const cpuMaskMs = h.measureCpuMask(250)

    const gpuByMode: Record<
      number,
      { label: string; baselineMs: number; modeMs: number; deltaMs: number; madMs: number }
    > = {}
    const rounds = 8
    for (const m of modes) {
      if (m.id === 0) {
        await setupInterior(0)
        const baseMs = await measureGpu()
        gpuByMode[0] = { label: m.label, baselineMs: baseMs, modeMs: baseMs, deltaMs: 0, madMs: 0 }
        continue
      }
      const aList: number[] = []
      const bList: number[] = []
      await setupInterior(0)
      for (let r = 0; r < rounds; r++) {
        const runVariant = async (modeId: number) => {
          h.setLab("unseenMode", modeId)
          await h.step(1 / 60)
          return await measureGpu()
        }
        if (r % 2 === 0) {
          aList.push(await runVariant(0))
          bList.push(await runVariant(m.id))
        } else {
          bList.push(await runVariant(m.id))
          aList.push(await runVariant(0))
        }
      }
      const med = (xs: number[]) => {
        const s = [...xs].sort((p, q) => p - q)
        return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) * 0.5
      }
      const diffs = aList.map((a, i) => bList[i]! - a)
      const deltaMed = med(diffs)
      const mad = med(diffs.map((d) => Math.abs(d - deltaMed)))
      gpuByMode[m.id] = {
        label: m.label,
        baselineMs: Number(med(aList).toFixed(3)),
        modeMs: Number(med(bList).toFixed(3)),
        deltaMs: Number(deltaMed.toFixed(3)),
        madMs: Number(mad.toFixed(3)),
      }
    }
    return { cpuMaskMs, gpuByMode }
  }, MODES)

  console.log(`CPU visibility mask + unseen eval: ${benchResult.cpuMaskMs.toFixed(3)} ms (target < 0.500 ms)`)
  assert(
    benchResult.cpuMaskMs < 0.5,
    `Expected CPU mask cost < 0.5 ms, measured ${benchResult.cpuMaskMs.toFixed(3)} ms`,
  )
  for (const m of MODES) {
    const g = benchResult.gpuByMode[m.id]!
    console.log(
      `GPU 3456×1894 Mode ${m.id} (${m.label}): total=${g.modeMs.toFixed(3)} ms, baseline=${g.baselineMs.toFixed(3)} ms, Δ=${g.deltaMs.toFixed(3)} ms (±${g.madMs.toFixed(3)} ms)`,
    )
    assert(
      g.deltaMs < 1.0,
      `Expected GPU pass delta < 1.0 ms at 3456×1894 for ${m.label}, measured ${g.deltaMs.toFixed(3)} ms`,
    )
  }
  await benchPage.close()

  // 2. Capture stills and 30fps muted MP4 clips (1280×720) per mode
  const capPage = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  capPage.on("pageerror", (e) => errors.push(e.message))
  capPage.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await capPage.goto(`http://127.0.0.1:${port}/?seed=7&bench`, { waitUntil: "networkidle" })
  await capPage.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await capPage.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body > *:not(#game)")) el.style.visibility = "hidden"
  })

  const stageHouseScene = async (opts: {
    mode: number
    hour?: number
    hideZombies?: boolean
    aim?: number
    px?: number
    py?: number
  }) => {
    await capPage.evaluate(async (o) => {
      const h = (window as any).__arcadeHarness
      h.freeze(true)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", o.hour ?? 22)
      h.setLab("zoom", 34)
      h.setLab("unseenMode", o.mode)
      h.setLab("unseenStrength", 1.0)
      h.setLab("unseenNightScale", 0.75)
      h.setLab("unseenEdgeSoftness", 0.85)
      h.setLab("unseenUpdateRate", 10)
      h.setLab("hideUnseenZombies", o.hideZombies ?? true)

      const st = h.state()
      if ((o.hour ?? 22) < 17) {
        st.player.flashlightOn = false
        st.player.flashlightOutput = 0
      } else {
        st.player.flashlightOn = true
        st.player.flashlightOutput = 1
      }
      for (const d of st.town.doors) {
        if (d.id.startsWith("0-")) d.open = true
      }
      // Clear random ambient zombies near house 0 so choreography is 100% deterministic
      for (const z of st.zombies) {
        if (Math.hypot(z.x - 29, z.y - 30) < 25) {
          z.x = 6
          z.y = 6
          z.state = "wander"
        }
      }
      // Pre-explore living room, bedroom, and kitchen so memory textures are populated
      for (const [vx, vy, va] of [
        [24.8, 32.5, -1.57],
        [33.8, 32.2, 0],
        [27.7, 26.8, -1.57],
      ] as const) {
        h.pose(vx, vy, va)
        await h.step(1 / 60)
      }
      // Spawn a zombie in the north bedroom (glimpsed so Mode 4 can ghost it) and an approaching zombie in the east kitchen
      const zBed = h.spawnZombie(26.6, 26.8, "wander", 1.57)
      // Glimpse the bedroom zombie briefly so last-known memory records its pose
      h.pose(27.7, 29.8, -1.75)
      for (let i = 0; i < 4; i++) await h.step(1 / 60)
      void zBed

      const zKitchen = h.spawnZombie(31.2, 31.8, "chase", Math.PI)
      zKitchen.targetX = 27.7
      zKitchen.targetY = 31.8

      h.pose(o.px ?? 27.7, o.py ?? 33.4, o.aim ?? -2.25)
      for (let i = 0; i < 6; i++) await h.step(1 / 60)
    }, opts)
  }

  const stills: string[] = []
  const clips: string[] = []

  const gameCanvas = capPage.locator("#game")

  // Extra comparison stills: daylight subtle scaling + hideUnseenZombies=false
  await stageHouseScene({ mode: 1, hour: 14, px: 27.7, py: 31.6, aim: -0.45 })
  const dayStill = resolve(outDir, "mode-1-daylight.png")
  await gameCanvas.screenshot({ path: dayStill })
  stills.push(dayStill)

  await stageHouseScene({ mode: 1, hour: 22, hideZombies: false, px: 27.7, py: 31.6, aim: -2.25 })
  const showZombiesStill = resolve(outDir, "mode-1-zombies-shown.png")
  await gameCanvas.screenshot({ path: showZombiesStill })
  stills.push(showZombiesStill)

  const benchOnly = process.argv.includes("--bench-only")
  // Per-mode stills & 96-frame (3.2s @ 30fps) muted top-down clips
  const totalFrames = 96
  for (const m of MODES) {
    if (benchOnly && m.id <= 5) continue
    await stageHouseScene({ mode: m.id, hour: 22, hideZombies: true, px: 27.7, py: 33.6, aim: -2.25 })
    const frameDir = resolve(outDir, `frames-${m.slug}`)
    rmSync(frameDir, { recursive: true, force: true })
    mkdirSync(frameDir, { recursive: true })

    for (let f = 0; f < totalFrames; f++) {
      await capPage.evaluate(async (frameIdx) => {
        const h = (window as any).__arcadeHarness
        // Choreography:
        // f = 0..32: walk North into the house hallway while sweeping flashlight/cone from West (-2.25) toward North (-1.55)
        // f = 33..68: turn cone & flashlight from North (-1.55) toward East-Southeast (-0.12) as the unseen kitchen zombie approaches
        // f = 69..95: step back West-South slightly while holding the beam on the approaching zombie entering sight
        let mx = 0
        let my = 0
        let aim = -2.25
        if (frameIdx <= 32) {
          const u = frameIdx / 32
          my = -0.85
          aim = -2.25 + u * 0.70
        } else if (frameIdx <= 68) {
          const u = (frameIdx - 32) / 36
          const s = u * u * (3 - 2 * u)
          mx = -0.15
          my = -0.15
          aim = -1.55 + s * 1.65
        } else {
          const u = (frameIdx - 68) / 27
          mx = -0.45
          my = 0.25
          aim = 0.10 + Math.sin(u * Math.PI) * 0.08
        }
        await h.step(1 / 30, { mx, my, aim })
      }, f)

      const framePath = resolve(frameDir, `frame_${String(f).padStart(4, "0")}.jpg`)
      await gameCanvas.screenshot({ path: framePath, type: "jpeg", quality: 95 })
      if (f === 69) {
        const stillPath = resolve(outDir, `${m.slug}.png`)
        await gameCanvas.screenshot({ path: stillPath })
        stills.push(stillPath)
      }
    }

    const mp4Path = resolve(outDir, `${m.slug}.mp4`)
    const ff = Bun.spawnSync(
      [
        "ffmpeg",
        "-y",
        "-framerate",
        "30",
        "-i",
        resolve(frameDir, "frame_%04d.jpg"),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4Path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    assert.equal(ff.exitCode, 0, `ffmpeg failed for ${m.slug}: ${ff.stderr.toString()}`)
    rmSync(frameDir, { recursive: true, force: true })
    clips.push(mp4Path)
    console.log(`Captured ${m.slug}.png & ${m.slug}.mp4`)
  }

  assert.deepEqual(errors, [])
  const summaryPath = resolve(outDir, "proof-summary.json")
  await Bun.write(
    summaryPath,
    JSON.stringify(
      {
        resolution: "3456x1894",
        cpuMaskMs: benchResult.cpuMaskMs,
        gpuByMode: benchResult.gpuByMode,
        stills,
        clips,
      },
      null,
      2,
    ),
  )
  console.log(`Unseen proof & benchmark complete: ${summaryPath}`)
} finally {
  await browser.close()
  await server.close()
}
