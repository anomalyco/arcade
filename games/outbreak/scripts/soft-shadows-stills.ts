/**
 * Stills of soft character shadows (AR-113, Look · Character shadows), Today then Soft per scene, one headless run:
 *
 *   bun scripts/soft-shadows-stills.ts --out <dir> [--scenes a,b] [--soft '{"softShadowLightSize":3}']
 *   (via hivemind run --kind browser)
 *
 * Scenes (seed 7): a survivor under Ash's street lamp, three of the dead walking into
 * the flashlight down the cross street, two teammates and one of the dead round a ground fire, four co-op players
 * together under the lamp, and three of them by day. Each is a frozen frame; the CPU stats of
 * the soft pass (bodies, capsules, ms) go in meta.json. Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/soft-shadows"))!)
const only = arg("scenes")?.split(",")
const softExtra: Record<string, number> = JSON.parse(arg("soft", "{}")!)
mkdirSync(out, { recursive: true })

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Body = { x: number; y: number; aim: number }
type Scene = {
  name: string
  hour: number
  zoom: number
  /** Survivor position, relative to Ash's street lamp pool when `atLamp`. */
  x: number
  y: number
  aim: number
  flashlight: boolean
  atLamp?: boolean
  /** A ground fire (radius), at `fire` relative to the survivor. */
  fire?: { x: number; y: number; r: number }
  /** Relative to the survivor. */
  zombies?: Body[]
  mates?: Body[]
}
const GROUP: Body[] = [{ x: 1.5, y: 0.1, aim: 2.6 }, { x: 0.5, y: 1.2, aim: -1.4 }, { x: -0.9, y: 0.9, aim: -0.7 }]
const scenes: Scene[] = [
  { name: "streetlamp", hour: 22, zoom: 13, x: 1.4, y: 1.1, aim: 0.5, flashlight: false, atLamp: true },
  {
    name: "flashlight",
    hour: 22.5,
    zoom: 16,
    x: 51.4,
    y: 45.2,
    aim: Math.PI,
    flashlight: true,
    zombies: [{ x: -3.1, y: -0.2, aim: 0 }, { x: -4.4, y: 1.0, aim: -0.3 }, { x: -5.4, y: -1.1, aim: 0.4 }],
  },
  {
    name: "fire",
    hour: 22,
    zoom: 11,
    x: 51.4,
    y: 45.2,
    aim: Math.PI,
    flashlight: false,
    fire: { x: -1.3, y: 0, r: 0.75 },
    mates: [{ x: -2.5, y: 0.8, aim: -0.4 }, { x: -1.2, y: 1.3, aim: -1.6 }],
    zombies: [{ x: -2.4, y: -1.2, aim: 0.6 }],
  },
  { name: "coop", hour: 21.5, zoom: 13, x: 0.2, y: 0.2, aim: 0.6, flashlight: false, atLamp: true, mates: GROUP },
  { name: "day", hour: 16.5, zoom: 13, x: 0.2, y: 0.2, aim: 0.6, flashlight: false, atLamp: true, mates: GROUP.slice(0, 2), zombies: [{ x: -2.4, y: 1.8, aim: 0.2 }] },
].filter(s => !only || only.includes(s.name))

const VARIANTS: [string, Record<string, number>][] = [
  ["today", { softShadowMode: 0 }],
  ["soft", { softShadowMode: 1, ...softExtra }],
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues, .coop-tag"
const errors: string[] = []
const meta: Record<string, unknown> = { scenes: {}, soft: softExtra }

async function setup(page: Page, s: Scene, knobs: Record<string, number>) {
  return page.evaluate(async ({ s, knobs }) => {
    const h = (window as any).__arcadeHarness
    // Ash's street lamp: the start block's (52, 39) lamp resolves to a pool at (40.6, 42.4) (`resolveLampLight` in lighting.ts).
    const lamp = s.atLamp ? { x: 40.6, y: 42.4 } : null
    const stage = () => {
      h.freeze(true)
      h.reset(7)
      h.setQuality("high")
      h.setLab("timeScale", 0)
      h.lookPreset("today")
      for (const [key, v] of Object.entries(knobs)) h.setLab(key, v)
      h.setZoomRaw(s.zoom)
      const at = lamp ? { x: lamp.x + s.x, y: lamp.y + s.y } : { x: s.x, y: s.y }
      h.setLab("hour", s.hour)
      h.pose(at.x, at.y, s.aim)
      if (s.fire) h.placeShadowFire(at.x + s.fire.x, at.y + s.fire.y, s.fire.r)
      for (const z of s.zombies ?? []) h.spawnZombie(at.x + z.x, at.y + z.y, "wander", z.aim)
      for (const m of s.mates ?? []) h.addShadowMate(at.x + m.x, at.y + m.y, m.aim)
      return at
    }
    let at = stage()
    const pin = () => Object.assign(h.state().player, { x: at.x, y: at.y, aim: s.aim, vx: 0, vy: 0, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    at = stage()
    for (let i = 0; i < 40; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    return { at, lamp, softShadows: h.state().softShadows }
  }, { s, knobs })
}

try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const scene of scenes) {
    for (const [variant, knobs] of VARIANTS) {
      const info = await setup(page, scene, knobs)
      const name = `${scene.name}-${variant}`
      await page.screenshot({ path: resolve(out, `${name}.png`) })
      ;(meta.scenes as Record<string, unknown>)[name] = { scene, knobs, info }
      console.log(name, JSON.stringify(info))
    }
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
