/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { chromium } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.EXPLOSION_UNIFY_OUT ?? "/Users/kit/code/home/artifacts/2026-10-14-explosion-unify")
mkdirSync(out, { recursive: true })

const baseline = process.env.EXPLOSION_BASELINE ?? "HEAD~1"
const baselineFiles = [
  "packages/kit/fx/explosion.ts",
  "packages/kit/fx/particle-renderer.ts",
  "packages/kit/fx/index.ts",
  "packages/kit/fx/fire-water.ts",
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
const servers: ViteDevServer[] = []
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
    server: { host: "127.0.0.1", port: 18400 + nextPort++, strictPort: false, hmr: false },
  })
  servers.push(server)
  await server.listen()
  const addr = server.httpServer!.address()
  assert(addr && typeof addr !== "string")
  return { url: `http://127.0.0.1:${addr.port}`, server }
}

const median = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}
const mad = (arr: number[], med: number) => median(arr.map(x => Math.abs(x - med)))

const errors: string[] = []
const report: Record<string, unknown> = { baseline }

try {
  // 1. Verify Lab unification: single Explosion catalogue entry, all 7 presets, and shared reuse in getaway-effects / blackout-effects
  console.log("Step 1: Lab unification check...")
  {
    const { url, server } = await startGameServer("lab", "after")
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => errors.push(`lab: ${e.message}`))
    await page.goto(`${url}/?bench`)
    await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 60000 })

    const labChecks = await page.evaluate(async () => {
      const l = (window as any).lab
      // Check all 7 presets in Effects -> Explosion
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

      // Check getaway-effects explosion uses shared context.particles & context.volume
      await l.select("getaway-effects")
      const gwSec = l.sections.find((s: any) => s.id === "getaway-effects")
      gwSec.settings.effect = "explosion"
      gwSec.retrigger()
      for (let i = 0; i < 6; i++) l.advance(1 / 60)
      const getawaySharedParticles = l.context.particles.count
      const getawaySharedVolumes = l.context.volume.count

      // Check blackout-effects explosion uses shared context.particles & context.volume
      await l.select("blackout-effects")
      const boSec = l.sections.find((s: any) => s.id === "blackout-effects")
      boSec.settings.effect = "explosion"
      boSec.retrigger()
      for (let i = 0; i < 6; i++) l.advance(1 / 60)
      const blackoutSharedParticles = l.context.particles.count
      const blackoutSharedVolumes = l.context.volume.count

      // Check Library catalogue entries for duplicate explosion items
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
    assert.equal(labChecks.presetCounts.missile!.scorch, false, "Missile airburst disables ground scorch")
    assert.equal(labChecks.presetCounts.missile!.volumes, 0, "Missile airburst omits ground smoke volume")
    assert(labChecks.getawaySharedParticles > 60 && labChecks.getawaySharedVolumes === 1, "Getaway effects reuses shared explosion")
    assert(labChecks.blackoutSharedParticles > 60 && labChecks.blackoutSharedVolumes === 1, "Blackout effects reuses shared explosion")
    assert(!labChecks.catalogItems.includes("blackout-effects:explosion"), "No duplicate blackout-effects:explosion in Library")
    assert(!labChecks.catalogItems.includes("getaway-effects:explosion"), "No duplicate getaway-effects:explosion in Library")
    assert(!labChecks.catalogItems.includes("fire-water:explosion"), "No duplicate fire-water:explosion in Library")
    report.labUnification = labChecks
    await page.close()
    await server.close()
  }

  // 2. Getaway paired performance benchmark during active propane + fuel blast (1 warmup + 7 alternating pairs of 20 frames)
  console.log("Step 2: Getaway paired perf...")
  {
    const bSrv = await startGameServer("getaway", "before")
    const aSrv = await startGameServer("getaway", "after")
    const beforeUrl = bSrv.url
    const afterUrl = aSrv.url
    const pages = {
      before: await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 }),
      after: await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 }),
    }
    for (const [variant, page] of Object.entries(pages) as ["before" | "after", typeof pages.before][]) {
      page.on("pageerror", e => errors.push(`getaway-${variant}: ${e.message}`))
      await page.goto(`${variant === "before" ? beforeUrl : afterUrl}/?peaceful=1&seed=7&bench=1&nohud=1&smoketiming=1`)
      await page.waitForFunction(() => !!(window as any).__getawayBench && !!(window as any).__scene, undefined, { timeout: 60000 })
      await page.evaluate(async () => {
        const b = (window as any).__getawayBench
        await b.ready
      })
    }

    const pairs: { pair: number; beforeGpuMs: number; afterGpuMs: number; deltaGpuMs: number; beforeCpuMs: number; afterCpuMs: number }[] = []
    for (let pair = 0; pair < 8; pair++) {
      const order: ("before" | "after")[] = pair % 2 === 0 ? ["before", "after"] : ["after", "before"]
      const row: Record<string, { gpuMs: number; cpuMs: number }> = {}
      for (const v of order) {
        const page = pages[v]
        await page.bringToFront()
        row[v] = await page.evaluate(async variant => {
          const b = (window as any).__getawayBench
          const scene = (window as any).__scene
          b.reset(true)
          const s0 = await b.step(0, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
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
          const gpus: number[] = []
          const cpus: number[] = []
          for (let i = 1; i <= 20; i++) {
            const res = await b.step(i, 1 / 60, true, { boost: false, throttle: 0, steer: 0, handbrake: true })
            if (typeof res.totalGpuMs === "number" && Number.isFinite(res.totalGpuMs)) gpus.push(res.totalGpuMs)
            cpus.push(res.cpuMs)
          }
          const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
          return { gpuMs: Number(med(gpus).toFixed(4)), cpuMs: Number(med(cpus).toFixed(4)) }
        }, v)
      }
      if (pair > 0) {
        pairs.push({
          pair,
          beforeGpuMs: row.before!.gpuMs,
          afterGpuMs: row.after!.gpuMs,
          deltaGpuMs: Number((row.after!.gpuMs - row.before!.gpuMs).toFixed(4)),
          beforeCpuMs: row.before!.cpuMs,
          afterCpuMs: row.after!.cpuMs,
        })
      }
    }
    const deltas = pairs.map(p => p.deltaGpuMs)
    const medDelta = median(deltas)
    report.getawayPerf = {
      beforeGpuMedianMs: Number(median(pairs.map(p => p.beforeGpuMs)).toFixed(4)),
      afterGpuMedianMs: Number(median(pairs.map(p => p.afterGpuMs)).toFixed(4)),
      deltaGpuMedianMs: Number(medDelta.toFixed(4)),
      deltaGpuMadMs: Number(mad(deltas, medDelta).toFixed(4)),
      beforeCpuMedianMs: Number(median(pairs.map(p => p.beforeCpuMs)).toFixed(4)),
      afterCpuMedianMs: Number(median(pairs.map(p => p.afterCpuMs)).toFixed(4)),
      pairs,
    }
    await pages.before.close()
    await pages.after.close()
    await bSrv.server.close()
    await aSrv.server.close()
  }

  // 3. Blackout paired performance benchmark during active grenade blast (1 warmup + 7 alternating pairs of 20 frames)
  console.log("Step 3: Blackout paired perf...")
  {
    const bSrv = await startGameServer("blackout", "before")
    const aSrv = await startGameServer("blackout", "after")
    const beforeUrl = bSrv.url
    const afterUrl = aSrv.url
    const pages = {
      before: await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 }),
      after: await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 }),
    }
    for (const [variant, page] of Object.entries(pages) as ["before" | "after", typeof pages.before][]) {
      page.on("pageerror", e => errors.push(`blackout-${variant}: ${e.message}`))
      await page.goto(`${variant === "before" ? beforeUrl : afterUrl}/envlab.html?kind=office&seed=1&fxproof=1&bench=1`)
      await page.waitForFunction(() => !!(window as any).fxProof, undefined, { timeout: 60000 })
    }

    const pairs: { pair: number; beforeGpuMs: number; afterGpuMs: number; deltaGpuMs: number }[] = []
    for (let pair = 0; pair < 8; pair++) {
      const order: ("before" | "after")[] = pair % 2 === 0 ? ["before", "after"] : ["after", "before"]
      const row: Record<string, number> = {}
      for (const v of order) {
        const page = pages[v]
        await page.bringToFront()
        row[v] = await page.evaluate(async () => {
          const f = (window as any).fxProof
          f.game.labClear()
          await f.step(0)
          f.explode()
          const gpus: number[] = []
          for (let i = 0; i < 20; i++) {
            await f.step(1 / 60)
            const ms = await f.draw(true, true)
            if (typeof ms === "number" && Number.isFinite(ms)) gpus.push(ms)
          }
          const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
          return Number(med(gpus).toFixed(4))
        })
      }
      if (pair > 0) {
        pairs.push({
          pair,
          beforeGpuMs: row.before!,
          afterGpuMs: row.after!,
          deltaGpuMs: Number((row.after! - row.before!).toFixed(4)),
        })
      }
    }
    const deltas = pairs.map(p => p.deltaGpuMs)
    const medDelta = median(deltas)
    report.blackoutPerf = {
      beforeGpuMedianMs: Number(median(pairs.map(p => p.beforeGpuMs)).toFixed(4)),
      afterGpuMedianMs: Number(median(pairs.map(p => p.afterGpuMs)).toFixed(4)),
      deltaGpuMedianMs: Number(medDelta.toFixed(4)),
      deltaGpuMadMs: Number(mad(deltas, medDelta).toFixed(4)),
      pairs,
    }
    await pages.before.close()
    await pages.after.close()
    await bSrv.server.close()
    await aSrv.server.close()
  }

  // 4. Carrier paired throughput benchmark during active missile + ship blast (1 warmup + 7 alternating pairs of 60 frames)
  console.log("Step 4: Carrier paired perf...")
  {
    const bSrv = await startGameServer("carrier", "before")
    const aSrv = await startGameServer("carrier", "after")
    const beforeUrl = bSrv.url
    const afterUrl = aSrv.url
    const pages = {
      before: await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 }),
      after: await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 }),
    }
    for (const [variant, page] of Object.entries(pages) as ["before" | "after", typeof pages.before][]) {
      page.on("pageerror", e => errors.push(`carrier-${variant}: ${e.message}`))
      await page.goto(`${variant === "before" ? beforeUrl : afterUrl}/?seed=7&tod=10.5&free=1`)
      await page.waitForFunction(() => !!(globalThis as any).carrier?.game?.state?.sea, undefined, { timeout: 60000 })
      await page.waitForTimeout(800)
      await page.evaluate(async () => {
        const c = (globalThis as any).carrier
        const s = c.game.state.ship
        c.game.state.free = true
        c.camera.set({ x: s.x, z: s.z, yaw: 35, pitch: 18, dist: 145 })
        c.flight.weapons.fx.explosion(s.x, s.heave + 28, s.z + 15, 0, 0, 0, 1.8, false)
        c.flight.weapons.fx.explosion(s.x - 18, s.heave + 42, s.z - 25, 0, 0, 0, 1.2, false)
        await new Promise(r => setTimeout(r, 180))
        // Freeze RAF for flat-out throughput measurement (same method as carrier/scripts/explosion-shot.ts)
        globalThis.requestAnimationFrame = () => 0
        await new Promise(r => setTimeout(r, 60))
      })
    }

    const pairs: { pair: number; beforeFrameMs: number; afterFrameMs: number; deltaFrameMs: number }[] = []
    for (let pair = 0; pair < 8; pair++) {
      const order: ("before" | "after")[] = pair % 2 === 0 ? ["before", "after"] : ["after", "before"]
      const row: Record<string, number> = {}
      for (const v of order) {
        const page = pages[v]
        await page.bringToFront()
        row[v] = await page.evaluate(async () => {
          const c = (globalThis as any).carrier
          const r = c.renderer
          const dev: GPUDevice = r.context.device
          await dev.queue.onSubmittedWorkDone()
          const t0 = performance.now()
          const n = 60
          for (let i = 0; i < n; i++) {
            r.draw(c.frame, c.grade)
            if (i % 20 === 19) await dev.queue.onSubmittedWorkDone()
          }
          await dev.queue.onSubmittedWorkDone()
          return Number(((performance.now() - t0) / n).toFixed(4))
        })
      }
      if (pair > 0) {
        pairs.push({
          pair,
          beforeFrameMs: row.before!,
          afterFrameMs: row.after!,
          deltaFrameMs: Number((row.after! - row.before!).toFixed(4)),
        })
      }
    }
    const deltas = pairs.map(p => p.deltaFrameMs)
    const medDelta = median(deltas)
    report.carrierPerf = {
      beforeFrameMedianMs: Number(median(pairs.map(p => p.beforeFrameMs)).toFixed(4)),
      afterFrameMedianMs: Number(median(pairs.map(p => p.afterFrameMs)).toFixed(4)),
      deltaFrameMedianMs: Number(medDelta.toFixed(4)),
      deltaFrameMadMs: Number(mad(deltas, medDelta).toFixed(4)),
      pairs,
    }
    await pages.before.close()
    await pages.after.close()
    await bSrv.server.close()
    await aSrv.server.close()
  }

  assert.deepEqual(errors, [])
  writeFileSync(join(out, "unify-report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(
    JSON.stringify(
      {
        getawayPerf: { ...(report.getawayPerf as any), pairs: undefined },
        blackoutPerf: { ...(report.blackoutPerf as any), pairs: undefined },
        carrierPerf: { ...(report.carrierPerf as any), pairs: undefined },
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
  for (const s of servers) await s.close()
}
