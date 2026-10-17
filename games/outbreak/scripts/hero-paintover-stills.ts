/**
 * Hero and zombie paint-over frames (AR-42), one headless run (via hivemind run --kind browser):
 *
 *   bun scripts/hero-paintover-stills.ts --out <dir> [--looks before,after] [--bench]
 *
 * Captures the survivor in the start house's bedroom and entry hall at 21:00 with the flashlight on, two zombies in
 * the beam up the entry hall, and a group of zombies on the street at dusk: full frame at the game camera plus 2× and
 * 3× crops around the subject. `--looks` picks which looks to capture: `before` is today's survivor and zombies,
 * `after` turns on the refined survivor (Look · Hero › Survivor style › Today, refined) and the refined zombies
 * (Look · Zombies › Zombie look). `--bench` adds paired GPU timing (3456×1894) on the street horde and the bedroom.
 * Headless Metal Chromium, muted, no visible window.
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
const out = resolve(arg("out", resolve(root, "../../captures/hero-paintover"))!)
const looks = arg("looks", "before")!.split(",")
const bench = process.argv.includes("--bench")
const rounds = Number(arg("rounds", "10"))
mkdirSync(out, { recursive: true })

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

type Z = { x: number; y: number; aim: number }
type Shot = { name: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; zombies?: Z[]; walk?: number }
const UP = -Math.PI / 2
const DOWN = Math.PI / 2
const shots: Shot[] = [
  { name: "bedroom-21h", hour: 21, zoom: 26, x: 27.5, y: 27.2, aim: Math.PI * 0.8, flashlight: true },
  { name: "hall-21h", hour: 21, zoom: 26, x: 27.7, y: 34.3, aim: UP, flashlight: true },
  // Two zombies coming down the hall runner into the beam.
  { name: "hall-zombies-21h", hour: 21, zoom: 26, x: 27.7, y: 34.6, aim: UP, flashlight: true, walk: 24, zombies: [{ x: 27.5, y: 31.4, aim: DOWN }, { x: 28.3, y: 30.5, aim: DOWN + 0.2 }] },
  // A loose group crossing the street at dusk, the survivor's beam along the road.
  {
    name: "street-horde-1830", hour: 18.5, zoom: 34, x: 22, y: 44, aim: 0.05, flashlight: true, walk: 30,
    zombies: [
      { x: 26.2, y: 43.1, aim: Math.PI }, { x: 27.0, y: 44.6, aim: Math.PI + 0.2 }, { x: 27.9, y: 43.6, aim: Math.PI - 0.3 },
      { x: 28.6, y: 45.3, aim: Math.PI + 0.4 }, { x: 29.3, y: 42.6, aim: Math.PI - 0.1 }, { x: 30.2, y: 44.3, aim: Math.PI },
      { x: 25.4, y: 45.6, aim: Math.PI - 0.5 },
    ],
  },
]
const LOOKS: Record<string, { label: string; set: Record<string, number> }> = {
  before: { label: "Today", set: { heroStyle: 0, zombieLook: 0 } },
  after: { label: "Refined", set: { heroStyle: 5, zombieLook: 1 } },
}
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

/** Same frame for stills and timing: look, pose, hour, zoom, props settled, then zombies spawned and walked a fixed count of ticks. */
async function setup(page: Page, s: Omit<Shot, "name">, set: Record<string, number>) {
  return page.evaluate(async ({ s, set }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    for (const [k, v] of Object.entries(set)) {
      try { h.setLab(k, v) } catch { /* the before build has no zombieLook */ }
    }
    h.pose(s.x, s.y, s.aim)
    const light = () => {
      const p = h.state().player
      p.flashlightOn = s.flashlight
      p.flashlightOutput = s.flashlight ? 1 : 0
    }
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      light()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
    for (const z of s.zombies ?? []) h.spawnZombie(z.x, z.y, "chase", z.aim)
    for (let i = 0; i < (s.walk ?? 30); i++) {
      light()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    const all = [{ x: s.x, y: s.y }, ...(s.zombies ?? [])]
    const zs = h.session().view.zombies.filter((a: any) => a.state !== "dead").map((a: any) => ({ x: a.x, y: a.y }))
    const group = s.zombies ? zs : all
    const mid: [number, number, number] = [group.reduce((t: number, m: any) => t + m.x, 0) / group.length, 0.9, group.reduce((t: number, m: any) => t + m.y, 0) / group.length]
    const rect = h.resolveTargetRect(s.zombies ? { world: mid } : { objectId: "player" })
    return { look: h.state().look, rect, zombies: zs }
  }, { s, set })
}

async function open(width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  return page
}

const W = 1536
const H = 1024
const img = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`

async function sheet(page: Page, file: string, title: string, rows: { label: string; file: string }[][], tileW: number) {
  const cols = Math.max(...rows.map(r => r.length))
  await page.setViewportSize({ width: cols * (tileW + 12) + 12, height: 200 })
  await page.setContent(`<body style="margin:0;padding:12px;background:#111;color:#ddd;font:15px -apple-system,sans-serif">
    <div style="font-size:18px;margin:0 0 10px">${title}</div>
    ${rows.map(r => `<div style="display:flex;gap:12px;margin-bottom:12px">${r.map(t => `<figure style="margin:0;width:${tileW}px">
      <img src="${img(t.file)}" style="width:${tileW}px;display:block"><figcaption style="margin-top:6px">${t.label}</figcaption></figure>`).join("")}</div>`).join("")}
  </body>`)
  await page.waitForFunction(() => [...document.images].every(i => i.complete))
  await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 90 })
}

try {
  const page = await open(W, H, 2)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  const files: Record<string, string> = {}
  for (const shot of shots) {
    for (const id of looks) {
      const info = await setup(page, shot, LOOKS[id]!.set)
      const name = `${shot.name}-${id}`
      files[name] = resolve(out, `${name}.png`)
      await page.screenshot({ path: files[name] })
      if (info.rect) {
        const cx = info.rect.x + info.rect.width / 2
        const cy = info.rect.y + info.rect.height / 2
        for (const k of [2, 3]) {
          const clip = { x: Math.max(0, Math.min(W - W / k, cx - W / (2 * k))), y: Math.max(0, Math.min(H - H / k, cy - H / (2 * k))), width: W / k, height: H / k }
          files[`${name}-x${k}`] = resolve(out, `${name}-x${k}.png`)
          await page.screenshot({ path: files[`${name}-x${k}`], clip })
        }
      }
      ;(meta.shots as Record<string, unknown>)[name] = { ...shot, look: id, ...info }
      console.log(name, JSON.stringify(info.look), info.zombies.length)
    }
  }
  if (looks.length > 1) {
    const sheetPage = await browser.newPage()
    for (const shot of shots) {
      const row = (k: string) => looks.map(id => ({ label: `${LOOKS[id]!.label}${k ? ` (${k})` : ""}`, file: files[`${shot.name}-${id}${k ? `-${k}` : ""}`]! }))
      await sheet(sheetPage, resolve(out, `compare-${shot.name}.jpg`), shot.name, [row("x3"), row("x2"), row("")], 760)
    }
    await sheetPage.close()
  }

  if (bench && looks.length > 1) {
    await page.close()
    const gpuPage = await open(1728, 947, 2)
    meta.gpuViewport = await gpuPage.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
    const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
    const gpu: Record<string, unknown> = {}
    for (const shot of [shots[3]!, shots[0]!]) {
      const a: number[] = [], b: number[] = []
      for (let r = 0; r < rounds; r++) {
        for (const after of r % 2 ? [true, false] : [false, true]) {
          await setup(gpuPage, shot, LOOKS[after ? "after" : "before"]!.set)
          const ms = await gpuPage.evaluate(async () => {
            const h = (window as any).__arcadeHarness
            const v: number[] = []
            for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
            return v.slice(2).sort((x: number, y: number) => x - y)[1]!
          })
          ;(after ? b : a).push(ms)
        }
      }
      const diffs = a.map((x, i) => b[i]! - x)
      gpu[shot.name] = { before: med(a), after: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map(d => Math.abs(d - med(diffs)))), raw: { a, b } }
      console.log(`GPU ${shot.name} before=${med(a).toFixed(3)} after=${med(b).toFixed(3)} paired Δ=${med(diffs).toFixed(3)} ms`)
    }
    meta.gpu = gpu
  }
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
