/**
 * Stills, a comparison sheet and a short clip of Bounced light (Lab › Bounced light, AR-115), one headless run:
 *
 *   bun scripts/bounce-stills.ts --out <dir> [--clip]      (via hivemind run --kind browser)
 *
 * Four night scenes at 22:00, each Today, then Bounced light at strength 3 (the default when on) and 5: the ground
 * fire and burning dead south of Ash (`fire.stage burning`), a pistol fired in Ash's living room with the torch off,
 * the torch down Ash's entry hall, and the crossroads east of Ash under its street lamps. `--clip` adds
 * the torch sweeping the hall, Today and Bounced light ×3 side by side. Paired GPU cost is `scripts/ab-gpu.ts` with `AB_B='{"bouncedLight":1}'`.
 * Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/bounce-light"))!)
const clip = process.argv.includes("--clip")
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
type Scene = { name: string; title: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; fire?: boolean; shoot?: boolean; knobs?: Knobs }
// `--variants '[{"name","label","knobs"}]'` replaces these (tuning runs); `--extra '{knobs}'` adds knobs to every variant.
const extra: Knobs = JSON.parse(arg("extra", "{}")!)
const VARIANTS: { name: string; label: string; knobs: Knobs }[] = (JSON.parse(arg("variants", "null")!) ?? [
  { name: "today", label: "Today", knobs: { bouncedLight: 0 } },
  { name: "bounce-3", label: "Bounced light ×3 (default)", knobs: { bouncedLight: 1, bounceStrength: 3 } },
  { name: "bounce-5", label: "Bounced light ×5", knobs: { bouncedLight: 1, bounceStrength: 5 } },
]).map((v: { name: string; label: string; knobs: Knobs }) => ({ ...v, knobs: { ...extra, ...v.knobs } }))
// Ash (seed 7): the entry hall and living room from props-stills; the crossroads lamps from reflections-stills.
const ALL_SCENES: Scene[] = [
  { name: "fire", title: "Ground fire and burning dead, 22:00, torch off", hour: 22, zoom: 24, x: 0, y: 0, aim: 0, flashlight: false, fire: true },
  // The lamps and the baked room light off (Lighting master 0, Look › Lights › Baked room light 0), so the muzzle flash
  // and the torch are the only lights in the house.
  { name: "muzzle", title: "Pistol fired in Ash's living room, 22:00, torch and lamps off", hour: 22, zoom: 22, x: 25.2, y: 32.6, aim: 0, flashlight: false, shoot: true, knobs: { lighting: 0, bakedLight: 0 } },
  { name: "hall", title: "Torch down Ash's entry hall, 22:00, lamps off", hour: 22, zoom: 22, x: 27.7, y: 34.3, aim: -Math.PI / 2, flashlight: true, knobs: { lighting: 0, bakedLight: 0 } },
  { name: "street", title: "Street lamps at the crossroads east of Ash, 22:00, torch off", hour: 22, zoom: 30, x: 51.6, y: 40.8, aim: Math.PI / 2, flashlight: false },
]
const only = arg("scenes")?.split(",")
const SCENES = only ? ALL_SCENES.filter(s => only.includes(s.name)) : ALL_SCENES
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/** Same frozen frame for every variant: warm caches until props and rugs settle, then reset and step a fixed count. */
async function setup(page: Page, s: Scene, knobs: Knobs, aim = s.aim) {
  return page.evaluate(async ({ s, knobs, aim }) => {
    const h = (window as any).__arcadeHarness
    const stage = () => {
      h.freeze(true)
      h.reset(7)
      h.setQuality("high")
      h.setLab("timeScale", 0)
      h.lookPreset("today")
      for (const [key, v] of Object.entries({ ...s.knobs, ...knobs })) h.setLab(key, v)
      h.setZoomRaw(s.zoom)
      const at = s.fire ? h.stageFire("burning") : { x: s.x, y: s.y }
      h.setLab("hour", s.hour)
      h.pose(at.x, at.y, aim)
      if (s.shoot) h.bounceArmPistol()
      return at
    }
    let at = stage()
    const pin = () => Object.assign(h.state().player, { x: at.x, y: at.y, aim, vx: 0, vy: 0, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    at = stage()
    for (let i = 0; i < 120; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim })
    }
    if (s.shoot) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim, fire: true, fireHeld: true })
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim, fireHeld: false })
    }
    return { at, bounce: h.state().bounce, shots: h.state().shots?.length }
  }, { s, knobs, aim })
}

