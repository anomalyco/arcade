/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.EXPLOSION_UNIFY_OUT ?? "/Users/kit/code/home/artifacts/2026-10-14-explosion-unify")
const framesRoot = join(out, "video-frames")
mkdirSync(framesRoot, { recursive: true })

// Before = what review R-1 showed (release-6 head before explosion-r1); 457167a is the pre-unification commit.
const baseline = process.env.EXPLOSION_BASELINE ?? "a035957"
const steps = new Set((process.env.EXPLOSION_STEPS ?? "lab,getaway,blackout,carrier").split(","))
const baselineFiles = [
  "packages/kit/fx/explosion.ts",
  "packages/kit/fx/particles.ts",
  "packages/kit/fx/particle-renderer.ts",
  "packages/kit/fx/index.ts",
  "packages/kit/fx/fire-water.ts",
  "packages/kit/fx/volume.ts",
  "packages/kit/fx/volume-shader.ts",
  "packages/kit/gpu/renderer.ts",
  "packages/kit/lab/effects.ts",
  "packages/kit/lab/workbench.ts",
  "games/getaway/src/render/renderer.ts",
  "games/getaway/src/render/shaders.ts",
  "games/getaway/src/game/scene.ts",
  "games/getaway/src/game/props/index.ts",
  "games/getaway/src/game/props/particles.ts",
  "games/getaway/src/lab/effects.ts",
  "games/getaway/src/lab/spawn.ts",
  "games/blackout/src/game/game.ts",
  "games/blackout/src/game/vehicles.ts",
  "games/blackout/src/lab/effects.ts",
  "games/blackout/src/lab/fire-water.ts",
  "games/carrier/src/render/renderer.ts",
  "games/carrier/src/render/weapon-fx.ts",
  "games/carrier/src/render/explosion-fx.ts",
  "games/carrier/src/render/explosions.ts",
  "games/carrier/src/weapons/ship-fx.ts",
  "games/carrier/src/weapons/weapons.ts",
  "games/carrier/src/gunnery/gunnery.ts",
  "games/carrier/src/render/boat-fx.ts",
]

const originals = new Map<string, string>()
for (const rel of baselineFiles) {
  try {
    originals.set(resolve(root, rel), execFileSync("git", ["show", `${baseline}:${rel}`], { cwd: root, encoding: "utf8" }))
  } catch {
    // New file
  }
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--disable-dawn-features=timestamp_quantization"],
})

let nextPort = 0
async function startGameServer(game: "getaway" | "blackout" | "carrier" | "lab", variant: "before" | "after") {
  const dir = resolve(root, "games", game)
  const server = await createServer({
    root: dir,
    configFile: resolve(dir, "vite.config.ts"),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      ...(variant === "before"
        ? [
            {
              name: "explosion-unify-baseline",
              enforce: "pre" as const,
              load(id: string) {
                const clean = id.split("?")[0]!
                if (!clean.includes("/packages/kit/") && !clean.includes(`/games/${game}/`)) return null
                return originals.get(clean) ?? null
              },
            },
          ]
        : []),
      {
        name: "expose-scene",
        transform(code: string, id: string) {
          if (id.endsWith("games/getaway/src/main.ts")) {
            return code.replace(
              "const scene = new Scene(renderer, session.city)",
              "const scene = (window.__scene = new Scene(renderer, session.city))",
            )
          }
          return null
        },
      },
    ],
    server: { host: "127.0.0.1", port: 18500 + nextPort++, strictPort: false, hmr: false },
  })
  await server.listen()
  const addr = server.httpServer!.address()
  assert(addr && typeof addr !== "string")
  return { url: `http://127.0.0.1:${addr.port}`, server }
}

const median = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const maxVal = (arr: number[]) => (arr.length ? Math.max(...arr) : 0)
const mad = (arr: number[], med: number) => median(arr.map(x => Math.abs(x - med)))

const errors: string[] = []
const report: Record<string, unknown> = { baseline, budgetMs: 16.67 }

