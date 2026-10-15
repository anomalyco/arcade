import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { WEATHER_PRESET_IDS, type WeatherPresetId } from "@arcade/kit/weather"

const repoRoot = resolve(import.meta.dir, "../..")
const outbreakRoot = resolve(repoRoot, "games/outbreak")
const labRoot = resolve(repoRoot, "games/lab")
const artifactDir = resolve(process.env.HOME ?? "/Users/kit", "code/home/artifacts/2026-10-14-weather")
mkdirSync(artifactDir, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary not found")

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2
}
const mad = (xs: number[]): number => {
  const m = median(xs)
  return median(xs.map(x => Math.abs(x - m)))
}

const outbreakServer = await createServer({
  root: outbreakRoot,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "prove-weather-outbreak-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(outbreakRoot, "src/main.ts")) return
        return code.replace(
          "const harness = {",
          "const harness = { renderer, render, lab,",
        )
      },
    },
  ],
})
await outbreakServer.listen()
const outbreakPort = (outbreakServer.httpServer!.address() as { port: number }).port

const labServer = await createServer({
  root: labRoot,
  server: { host: "127.0.0.1", port: 0 },
})
await labServer.listen()
const labPort = (labServer.httpServer!.address() as { port: number }).port

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

try {
  // 1. Outbreak preset captures & per-preset GPU hardware timestamp measurements
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
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

  await page.goto(`http://127.0.0.1:${outbreakPort}/?solo&seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/, `Expected Metal adapter, got ${JSON.stringify(adapter)}`)

  const scenes = [
    { name: "street", x: 30, y: 41, aim: -Math.PI / 2, hour: 18, zoom: 42 },
    { name: "open", x: 27.7, y: 31, aim: -Math.PI / 2, hour: 19, zoom: 34 },
  ] as const

  for (const preset of WEATHER_PRESET_IDS) {
    for (const scene of scenes) {
      await page.evaluate(
        async ({ preset, scene }) => {
          const h = (window as any).__arcadeHarness
          h.reset(7)
          h.setLab("timeScale", 0)
          h.setLab("hour", scene.hour)
          h.setLab("zoom", scene.zoom)
          h.setWeatherPreset(preset)
          for (const [x, y, a] of [
            [30, 41, -1.57],
            [20, 35, -1.57],
            [20, 26, 0],
            [30, 21, 1.57],
            [38, 32, 3.14],
          ] as const) {
            h.pose(x, y, a)
            await h.step()
          }
          h.pose(scene.x, scene.y, scene.aim)
          if (scene.name === "open") await h.step(1 / 60, { interact: true })
          for (let i = 0; i < 18; i++) await h.step(1 / 60)
        },
        { preset, scene },
      )
      await page.screenshot({ path: resolve(artifactDir, `outbreak-${scene.name}-${preset}.png`) })
    }
  }

  // Also capture Storm with active lightning flash & Rain at deep night (hour 20.5) with flashlight aimed across the wet street
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 20.5)
    h.setLab("zoom", 42)
    h.setWeatherPreset("rain")
    h.pose(30, 41, 0.45)
    for (let i = 0; i < 20; i++) await h.step(1 / 60)
  })
  await page.screenshot({ path: resolve(artifactDir, "outbreak-street-rain-night.png") })

  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setWeatherPreset("storm")
    h.strikeLightning(42)
    await h.step(0.02)
  })
  await page.screenshot({ path: resolve(artifactDir, "outbreak-street-storm-lightning.png") })

  // Measure 1 warmup + 7 alternating rounds of GPU hardware timestamps per preset in Outbreak street & interior
  const outbreakPresetGpu: Record<string, Record<string, { medianMs: number; madMs: number; runs: number[] }>> = {
    street: {},
    interior: {},
  }
  for (const p of WEATHER_PRESET_IDS) {
    outbreakPresetGpu.street![p] = { medianMs: 0, madMs: 0, runs: [] }
    outbreakPresetGpu.interior![p] = { medianMs: 0, madMs: 0, runs: [] }
  }

  for (const scene of scenes) {
    const sceneKey = scene.name === "open" ? "interior" : "street"
    await page.evaluate(async s => {
      const h = (window as any).__arcadeHarness
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", s.hour)
      h.setLab("zoom", s.zoom)
      h.pose(s.x, s.y, s.aim)
      if (s.name === "open") await h.step(1 / 60, { interact: true })
      for (let i = 0; i < 8; i++) await h.step(1 / 60)
    }, scene)

    for (let round = 0; round < 8; round++) {
      const order = round % 2 === 0 ? [...WEATHER_PRESET_IDS] : [...WEATHER_PRESET_IDS].reverse()
      for (const preset of order) {
        const ms = await page.evaluate(async p => {
          const h = (window as any).__arcadeHarness
          h.setWeatherPreset(p)
          await h.step(1 / 60)
          const samples: number[] = []
          for (let i = 0; i < 5; i++) {
            samples.push(await h.renderer.measure(h.render))
          }
          samples.sort((a, b) => a - b)
          return samples[2]!
        }, preset)
        if (round >= 1) {
          outbreakPresetGpu[sceneKey]![preset]!.runs.push(Number(ms.toFixed(4)))
        }
      }
    }
    for (const p of WEATHER_PRESET_IDS) {
      const entry = outbreakPresetGpu[sceneKey]![p]!
      entry.medianMs = Number(median(entry.runs).toFixed(4))
      entry.madMs = Number(mad(entry.runs).toFixed(4))
    }
  }
  assert.deepEqual(errors, [])
  await page.close()

  // 2. Unified Lab Weather section proof across game picker entries + per-preset GPU timings
  const labPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const labErrors: string[] = []
  labPage.on("pageerror", e => labErrors.push(e.message))
  labPage.on("console", m => {
    if (m.type() === "error") labErrors.push(m.text())
  })

  for (const gameChoice of ["outbreak", "getaway", "blackout"] as const) {
    await labPage.goto(`http://127.0.0.1:${labPort}/arcade/lab/?game=${gameChoice}&section=weather&bench`)
    await labPage.waitForFunction(() => Boolean((window as any).lab?.weather))
    await labPage.evaluate(async () => {
      const lab = (window as any).lab
      lab.select("weather")
      lab.advance(0.5)
      await lab.render(true)
    })
    const activeSec = await labPage.evaluate(() => (window as any).lab.settings.section)
    assert.equal(activeSec, "weather", `Expected weather section in game=${gameChoice}`)
  }

  await labPage.goto(`http://127.0.0.1:${labPort}/arcade/lab/?section=weather&bench`)
  await labPage.waitForFunction(() => Boolean((window as any).lab?.weather))

  const labPresetGpu: Record<WeatherPresetId, { medianMs: number; madMs: number; runs: number[] }> = {
    clear: { medianMs: 0, madMs: 0, runs: [] },
    drizzle: { medianMs: 0, madMs: 0, runs: [] },
    rain: { medianMs: 0, madMs: 0, runs: [] },
    storm: { medianMs: 0, madMs: 0, runs: [] },
    fog: { medianMs: 0, madMs: 0, runs: [] },
    snow: { medianMs: 0, madMs: 0, runs: [] },
  }

  for (const preset of WEATHER_PRESET_IDS) {
    await labPage.evaluate(async p => {
      const lab = (window as any).lab
      lab.select("weather")
      lab.workbench.invoke("weather.preset", { preset: p })
      for (let i = 0; i < 15; i++) lab.advance(1 / 60)
      await lab.render(true)
    }, preset)
    await labPage.screenshot({ path: resolve(artifactDir, `lab-weather-${preset}.png`) })
  }

  // Capture A/B wipe vs Clear
  await labPage.evaluate(async () => {
    const lab = (window as any).lab
    lab.workbench.invoke("weather.preset", { preset: "rain" })
    lab.workbench.invoke("weather.set", { key: "compare", value: 2 })
    lab.workbench.invoke("weather.set", { key: "wipeSplit", value: 0.48 })
    for (let i = 0; i < 10; i++) lab.advance(1 / 60)
    await lab.render(false)
  })
  await labPage.screenshot({ path: resolve(artifactDir, "lab-weather-ab-wipe.png") })
  await labPage.evaluate(async () => {
    const lab = (window as any).lab
    lab.workbench.invoke("weather.set", { key: "compare", value: 1 })
  })

  // Capture 6-tile Weather Variation Grid
  await labPage.evaluate(async () => {
    const lab = (window as any).lab
    lab.workbench.invoke("grid.open", { preset: "weather" })
    for (let i = 0; i < 8; i++) lab.advance(1 / 60)
    await lab.render(false)
  })
  await labPage.screenshot({ path: resolve(artifactDir, "lab-weather-grid-6.png") })
  await labPage.evaluate(async () => {
    const lab = (window as any).lab
    lab.workbench.invoke("grid.close")
  })

  // Measure 1 warmup + 7 alternating rounds of Lab Weather GPU ms per preset
  for (let round = 0; round < 8; round++) {
    const order = round % 2 === 0 ? [...WEATHER_PRESET_IDS] : [...WEATHER_PRESET_IDS].reverse()
    for (const preset of order) {
      const ms = await labPage.evaluate(async p => {
        const lab = (window as any).lab
        lab.workbench.invoke("weather.preset", { preset: p })
        lab.advance(1 / 60)
        const vals: number[] = []
        for (let i = 0; i < 5; i++) {
          const m = await lab.render(true)
          if (typeof m === "number") vals.push(m)
        }
        vals.sort((a, b) => a - b)
        return vals[Math.floor(vals.length / 2)] ?? 0
      }, preset)
      if (round >= 1) {
        labPresetGpu[preset].runs.push(Number(ms.toFixed(4)))
      }
    }
  }
  for (const p of WEATHER_PRESET_IDS) {
    labPresetGpu[p].medianMs = Number(median(labPresetGpu[p].runs).toFixed(4))
    labPresetGpu[p].madMs = Number(mad(labPresetGpu[p].runs).toFixed(4))
  }

  assert.deepEqual(labErrors, [])
  await labPage.close()

  const report = {
    recordedAt: new Date().toISOString(),
    adapter,
    outbreakViewport: [1000, 680],
    labViewport: [1280, 800],
    outbreakPresetGpuMs: outbreakPresetGpu,
    labPresetGpuMs: labPresetGpu,
  }
  await Bun.write(resolve(artifactDir, "weather-gpu-report.json"), JSON.stringify(report, null, 2))
  await Bun.write(resolve(repoRoot, "perf/weather-lab.json"), JSON.stringify(report, null, 2))
  console.log("WEATHER_PROOF_OK", JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  await outbreakServer.close()
  await labServer.close()
}