async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  return page
}

/** A labelled grid: one row per scene, Today first. */
async function sheet(page: Page, file: string, rows: { title: string; cells: { label: string; png: string }[] }[]) {
  const img = (p: string) => `data:image/png;base64,${readFileSync(p).toString("base64")}`
  const html = `<body style="margin:0;background:#111;color:#ddd;font:15px/1.3 system-ui;padding:12px">
    <h2 style="margin:4px 0 10px;font-weight:600">Outbreak · Bounced light (AR-115) · Today first</h2>
    ${rows.map(r => `<div style="margin:0 0 14px"><div style="margin:0 0 6px;color:#aaa">${r.title}</div><div style="display:flex;gap:8px">${r.cells
      .map(c => `<figure style="margin:0;flex:1"><img src="${img(c.png)}" style="width:100%;display:block"><figcaption style="padding:4px 0">${c.label}</figcaption></figure>`)
      .join("")}</div></div>`).join("")}</body>`
  await page.setViewportSize({ width: 2100, height: 400 })
  await page.setContent(html)
  await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 88 })
}

try {
  const page = await open(1280, 800)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const scene of SCENES) {
    for (const v of VARIANTS) {
      const info = await setup(page, scene, v.knobs)
      const name = `${scene.name}-${v.name}`
      await page.screenshot({ path: resolve(out, `${name}.png`) })
      ;(meta.shots as Record<string, unknown>)[name] = { scene, variant: v, info }
      console.log(name, JSON.stringify(info))
    }
  }
  if (clip) {
    // The torch sweeping the hall (−150° .. −30°), Today and the first Bounced light variant, 72 frames each.
    const hall = ALL_SCENES.find(s => s.name === "hall")!
    for (const v of VARIANTS.slice(0, 2)) {
      const dir = resolve(out, `clip-${v.name}`)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      await setup(page, hall, v.knobs)
      for (let f = 0; f < 72; f++) {
        const aim = -Math.PI / 2 + Math.sin((f / 72) * Math.PI * 2) * 1.05
        await page.evaluate(async ({ aim, at }) => {
          const h = (window as any).__arcadeHarness
          Object.assign(h.state().player, { x: at.x, y: at.y, aim, vx: 0, vy: 0, flashlightOn: true, flashlightOutput: 1 })
          await h.step(1 / 30, { mx: 0, my: 0, aim })
        }, { aim, at: { x: hall.x, y: hall.y } })
        await page.screenshot({ path: resolve(dir, `${String(f).padStart(3, "0")}.png`) })
      }
    }
    const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24", "-i", resolve(out, "clip-today/%03d.png"), "-framerate", "24", "-i", resolve(out, `clip-${VARIANTS[1]!.name}/%03d.png`),
      "-filter_complex", "[0:v]drawtext=text='Today':x=20:y=20:fontsize=36:fontcolor=white[a];[1:v]drawtext=text='Bounced light':x=20:y=20:fontsize=36:fontcolor=white[b];[a][b]hstack=inputs=2,scale=1920:-2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", resolve(out, "hall-sweep.mp4")])
    if (ff.exitCode !== 0) {
      // Builds without drawtext: plain side by side.
      Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24", "-i", resolve(out, "clip-today/%03d.png"), "-framerate", "24", "-i", resolve(out, `clip-${VARIANTS[1]!.name}/%03d.png`),
        "-filter_complex", "[0:v][1:v]hstack=inputs=2,scale=1920:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", resolve(out, "hall-sweep.mp4")])
    }
  }
  await sheet(page, resolve(out, "compare.jpg"), SCENES.map(s => ({ title: s.title, cells: VARIANTS.map(v => ({ label: v.label, png: resolve(out, `${s.name}-${v.name}.png`) })) })))
  await page.close()
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
