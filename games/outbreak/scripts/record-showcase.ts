import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"

const game = resolve(import.meta.dir, "..")
const artifactDir = "/Users/kit/code/home/artifacts/2026-10-14-zombie-ai"
mkdirSync(artifactDir, { recursive: true })

// 1. Autoresearch-style 80-zombie CPU simulation benchmark (1 warmup + 7 measured runs × 180 ticks)
function runPerfBenchmark() {
  const samplesMs: number[] = []
  for (let run = 0; run < 8; run++) {
    const session = new LocalSession(7 + run, 7, 0.22, { zombieCount: 80 })
    const p = session.view.player
    Object.assign(p, { x: 44, y: 44, aim: 0 })
    const tickTimes: number[] = []
    for (let t = 0; t < 180; t++) {
      const fire = t === 30 || t === 90
      const sprint = t >= 30 && t < 120
      const aim = (t * 0.04) % (Math.PI * 2) - Math.PI
      const t0 = performance.now()
      session.update(
        TICK_DT,
        { mx: Math.cos(aim), my: Math.sin(aim), aim, sprint, interact: t === 60, fire },
        120,
      )
      tickTimes.push(performance.now() - t0)
    }
    if (run > 0) {
      const avg = tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length
      samplesMs.push(Number(avg.toFixed(4)))
    }
  }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const medianMs = sorted[Math.floor(sorted.length / 2)]!
  const spreadMad = Number(
    (
      sorted.map((v) => Math.abs(v - medianMs)).sort((a, b) => a - b)[Math.floor(sorted.length / 2)]!
    ).toFixed(4),
  )
  assert(medianMs < 1.0, `Expected 80-zombie CPU sim median < 1.0 ms/tick, got ${medianMs} ms`)
  const report = {
    date: "2026-10-14",
    agents: 80,
    ticksPerRun: 180,
    warmupRuns: 1,
    measuredRuns: 7,
    medianMsPerTick: medianMs,
    madMs: spreadMad,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    samplesMs,
  }
  Bun.write(resolve(artifactDir, "perf-benchmark.json"), JSON.stringify(report, null, 2))
  console.log(`80-zombie CPU benchmark: median ${medianMs} ms/tick (MAD ${spreadMad} ms)`)
}

runPerfBenchmark()

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

