/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "../..")
const out = resolve(process.env.EXPLOSION_OUT ?? resolve(root, "captures/explosion"))
const framesDir = resolve(out, "frames")
mkdirSync(framesDir, { recursive: true })

const baseline = process.env.EXPLOSION_BASELINE ?? "origin/main"
const baselineFiles = [
  "fx/particles.ts",
  "fx/particle-renderer.ts",
  "fx/volume.ts",
  "fx/volume-renderer.ts",
  "fx/volume-shader.ts",
  "lab/effects.ts",
]
const originals = new Map(
  baselineFiles.map(p => {
    const file = `packages/kit/${p}`
    return [resolve(root, file), execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })]
  }),
)

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)

const SNAP_TIMES = [0.05, 0.15, 0.3, 0.6, 1.0, 2.0, 4.0] as const
const SNAP_FRAMES = SNAP_TIMES.map(t => Math.round(t * 60)) // [3, 9, 18, 36, 60, 120, 240]

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const errors: string[] = []
const live: { variant: "before" | "after"; page: Page; server: ViteDevServer }[] = []
const report: Record<string, unknown> = {
  baseline,
  seed: 7,
  snapTimes: SNAP_TIMES,
  snapFrames: SNAP_FRAMES,
}

try {
  for (const variant of ["before", "after"] as const) {
    const dir = resolve(root, "games/lab")
    const server = await createServer({
      root: dir,
      configFile: resolve(dir, "vite.config.ts"),
      plugins:
        variant === "before"
          ? [
              {
                name: "explosion-baseline",
                enforce: "pre",
                load(id) {
                  return originals.get(id)
                },
              },
            ]
          : [],
      server: { host: "127.0.0.1", port: 0 },
    })
    await server.listen()
    const addr = server.httpServer!.address()
    assert(addr && typeof addr !== "string")
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    live.push({ variant, page, server })
    page.on("pageerror", e => errors.push(`${variant}: ${e.message}`))
    page.on("console", m => {
      if (m.type() === "error") errors.push(`${variant}: ${m.text()}`)
    })
    await page.addInitScript(() => {
      window.AudioContext = class {
        constructor() {
          throw new Error("Live audio is disabled in this proof")
        }
      } as any
    })

    await page.goto(`http://127.0.0.1:${addr.port}/?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 60000 })

    const adapter = await page.evaluate(() => {
      const a = (window as any).lab.adapter
      return { architecture: a.architecture, vendor: a.vendor, device: a.device }
    })
    assert.match(adapter.architecture, /metal/i, "Apple Metal WebGPU required")
    report[`${variant}Adapter`] = adapter

    // Select Effects -> Explosion via the Effect select control so both baseline and new code enter "explosion"
    await page.getByRole("combobox", { name: "Effect", exact: true }).selectOption("explosion")

    if (variant === "after") {
      // Capture full 1280x800 workbench inspector screenshot at t = 0.18s (f = 11)
      await page.evaluate(async () => {
        const l = (window as any).lab
        const s = l.sections.find((x: any) => x.id === "effects")
        s.settings.seed = 7
        s.settings.targetX = -1
        s.settings.targetZ = 0
        s.settings.loop = true
        s.settings.interval = 2.2
        s.retrigger()
        l.context.stage.frameTarget(-1, 0.7, 0, 14.5)
        for (let i = 0; i < 11; i++) l.advance(1 / 60)
        await l.render()
      })
      await page.screenshot({ path: resolve(out, "inspector-controls.png") })

      // Verify behavioral assertions:
      // 1. Seeded Randomize increments tuningSeed, preserves effect seed & roomSeed, and retriggers
      const randCheck = await page.evaluate(async () => {
        const l = (window as any).lab
        const s = l.sections.find((x: any) => x.id === "effects")
        for (let i = 0; i < 40; i++) l.advance(1 / 60)
        const timeBefore = l.context.volume.time
        const seedBefore = s.settings.seed
        const roomSeedBefore = s.settings.roomSeed
        const tuningBefore = s.settings.tuningSeed
        const fbSizeBefore = s.settings.fireballSize
        const res = l.workbench.invoke("effect.randomize", { group: "Fireball" })
        const timeAfter = l.context.volume.time
        const particlesAfter = l.context.particles.count
        return {
          ok: res.ok,
          timeBefore,
          timeAfter,
          seedBefore,
          seedAfter: s.settings.seed,
          roomSeedBefore,
          roomSeedAfter: s.settings.roomSeed,
          tuningBefore,
          tuningAfter: s.settings.tuningSeed,
          fbSizeBefore,
          fbSizeAfter: s.settings.fireballSize,
          particlesAfter,
        }
      })
      assert.equal(randCheck.ok, true, "effect.randomize command succeeded")
      assert(randCheck.timeBefore > 0.5 && randCheck.timeAfter === 0, "Randomize retriggered explosion to t=0")
      assert.equal(randCheck.seedAfter, randCheck.seedBefore, "Randomize preserved effect seed")
      assert.equal(randCheck.roomSeedAfter, randCheck.roomSeedBefore, "Randomize preserved roomSeed")
      assert.equal(randCheck.tuningAfter, randCheck.tuningBefore + 1, "Randomize incremented tuningSeed")
      assert(randCheck.particlesAfter > 80, "Randomize spawned fresh explosion particles")

      // Reset Fireball back to approved defaults and verify parameter edit retriggers
      await page.getByRole("button", { name: "Reset Fireball", exact: true }).click()
      const resetCheck = await page.evaluate(() => {
        const l = (window as any).lab
        const s = l.sections.find((x: any) => x.id === "effects")
        return { fbSize: s.settings.fireballSize, time: l.context.volume.time }
      })
      assert.equal(resetCheck.fbSize, 1.25, "Reset Fireball restored default fireballSize = 1.25")
      assert.equal(resetCheck.time, 0, "Reset Fireball retriggered explosion")

      // 2. Verify Loop interval (default 2.2s = 132 frames) retriggers automatically
      const loopCheck = await page.evaluate(() => {
        const l = (window as any).lab
        const s = l.sections.find((x: any) => x.id === "effects")
        s.settings.loop = true
        s.settings.interval = 2.0
        s.retrigger()
        for (let i = 0; i < 119; i++) l.advance(1 / 60)
        const beforeLoopTime = l.context.volume.time
        l.advance(1 / 60) // reaches 120/60 = 2.0s -> resets
        const afterLoopTime = l.context.volume.time
        const particlesCount = l.context.particles.count
        s.settings.interval = 2.2
        return { beforeLoopTime, afterLoopTime, particlesCount }
      })
      assert(loopCheck.beforeLoopTime > 1.95, "Advanced to just before loop interval")
      assert.equal(loopCheck.afterLoopTime, 0, "Loop retriggered at configured 2.0s interval")
      assert(loopCheck.particlesCount > 80, "Loop retrigger spawned full particle burst")

      report.behavioralChecks = { randCheck, resetCheck, loopCheck }
    }

    // Capture full 240-frame sequence at both Game Camera and Close Camera (with loop=false, seed=7)
    for (const camKind of ["game", "close"] as const) {
      await page.evaluate(
        async ({ camKind }) => {
          const l = (window as any).lab
          const s = l.sections.find((x: any) => x.id === "effects")
          s.settings.effect = "explosion"
          s.settings.seed = 7
          s.settings.targetX = -1
          s.settings.targetZ = 0
          s.settings.loop = false
          s.settings.playing = false
          s.retrigger()
          const st = l.context.stage
          st.resetCamera()
          if (camKind === "game") {
            st.frameTarget(-1, 0.5, 0, 16)
          } else {
            st.frameTarget(-1, 0.85, 0, 7.6)
            st.orbit(0.28, -0.32, false)
          }
          await l.render()
        },
        { camKind },
      )

      const canvasEl = page.locator("canvas")
      for (let f = 1; f <= 240; f++) {
        const isSnap = SNAP_FRAMES.includes(f)
        const isVid = camKind === "close" && f <= 150 && f % 2 === 0
        await page.evaluate(async ({ needRender }) => {
          const l = (window as any).lab
          const s = l.sections.find((x: any) => x.id === "effects")
          s.settings.playing = true
          l.advance(1 / 60)
          s.settings.playing = false
          if (needRender) await l.render()
        }, { needRender: isSnap || isVid })
        if (isSnap) {
          await canvasEl.screenshot({ path: resolve(framesDir, `${variant}-${camKind}-f${String(f).padStart(3, "0")}.png`) })
        }
        if (isVid) {
          await canvasEl.screenshot({ path: resolve(framesDir, `vid-${variant}-${String(f / 2).padStart(3, "0")}.png`) })
        }
      }
    }
  }

  // Paired performance benchmark while exploding (1 warmup pair + 7 measured pairs of 60 active explosion frames)
  for (const { page } of live) {
    await page.evaluate(() => {
      const l = (window as any).lab
      const s = l.sections.find((x: any) => x.id === "effects")
      l.context.stage.resetCamera()
      l.context.stage.frameTarget(-1, 0.5, 0, 16)
      ;(window as any).benchExplosionRun = async () => {
        s.settings.seed = 7
        s.settings.loop = false
        s.settings.playing = false
        s.retrigger()
        const gpuSamples: number[] = []
        const cpuAdvanceMs: number[] = []
        const frameWallMs: number[] = []
        for (let f = 1; f <= 20; f++) {
          const t0 = performance.now()
          s.settings.playing = true
          l.advance(1 / 60)
          s.settings.playing = false
          const t1 = performance.now()
          const gpu = await l.render(true)
          await l.context.device.queue.onSubmittedWorkDone()
          const t2 = performance.now()
          cpuAdvanceMs.push(t1 - t0)
          frameWallMs.push(t2 - t0)
          if (typeof gpu === "number" && Number.isFinite(gpu)) gpuSamples.push(gpu)
        }
        const median = (arr: number[]) => {
          const sorted = [...arr].sort((a, b) => a - b)
          return sorted[Math.floor(sorted.length / 2)] ?? 0
        }
        return {
          gpuMedianMs: Number(median(gpuSamples).toFixed(4)),
          cpuMedianMs: Number(median(cpuAdvanceMs).toFixed(4)),
          wallMedianMs: Number(median(frameWallMs).toFixed(4)),
          gpuMeanMs: Number((gpuSamples.reduce((a, b) => a + b, 0) / Math.max(1, gpuSamples.length)).toFixed(4)),
        }
      }
    })
  }

  const pairs: { pair: number; before: any; after: any; deltaGpuMs: number; deltaWallMs: number }[] = []
  for (let pair = 0; pair < 8; pair++) {
    const order = pair % 2 === 0 ? live : [...live].reverse()
    const row: Record<string, any> = {}
    for (const { variant, page } of order) {
      await page.bringToFront()
      row[variant] = await page.evaluate(async () => await (window as any).benchExplosionRun())
    }
    if (pair > 0) {
      pairs.push({
        pair,
        before: row.before,
        after: row.after,
        deltaGpuMs: Number((row.after.gpuMedianMs - row.before.gpuMedianMs).toFixed(4)),
        deltaWallMs: Number((row.after.wallMedianMs - row.before.wallMedianMs).toFixed(4)),
      })
    }
  }
  const medianVal = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)] ?? 0
  }
  const madVal = (arr: number[], med: number) => medianVal(arr.map(x => Math.abs(x - med)))
  const beforeGpus = pairs.map(p => p.before.gpuMedianMs)
  const afterGpus = pairs.map(p => p.after.gpuMedianMs)
  const deltaGpus = pairs.map(p => p.deltaGpuMs)
  const medDeltaGpu = medianVal(deltaGpus)

  const perfSummary = {
    pairs,
    summary: {
      beforeGpuMedianMs: Number(medianVal(beforeGpus).toFixed(4)),
      afterGpuMedianMs: Number(medianVal(afterGpus).toFixed(4)),
      deltaGpuMedianMs: Number(medDeltaGpu.toFixed(4)),
      deltaGpuMadMs: Number(madVal(deltaGpus, medDeltaGpu).toFixed(4)),
      afterCpuMedianMs: Number(medianVal(pairs.map(p => p.after.cpuMedianMs)).toFixed(4)),
    },
  }
  report.perf = perfSummary

  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(perfSummary.summary, null, 2))
} finally {
  await browser.close()
  for (const { server } of live) await server.close()
}
