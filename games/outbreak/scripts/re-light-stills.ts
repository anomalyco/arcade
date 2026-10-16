/**
 * Before/after stills for the Resident Evil house lighting pass (light-driven colour, dust in the beams, baked room
 * light, floor detail): each shot is captured with the new Look knobs off and on from the same headless run, so the
 * only difference is the knobs. Local build (run `bun run build` first) or `--url`.
 *
 *   bun scripts/re-light-stills.ts [--url <build>] [--main https://anoma.ly/arcade/outbreak/] [--out <dir>] [--only hall,street]
 *
 * `RL_VARIANTS` (JSON `{ name: { knob: value } }`) replaces the default before / colour / after knob sets. `--main`
 * also captures every scene from a second build (production) first, as variant `main`, in the same run.
 *
 * Headless Metal Chromium, muted, no visible window. Run through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(game, "../../captures/re-light"))!)
const only = arg("only")?.split(",")
mkdirSync(out, { recursive: true })

let base = arg("url")
let fixture: ReturnType<typeof Bun.serve> | null = null
if (!base) {
  const root = resolve(game, "dist/arcade/outbreak")
  assert(existsSync(resolve(root, "index.html")), "run bun run build first")
  fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/arcade\/outbreak/, "")
    const file = Bun.file(resolve(root, `.${path === "/" || path === "" ? "/index.html" : path}`))
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
  } })
  base = `http://127.0.0.1:${fixture.port}/arcade/outbreak/`
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Pose = { x: number; y: number; aim: number }
type Scene = { name: string; pose: Pose; hour: number; zoom: number }
/** Knob sets per variant; every variant sets every key so they never leak. */
const OFF = { lightColour: 0, dustAmount: 0 }
const VARIANTS: Record<string, Record<string, number>> = process.env.RL_VARIANTS ? JSON.parse(process.env.RL_VARIANTS) : {
  before: OFF,
  colour: { ...OFF, lightColour: 1 },
  after: { lightColour: 1, dustAmount: 0.6 },
}
/** Optional second build (e.g. production) captured first for every scene, with no knobs set, as variant `main`. */
const mainUrl = arg("main")
const HALL: Pose = { x: 27.7, y: 34.3, aim: -Math.PI / 2 }
const SCENES: Scene[] = [
  { name: "hall-19h", pose: HALL, hour: 19, zoom: 26 },
  { name: "hall-21h", pose: HALL, hour: 21, zoom: 32 },
  { name: "living-21h", pose: { x: 25.2, y: 33.6, aim: Math.PI * 0.9 }, hour: 21, zoom: 26 },
  { name: "bedroom-21h", pose: { x: 27.5, y: 27.2, aim: Math.PI * 0.8 }, hour: 21, zoom: 26 },
  { name: "house-20h", pose: { x: 30.5, y: 30.2, aim: 0 }, hour: 20, zoom: 44 },
  { name: "house-noon", pose: { x: 30.5, y: 30.2, aim: 0 }, hour: 12, zoom: 30 },
  { name: "street-18h", pose: { x: 27.7, y: 41, aim: -Math.PI / 2 }, hour: 18, zoom: 40 },
  { name: "street-noon", pose: { x: 27.7, y: 41, aim: -Math.PI / 2 }, hour: 12, zoom: 40 },
].filter(s => !only || only.some(o => s.name.startsWith(o)))
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt"

const errors: string[] = []
const meta: Record<string, unknown> = { base, viewport: [1536, 1024], dpr: 1, variants: VARIANTS }

async function still(page: Page, scene: Scene, variant: string) {
  const info = await page.evaluate(async ({ scene, knobs }) => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", scene.hour)
    h.setZoomRaw(scene.zoom)
    for (const [k, v] of Object.entries(knobs)) h.setLab(k, v)
    h.pose(scene.pose.x, scene.pose.y, scene.pose.aim)
    const p = h.state().player
    p.flashlightOn = true
    p.flashlightOutput = 1
    const t0 = performance.now()
    while (performance.now() - t0 < 15000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim: scene.pose.aim })
      const st = h.interiors?.()
      if (st?.settled && performance.now() - t0 > 800) break
      await new Promise(r => setTimeout(r, 25))
    }
    for (let i = 0; i < 30; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: scene.pose.aim })
    const s = h.state()
    const st = h.interiors?.()
    return { hour: s.hour, player: { x: s.player.x, y: s.player.y }, tier: h.quality?.()?.activeTier ?? null, floor: st?.floor ?? null, resident: st?.resident, settled: st?.settled }
  }, { scene, knobs: VARIANTS[variant]! })
  await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
  const file = resolve(out, `${scene.name}-${variant}.png`)
  await page.screenshot({ path: file })
  meta[`${scene.name}-${variant}`] = { ...scene, variant, ...info }
  console.log(scene.name, variant, JSON.stringify(info))
}

try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  if (mainUrl) {
    VARIANTS.main = {}
    await page.goto(`${mainUrl}?solo&seed=7&bench&peaceful=1`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60000 })
    for (const scene of SCENES) await still(page, scene, "main")
  }
  await page.goto(`${base}?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60000 })
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const scene of SCENES) for (const variant of Object.keys(VARIANTS)) if (variant !== "main") await still(page, scene, variant)
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  fixture?.stop(true)
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
