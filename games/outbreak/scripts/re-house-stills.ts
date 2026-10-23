/**
 * Stills of the start house's entry hall from above at night, for the Resident Evil house study (AR-42):
 * the survivor on the hall runner by the front door, flashlight on, today's look. One headless run.
 *
 *   bun scripts/re-house-stills.ts --mode today [--url https://anoma.ly/arcade/outbreak/] --out <dir>
 *   bun scripts/re-house-stills.ts --mode plate --out <dir>        (local build: painted floor plate off, then on)
 *
 * `today` captures a few hours and zooms with and without the HUD, plus where the hall and living-room floor
 * corners land on screen (for rectifying a paint-over onto the floor). `plate` captures the chosen frame with the
 * Lab's painted floor plate off and on from the same run. Headless Metal Chromium, muted, no visible window.
 * Run through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const mode = arg("mode", "today")!
const out = resolve(arg("out", resolve(game, "../../captures/re-house", mode))!)
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

/** Ash's front door is at (27.7, 35.4); the survivor stands on the runner just inside it, facing up the hall. */
const HALL = { x: 27.7, y: 34.3, aim: -Math.PI / 2 }
/** Floor points projected to the screen: the living room and hall (x 22–30.2, z 29.6–35.5) on a 1 m grid. */
const FLOOR_Y = 0.13
const grid: [number, number][] = []
for (let x = 22; x <= 30.25; x += 1) for (let z = 29.5; z <= 35.55; z += 1) grid.push([x, z])
grid.push([22, 35.5], [30.2, 35.5], [30.2, 29.6], [22, 29.6])

type Shot = { name: string; hour: number; zoom: number; hud: boolean; plate?: number }
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers"

const errors: string[] = []
const meta: Record<string, unknown> = { base, mode, viewport: [1536, 1024], dpr: 1, pose: HALL }

async function still(page: Page, shot: Shot) {
  const info = await page.evaluate(async ({ shot, pose, grid, floorY }) => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", shot.hour)
    h.setZoomRaw(shot.zoom)
    if (shot.plate !== undefined) h.setLab("paintedPlate", shot.plate)
    h.pose(pose.x, pose.y, pose.aim)
    const p = h.state().player
    p.flashlightOn = true
    p.flashlightOutput = 1
    const t0 = performance.now()
    // Let the rug pool (and the plate, when on) bake and upload before the still.
    while (performance.now() - t0 < 15000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim: pose.aim })
      const st = h.interiors?.()
      if (st?.settled && performance.now() - t0 > 800) break
      await new Promise(r => setTimeout(r, 25))
    }
    for (let i = 0; i < 30; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: pose.aim })
    const s = h.state()
    const points = grid.map(([x, z]: [number, number]) => {
      const r = h.resolveTargetRect({ world: [x, floorY, z] })
      return r ? { x, z, sx: r.x + 42, sy: r.y + 42 } : { x, z, sx: null, sy: null }
    })
    const doors = s.town.doors.filter((d: { id: string }) => d.id.startsWith("ash")).map((d: { id: string; open: boolean }) => [d.id, d.open])
    return { doors, hour: s.hour, player: { x: s.player.x, y: s.player.y, aim: s.player.aim, flashlightOn: s.player.flashlightOn }, prompt: document.querySelector("#prompt")?.textContent ?? null, interiors: h.interiors?.() ?? null, quality: h.quality?.() ?? null, points }
  }, { shot, pose: HALL, grid, floorY: FLOOR_Y })
  await page.evaluate(({ sel, hud }) => {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = hud ? "" : "hidden"
    const prompt = document.querySelector<HTMLElement>("#prompt")
    if (prompt) prompt.style.visibility = hud ? "" : "hidden"
  }, { sel: HUD, hud: shot.hud })
  const file = resolve(out, `${shot.name}.png`)
  await page.screenshot({ path: file })
  meta[shot.name] = { ...shot, ...info }
  console.log(shot.name, JSON.stringify({ doors: info.doors, hour: info.hour, prompt: info.prompt, settled: info.interiors?.settled, resident: info.interiors?.resident }))
}

const shots: Shot[] = mode === "plate"
  ? [
      { name: "plate-off", hour: 19, zoom: 26, hud: false, plate: 0 },
      { name: "plate-on", hour: 19, zoom: 26, hud: false, plate: 1 },
    ]
  : [19, 21].flatMap(hour => [26, 32].flatMap(zoom => [
      { name: `hall-${hour}h-z${zoom}-hud`, hour, zoom, hud: true },
      { name: `hall-${hour}h-z${zoom}-clean`, hour, zoom, hud: false },
    ]))

try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`${base}?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60000 })
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const shot of shots) await still(page, shot)
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  fixture?.stop(true)
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
