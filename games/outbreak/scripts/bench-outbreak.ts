import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { hostname } from "node:os"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.PERF_OUT ?? "captures/outbreak-bench")
const label = process.env.BENCH_LABEL ?? "baseline"
const weatherPreset = process.env.BENCH_WEATHER ?? ""
const warmupRuns = Number(process.env.BENCH_WARMUP ?? 1)
const measuredRuns = Number(process.env.BENCH_RUNS ?? 7)
const holdMs = Number(process.env.BENCH_HOLD_MS ?? 2000)
const runAblations = process.env.BENCH_ABLATE === "1"
// Optional Lab overrides for A/B experiments, e.g. BENCH_LAB='{"streetAirHaze":1}'.
const labOverrides: Record<string, number> = JSON.parse(process.env.BENCH_LAB ?? "{}")
// Foliage density sweeps (GPU cost per density): BENCH_FOLIAGE_DENSITY=0.5 is shorthand for BENCH_LAB='{"foliageDensity":0.5}'.
if (process.env.BENCH_FOLIAGE_DENSITY) labOverrides.foliageDensity = Number(process.env.BENCH_FOLIAGE_DENSITY)
mkdirSync(out, { recursive: true })

function sampleThermal(): { host: string; thermalPressure: string; pmset: string } {
  let thermalPressure = "unknown"
  let pmset = ""
  try {
    pmset = execSync("pmset -g therm", { encoding: "utf8", timeout: 2000 }).trim()
    const match = pmset.match(/CPU_Speed_Limit\s*=\s*(\d+)|Thermal_Level\s*=\s*(\S+)|No thermal warning/i)
    thermalPressure = match ? match[0] : pmset.split("\n")[0] ?? "nominal"
  } catch {}
  return { host: hostname(), thermalPressure, pmset }
}

const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "bench-outbreak-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code
          .replace("const harness = {", "const harness = { renderer, render, lab, session: () => session, vision: () => vision,")
          .replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render, lab, session: () => session, vision: () => vision })")
          .replace(
            "function tick(now: number) {",
            "function tick(now: number) { const stats = (window as any).__pacing; if (stats?.active) stats.callbacks.push({ wall: performance.now(), raf: now, hidden: document.hidden, frozen });",
          )
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary not found")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const scenes = [
  { name: "street", x: 30, y: 41, zoom: 46, hour: 18 },
  { name: "interior", x: 27.7, y: 31, zoom: 34, hour: 19 },
] as const

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2
}
const mad = (xs: number[]): number => {
  const m = median(xs)
  return median(xs.map(x => Math.abs(x - m)))
}
const quantile = (xs: number[], p: number): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!
}
const summarizeSeries = (xs: number[]) => ({
  count: xs.length,
  median: median(xs),
  mad: mad(xs),
  p95: quantile(xs, 0.95),
  p99: quantile(xs, 0.99),
  min: xs.length ? Math.min(...xs) : 0,
  max: xs.length ? Math.max(...xs) : 0,
  mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
  runs: xs,
})
const gapsOf = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!)