async function encodeClip(name: string, framesDir: string) {
  const outMp4 = resolve(artifactDir, `${name}.mp4`)
  const ff = Bun.spawnSync(
    [
      "ffmpeg",
      "-y",
      "-framerate",
      "30",
      "-i",
      resolve(framesDir, "frame-%04d.jpg"),
      "-c:v",
      "h264_videotoolbox",
      "-profile:v",
      "high",
      "-q:v",
      "75",
      "-pix_fmt",
      "yuv420p",
      outMp4,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  assert.equal(ff.exitCode, 0, `ffmpeg failed for ${name}`)
  rmSync(framesDir, { recursive: true, force: true })
  console.log(`Encoded ${outMp4}`)
}

async function recordScenario(
  page: Page,
  name: string,
  totalFrames: number,
  stillFrame: number,
  setup: () => Promise<void>,
  stepFrame: (f: number) => Promise<void>,
) {
  const framesDir = resolve(artifactDir, `_frames_${name}`)
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })

  await page.evaluate(() => (window as any).__arcadeHarness.reset(7))
  await setup()

  for (let f = 0; f < totalFrames; f++) {
    await stepFrame(f)
    const padded = String(f).padStart(4, "0")
    await page.screenshot({ path: resolve(framesDir, `frame-${padded}.jpg`), type: "jpeg", quality: 90 })
    if (f === stillFrame) {
      await page.screenshot({ path: resolve(artifactDir, `${name}-still.jpg`), type: "jpeg", quality: 92 })
    }
  }
  await encodeClip(name, framesDir)
}

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

  // (a) Zombies wandering in loose groups; one hears a sprint/door and investigates, others follow; debug overlay shown
  await recordScenario(
    page,
    "a-wander-and-investigate",
    150,
    85,
    async () => {
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", 18.6)
        h.setLab("zoom", 38)
        h.setLab("aiDebugOverlay", false)
        h.pose(27.7, 37.2, -Math.PI / 2)
        if (h.state().flashlight.on) await h.step(1 / 60, { flashlight: true })
        h.setZombieState("wander")
        // Spawn a loose street group near the intersection
        h.spawnZombie(33.2, 41.8, "wander", 0.3)
        h.spawnZombie(35.4, 43.1, "wander", -0.2)
        h.spawnZombie(32.5, 44.4, "wander", 0.6)
        h.spawnZombie(37.2, 42.0, "wander", -0.5)
        await h.step(1 / 60)
      })
    },
    async (f) => {
      await page.evaluate(
        async ({ f }) => {
          const h = (window as any).__arcadeHarness
          if (f === 35) h.setLab("aiDebugOverlay", true)
          // At frame 45, survivor sprints east briefly and toggles Ash front door, emitting sprint + door noise
          const interact = f === 45
          const sprint = f >= 46 && f < 68
          const mx = f >= 46 && f < 68 ? -1 : 0
          const my = f >= 68 && f < 95 ? -1 : 0
          await h.step(1 / 60, { mx, my, sprint, interact, aim: -Math.PI / 2 })
          await h.step(1 / 60, { mx, my, sprint, interact: false, aim: -Math.PI / 2 })
        },
        { f },
      )
    },
  )

  // (b) Flashlight sweep at night making a zombie notice you
  await recordScenario(
    page,
    "b-flashlight-sweep",
    135,
    72,
    async () => {
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", 22.5)
        h.setLab("zoom", 34)
        h.setLab("aiDebugOverlay", false)
        h.pose(32.0, 43.5, -Math.PI * 0.75)
        if (h.state().flashlight.on) await h.step(1 / 60, { flashlight: true })
        h.setZombieState("wander")
        h.spawnZombie(39.2, 42.6, "wander", Math.PI * 0.85)
        h.spawnZombie(40.8, 44.5, "wander", -Math.PI * 0.75)
        await h.step(1 / 60)
      })
    },
    async (f) => {
      await page.evaluate(
        async ({ f }) => {
          const h = (window as any).__arcadeHarness
          // Turn flashlight ON at frame 25 and sweep beam from west (-2.3 rad) across east (0 rad) onto the zombies
          const toggleFl = f === 25
          const sweepU = Math.max(0, Math.min(1, (f - 25) / 42))
          const aim = f < 25 ? -2.2 : -2.2 + sweepU * 2.15
          const mx = f > 80 ? -0.85 : 0
          await h.step(1 / 60, { mx, my: 0, aim, flashlight: toggleFl })
          await h.step(1 / 60, { mx, my: 0, aim })
        },
        { f },
      )
    },
  )

  // (c) Chase through a house with door bashing and open-window climbing (AI debug overlay shown in second half)
  await recordScenario(
    page,
    "c-house-chase-door-window",
    150,
    92,
    async () => {
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", 18.8)
        h.setLab("zoom", 35)
        h.setLab("aiDebugOverlay", false)
        // Open the south-west window so one zombie can climb through it while others bash the closed front door!
        const swWin = h.state().town.windows.find((w: any) => w.id === "ash-south-west")
        if (swWin) swWin.open = true
        h.pose(27.7, 33.5, Math.PI / 2)
        const zDoor1 = h.spawnZombie(27.5, 36.4, "chase", -Math.PI / 2)
        const zDoor2 = h.spawnZombie(28.3, 36.8, "chase", -Math.PI / 2)
        const zWin = h.spawnZombie(24.5, 36.3, "chase", -Math.PI / 2)
        for (const z of [zDoor1, zDoor2, zWin]) {
          z.targetX = 27.7
          z.targetY = 33.5
        }
        await h.step(1 / 60)
      })
    },
    async (f) => {
      await page.evaluate(
        async ({ f }) => {
          const h = (window as any).__arcadeHarness
          if (f === 40) h.setLab("aiDebugOverlay", true)
          if (f === 105) h.setLab("aiDebugOverlay", false)
          // Survivor backs deeper into the house and opens internal room door at f === 90
          const mx = f > 55 && f < 85 ? 0.2 : 0
          const my = f > 55 && f < 85 ? -0.7 : 0
          const interact = f === 90
          await h.step(1 / 60, { mx, my, interact, aim: Math.PI / 2 })
          await h.step(1 / 60, { mx, my, interact: false, aim: Math.PI / 2 })
        },
        { f },
      )
    },
  )

  // (d) Pistol: fire, gunshot noise pulls a crowd, reload (R), and loot ammo from a house cabinet (E)
  await recordScenario(
    page,
    "d-pistol-combat-and-loot",
    165,
    18,
    async () => {
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", 19.0)
        h.setLab("zoom", 34)
        h.setLab("aiDebugOverlay", false)
        const frontDoor = h.state().town.doors.find((d: any) => d.id === "ash-front")
        if (frontDoor) frontDoor.open = true
        h.pose(27.7, 41.2, 0)
        h.stock(4, { ammo: 4 })
        h.setZombieState("wander")
        h.spawnZombie(32.5, 41.2, "chase", Math.PI)
        h.spawnZombie(33.8, 42.1, "chase", Math.PI)
        h.spawnZombie(35.2, 40.4, "wander", Math.PI)
        await h.step(1 / 60)
      })
    },
    async (f) => {
      await page.evaluate(
        async ({ f }) => {
          const h = (window as any).__arcadeHarness
          const p = h.state().player
          const fire = f === 8 || f === 18 || f === 30 || f === 42
          const reload = f === 50
          if (f === 88) {
            h.pose(35.1, 33.5, 0)
          }
          const interact = f === 94
          const living = h
            .state()
            .zombies.filter((z: any) => z.state !== "dead" && z.x > p.x && Math.hypot(z.x - p.x, z.y - p.y) < 12)
          const target = living[0]
          const aim = f < 88 ? (target ? Math.atan2(target.y - p.y, target.x - p.x) : 0) : 0
          const mx = f >= 10 && f < 50 ? -0.35 : 0
          const my = f >= 50 && f < 86 ? -0.85 : 0
          await h.step(1 / 60, { mx, my, aim, fire, reload, interact })
          await h.step(1 / 60, { mx, my, aim })
        },
        { f },
      )
    },
  )

  // (e) Barricade a window with planks and watch zombies bash it
  await recordScenario(
    page,
    "e-window-barricade-siege",
    145,
    90,
    async () => {
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", 18.5)
        h.setLab("zoom", 30)
        h.setLab("aiDebugOverlay", false)
        h.pose(24.5, 36.15, -Math.PI / 2)
        h.stock(undefined, { plank: 3 })
        h.setZombieState("wander")
        await h.step(1 / 60, { barricade: true })
      })
    },
    async (f) => {
      await page.evaluate(
        async ({ f }) => {
          const h = (window as any).__arcadeHarness
          const secondPlank = f === 25
          if (f === 52) {
            // Move survivor inside the room and spawn chasing zombies outside to bash the planked window
            h.pose(24.5, 33.8, Math.PI / 2)
            const z1 = h.spawnZombie(24.1, 36.25, "chase", -Math.PI / 2)
            const z2 = h.spawnZombie(24.9, 36.3, "chase", -Math.PI / 2)
            z1.targetX = 24.5
            z1.targetY = 33.8
            z2.targetX = 24.5
            z2.targetY = 33.8
          }
          await h.step(1 / 60, { mx: 0, my: 0, aim: f < 52 ? -Math.PI / 2 : Math.PI / 2, barricade: secondPlank })
          await h.step(1 / 60, { mx: 0, my: 0, aim: f < 52 ? -Math.PI / 2 : Math.PI / 2 })
        },
        { f },
      )
    },
  )

  assert.deepEqual(errors, [])
  console.log(`All 5 showcase videos and stills recorded to ${artifactDir}`)
} finally {
  await browser.close()
  fixture.stop(true)
}
