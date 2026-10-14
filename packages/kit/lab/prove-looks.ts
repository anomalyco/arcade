/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { LOOK_PRESETS, LOOK_PRESET_IDS, type LookPresetId } from "../gpu/look"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(process.env.LOOKS_OUT ?? "/Users/kit/code/home/artifacts/2026-10-14-looks")
const perfDir = resolve(root, "perf")
mkdirSync(out, { recursive: true })
mkdirSync(perfDir, { recursive: true })

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) * 0.5
}

function mad(values: number[], med = median(values)): number {
  return median(values.map(v => Math.abs(v - med)))
}

const labDir = resolve(root, "games/lab")
const outbreakDir = resolve(root, "games/outbreak")
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: labDir, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: outbreakDir, stdout: "inherit", stderr: "inherit" }).exitCode, 0)

const labDist = resolve(labDir, "dist/arcade/lab")
const outbreakDist = resolve(outbreakDir, "dist/arcade/outbreak")

const labServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(labDist, `.${p === "/" ? "/index.html" : p}`))
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})

const outbreakServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(resolve(outbreakDist, `.${p === "/" ? "/index.html" : p}`))
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const errors: string[] = []
try {
  // --- PART 1: Lab "Looks" Debug Room Captures, A/B Wipes, Command Verification & 7-Run Perf ---
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(15000)
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${labServer.port}/?bench`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 25000 })

  const adapter = await page.evaluate(() => {
    const a = (window as any).lab.adapter
    return { vendor: a.vendor, architecture: a.architecture }
  })
  assert.match(adapter.architecture, /metal/i, "Metal WebGPU adapter required")

  const renderStep = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(async () => {
        ;(window as any).lab.advance(1 / 60)
        await (window as any).lab.render(true)
      })
    }
  }

  await page.getByRole("button", { name: "Category Looks", exact: true }).click()
  await page.locator('[data-catalog-id="section:looks"]').click()
  await renderStep(3)
  assert.equal(await page.evaluate(() => (window as any).lab.settings.section), "looks")
  assert.equal(errors.length, 0)

  // Disable temporal grain animation during deterministic capture & comparison
  for (const id of LOOK_PRESET_IDS) {
    const res = await page.evaluate((pid: string) => {
      const r = (window as any).lab.workbench.invoke("look.preset", { preset: pid })
      ;(window as any).lab.workbench.invoke("look.set", { key: "grainAnimated", value: false })
      return r
    }, id)
    assert.equal(res.ok, true)
    await renderStep(3)
    await page.locator("canvas").screenshot({ path: resolve(out, `room-${id}.png`) })
    if (id === "current" || id === "noir" || id === "painterly") {
      await page.screenshot({ path: resolve(out, `workbench-${id}.png`) })
    }
  }

  // Capture A/B wipes vs Current in the Debug Room
  for (const id of ["noir", "painterly", "cinematic_dusk", "sodium_70s", "cozy_golden_hour"] as const) {
    await page.evaluate((pid: string) => {
      ;(window as any).lab.workbench.invoke("look.preset", { preset: pid })
      ;(window as any).lab.workbench.invoke("look.set", { key: "grainAnimated", value: false })
      ;(window as any).lab.workbench.invoke("look.set", { key: "compare", value: 2 })
      ;(window as any).lab.workbench.invoke("look.set", { key: "wipeSplit", value: 0.5 })
    }, id)
    await renderStep(3)
    await page.locator("canvas").screenshot({ path: resolve(out, `room-ab-${id}-vs-current.png`) })
    if (id === "noir") {
      await page.screenshot({ path: resolve(out, "workbench-ab-noir-vs-current.png") })
    }
  }
  await page.evaluate(() => (window as any).lab.workbench.invoke("look.set", { key: "compare", value: 1 }))

  // Measure Debug Room GPU cost per preset: 1 warmup round + 7 alternating rounds across all 6 presets
  const debugRoomSamples: Record<LookPresetId, number[]> = {
    current: [],
    noir: [],
    painterly: [],
    cinematic_dusk: [],
    sodium_70s: [],
    cozy_golden_hour: [],
  }
  for (let round = -1; round < 7; round++) {
    const order = round % 2 === 0 ? [...LOOK_PRESET_IDS] : [...LOOK_PRESET_IDS].reverse()
    for (const id of order) {
      const ms = await page.evaluate(async (pid: string) => {
        ;(window as any).lab.looks.applyPreset(pid)
        await (window as any).lab.render(false)
        let sum = 0
        let count = 0
        for (let f = 0; f < 6; f++) {
          const t = await (window as any).lab.render(true)
          if (typeof t === "number" && t > 0) {
            sum += t
            count++
          }
        }
        return count > 0 ? sum / count : 0
      }, id)
      if (round >= 0 && ms > 0) {
        debugRoomSamples[id].push(Number(ms.toFixed(4)))
      }
    }
  }

  const debugRoomPerf: Record<string, { medianGpuMs: number; madGpuMs: number; deltaVsCurrentMs: number; samples: number[] }> = {}
  const currentMed = median(debugRoomSamples.current)
  for (const id of LOOK_PRESET_IDS) {
    const med = median(debugRoomSamples[id])
    debugRoomPerf[id] = {
      medianGpuMs: Number(med.toFixed(4)),
      madGpuMs: Number(mad(debugRoomSamples[id], med).toFixed(4)),
      deltaVsCurrentMs: Number((med - currentMed).toFixed(4)),
      samples: debugRoomSamples[id],
    }
  }

  // Verify look.randomize & preset export/import
  const randRes = await page.evaluate(() =>
    (window as any).lab.workbench.invoke("look.randomize", { group: "Atmosphere & Shafts", seed: 2026 }),
  )
  assert.equal(randRes.ok, true)
  assert.equal(randRes.result.roomSeed, 7)
  assert.equal(randRes.result.tuningSeed, 2026)

  const exportedJson = await page.evaluate(() => (window as any).lab.looks.exportPresetJson())
  const importedRes = await page.evaluate((raw: string) => (window as any).lab.workbench.importPreset(raw), exportedJson)
  assert.equal(importedRes.ok, true)
  await page.close()

  // --- PART 2: Outbreak Street & Interior Captures + Pixel-Identity Verification under "Current" ---
  const obPage = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  obPage.setDefaultTimeout(15000)
  obPage.on("pageerror", e => errors.push(e.message))
  obPage.on("console", m => {
    if (m.type() === "error") errors.push(m.text())
  })

  await obPage.goto(`http://127.0.0.1:${outbreakServer.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await obPage.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 25000 })

  const poseOutbreak = async (x: number, y: number, aim: number, hour: number, zoom: number) => {
    await obPage.evaluate(
      async ({ x, y, aim, hour, zoom }) => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0)
        h.setLab("hour", hour)
        h.setLab("zoom", zoom)
        h.pose(x, y, aim)
        for (let i = 0; i < 6; i++) await h.step(0)
      },
      { x, y, aim, hour, zoom },
    )
  }

  // Street frame aligned with ~/code/home/artifacts/2026-10-14-outbreak-directions/ (pos 30, 41, 18:00, zoom 42)
  await poseOutbreak(30, 41, -Math.PI / 2, 18, 42)
  const streetBaselineBytes = await obPage.locator("#game").screenshot({ path: resolve(out, "outbreak-street-current.png") })

  // Capture each preset on the Outbreak Street frame
  for (const id of LOOK_PRESET_IDS) {
    if (id === "current") continue
    const presetId: string = id
    await obPage.evaluate(async (pid: string) => {
      const h = (window as any).__arcadeHarness
      h.setLookPreset(pid)
      h.setLook({ grainAnimated: false })
      for (let i = 0; i < 3; i++) await h.step(0)
    }, presetId)
    await obPage.locator("#game").screenshot({ path: resolve(out, `outbreak-street-${id}.png`) })
  }

  // Capture A/B wipe on Outbreak Street for Noir and Painterly vs Current
  for (const id of ["noir", "painterly"] as const) {
    const presetId: string = id
    await obPage.evaluate(async (pid: string) => {
      const h = (window as any).__arcadeHarness
      h.setLookPreset(pid)
      h.setLook({ grainAnimated: false })
      h.setLookCompare(2, 0.5)
      for (let i = 0; i < 3; i++) await h.step(0)
    }, presetId)
    await obPage.locator("#game").screenshot({ path: resolve(out, `outbreak-street-${id}-ab.png`) })
    await obPage.locator("#game").screenshot({ path: resolve(out, `outbreak-street-ab-${id}.png`) })
  }
  await obPage.evaluate(() => (window as any).__arcadeHarness.setLookCompare(1, 0.5))

  // Switch back to "Current" and verify exact byte-for-byte / pixel-identical restoration
  await obPage.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLookPreset("current")
    for (let i = 0; i < 3; i++) await h.step(0)
  })
  const streetRestoredBytes = await obPage.locator("#game").screenshot()
  assert.equal(
    Buffer.compare(streetBaselineBytes, streetRestoredBytes),
    0,
    "Outbreak street frame under 'Current' after switching presets must be byte-for-byte pixel-identical to untouched baseline",
  )

  // Interior cutaway frame aligned with 2026-10-14-outbreak-directions (pos 27.7, 31, 19:00, zoom 34, door opened)
  await poseOutbreak(27.7, 31, -Math.PI / 2, 19, 34)
  await obPage.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    await h.step(1 / 60, { interact: true })
    for (let i = 0; i < 4; i++) await h.step(0)
  })
  for (const id of ["current", "noir", "painterly", "cinematic_dusk", "sodium_70s", "cozy_golden_hour"] as const) {
    await obPage.evaluate(async (pid: string) => {
      const h = (window as any).__arcadeHarness
      h.setLookPreset(pid)
      h.setLook({ grainAnimated: false })
      for (let i = 0; i < 3; i++) await h.step(0)
    }, id)
    await obPage.locator("#game").screenshot({ path: resolve(out, `outbreak-interior-${id}.png`) })
  }

  // Measure Outbreak street frame submission spans across presets (7 alternating rounds)
  await poseOutbreak(30, 41, -Math.PI / 2, 18, 42)
  const outbreakSamples: Record<LookPresetId, number[]> = {
    current: [],
    noir: [],
    painterly: [],
    cinematic_dusk: [],
    sodium_70s: [],
    cozy_golden_hour: [],
  }
  for (let round = -1; round < 7; round++) {
    const order = round % 2 === 0 ? [...LOOK_PRESET_IDS] : [...LOOK_PRESET_IDS].reverse()
    for (const id of order) {
      const ms = await obPage.evaluate(async (pid: string) => {
        const h = (window as any).__arcadeHarness
        h.setLookPreset(pid)
        await h.step(0)
        const t0 = performance.now()
        for (let i = 0; i < 8; i++) await h.step(0)
        return (performance.now() - t0) / 8
      }, id)
      if (round >= 0) outbreakSamples[id].push(Number(ms.toFixed(4)))
    }
  }
  const outbreakPerf: Record<string, { medianSpanMs: number; madSpanMs: number; deltaVsCurrentMs: number; samples: number[] }> = {}
  const obCurMed = median(outbreakSamples.current)
  for (const id of LOOK_PRESET_IDS) {
    const med = median(outbreakSamples[id])
    outbreakPerf[id] = {
      medianSpanMs: Number(med.toFixed(4)),
      madSpanMs: Number(mad(outbreakSamples[id], med).toFixed(4)),
      deltaVsCurrentMs: Number((med - obCurMed).toFixed(4)),
      samples: outbreakSamples[id],
    }
  }

  assert.deepEqual(errors, [])

  const report = {
    date: "2026-10-14",
    adapter,
    pixelIdentityUnderCurrent: {
      verified: true,
      streetBaselineBytes: streetBaselineBytes.byteLength,
      streetRestoredBytes: streetRestoredBytes.byteLength,
      diffBytes: 0,
    },
    debugRoomPerf: {
      viewport: [1280, 800],
      metric: "dependent whole-frame GPU timestamp interval (ms)",
      warmupRounds: 1,
      measuredPairs: 7,
      presets: debugRoomPerf,
    },
    outbreakHookPerf: {
      viewport: [1000, 680],
      metric: "queue-completed frame submission span (ms)",
      warmupRounds: 1,
      measuredPairs: 7,
      presets: outbreakPerf,
    },
    commandsVerified: ["look.preset", "look.set", "look.randomize", "preset.export", "preset.import"],
  }

  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
  writeFileSync(resolve(perfDir, "looks.json"), JSON.stringify(report, null, 2) + "\n")

  // Write visual comparison gallery index.html in out directory
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Arcade Rendering Styles ("Looks") — Debug Room & Outbreak Hook</title>
  <style>
    :root { color-scheme: dark; --bg: #0c1016; --panel: #141a23; --border: #252f3f; --text: #e6ecf5; --muted: #95a3b8; --accent: #7cc5d6; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px 32px 64px; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
    main { max-width: 1440px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    h2 { margin: 28px 0 12px; font-size: 18px; color: var(--accent); }
    p.sub { margin: 0 0 20px; color: var(--muted); }
    .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
    figure { margin: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    figure img { display: block; width: 100%; height: auto; }
    figcaption { padding: 10px 12px; font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--border); }
    figcaption strong { color: var(--text); }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
    th { color: var(--muted); font-weight: 600; background: #10151d; }
  </style>
</head>
<body>
  <main>
    <h1>Arcade Rendering Styles ("Looks") — Debug Room &amp; Outbreak Hook</h1>
    <p class="sub">Shared <code>@arcade/kit/look</code> system &amp; Lab <code>Looks</code> debug room on Apple Metal (${adapter.architecture}). Default "Current" is strict identity (0 diff pixels).</p>

    <h2>1. Lab Debug Room — 6 Presets</h2>
    <div class="grid3">
      ${LOOK_PRESET_IDS.map(id => {
        const def = LOOK_PRESETS[id]
        const p = debugRoomPerf[id]!
        return `<figure>
          <img src="room-${id}.png" alt="${def.label}" />
          <figcaption><strong>${def.label}</strong> (${def.directionRef}) · GPU median <code>${p.medianGpuMs.toFixed(2)} ms</code><br/>${def.summary}</figcaption>
        </figure>`
      }).join("\n")}
    </div>

    <h2>2. Lab Debug Room — Split-Screen A/B Wipes vs Current (Left = Current, Right = Preset)</h2>
    <div class="grid2">
      <figure><img src="room-ab-noir-vs-current.png" alt="Noir vs Current A/B" /><figcaption><strong>A/B Wipe: Current | Noir / Limbo</strong></figcaption></figure>
      <figure><img src="room-ab-painterly-vs-current.png" alt="Painterly vs Current A/B" /><figcaption><strong>A/B Wipe: Current | Painterly</strong></figcaption></figure>
    </div>

    <h2>3. Outbreak Renderer Hook — Street &amp; Interior Cutaway</h2>
    <div class="grid3">
      <figure><img src="outbreak-street-current.png" alt="Outbreak Street Current" /><figcaption><strong>Street — Current (Identity)</strong></figcaption></figure>
      <figure><img src="outbreak-street-noir.png" alt="Outbreak Street Noir" /><figcaption><strong>Street — Noir / Limbo</strong> (Flashlight cone + steel-blue moon + crushed blacks)</figcaption></figure>
      <figure><img src="outbreak-street-painterly.png" alt="Outbreak Street Painterly" /><figcaption><strong>Street — Painterly</strong> (3-band gouache wrap + Kuwahara + ink outlines)</figcaption></figure>
      <figure><img src="outbreak-interior-current.png" alt="Outbreak Interior Current" /><figcaption><strong>Interior — Current (Identity)</strong></figcaption></figure>
      <figure><img src="outbreak-interior-noir.png" alt="Outbreak Interior Noir" /><figcaption><strong>Interior — Noir / Limbo</strong></figcaption></figure>
      <figure><img src="outbreak-interior-painterly.png" alt="Outbreak Interior Painterly" /><figcaption><strong>Interior — Painterly</strong></figcaption></figure>
      <figure><img src="outbreak-street-cinematic_dusk.png" alt="Outbreak Street Cinematic Dusk" /><figcaption><strong>Street — Cinematic dusk</strong></figcaption></figure>
      <figure><img src="outbreak-street-sodium_70s.png" alt="Outbreak Street 70s Sodium" /><figcaption><strong>Street — 70s sodium</strong></figcaption></figure>
      <figure><img src="outbreak-street-cozy_golden_hour.png" alt="Outbreak Street Cozy Golden Hour" /><figcaption><strong>Street — Cozy golden hour</strong></figcaption></figure>
    </div>

    <h2>4. Paired Metal Performance (7 Alternating Runs after Warmup)</h2>
    <table>
      <thead>
        <tr>
          <th>Preset</th>
          <th>Debug Room GPU Median (ms)</th>
          <th>Debug Room MAD (ms)</th>
          <th>Outbreak Street Span Median (ms)</th>
          <th>Outbreak Street MAD (ms)</th>
        </tr>
      </thead>
      <tbody>
        ${LOOK_PRESET_IDS.map(id => {
          const def = LOOK_PRESETS[id]
          const r = debugRoomPerf[id]!
          const o = outbreakPerf[id]!
          return `<tr>
            <td><strong>${def.label}</strong> (<code>${id}</code>)</td>
            <td>${r.medianGpuMs.toFixed(3)} ms</td>
            <td>±${r.madGpuMs.toFixed(3)} ms</td>
            <td>${o.medianSpanMs.toFixed(3)} ms</td>
            <td>±${o.madSpanMs.toFixed(3)} ms</td>
          </tr>`
        }).join("\n")}
      </tbody>
    </table>
  </main>
</body>
</html>`
  writeFileSync(resolve(out, "index.html"), html + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally {
  labServer.stop(true)
  outbreakServer.stop(true)
  await browser.close()
}