try {
  const cdp = await browser.newBrowserCDPSession()
  const gpuInfo = (await cdp.send("SystemInfo.getInfo")).gpu
  const thermalStart = sampleThermal()
  const rawRuns: any[] = []

  for (let run = 0; run < warmupRuns + measuredRuns; run++) {
    const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
    await page.addInitScript(() => {
      const request = GPUAdapter.prototype.requestDevice
      GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
        return request.call(this, {
          ...desc,
          requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [],
        })
      }
    })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => {
      if (m.type() === "error") errors.push(m.text())
    })
    await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
    const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
    assert.match(adapter.architecture, /metal/, `Expected Metal adapter, got ${JSON.stringify(adapter)}`)

    // Install key listeners once per page.
    await page.evaluate(() => {
      const w = window as any
      const h = w.__arcadeHarness
      const r = h.renderer
      const origDraw = r.draw.bind(r)
      r.draw = (f: any) => {
        const stats = w.__pacing
        const submit = performance.now()
        const stateTime = f.frame[19]
        const x = f.frame[24]
        const y = f.frame[25]
        origDraw(f)
        if (stats?.active) {
          const entry = {
            submit,
            time: stateTime,
            x,
            y,
            complete: 0,
            drawnChunks: r.drawnChunks,
            lightCount: f.lightCount,
            occluderCount: f.occluderCount,
          }
          stats.draws.push(entry)
          void r.device.queue.onSubmittedWorkDone().then(() => {
            entry.complete = performance.now()
          })
        }
      }
      window.addEventListener(
        "keydown",
        e => {
          const stats = w.__pacing
          const s = h.session()
          if (e.code === "ArrowRight" && stats?.active) {
            stats.inputs.push({ kind: "down", wall: performance.now(), x: s.view.player.x, y: s.view.player.y, time: s.view.time })
          }
        },
        true,
      )
      window.addEventListener(
        "keyup",
        e => {
          const stats = w.__pacing
          const s = h.session()
          if (e.code === "ArrowRight" && stats?.active) {
            stats.inputs.push({ kind: "up", wall: performance.now(), x: s.view.player.x, y: s.view.player.y, time: s.view.time })
          }
        },
        true,
      )
    })

    for (const scene of scenes) {
      await page.evaluate(
        async ({ scene, weatherPreset, labOverrides }) => {
          const w = window as any
          const h = w.__arcadeHarness
          h.freeze(true)
          h.reset(7)
          h.setLab("timeScale", 0)
          h.setLab("zoom", scene.zoom)
          h.setLab("hour", scene.hour)
          for (const [key, value] of Object.entries(labOverrides)) h.setLab(key, value)
          if (weatherPreset && typeof h.setWeatherPreset === "function") {
            h.setWeatherPreset(weatherPreset)
          }
          h.pose(scene.x, scene.y, -Math.PI / 2)
          await h.step(0)
          const s = h.session()
          const v = h.vision()
          const r = h.renderer
          const stats: any = (w.__pacing = {
            active: false,
            callbacks: [],
            ticks: [],
            draws: [],
            inputs: [],
            cpuVisionMs: [],
            end: 0,
            header: "",
          })
          const origUpdate = s.update.bind(s)
          s.update = (dt: number, c: any, ...args: any[]) => {
            const t0 = performance.now()
            origUpdate(dt, c, ...args)
            const cpuSimMs = performance.now() - t0
            if (stats.active) {
              stats.ticks.push({
                wall: t0,
                cpuSimMs,
                dt,
                mx: c.mx,
                my: c.my,
                time: s.view.time,
                x: s.view.player.x,
                y: s.view.player.y,
              })
            }
          }
          const origVision = v.update.bind(v)
          v.update = (...args: any[]) => {
            const t0 = performance.now()
            const res = origVision(...args)
            if (stats.active) stats.cpuVisionMs.push(performance.now() - t0)
            return res
          }
          h.freeze(false)
          await new Promise(resolve => setTimeout(resolve, 350))
          h.freeze(true)
          await r.device.queue.onSubmittedWorkDone()
        },
        { scene, weatherPreset, labOverrides },
      )

      await page.locator("#game").click()
      await page.evaluate(() => {
        const w = window as any
        w.__pacing.active = true
        w.__arcadeHarness.freeze(false)
      })
      await page.keyboard.down("ArrowRight")
      await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), holdMs)
      await page.keyboard.up("ArrowRight")

      const live = await page.evaluate(
        async ({ scene, weatherPreset, labOverrides }) => {
          const w = window as any
          const h = w.__arcadeHarness
          const s = w.__pacing
          s.end = performance.now()
          s.header = h.lab.header.textContent
          s.active = false
          h.freeze(true)
          await h.renderer.device.queue.onSubmittedWorkDone()

          // Deterministic 24-step non-overlapping CPU / queue-completion / GPU hardware timestamp profile
          h.reset(7)
          h.setLab("timeScale", 0)
          h.setLab("zoom", scene.zoom)
          h.setLab("hour", scene.hour)
          for (const [key, value] of Object.entries(labOverrides)) h.setLab(key, value)
          if (weatherPreset && typeof h.setWeatherPreset === "function") {
            h.setWeatherPreset(weatherPreset)
          }
          h.pose(scene.x, scene.y, -Math.PI / 2)
        const cpuPrepMs: number[] = []
        const cpuVisionStepMs: number[] = []
        const cpuSimStepMs: number[] = []
        const stepQueueCompletionMs: number[] = []
        const sess = h.session()
        const vis = h.vision()
        const origSim = sess.update.bind(sess)
        const origVis = vis.update.bind(vis)
        const origRender = h.renderer.render.bind(h.renderer)
        let stepStart = 0
        sess.update = (dt: number, c: any, ...args: any[]) => {
          const t0 = performance.now()
          origSim(dt, c, ...args)
          cpuSimStepMs.push(performance.now() - t0)
        }
        vis.update = (...args: any[]) => {
          const t0 = performance.now()
          const out = origVis(...args)
          cpuVisionStepMs.push(performance.now() - t0)
          return out
        }
        h.renderer.render = (...args: any[]) => {
          cpuPrepMs.push(performance.now() - stepStart)
          return origRender(...args)
        }
        for (let i = 0; i < 24; i++) {
          stepStart = performance.now()
          await h.step(1 / 60, { mx: i < 12 ? 1 : -1 })
          stepQueueCompletionMs.push(performance.now() - stepStart)
        }
        const gpuHwTimestampMs: number[] = []
        for (let i = 0; i < 8; i++) {
          gpuHwTimestampMs.push(await h.renderer.measure(h.render))
        }
        const st = h.state()
        const canvas = document.querySelector<HTMLCanvasElement>("canvas")!
        return {
          ...s,
          deterministic: {
            cpuSimStepMs: cpuSimStepMs.slice(4),
            cpuVisionStepMs: cpuVisionStepMs.slice(4),
            cpuPrepMs: cpuPrepMs.slice(4),
            stepQueueCompletionMs: stepQueueCompletionMs.slice(4),
            gpuHwTimestampMs: gpuHwTimestampMs.slice(1),
            lightCount: h.render.lightCount,
            occluderCount: h.render.occluderCount,
            drawnChunks: h.renderer.drawnChunks,
            totalChunks: h.renderer.chunks?.length ?? 0,
            vertices: st.vertices,
          },
          actors: {
            survivors: 1,
            npcs: 0,
            doors: st.town.doors.length,
            props: st.town.props.length,
            lamps: st.town.lamps.length,
            buildings: st.town.buildings.length,
          },
          viewport: [innerWidth, innerHeight, devicePixelRatio],
          canvas: [canvas.width, canvas.height],
          hidden: document.hidden,
        }
      },
      { scene, weatherPreset, labOverrides },
    )

      const down = live.inputs.find((e: any) => e.kind === "down")
      const up = live.inputs.find((e: any) => e.kind === "up")
      const ticks = live.ticks.filter((t: any) => t.wall >= down.wall && t.wall <= up.wall)
      const moved = ticks.find((t: any) => Math.hypot(t.x - down.x, t.y - down.y) > 0.0001)
      const draws = live.draws.filter((d: any) => d.submit >= down.wall && d.submit <= up.wall)
      const freshDraws: any[] = []
      for (const d of draws) {
        const prev = freshDraws.at(-1)
        if (!prev || d.time > prev.time + 1e-6 || Math.hypot(d.x - prev.x, d.y - prev.y) > 1e-5) {
          freshDraws.push(d)
        }
      }
      const firstFresh = draws.find((d: any) => moved && d.time >= moved.time - 1e-5 && Math.hypot(d.x - down.x, d.y - down.y) > 0.0001)
      const wallSeconds = (up.wall - down.wall) / 1000
      const simSeconds = up.time - down.time
      const distance = Math.hypot(up.x - down.x, up.y - down.y)

      rawRuns.push({
        run,
        warmup: run < warmupRuns,
        scene: scene.name,
        header: live.header,
        wallSeconds,
        simSeconds,
        realtimeRatio: simSeconds / wallSeconds,
        distance,
        expectedDistance: 3.4 * simSeconds,
        expectedWallDistance: 3.4 * wallSeconds,
        speedMetersPerWallSecond: distance / wallSeconds,
        counts: {
          renderCallbacks: live.callbacks.filter((c: any) => c.wall >= down.wall && c.wall <= up.wall).length,
          actualUpdates: ticks.length,
          submittedDraws: draws.length,
          freshSubmittedStates: freshDraws.length,
          freshStatesPerSecond: freshDraws.length / wallSeconds,
          submittedDrawsPerSecond: draws.length / wallSeconds,
        },
        callbackGapsMs: summarizeSeries(gapsOf(live.callbacks.filter((c: any) => c.wall >= down.wall && c.wall <= up.wall).map((c: any) => c.wall))),
        updateGapsMs: summarizeSeries(gapsOf(ticks.map((t: any) => t.wall))),
        drawSubmissionGapsMs: summarizeSeries(gapsOf(draws.map((d: any) => d.submit))),
        freshSubmissionGapsMs: summarizeSeries(gapsOf(freshDraws.map((d: any) => d.submit))),
        gpuCompletionCallbackGapsMs: summarizeSeries(gapsOf(freshDraws.filter((d: any) => d.complete > 0).map((d: any) => d.complete))),
        submitToGpuCompleteCallbackMs: summarizeSeries(freshDraws.filter((d: any) => d.complete > 0).map((d: any) => d.complete - d.submit)),
        inputLatencyMs: {
          note: "Measured to simulation/submission/queue-completion callback only; true physical display presentation latency is not measured.",
          keydownToSimMs: moved ? moved.wall - down.wall : null,
          keydownToSubmitMs: firstFresh ? firstFresh.submit - down.wall : null,
          keydownToGpuCompleteCallbackMs: firstFresh && firstFresh.complete > 0 ? firstFresh.complete - down.wall : null,
        },
        nonOverlappingSpansMs: {
          cpuSimStepMedianMs: median(live.deterministic.cpuSimStepMs),
          cpuVisionStepMedianMs: median(live.deterministic.cpuVisionStepMs),
          cpuPrepStepMedianMs: median(live.deterministic.cpuPrepMs),
          stepToQueueCompleteMedianMs: median(live.deterministic.stepQueueCompletionMs),
          gpuHwDependentIntervalMedianMs: median(live.deterministic.gpuHwTimestampMs),
          gpuHwDependentIntervalRawMs: live.deterministic.gpuHwTimestampMs,
        },
        sceneMeta: {
          lightCount: live.deterministic.lightCount,
          occluderCount: live.deterministic.occluderCount,
          drawnChunks: live.deterministic.drawnChunks,
          vertices: live.deterministic.vertices,
          actors: live.actors,
          viewport: live.viewport,
          canvas: live.canvas,
        },
      })
    }
    assert.deepEqual(errors, [])
    await page.close()
  }

  let ablations: any = undefined
  if (runAblations) {
    const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
    await page.addInitScript(() => {
      const request = GPUAdapter.prototype.requestDevice
      GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
        return request.call(this, {
          ...desc,
          requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [],
        })
      }
    })
    await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
    ablations = await page.evaluate(async scenes => {
      const h = (window as any).__arcadeHarness
      const r = h.renderer
      const results: Record<string, any> = {}
      for (const scene of scenes) {
        h.freeze(true)
        h.reset(7)
        h.setLab("timeScale", 0)
        h.setLab("zoom", scene.zoom)
        h.setLab("hour", scene.hour)
        h.pose(scene.x, scene.y, -Math.PI / 2)
        await h.step(0)

        const sample = async (fn?: () => void, restore?: () => void) => {
          fn?.()
          try {
            const vals: number[] = []
            for (let i = 0; i < 12; i++) {
              const ms = await r.measure(h.render)
              if (i >= 3) vals.push(ms)
            }
            vals.sort((a, b) => a - b)
            return { medianMs: vals[Math.floor(vals.length / 2)]!, vals }
          } finally {
            restore?.()
          }
        }

        const origLightCount = h.render.lightCount
        const origShadowCount = h.render.shadowLightCount
        const origChunks = [...r.chunks]
        const [vx0, vy0, vx1, vy1] = h.render.view

        // Count how many lamps in h.render.lights actually overlap view frustum
        const rawLights = h.render.lights.slice(0, origLightCount * 16)
        const culledLights = new Float32Array(h.render.lights.length)
        culledLights.set(rawLights.subarray(0, 16), 0)
        let culledCount = 1
        for (let i = 1; i < origLightCount; i++) {
          const base = i * 16
          const lx = rawLights[base]!
          const lz = rawLights[base + 2]!
          const lr = rawLights[base + 3]!
          const power = rawLights[base + 7]!
          if (power <= 0.001) continue
          if (lx + lr < vx0 || lx - lr > vx1 || lz + lr < vy0 || lz - lr > vy1) continue
          culledLights.set(rawLights.subarray(base, base + 16), culledCount * 16)
          culledCount++
        }

        const full = await sample()
        const sortedChunks = await sample(
          () => {
            r.chunks = [...origChunks].sort((a: any, b: any) => Number(!!a.customCutaway || !!a.cutBox) - Number(!!b.customCutaway || !!b.cutBox))
          },
          () => {
            r.chunks = origChunks
          },
        )
        const frustumLights = await sample(
          () => {
            h.render.lights.set(culledLights)
            h.render.lightCount = culledCount
            h.render.shadowLightCount = culledCount
            h.render.frame[22] = culledCount
            h.render.frame[35] = culledCount
          },
          () => {
            h.render.lights.set(rawLights)
            h.render.lightCount = origLightCount
            h.render.shadowLightCount = origShadowCount
            h.render.frame[22] = origLightCount
            h.render.frame[35] = origLightCount
          },
        )
        const noLights = await sample(
          () => {
            h.render.lightCount = 1
            h.render.shadowLightCount = 1
            h.render.frame[22] = 1
            h.render.frame[35] = 1
          },
          () => {
            h.render.lightCount = origLightCount
            h.render.shadowLightCount = origShadowCount
            h.render.frame[22] = origLightCount
            h.render.frame[35] = origLightCount
          },
        )
        const albedoOnly = await sample(
          () => {
            h.render.frame[42] = 1
            h.render.grade[1] = 1
          },
          () => {
            h.render.frame[42] = 0
            h.render.grade[1] = 0
          },
        )
        const allOpaquePipe = await sample(
          () => {
            r.chunks = origChunks.map((c: any) => ({ ...c, cutBox: undefined, customCutaway: false }))
          },
          () => {
            r.chunks = origChunks
          },
        )
        results[scene.name] = {
          origLightCount,
          culledLightCount: culledCount,
          viewRect: [vx0, vy0, vx1, vy1],
          full,
          sortedChunks,
          frustumLights,
          noLights,
          albedoOnly,
          allOpaquePipe,
        }
      }
      return results
    }, scenes)
    await page.close()
  }

  const thermalEnd = sampleThermal()
  const measured = rawRuns.filter(r => !r.warmup)
  const sceneSummaries: Record<string, any> = {}
  for (const scene of scenes) {
    const sr = measured.filter(r => r.scene === scene.name)
    const pooledFreshGaps = sr.flatMap(r => r.freshSubmissionGapsMs.runs)
    const pooledCallbackGaps = sr.flatMap(r => r.callbackGapsMs.runs)
    const pooledCompleteGaps = sr.flatMap(r => r.gpuCompletionCallbackGapsMs.runs)
    sceneSummaries[scene.name] = {
      warmupRuns,
      measuredRuns: sr.length,
      primary_freshSubmissionGapP95Ms: summarizeSeries(sr.map(r => r.freshSubmissionGapsMs.p95)),
      primary_pooledFreshSubmissionGapsMs: summarizeSeries(pooledFreshGaps),
      primary_realtimeSimRatio: summarizeSeries(sr.map(r => r.realtimeRatio)),
      secondary_freshSubmissionGapMedianMs: summarizeSeries(sr.map(r => r.freshSubmissionGapsMs.median)),
      secondary_freshSubmissionGapP99Ms: summarizeSeries(sr.map(r => r.freshSubmissionGapsMs.p99)),
      secondary_keydownToGpuCompleteCallbackMs: summarizeSeries(
        sr.map(r => r.inputLatencyMs.keydownToGpuCompleteCallbackMs).filter((x): x is number => x !== null),
      ),
      secondary_keydownToSubmitMs: summarizeSeries(
        sr.map(r => r.inputLatencyMs.keydownToSubmitMs).filter((x): x is number => x !== null),
      ),
      secondary_freshStatesPerSecond: summarizeSeries(sr.map(r => r.counts.freshStatesPerSecond)),
      secondary_speedMetersPerWallSecond: summarizeSeries(sr.map(r => r.speedMetersPerWallSecond)),
      nonOverlappingSpansMs: {
        cpuSimStepMs: summarizeSeries(sr.map(r => r.nonOverlappingSpansMs.cpuSimStepMedianMs)),
        cpuVisionStepMs: summarizeSeries(sr.map(r => r.nonOverlappingSpansMs.cpuVisionStepMedianMs)),
        cpuPrepStepMs: summarizeSeries(sr.map(r => r.nonOverlappingSpansMs.cpuPrepStepMedianMs)),
        stepToQueueCompleteMs: summarizeSeries(sr.map(r => r.nonOverlappingSpansMs.stepToQueueCompleteMedianMs)),
        gpuHwDependentIntervalMs: summarizeSeries(sr.map(r => r.nonOverlappingSpansMs.gpuHwDependentIntervalMedianMs)),
      },
      pooledCallbackGapsMs: summarizeSeries(pooledCallbackGaps),
      pooledGpuCompletionCallbackGapsMs: summarizeSeries(pooledCompleteGaps),
      sceneMeta: sr[0]?.sceneMeta,
    }
  }

  const output = {
    label,
    labOverrides,
    recordedAt: new Date().toISOString(),
    note: "GPU queue completion and submission timestamps are not physical display presentation. True display presentation latency is unmeasured.",
    device: {
      gpuInfo,
      adapter: { vendor: "apple", architecture: "metal-3" },
    },
    thermal: { start: thermalStart, end: thermalEnd },
    viewport: { css: [1728, 947], dpr: 2, backingPixels: [3456, 1894] },
    warmupRuns,
    measuredRuns,
    holdMs,
    sceneSummaries,
    ablations,
    rawRuns,
  }

  await Bun.write(resolve(out, `${label}.json`), JSON.stringify(output, null, 2))
  for (const scene of ["street", "interior"] as const) {
    const s = sceneSummaries[scene]
    console.log(
      `METRIC ${scene}_fresh_submit_p95_ms=${s.primary_freshSubmissionGapP95Ms.median.toFixed(3)} mad=${s.primary_freshSubmissionGapP95Ms.mad.toFixed(3)} pooled_p95=${s.primary_pooledFreshSubmissionGapsMs.p95.toFixed(3)}`,
    )
    console.log(
      `METRIC ${scene}_fresh_submit_p50_ms=${s.secondary_freshSubmissionGapMedianMs.median.toFixed(3)} p99_ms=${s.secondary_freshSubmissionGapP99Ms.median.toFixed(3)} states_per_s=${s.secondary_freshStatesPerSecond.median.toFixed(2)}`,
    )
    console.log(
      `METRIC ${scene}_realtime_ratio=${s.primary_realtimeSimRatio.median.toFixed(4)} mad=${s.primary_realtimeSimRatio.mad.toFixed(4)} min=${s.primary_realtimeSimRatio.min.toFixed(4)} speed_mps=${s.secondary_speedMetersPerWallSecond.median.toFixed(3)}`,
    )
    console.log(
      `METRIC ${scene}_gpu_hw_ms=${s.nonOverlappingSpansMs.gpuHwDependentIntervalMs.median.toFixed(3)} mad=${s.nonOverlappingSpansMs.gpuHwDependentIntervalMs.mad.toFixed(3)} queue_span_ms=${s.nonOverlappingSpansMs.stepToQueueCompleteMs.median.toFixed(3)} cpu_prep_ms=${s.nonOverlappingSpansMs.cpuPrepStepMs.median.toFixed(3)}`,
    )
    console.log(
      `METRIC ${scene}_keydown_to_gpu_complete_ms=${s.secondary_keydownToGpuCompleteCallbackMs.median.toFixed(3)} keydown_to_submit_ms=${s.secondary_keydownToSubmitMs.median.toFixed(3)}`,
    )
  }
  if (ablations) {
    console.log(`ABLATIONS ${JSON.stringify(ablations)}`)
  }
} finally {
  await browser.close()
  await server.close()
}
