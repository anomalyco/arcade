/**
 * Stills and a comparison sheet of the four Lot ports (Lab › Look · Street lamps / Low mist / Contact shadows / Lit
 * rooms), one headless run:
 *
 *   bun scripts/look-ports-stills.ts --out <dir> [--scenes street,mist,contact,rooms] [--extra '{knobs}']
 *     (via hivemind run --kind browser)
 *
 * Four night scenes in Ash's block (seed 7), each Today first, then its feature on: the street lamps at the crossroads
 * east of Ash, Ash's west yard in mist with the torch, the torch over the furniture in Ash's living room, and Ash's
 * front with its lamps on. `--variants '{"street":[{"name","label","knobs"}]}'` replaces a scene's variants (tuning
 * runs). Paired GPU cost is `scripts/ab-gpu.ts` with e.g. `AB_B='{"streetLampStyle":1}'`. Headless Metal Chromium, muted.
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
const out = resolve(arg("out", resolve(root, "../../captures/look-ports"))!)
mkdirSync(out, { recursive: true })

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Knobs = Record<string, number | boolean>
type Variant = { name: string; label: string; knobs: Knobs }
type Scene = { name: string; title: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; knobs?: Knobs; variants: Variant[] }
const extra: Knobs = JSON.parse(arg("extra", "{}")!)
const override: Record<string, Variant[]> = JSON.parse(arg("variants", "{}")!)
const ALL_SCENES: Scene[] = [
  {
    name: "street", title: "Street lamps at the crossroads east of Ash, 22:00, torch off", hour: 22, zoom: 30, x: 45, y: 46, aim: Math.PI / 2, flashlight: false,
    variants: [{ name: "today", label: "Today", knobs: { streetLampStyle: 0 } }, { name: "lens", label: "Lens emitter + street photometry", knobs: { streetLampStyle: 1 } }],
  },
  {
    name: "mist", title: "Ash's west yard and the street, 23:00, torch on", hour: 23, zoom: 38, x: 22.5, y: 42.2, aim: -2.2, flashlight: true,
    variants: [{ name: "today", label: "Today", knobs: { mistStyle: 0 } }, { name: "mist", label: "Low mist in yards and gutters", knobs: { mistStyle: 1 } }],
  },
  {
    name: "contact", title: "Torch over the furniture in Ash's living room, 22:00", hour: 22, zoom: 24, x: 27.2, y: 33.6, aim: -2.6, flashlight: true,
    variants: [{ name: "today", label: "Today", knobs: { contactShadowStyle: 0 } }, { name: "contact", label: "Screen-space contact shadows", knobs: { contactShadowStyle: 1 } }],
  },
  {
    name: "rooms", title: "Ash's front with its lamps on, 21:30, torch off", hour: 21.5, zoom: 24, x: 27.7, y: 40.4, aim: -Math.PI / 2, flashlight: false, knobs: { litWindows: 1 },
    variants: [{ name: "today", label: "Today", knobs: { windowRoomStyle: 0 } }, { name: "rooms", label: "Rooms behind the glass", knobs: { windowRoomStyle: 1 } }],
  },
]
const only = arg("scenes")?.split(",")
const SCENES = (only ? ALL_SCENES.filter(s => only.includes(s.name)) : ALL_SCENES).map(s => ({
  ...s,
  // Every variant starts from Today for all four (settings persist across stages).
  variants: (override[s.name] ?? s.variants).map(v => ({ ...v, knobs: { streetLampStyle: 0, mistStyle: 0, contactShadowStyle: 0, windowRoomStyle: 0, ...extra, ...v.knobs } })),
}))
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/** Same frozen frame for every variant: warm caches until props and rugs settle, then reset and step a fixed count. */
async function setup(page: Page, s: Scene, knobs: Knobs) {
  return page.evaluate(async ({ s, knobs }) => {
    const h = (window as any).__arcadeHarness
    const stage = () => {
      h.freeze(true)
      h.reset(7)
      h.setQuality("high")
      h.setLab("timeScale", 0)
      h.lookPreset("today")
      for (const [key, v] of Object.entries({ ...s.knobs, ...knobs })) h.setLab(key, v)
      h.setZoomRaw(s.zoom)
      h.setLab("hour", s.hour)
      h.pose(s.x, s.y, s.aim)
    }
    stage()
    const pin = () => Object.assign(h.state().player, { x: s.x, y: s.y, aim: s.aim, vx: 0, vy: 0, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    stage()
    // Enough frames for the temporal passes (contact-shadow history) to converge.
    for (let i = 0; i < 120; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    const st = h.state()
    // The frame's lamps (x, h, z, r, power, cone) for checking what the variant packed.
    const L = h.render?.lights as Float32Array | undefined
    const lamps: number[][] = []
    for (let i = 1; L && i < (h.render.lightCount ?? 0); i++) {
      const k = i * 16
      if (L[k + 7]! > 0.001) lamps.push([L[k]!, L[k + 1]!, L[k + 2]!, L[k + 3]!, L[k + 7]!, L[k + 8]!, L[k + 9]!, L[k + 10]!, L[k + 11]!, L[k + 13]!, L[k + 14]!].map(v => Math.round(v * 1000) / 1000))
    }
    return { streetLamps: st.streetLamps, mist: st.mist, contactShadows: st.contactShadows, windowRooms: st.windowRooms, lamps }
  }, { s, knobs })
}

async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  // A cold Vite transform of the whole game takes over 30 s on a loaded worker.
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  return page
}

/** A labelled grid: one row per scene, Today first. */
async function sheet(page: Page, file: string, rows: { title: string; cells: { label: string; png: string }[] }[]) {
  const img = (p: string) => `data:image/png;base64,${readFileSync(p).toString("base64")}`
  const html = `<body style="margin:0;background:#111;color:#ddd;font:15px/1.3 system-ui;padding:12px">
    <h2 style="margin:4px 0 10px;font-weight:600">Outbreak · Lot ports (AR-124) · Today first</h2>
    ${rows.map(r => `<div style="margin:0 0 14px"><div style="margin:0 0 6px;color:#aaa">${r.title}</div><div style="display:flex;gap:8px">${r.cells
      .map(c => `<figure style="margin:0;flex:1"><img src="${img(c.png)}" style="width:100%;display:block"><figcaption style="padding:4px 0">${c.label}</figcaption></figure>`)
      .join("")}</div></div>`).join("")}</body>`
  await page.setViewportSize({ width: 1800, height: 400 })
  await page.setContent(html)
  await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 88 })
}

try {
  const page = await open(1280, 800)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const scene of SCENES) {
    for (const v of scene.variants) {
      const info = await setup(page, scene, v.knobs)
      const name = `${scene.name}-${v.name}`
      await page.screenshot({ path: resolve(out, `${name}.png`) })
      ;(meta.shots as Record<string, unknown>)[name] = { scene: { ...scene, variants: undefined }, variant: v, info }
      console.log(name, JSON.stringify(info))
    }
  }
  await sheet(page, resolve(out, "compare.jpg"), SCENES.map(s => ({ title: s.title, cells: s.variants.map(v => ({ label: v.label, png: resolve(out, `${s.name}-${v.name}.png`) })) })))
  await page.close()
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
