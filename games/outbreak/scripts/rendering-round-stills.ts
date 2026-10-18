/**
 * Captures baseline and candidate stills, comparison sheets, and paired GPU timing (3456×1894)
 * for the Outbreak rendering design round (AR-47).
 *
 *   bun scripts/rendering-round-stills.ts [--out <dir>] [--mode baseline|candidates]
 *
 * Headless Metal Chromium, muted, no visible window. Run through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/outbreak-rendering-round"))!)
const mode = arg("mode", "candidates")!
const rounds = Number(arg("rounds", "6"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "rendering-round-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render })")
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Scene = {
  name: string
  hour: number
  zoom: number
  x: number
  y: number
  aim: number
  flashlight: boolean
}

const SCENES: Record<string, Scene> = {
  streetDay: { name: "street-day-14h", hour: 14, zoom: 46, x: 27.7, y: 41.0, aim: -Math.PI / 2, flashlight: false },
  streetNight: { name: "street-night-21h", hour: 21, zoom: 46, x: 27.7, y: 41.0, aim: -Math.PI / 2, flashlight: true },
  interiorNight: { name: "interior-night-21h", hour: 21, zoom: 46, x: 27.7, y: 31.8, aim: -Math.PI / 2, flashlight: true },
  interiorClose: { name: "interior-close-21h", hour: 21, zoom: 28, x: 27.7, y: 33.8, aim: -Math.PI / 2, flashlight: true },
}

const RESET_KNOBS = {
  groundStyle: 0,
  lightSatStyle: 0,
  modelStyle: 0,
  styleGrade: 0,
}

const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt"
const errors: string[] = []
const meta: Record<string, unknown> = { mode, shots: {}, gpu: {} }

async function open(width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  return page
}

async function setup(page: Page, s: Scene, knobs: Record<string, unknown> = {}, preset = "today") {
  return page.evaluate(async ({ s, knobs, preset, reset }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("propsOn", true)
    h.lookPreset(preset)
    for (const [k, v] of Object.entries(reset)) h.setLab(k, v)
    if (preset !== "today") h.lookPreset(preset)
    for (const [k, v] of Object.entries(knobs)) h.setLab(k, v)
    h.pose(s.x, s.y, s.aim)
    const p = h.state().player
    p.flashlightOn = s.flashlight
    p.flashlightOutput = s.flashlight ? 1 : 0
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if (props?.ready && (rugs?.settled ?? true) && performance.now() - t0 > 450) break
      await new Promise(r => setTimeout(r, 25))
    }
    for (let i = 0; i < 20; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    return {
      hour: h.state().hour,
      props: h.state().props?.lastFrame ?? null,
    }
  }, { s, knobs, preset, reset: RESET_KNOBS })
}

async function capture(page: Page, filename: string, scene: Scene, knobs: Record<string, unknown> = {}, preset = "today"): Promise<string> {
  const info = await setup(page, scene, knobs, preset)
  const file = resolve(out, filename)
  await page.screenshot({ path: file })
  ;(meta.shots as Record<string, unknown>)[filename] = { scene: scene.name, knobs, preset, ...info }
  console.log("captured", filename, JSON.stringify(info.props))
  return file
}

async function sheet(page: Page, file: string, title: string, tiles: { label: string; file: string }[], columns = 2) {
  const img = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`
  await page.setViewportSize({ width: columns * 760 + 36, height: Math.ceil(tiles.length / columns) * 545 + 64 })
  await page.setContent(`<body style="margin:0;padding:16px;background:#0e1013;color:#e6e8ec;font:600 15px -apple-system,BlinkMacSystemFont,sans-serif">
    <div style="font-size:19px;margin:0 0 12px;letter-spacing:-0.01em">${title}</div>
    <div style="display:grid;grid-template-columns:repeat(${columns},748px);gap:14px">
    ${tiles.map(t => `<figure style="margin:0;background:#171a20;border:1px solid #282d37;border-radius:6px;overflow:hidden"><img src="${img(t.file)}" style="width:748px;display:block"><figcaption style="padding:7px 10px;font-size:14px;color:#cfd4dc">${t.label}</figcaption></figure>`).join("")}
    </div></body>`)
  await page.locator("body").screenshot({ path: file })
}

const med = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q)
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2
}

async function measurePair(page: Page, scene: Scene, knobs: Record<string, unknown>, preset = "today") {
  const a: number[] = []
  const b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const on of r % 2 ? [true, false] : [false, true]) {
      await setup(page, scene, on ? knobs : {}, on ? preset : "today")
      const ms = await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const v: number[] = []
        for (let i = 0; i < 16; i++) v.push(await h.renderer.measure(h.render))
        return v.slice(2).sort((x: number, y: number) => x - y)[1]!
      })
      ;(on ? b : a).push(ms)
    }
  }
  const diffs = a.map((x, i) => b[i]! - x)
  const dMed = med(diffs)
  const mad = med(diffs.map(d => Math.abs(d - dMed)))
  return { todayMs: +med(a).toFixed(3), candidateMs: +med(b).toFixed(3), deltaMs: +dMed.toFixed(3), madMs: +mad.toFixed(3) }
}

try {
  const page = await open(1536, 1024, 1)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })

  if (mode === "baseline") {
    for (const s of Object.values(SCENES)) {
      await capture(page, `baseline-${s.name}.png`, s)
    }
  } else {
    // 1. Axis A: Ground candidates (street day & street night)
    const gDay0 = await capture(page, "ground-0-today-day.png", SCENES.streetDay!, { groundStyle: 0, lightSatStyle: 0 })
    const gDay1 = await capture(page, "ground-1-weathered-day.png", SCENES.streetDay!, { groundStyle: 1, lightSatStyle: 1 })
    const gDay2 = await capture(page, "ground-2-rainslick-day.png", SCENES.streetDay!, { groundStyle: 2, lightSatStyle: 1 })
    const gDay3 = await capture(page, "ground-3-overgrown-day.png", SCENES.streetDay!, { groundStyle: 3, lightSatStyle: 1 })

    const gNight0 = await capture(page, "ground-0-today-night.png", SCENES.streetNight!, { groundStyle: 0 })
    const gNight1 = await capture(page, "ground-1-weathered-night.png", SCENES.streetNight!, { groundStyle: 1 })
    const gNight2 = await capture(page, "ground-2-rainslick-night.png", SCENES.streetNight!, { groundStyle: 2 })
    const gNight3 = await capture(page, "ground-3-overgrown-night.png", SCENES.streetNight!, { groundStyle: 3 })

    // 2. Axis B: Lighting saturation curve candidates (interior night, street night, street day)
    const sInt0 = await capture(page, "sat-0-today-interior.png", SCENES.interiorNight!, { lightSatStyle: 0 })
    const sInt1 = await capture(page, "sat-1-pigment-interior.png", SCENES.interiorNight!, { lightSatStyle: 1 })
    const sInt2 = await capture(page, "sat-2-split-interior.png", SCENES.interiorNight!, { lightSatStyle: 2 })
    const sInt3 = await capture(page, "sat-3-amber-interior.png", SCENES.interiorNight!, { lightSatStyle: 3 })

    const sNight0 = gNight0
    const sNight1 = await capture(page, "sat-1-pigment-street.png", SCENES.streetNight!, { lightSatStyle: 1 })
    const sNight2 = await capture(page, "sat-2-split-street.png", SCENES.streetNight!, { lightSatStyle: 2 })
    const sNight3 = await capture(page, "sat-3-amber-street.png", SCENES.streetNight!, { lightSatStyle: 3 })

    const sDay1 = await capture(page, "sat-1-pigment-day.png", SCENES.streetDay!, { lightSatStyle: 1 })

    // 3. Axis C: Model & prop shading candidates (interior default zoom 46 & interior close zoom 28)
    const mInt0 = sInt0
    const mInt1 = await capture(page, "model-1-satin-lod0-z46.png", SCENES.interiorNight!, { modelStyle: 1, lightSatStyle: 1 })
    const mInt2 = await capture(page, "model-2-crisp-rim-z46.png", SCENES.interiorNight!, { modelStyle: 2, lightSatStyle: 1 })
    const mInt3 = await capture(page, "model-3-matte-lod1-z46.png", SCENES.interiorNight!, { modelStyle: 3, lightSatStyle: 1 })

    const mClose0 = await capture(page, "model-0-today-z28.png", SCENES.interiorClose!, { modelStyle: 0, lightSatStyle: 0 })
    const mClose1 = await capture(page, "model-1-satin-lod0-z28.png", SCENES.interiorClose!, { modelStyle: 1, lightSatStyle: 1 })
    const mClose2 = await capture(page, "model-2-crisp-rim-z28.png", SCENES.interiorClose!, { modelStyle: 2, lightSatStyle: 1 })
    const mClose3 = await capture(page, "model-3-matte-lod1-z28.png", SCENES.interiorClose!, { modelStyle: 3, lightSatStyle: 1 })

    // 4. Axis D: Overall style / grade & full combined presets (interior night & street night)
    const pInt0 = sInt0
    const pInt1 = await capture(page, "style-1-re-biohazard-interior.png", SCENES.interiorNight!, {}, "re-biohazard")
    const pInt2 = await capture(page, "style-2-rain-nocturne-interior.png", SCENES.interiorNight!, {}, "rain-nocturne")
    const pInt3 = await capture(page, "style-3-overgrown-lantern-interior.png", SCENES.interiorNight!, {}, "overgrown-lantern")

    const pStreet0 = gNight0
    const pStreet1 = await capture(page, "style-1-re-biohazard-street.png", SCENES.streetNight!, {}, "re-biohazard")
    const pStreet2 = await capture(page, "style-2-rain-nocturne-street.png", SCENES.streetNight!, {}, "rain-nocturne")
    const pStreet3 = await capture(page, "style-3-overgrown-lantern-street.png", SCENES.streetNight!, {}, "overgrown-lantern")

    const pDay1 = await capture(page, "style-1-re-biohazard-day.png", SCENES.streetDay!, {}, "re-biohazard")
    const pDay2 = await capture(page, "style-2-rain-nocturne-day.png", SCENES.streetDay!, {}, "rain-nocturne")

    // Render comparison sheets
    const sheetPage = await browser.newPage({ deviceScaleFactor: 1 })
    await sheet(sheetPage, resolve(out, "sheet-axis-a-ground.png"), "Axis A · Ground Materials & Breakup (Street Day 14:00 & Night 21:00)", [
      { label: "1. Today (stippled road, 72% ochre yard wash) · Day", file: gDay0 },
      { label: "2. Weathered Suburban (macadam, wheel ruts, rich turf) · Day", file: gDay1 },
      { label: "3. Rain-Slick Nocturne (damp wheel ruts & curb puddles) · Day", file: gDay2 },
      { label: "4. Cracked & Overgrown (fractures & creeping moss) · Day", file: gDay3 },
      { label: "1. Today · Night 21:00", file: gNight0 },
      { label: "2. Weathered Suburban · Night 21:00", file: gNight1 },
      { label: "3. Rain-Slick Nocturne · Night 21:00", file: gNight2 },
      { label: "4. Cracked & Overgrown · Night 21:00", file: gNight3 },
    ], 2)

    await sheet(sheetPage, resolve(out, "sheet-axis-b-light-sat.png"), "Axis B · Lighting Saturation Curve (Start House 21:00 & Street 21:00)", [
      { label: "1. Today (51% sepia pre-wash, monochrome orange beam) · Interior", file: sInt0 },
      { label: "2. True Pigment in Light (restores rug/wood/foliage hues) · Interior", file: sInt1 },
      { label: "3. Warm Beam / Cold Moon Split (warm key vs cold slate shadow) · Interior", file: sInt2 },
      { label: "4. Deep Amber Halation (RE S-curve knee & rich bounce) · Interior", file: sInt3 },
      { label: "1. Today · Street 21:00", file: sNight0 },
      { label: "2. True Pigment in Light · Street 21:00", file: sNight1 },
      { label: "3. Warm Beam / Cold Moon Split · Street 21:00", file: sNight2 },
      { label: "4. Deep Amber Halation · Street 21:00", file: sNight3 },
    ], 2)

    await sheet(sheetPage, resolve(out, "sheet-axis-c-models.png"), "Axis C · Model & Prop Shading (Default Zoom 46 & Close Zoom 28)", [
      { label: "1. Today (faceted LOD1 at zoom 46, flat diffuse) · Zoom 46", file: mInt0 },
      { label: "2. Clean LOD0 + Grounded Satin (151k tris, deeper AO, bevel sheen) · Zoom 46", file: mInt1 },
      { label: "3. Crisp Bevel & Rim Relief (LOD0 + silhouette rim catch) · Zoom 46", file: mInt2 },
      { label: "4. Weathered Matte (Fast LOD1 38k tris, deep cavity AO & grain) · Zoom 46", file: mInt3 },
      { label: "1. Today · Close Zoom 28", file: mClose0 },
      { label: "2. Clean LOD0 + Grounded Satin · Close Zoom 28", file: mClose1 },
      { label: "3. Crisp Bevel & Rim Relief · Close Zoom 28", file: mClose2 },
      { label: "4. Weathered Matte · Close Zoom 28", file: mClose3 },
    ], 2)

    await sheet(sheetPage, resolve(out, "sheet-axis-d-style.png"), "Axis D · Overall Style & Combined Directions", [
      { label: "1. Today · Interior 21:00", file: pInt0 },
      { label: "2. RE Biohazard (Weathered + Warm/Cool Split + Clean Satin + Horror Toe)", file: pInt1 },
      { label: "3. Rain-Slick Nocturne (Rain Puddles + Warm/Cool Split + Crisp Rim + Bleach Grade)", file: pInt2 },
      { label: "4. Overgrown & Amber (Cracked Moss + Deep Amber + Clean Satin + Lantern Pools)", file: pInt3 },
      { label: "1. Today · Street 21:00", file: pStreet0 },
      { label: "2. RE Biohazard · Street 21:00", file: pStreet1 },
      { label: "3. Rain-Slick Nocturne · Street 21:00", file: pStreet2 },
      { label: "4. Overgrown & Amber · Street 21:00", file: pStreet3 },
    ], 2)

    const paintDir = resolve(out, "paintovers")
    if (existsSync(resolve(paintDir, "paint-interior-night-21h.png"))) {
      await sheet(sheetPage, resolve(out, "sheet-paintover-vs-engine.png"), "Before (Today) vs Paint-Over Target vs In-Engine Candidates", [
        { label: "Today · Street Day 14:00 (4 m colour circle + road stipple)", file: gDay0 },
        { label: "Paint-Over Target · Street Day 14:00", file: resolve(paintDir, "paint-street-day-14h.png") },
        { label: "In-Engine: RE Biohazard · Street Day 14:00", file: pDay1 },
        { label: "In-Engine: Rain-Slick Nocturne · Street Day 14:00", file: pDay2 },
        { label: "Today · Street Night 21:00", file: pStreet0 },
        { label: "Paint-Over Target · Street Night 21:00", file: resolve(paintDir, "paint-street-night-21h.png") },
        { label: "In-Engine: RE Biohazard · Street Night 21:00", file: pStreet1 },
        { label: "In-Engine: Rain-Slick Nocturne · Street Night 21:00", file: pStreet2 },
        { label: "Today · Start House 21:00 (Zoom 46)", file: pInt0 },
        { label: "Paint-Over Target · Start House 21:00", file: resolve(paintDir, "paint-interior-night-21h.png") },
        { label: "In-Engine: RE Biohazard · Start House 21:00", file: pInt1 },
        { label: "In-Engine: Rain-Slick Nocturne · Start House 21:00", file: pInt2 },
      ], 2)
    }
    await sheetPage.close()

    // 5. Paired GPU timing at 3456×1894
    await page.close()
    const gpuPage = await open(1728, 947, 2)
    meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
    const gpuResults: Record<string, unknown> = {}
    const pairs: { name: string; scene: Scene; knobs: Record<string, unknown>; preset?: string }[] = [
      { name: "ground-1-weathered (street)", scene: SCENES.streetNight!, knobs: { groundStyle: 1 } },
      { name: "ground-2-rainslick (street)", scene: SCENES.streetNight!, knobs: { groundStyle: 2 } },
      { name: "ground-3-overgrown (street)", scene: SCENES.streetNight!, knobs: { groundStyle: 3 } },
      { name: "sat-1-pigment (interior)", scene: SCENES.interiorNight!, knobs: { lightSatStyle: 1 } },
      { name: "sat-2-split (interior)", scene: SCENES.interiorNight!, knobs: { lightSatStyle: 2 } },
      { name: "sat-3-amber (interior)", scene: SCENES.interiorNight!, knobs: { lightSatStyle: 3 } },
      { name: "model-1-satin-lod0 (interior z46)", scene: SCENES.interiorNight!, knobs: { modelStyle: 1 } },
      { name: "model-2-crisp-rim-lod0 (interior z46)", scene: SCENES.interiorNight!, knobs: { modelStyle: 2 } },
      { name: "model-3-matte-lod1 (interior z46)", scene: SCENES.interiorNight!, knobs: { modelStyle: 3 } },
      { name: "preset-re-biohazard (interior z46)", scene: SCENES.interiorNight!, knobs: {}, preset: "re-biohazard" },
      { name: "preset-rain-nocturne (street)", scene: SCENES.streetNight!, knobs: {}, preset: "rain-nocturne" },
    ]
    for (const p of pairs) {
      const res = await measurePair(gpuPage, p.scene, p.knobs, p.preset ?? "today")
      gpuResults[p.name] = res
      console.log("GPU", p.name, JSON.stringify(res))
    }
    meta.gpu = gpuResults
    await gpuPage.close()
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
assert.deepEqual(errors, [])
console.log(out)