try {
  // 1. Lab unification & LOD verification
  console.log("Step 1: Lab unification & LOD verification...")
  if (steps.has("lab")) {
    const { url, server } = await startGameServer("lab", "after")
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => errors.push(`lab: ${e.message}`))
    await page.goto(`${url}/?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 60000 })

    const labChecks = await page.evaluate(async () => {
      const l = (window as any).lab
      await l.select("effects")
      const effSec = l.sections.find((s: any) => s.id === "effects")
      effSec.settings.effect = "explosion"
      const presetCtrl = effSec.controls.find((c: any) => c.key === "explosionPreset")
      const presetCounts: Record<string, { particles: number; volumes: number; scorch: boolean }> = {}
      for (const opt of presetCtrl.options) {
        presetCtrl.change(opt.value)
        presetCounts[opt.value] = {
          particles: l.context.particles.count,
          volumes: l.context.volume.count,
          scorch: Boolean(effSec.settings.scorch),
        }
      }

      await l.select("getaway-effects")
      const gwSec = l.sections.find((s: any) => s.id === "getaway-effects")
      gwSec.settings.effect = "explosion"
      gwSec.retrigger()
      for (let i = 0; i < 6; i++) l.advance(1 / 60)
      const getawaySharedParticles = l.context.particles.count
      const getawaySharedVolumes = l.context.volume.count

      await l.select("blackout-effects")
      const boSec = l.sections.find((s: any) => s.id === "blackout-effects")
      boSec.settings.effect = "explosion"
      boSec.retrigger()
      for (let i = 0; i < 6; i++) l.advance(1 / 60)
      const blackoutSharedParticles = l.context.particles.count
      const blackoutSharedVolumes = l.context.volume.count

      const catalogItems = Array.from(document.querySelectorAll("[data-catalog-id]")).map(el =>
        el.getAttribute("data-catalog-id"),
      )
      return {
        presetCounts,
        getawaySharedParticles,
        getawaySharedVolumes,
        blackoutSharedParticles,
        blackoutSharedVolumes,
        catalogItems,
      }
    })

    for (const id of ["grenade", "propane", "car", "barrel", "missile", "ship", "pop"]) {
      assert(labChecks.presetCounts[id]!.particles > 40, `Preset ${id} spawned particles`)
    }
    assert.equal(labChecks.presetCounts.missile!.scorch, false)
    assert.equal(labChecks.presetCounts.missile!.volumes, 0)
    assert(labChecks.getawaySharedParticles > 60 && labChecks.getawaySharedVolumes === 1)
    assert(labChecks.blackoutSharedParticles > 60 && labChecks.blackoutSharedVolumes === 1)
    assert(!labChecks.catalogItems.includes("blackout-effects:explosion"))
    assert(!labChecks.catalogItems.includes("getaway-effects:explosion"))
    assert(!labChecks.catalogItems.includes("fire-water:explosion"))
    report.labUnification = labChecks
    await page.close()
    await server.close()
  }

  // 2. Getaway: Single-blast + Worst-case (4 simultaneous propane/fuel blasts) perf + 300-frame (10s @ 30fps) Before/After video capture
  console.log("Step 2: Getaway perf (single + 4x worst-case) & video capture...")
  if (steps.has("getaway")) {
    const bSrv = await startGameServer("getaway", "before")
    const aSrv = await startGameServer("getaway", "after")
    const pages = {
      before: await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 }),
      after: await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 }),
    }
    for (const [variant, page] of Object.entries(pages) as ["before" | "after", Page][]) {
      page.on("pageerror", e => errors.push(`getaway-${variant}: ${e.message}`))
      await page.goto(`${variant === "before" ? bSrv.url : aSrv.url}/?peaceful=1&seed=7&bench=1&nohud=1&smoketiming=1`)
      await page.waitForFunction(() => !!(window as any).__getawayBench && !!(window as any).__scene, undefined, { timeout: 60000 })
      await page.evaluate(async () => {
        await (window as any).__getawayBench.ready
      })
    }

    // Helper for running Getaway perf scenario ('single' = 1 propane blast, 'worst' = 4 simultaneous propane/fuel blasts)
    const runGetawayBench = async (mode: "single" | "worst") => {
      const pairs: any[] = []
      for (let pair = 0; pair < 8; pair++) {
        const order: ("before" | "after")[] = pair % 2 === 0 ? ["before", "after"] : ["after", "before"]
        const row: Record<string, any> = {}
        for (const v of order) {
          const page = pages[v]
          await page.bringToFront()
          row[v] = await page.evaluate(
            async ({ variant, mode }) => {
              const b = (window as any).__getawayBench
              const scene = (window as any).__scene
              b.reset(true)
              // Warm 5 steady-state frames so the Apple GPU is at its active 60Hz clock before detonation
              for (let w = 0; w < 5; w++) {
                await b.step(0, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
              }
              const s0 = await b.step(0, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
              const fx = Math.sin(s0.pose.h)
              const fz = Math.cos(s0.pose.h)
              const px = s0.pose.x + fx * 4.2
              const pz = s0.pose.z + fz * 4.2
              const triggerOne = (kind: string, ox: number, oz: number) => {
                if (variant === "before") {
                  const prop = scene.clutter.props.find((p: any) => p.home.kind === kind && !p.broken && p.fuse < 0)
                  if (prop) {
                    prop.body.x = px + ox
                    prop.body.z = pz + oz
                    prop.body.y = scene.clutter.ground(px + ox, pz + oz) + prop.body.hy
                    scene.clutter.hit(prop, fx * 18, fz * 18, 18, 1400, true)
                  }
                } else {
                  scene.clutter.trigger(kind, px + ox, pz + oz)
                }
              }
              triggerOne("propane", 0, 0)
              if (mode === "worst") {
                triggerOne("fuel", -2.2, 1.2)
                triggerOne("propane", 2.2, 1.0)
                triggerOne("fuel", 0.4, 3.2)
              }
              const gpus: number[] = []
              const cpus: number[] = []
              for (let i = 1; i <= 30; i++) {
                const res = await b.step(i, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
                if (typeof res.totalGpuMs === "number" && Number.isFinite(res.totalGpuMs)) gpus.push(res.totalGpuMs)
                cpus.push(res.cpuMs)
              }
              const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
              const max = (a: number[]) => (a.length ? Math.max(...a) : 0)
              const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
              return {
                gpuMedianMs: Number(med(gpus).toFixed(4)),
                gpuMeanMs: Number(mean(gpus).toFixed(4)),
                gpuPeakMs: Number(max(gpus).toFixed(4)),
                cpuMeanMs: Number(mean(cpus).toFixed(4)),
                cpuPeakMs: Number(max(cpus).toFixed(4)),
              }
            },
            { variant: v, mode },
          )
        }
        if (pair > 0) {
          pairs.push({
            pair,
            before: row.before,
            after: row.after,
            deltaGpuMeanMs: Number((row.after.gpuMeanMs - row.before.gpuMeanMs).toFixed(4)),
            deltaGpuPeakMs: Number((row.after.gpuPeakMs - row.before.gpuPeakMs).toFixed(4)),
          })
        }
      }
      const meanDeltas = pairs.map(p => p.deltaGpuMeanMs)
      const medDelta = median(meanDeltas)
      return {
        beforeGpuMeanMs: Number(median(pairs.map(p => p.before.gpuMeanMs)).toFixed(4)),
        afterGpuMeanMs: Number(median(pairs.map(p => p.after.gpuMeanMs)).toFixed(4)),
        beforeGpuPeakMs: Number(median(pairs.map(p => p.before.gpuPeakMs)).toFixed(4)),
        afterGpuPeakMs: Number(median(pairs.map(p => p.after.gpuPeakMs)).toFixed(4)),
        deltaGpuMeanMs: Number(medDelta.toFixed(4)),
        deltaGpuMadMs: Number(mad(meanDeltas, medDelta).toFixed(4)),
        beforeCpuMeanMs: Number(median(pairs.map(p => p.before.cpuMeanMs)).toFixed(4)),
        afterCpuMeanMs: Number(median(pairs.map(p => p.after.cpuMeanMs)).toFixed(4)),
        beforeCpuPeakMs: Number(median(pairs.map(p => p.before.cpuPeakMs)).toFixed(4)),
        afterCpuPeakMs: Number(median(pairs.map(p => p.after.cpuPeakMs)).toFixed(4)),
        within60HzBudget: median(pairs.map(p => p.after.gpuPeakMs)) < 16.67,
        pairs,
      }
    }

    if (process.env.SKIP_PERF !== "1") report.getawayPerf = {
      singleBlast: await runGetawayBench("single"),
      worstCase4x: await runGetawayBench("worst"),
    }

    // Record 240 video frames (8.0s @ 30fps = 480 sim steps @ 60Hz):
    // Beat 1 (frames 1..120, 0..4s): Propane tank detonation
    // Beat 2 (frames 121..240, 4..8s): Car / fuel detonation
    const gwDir = join(framesRoot, "getaway")
    mkdirSync(gwDir, { recursive: true })
    if (process.env.SKIP_VIDEO_FRAMES !== "1") for (const [variant, page] of Object.entries(pages) as ["before" | "after", Page][]) {
      await page.evaluate(async variant => {
        const b = (window as any).__getawayBench
        const scene = (window as any).__scene
        b.reset(true)
        const s0 = await b.step(0, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
        ;(window as any).__gwPose = s0.pose
        const fx = Math.sin(s0.pose.h)
        const fz = Math.cos(s0.pose.h)
        const px = s0.pose.x + fx * 4.2
        const pz = s0.pose.z + fz * 4.2
        if (variant === "before") {
          const prop = scene.clutter.props.find((p: any) => p.home.kind === "propane" && !p.broken)
          if (prop) {
            prop.body.x = px
            prop.body.z = pz
            prop.body.y = scene.clutter.ground(px, pz) + prop.body.hy
            scene.clutter.hit(prop, fx * 18, fz * 18, 18, 1400, true)
          }
        } else {
          scene.clutter.trigger("propane", px, pz)
        }
      }, variant)
      const canvas = page.locator("#view")
      for (let vf = 1; vf <= 240; vf++) {
        if (vf === 121) {
          // Trigger Beat 2: Car / fuel explosion at identical camera framing
          await page.evaluate(async variant => {
            const b = (window as any).__getawayBench
            const scene = (window as any).__scene
            b.reset(true)
            const s0 = await b.step(0, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
            const fx = Math.sin(s0.pose.h)
            const fz = Math.cos(s0.pose.h)
            const px = s0.pose.x + fx * 4.5
            const pz = s0.pose.z + fz * 4.5
            if (variant === "before") {
              for (const [k, ox, oz] of [
                ["fuel", -0.6, 0],
                ["propane", 0.8, -0.3],
              ] as const) {
                const prop = scene.clutter.props.find((p: any) => p.home.kind === k && !p.broken && p.fuse < 0)
                if (prop) {
                  prop.body.x = px + ox
                  prop.body.z = pz + oz
                  prop.body.y = scene.clutter.ground(px + ox, pz + oz) + prop.body.hy
                  scene.clutter.hit(prop, fx * 18, fz * 18, 18, 1400, true)
                }
              }
            } else {
              scene.clutter.explodeCar(px, pz, 0, 0, { x: s0.pose.x, z: s0.pose.z })
            }
          }, variant)
        }
        await page.evaluate(async () => {
          const b = (window as any).__getawayBench
          await b.step(1, 1 / 60, false, { boost: false, throttle: 0, steer: 0, handbrake: true })
          await b.step(2, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
        })
        await canvas.screenshot({ path: join(gwDir, `${variant}-${String(vf).padStart(3, "0")}.png`) })
      }
    }
    await pages.before.close()
    await pages.after.close()
    await bSrv.server.close()
    await aSrv.server.close()
  }

  // 3. Blackout: Single-blast + Worst-case (5-grenade spam) perf + 240-frame (8.0s @ 30fps) Before/After video capture
  console.log("Step 3: Blackout perf (single + 5x grenade spam) & video capture...")
  if (steps.has("blackout")) {
    const bSrv = await startGameServer("blackout", "before")
    const aSrv = await startGameServer("blackout", "after")
    const pages = {
      before: await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 }),
      after: await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 }),
    }
    for (const [variant, page] of Object.entries(pages) as ["before" | "after", Page][]) {
      page.on("pageerror", e => errors.push(`blackout-${variant}: ${e.message}`))
      await page.goto(`${variant === "before" ? bSrv.url : aSrv.url}/envlab.html?kind=office&seed=1&fxproof=1&bench=1`)
      await page.waitForFunction(() => !!(window as any).fxProof, undefined, { timeout: 60000 })
    }

    const runBlackoutBench = async (mode: "single" | "worst") => {
      const pairs: any[] = []
      for (let pair = 0; pair < 8; pair++) {
        const order: ("before" | "after")[] = pair % 2 === 0 ? ["before", "after"] : ["after", "before"]
        const row: Record<string, any> = {}
        for (const v of order) {
          const page = pages[v]
          await page.bringToFront()
          row[v] = await page.evaluate(async mode => {
            const f = (window as any).fxProof
            f.game.labClear()
            await f.step(0)
            const cx = f.map.size[0] / 2
            const cy = f.map.size[1] / 2
            if (mode === "single") {
              f.explode(cx, cy)
            } else {
              // 5 simultaneous grenades across the room (grenade spam worst-case)
              f.explode(cx, cy)
              f.explode(cx - 1.8, cy - 1.2)
              f.explode(cx + 1.8, cy + 1.2)
              f.explode(cx - 4.2, cy + 2.0)
              f.explode(cx + 4.2, cy - 2.0)
            }
            const gpus: number[] = []
            const cpus: number[] = []
            for (let i = 0; i < 30; i++) {
              const t0 = performance.now()
              await f.step(1 / 60)
              const cpu = performance.now() - t0
              const ms = await f.draw(true, true)
              cpus.push(cpu)
              if (typeof ms === "number" && Number.isFinite(ms)) gpus.push(ms)
            }
            const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
            const max = (a: number[]) => (a.length ? Math.max(...a) : 0)
            const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
            return {
              gpuMedianMs: Number(med(gpus).toFixed(4)),
              gpuMeanMs: Number(mean(gpus).toFixed(4)),
              gpuPeakMs: Number(max(gpus).toFixed(4)),
              cpuMeanMs: Number(mean(cpus).toFixed(4)),
              cpuPeakMs: Number(max(cpus).toFixed(4)),
              activeVolumes: f.game.smokeVolumes.count,
            }
          }, mode)
        }
        if (pair > 0) {
          pairs.push({
            pair,
            before: row.before,
            after: row.after,
            deltaGpuMeanMs: Number((row.after.gpuMeanMs - row.before.gpuMeanMs).toFixed(4)),
            deltaGpuPeakMs: Number((row.after.gpuPeakMs - row.before.gpuPeakMs).toFixed(4)),
          })
        }
      }
      const meanDeltas = pairs.map(p => p.deltaGpuMeanMs)
      const medDelta = median(meanDeltas)
      return {
        beforeGpuMeanMs: Number(median(pairs.map(p => p.before.gpuMeanMs)).toFixed(4)),
        afterGpuMeanMs: Number(median(pairs.map(p => p.after.gpuMeanMs)).toFixed(4)),
        beforeGpuPeakMs: Number(median(pairs.map(p => p.before.gpuPeakMs)).toFixed(4)),
        afterGpuPeakMs: Number(median(pairs.map(p => p.after.gpuPeakMs)).toFixed(4)),
        deltaGpuMeanMs: Number(medDelta.toFixed(4)),
        deltaGpuMadMs: Number(mad(meanDeltas, medDelta).toFixed(4)),
        beforeCpuMeanMs: Number(median(pairs.map(p => p.before.cpuMeanMs)).toFixed(4)),
        afterCpuMeanMs: Number(median(pairs.map(p => p.after.cpuMeanMs)).toFixed(4)),
        beforeCpuPeakMs: Number(median(pairs.map(p => p.before.cpuPeakMs)).toFixed(4)),
        afterCpuPeakMs: Number(median(pairs.map(p => p.after.cpuPeakMs)).toFixed(4)),
        within60HzBudget: median(pairs.map(p => p.after.gpuPeakMs)) < 16.67,
        pairs,
      }
    }

    if (process.env.SKIP_PERF !== "1") report.blackoutPerf = {
      singleBlast: await runBlackoutBench("single"),
      worstCase5xGrenadeSpam: await runBlackoutBench("worst"),
    }

    // Record 240 video frames (8.0s @ 30fps = 480 sim steps @ 60Hz):
    // Beat 1 (frames 1..120, 0..4s): Office frag grenade detonation
    // Beat 2 (frames 121..240, 4..8s): Second frag + car/wreck detonation in office
    const boDir = join(framesRoot, "blackout")
    mkdirSync(boDir, { recursive: true })
    if (process.env.SKIP_VIDEO_FRAMES !== "1") for (const [variant, page] of Object.entries(pages) as ["before" | "after", Page][]) {
      await page.evaluate(async () => {
        const f = (window as any).fxProof
        f.game.labClear()
        await f.step(0)
        f.explode()
      })
      const canvas = page.locator("#view")
      for (let vf = 1; vf <= 240; vf++) {
        if (vf === 121) {
          await page.evaluate(async variant => {
            const f = (window as any).fxProof
            f.game.labClear()
            await f.step(0)
            const cx = f.map.size[0] / 2
            const cy = f.map.size[1] / 2
            if (variant === "before") {
              f.explode(cx, cy)
              f.game.veh.burst(cx, cy, f.game.fxv)
            } else {
              f.game.explode({ k: "explode", id: -1, by: "viewer", x: cx, y: cy, kind: "frag", aim: 0 }, "car")
            }
          }, variant)
        }
        await page.evaluate(async () => {
          const f = (window as any).fxProof
          await f.step(1 / 60)
          await f.step(1 / 60)
        })
        await canvas.screenshot({ path: join(boDir, `${variant}-${String(vf).padStart(3, "0")}.png`) })
      }
    }
    await pages.before.close()
    await pages.after.close()
    await bSrv.server.close()
    await aSrv.server.close()
  }

  // 4. Carrier: Single-blast + Worst-case (4 simultaneous explosions) perf + 270-frame (9.0s @ 30fps) Before/After video capture
  console.log("Step 4: Carrier perf (single + 4x worst-case) & video capture...")
  if (steps.has("carrier")) {
    const bSrv = await startGameServer("carrier", "before")
    const aSrv = await startGameServer("carrier", "after")
    const pages = {
      before: await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 }),
      after: await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 }),
    }
    for (const [variant, page] of Object.entries(pages) as ["before" | "after", Page][]) {
      page.on("pageerror", e => errors.push(`carrier-${variant}: ${e.message}`))
      await page.goto(`${variant === "before" ? bSrv.url : aSrv.url}/?seed=7&tod=10.5&free=1`)
      await page.waitForFunction(() => !!(globalThis as any).carrier?.game?.state?.sea, undefined, { timeout: 60000 })
      await page.waitForTimeout(800)
      await page.evaluate(() => {
        // Take over RAF so we can step Carrier deterministically at 60Hz
        const cbs: FrameRequestCallback[] = []
        let nowMs = performance.now()
        globalThis.requestAnimationFrame = cb => {
          cbs.push(cb)
          return cbs.length
        }
        // Kill every live weapon effect (sprites, faceted rocks, kit particles) so one beat never leaks into the next.
        ;(globalThis as any).__clearCarrierFx = () => {
          const fx = (globalThis as any).carrier.flight.weapons.fx
          for (const pool of [fx.sp, fx.rk]) {
            pool.age.fill(0)
            pool.life.fill(0)
          }
          fx.fxParticles.reset()
        }
        ;(globalThis as any).__stepCarrier = async (dtSec = 1 / 60) => {
          nowMs += dtSec * 1000
          const list = cbs.splice(0)
          for (const cb of list) cb(nowMs)
          await (globalThis as any).carrier.renderer.context.device.queue.onSubmittedWorkDone()
        }
      })
    }

    const runCarrierBench = async (mode: "single" | "worst") => {
      const pairs: any[] = []
      for (let pair = 0; pair < 8; pair++) {
        const order: ("before" | "after")[] = pair % 2 === 0 ? ["before", "after"] : ["after", "before"]
        const row: Record<string, any> = {}
        for (const v of order) {
          const page = pages[v]
          await page.bringToFront()
          row[v] = await page.evaluate(async mode => {
            const c = (globalThis as any).carrier
            const DEG = Math.PI / 180
            const s = c.game.state.ship
            c.game.state.free = true
            c.camera.set({ x: s.x, z: s.z + 15, yaw: 35 * DEG, pitch: 42 * DEG, dist: 160 })
            ;(globalThis as any).__clearCarrierFx()
            c.flight.weapons.fx.explosion(s.x, s.heave + 28, s.z + 15, 0, 0, 0, 1.8, false)
            if (mode === "worst") {
              c.flight.weapons.fx.explosion(s.x - 14, s.heave + 28, s.z - 22, 0, 0, 0, 1.6, false)
              c.flight.weapons.fx.explosion(s.x + 18, s.heave + 48, s.z + 5, 0, 0, 0, 1.3, false)
              c.flight.weapons.fx.explosion(s.x - 32, 3, s.z + 10, 0, 2, 0, 1.2, true)
            }
            const frameMs: number[] = []
            const cpuMs: number[] = []
            for (let i = 0; i < 30; i++) {
              const t0 = performance.now()
              await (globalThis as any).__stepCarrier(1 / 60)
              const t1 = performance.now()
              // Measure pure GPU render throughput over 4 back-to-back draws of this active blast frame
              const dev: GPUDevice = c.renderer.context.device
              await dev.queue.onSubmittedWorkDone()
              const g0 = performance.now()
              for (let k = 0; k < 4; k++) c.renderer.draw(c.frame, c.grade)
              await dev.queue.onSubmittedWorkDone()
              const gpu = (performance.now() - g0) / 4
              cpuMs.push(Math.max(0.05, t1 - t0 - gpu))
              frameMs.push(gpu)
            }
            const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
            const max = (a: number[]) => (a.length ? Math.max(...a) : 0)
            const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
            return {
              gpuMedianMs: Number(med(frameMs).toFixed(4)),
              gpuMeanMs: Number(mean(frameMs).toFixed(4)),
              gpuPeakMs: Number(max(frameMs).toFixed(4)),
              cpuMeanMs: Number(mean(cpuMs).toFixed(4)),
              cpuPeakMs: Number(max(cpuMs).toFixed(4)),
            }
          }, mode)
        }
        if (pair > 0) {
          pairs.push({
            pair,
            before: row.before,
            after: row.after,
            deltaGpuMeanMs: Number((row.after.gpuMeanMs - row.before.gpuMeanMs).toFixed(4)),
            deltaGpuPeakMs: Number((row.after.gpuPeakMs - row.before.gpuPeakMs).toFixed(4)),
          })
        }
      }
      const meanDeltas = pairs.map(p => p.deltaGpuMeanMs)
      const medDelta = median(meanDeltas)
      return {
        beforeGpuMeanMs: Number(median(pairs.map(p => p.before.gpuMeanMs)).toFixed(4)),
        afterGpuMeanMs: Number(median(pairs.map(p => p.after.gpuMeanMs)).toFixed(4)),
        beforeGpuPeakMs: Number(median(pairs.map(p => p.before.gpuPeakMs)).toFixed(4)),
        afterGpuPeakMs: Number(median(pairs.map(p => p.after.gpuPeakMs)).toFixed(4)),
        deltaGpuMeanMs: Number(medDelta.toFixed(4)),
        deltaGpuMadMs: Number(mad(meanDeltas, medDelta).toFixed(4)),
        beforeCpuMeanMs: Number(median(pairs.map(p => p.before.cpuMeanMs)).toFixed(4)),
        afterCpuMeanMs: Number(median(pairs.map(p => p.after.cpuMeanMs)).toFixed(4)),
        beforeCpuPeakMs: Number(median(pairs.map(p => p.before.cpuPeakMs)).toFixed(4)),
        afterCpuPeakMs: Number(median(pairs.map(p => p.after.cpuPeakMs)).toFixed(4)),
        within60HzBudget: median(pairs.map(p => p.after.gpuPeakMs)) < 16.67,
        pairs,
      }
    }

    if (process.env.SKIP_PERF !== "1") report.carrierPerf = {
      singleBlast: await runCarrierBench("single"),
      worstCase4xSimultaneous: await runCarrierBench("worst"),
    }

    // Record 315 video frames (10.5s @ 30fps = 630 sim steps @ 60Hz):
    // Beat 1 (frames 1..135, 0..4.5s): Missile hit on carrier ship deck (long enough for the fragment trails to land)
    // Beat 2 (frames 136..225, 4.5..7.5s): Missile airburst over sea
    // Beat 3 (frames 226..315, 7.5..10.5s): Boat explosion on water
    const caDir = join(framesRoot, "carrier")
    mkdirSync(caDir, { recursive: true })
    const shotCarrierFrame = async (page: Page, filepath: string) => {
      const dataUrl = await page.evaluate(async () => {
        const c = (globalThis as any).carrier
        const device: GPUDevice = c.renderer.context.device
        const ctx: GPUCanvasContext = c.renderer.canvas
        const format = navigator.gpu.getPreferredCanvasFormat()
        ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
        const w = (ctx.canvas as HTMLCanvasElement).width
        const h = (ctx.canvas as HTMLCanvasElement).height
        const row = Math.ceil((w * 4) / 256) * 256
        const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        await new Promise<void>(resolve => {
          const get = ctx.getCurrentTexture.bind(ctx)
          const submit = device.queue.submit.bind(device.queue)
          let tex: GPUTexture | null = null
          ctx.getCurrentTexture = () => {
            tex = get()
            ctx.getCurrentTexture = get
            return tex
          }
          device.queue.submit = (cbs: Iterable<GPUCommandBuffer>) => {
            submit(cbs)
            if (!tex) return
            device.queue.submit = submit
            const enc = device.createCommandEncoder()
            enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h])
            submit([enc.finish()])
            resolve()
          }
          c.renderer.draw(c.frame, c.grade)
        })
        await buf.mapAsync(GPUMapMode.READ)
        const src = new Uint8Array(buf.getMappedRange())
        const img = new ImageData(w, h)
        const bgra = format === "bgra8unorm"
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const s = y * row + x * 4
            const d = (y * w + x) * 4
            img.data[d] = src[s + (bgra ? 2 : 0)]!
            img.data[d + 1] = src[s + 1]!
            img.data[d + 2] = src[s + (bgra ? 0 : 2)]!
            img.data[d + 3] = 255
          }
        buf.unmap()
        buf.destroy()
        const cv = document.createElement("canvas")
        cv.width = w
        cv.height = h
        cv.getContext("2d")!.putImageData(img, 0, 0)
        return cv.toDataURL("image/png")
      })
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "")
      await Bun.write(filepath, Buffer.from(base64, "base64"))
    }

    if (process.env.SKIP_VIDEO_FRAMES !== "1") for (const [variant, page] of Object.entries(pages) as ["before" | "after", Page][]) {
      for (let vf = 1; vf <= 315; vf++) {
        if (vf === 1) {
          // Beat 1: Ship deck hit
          await page.evaluate(() => {
            const c = (globalThis as any).carrier
            const DEG = Math.PI / 180
            const s = c.game.state.ship
            ;(globalThis as any).__clearCarrierFx()
            c.game.state.free = true
            c.camera.set({ x: s.x, z: s.z + 15, yaw: 35 * DEG, pitch: 42 * DEG, dist: 160 })
            c.flight.weapons.fx.explosion(s.x, s.heave + 28, s.z + 15, 0, 0, 0, 1.8, false)
          })
        } else if (vf === 136) {
          // Beat 2: Missile airburst
          await page.evaluate(() => {
            const c = (globalThis as any).carrier
            const DEG = Math.PI / 180
            const s = c.game.state.ship
            ;(globalThis as any).__clearCarrierFx()
            c.game.state.free = true
            c.camera.set({ x: s.x, z: s.z - 220, yaw: 180 * DEG, pitch: 15 * DEG, dist: 95 })
            c.flight.weapons.fx.explosion(s.x, 22, s.z - 220, 0, 0, 0, 1.2, false)
          })
        } else if (vf === 226) {
          // Beat 3: Boat explosion on water
          await page.evaluate(() => {
            const c = (globalThis as any).carrier
            const DEG = Math.PI / 180
            const s = c.game.state.ship
            ;(globalThis as any).__clearCarrierFx()
            c.game.state.free = true
            c.camera.set({ x: s.x + 180, z: s.z - 120, yaw: 20 * DEG, pitch: 16 * DEG, dist: 75 })
            c.flight.weapons.fx.explosion(s.x + 180, 2.2, s.z - 120, 0, 2, 0, 1.15, true)
          })
        }
        await page.evaluate(async () => {
          await (globalThis as any).__stepCarrier(1 / 60)
          await (globalThis as any).__stepCarrier(1 / 60)
        })
        await shotCarrierFrame(page, join(caDir, `${variant}-${String(vf).padStart(3, "0")}.png`))
      }
    }
    await pages.before.close()
    await pages.after.close()
    await bSrv.server.close()
    await aSrv.server.close()
  }

  assert.deepEqual(errors, [])
  writeFileSync(join(out, "unify-report.json"), JSON.stringify(report, null, 2) + "\n")
  const summary = (perf: any) =>
    perf && Object.fromEntries(Object.entries(perf).map(([k, v]: [string, any]) => [k, { ...v, pairs: undefined }]))
  console.log(
    JSON.stringify(
      {
        getawayPerf: summary(report.getawayPerf),
        blackoutPerf: summary(report.blackoutPerf),
        carrierPerf: summary(report.carrierPerf),
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
