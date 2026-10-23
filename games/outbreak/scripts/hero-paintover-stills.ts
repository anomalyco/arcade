/**
 * Colour Blocks survivors & Former Townsfolk zombies (AR-42 / D-31), one headless run (via hivemind run --kind browser):
 *
 *   bun scripts/hero-paintover-stills.ts --out <dir> [--looks before,after] [--bench]
 *
 * Captures before (Today boxes: heroStyle=0, zombieLook=0) vs after (Colour Blocks + Former Townsfolk: heroStyle=5,
 * zombieLook=1) across:
 *   - solo survivor (night 21:00 & day 14:00)
 *   - 4 co-op survivors side by side (Cole, Maya, Hank, Tess; night 21:00 & day 14:00)
 *   - horde of townsfolk zombies (night 21:00 & day 14:00)
 * Plus 2×/3× crops, side-by-side comparison contact sheets, and paired GPU + CPU timing at 3456×1894.
 * Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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
const out = resolve(arg("out", resolve(root, "../../captures/outbreak-characters"))!)
const looks = arg("looks", "before,after")!.split(",")
const only = arg("only")?.split(",").filter(Boolean) ?? null
const bench = process.argv.includes("--bench")
const rounds = Number(arg("rounds", "8"))
mkdirSync(out, { recursive: true })

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
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

type Z = { x: number; y: number; aim: number }
type Companion = { id: string; index: number; x: number; y: number; aim: number; flashlight: boolean }
type Shot = {
  name: string
  hour: number
  zoom: number
  x: number
  y: number
  aim: number
  flashlight: boolean
  companions?: Companion[]
  zombies?: Z[]
  walk?: number
}

const UP = -Math.PI / 2
const DOWN = Math.PI / 2

const COOP_LINEUP: Companion[] = [
  { id: "maya", index: 1, x: 27.15, y: 39.75, aim: DOWN - 0.15, flashlight: true },
  { id: "hank", index: 2, x: 27.95, y: 40.0, aim: DOWN + 0.08, flashlight: true },
  { id: "tess", index: 3, x: 28.75, y: 40.25, aim: DOWN + 0.24, flashlight: true },
]

const STREET_HORDE: Z[] = [
  { x: 25.8, y: 43.2, aim: Math.PI + 0.08 },
  { x: 26.5, y: 44.5, aim: Math.PI - 0.12 },
  { x: 27.2, y: 43.5, aim: Math.PI + 0.22 },
  { x: 27.9, y: 44.9, aim: Math.PI - 0.18 },
  { x: 28.6, y: 42.9, aim: Math.PI + 0.05 },
  { x: 29.3, y: 44.1, aim: Math.PI - 0.08 },
  { x: 30.0, y: 45.2, aim: Math.PI + 0.25 },
  { x: 26.2, y: 45.5, aim: Math.PI - 0.32 },
  { x: 28.2, y: 45.8, aim: Math.PI - 0.15 },
  { x: 29.8, y: 43.2, aim: Math.PI + 0.14 },
  { x: 30.8, y: 44.3, aim: Math.PI },
  { x: 27.4, y: 42.6, aim: Math.PI + 0.3 },
]

const shots: Shot[] = [
  // Solo survivor (night & day)
  { name: "solo-night-21h", hour: 21, zoom: 26, x: 27.7, y: 34.3, aim: UP, flashlight: true },
  { name: "solo-day-14h", hour: 14, zoom: 26, x: 27.7, y: 40.4, aim: DOWN + 0.25, flashlight: false },
  // 4 co-op survivors side by side (night & day)
  {
    name: "coop-night-21h",
    hour: 21,
    zoom: 28,
    x: 26.35,
    y: 39.5,
    aim: 0.65,
    flashlight: true,
    companions: COOP_LINEUP,
    walk: 18,
  },
  {
    name: "coop-day-14h",
    hour: 14,
    zoom: 28,
    x: 26.35,
    y: 39.5,
    aim: 0.65,
    flashlight: false,
    companions: COOP_LINEUP.map(c => ({ ...c, flashlight: false })),
    walk: 18,
  },
  // Horde of Former Townsfolk zombies (night & day)
  {
    name: "horde-night-21h",
    hour: 21,
    zoom: 32,
    x: 22.4,
    y: 44.1,
    aim: 0.04,
    flashlight: true,
    zombies: STREET_HORDE,
    walk: 26,
  },
  {
    name: "horde-day-14h",
    hour: 14,
    zoom: 32,
    x: 22.4,
    y: 44.1,
    aim: 0.04,
    flashlight: false,
    zombies: STREET_HORDE,
    walk: 26,
  },
]

const LOOKS: Record<string, { label: string; set: Record<string, number> }> = {
  before: { label: "Before (Today boxes)", set: { heroStyle: 0, zombieLook: 0 } },
  v1: { label: "Before (Former Townsfolk v1)", set: { heroStyle: 5, zombieLook: 2 } },
  after: { label: "After (Undead Former Townsfolk)", set: { heroStyle: 5, zombieLook: 1 } },
}
const activeShots = only ? shots.filter(s => only.includes(s.name)) : shots
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

async function waitForWorldReady(page: Page) {
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      await h.step(1 / 60, { mx: 0, my: 0, aim: -Math.PI / 2 })
      const props = h.state().props
      const rugs = h.interiors?.()
      if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 25))
    }
  })
}

async function setup(page: Page, s: Omit<Shot, "name">, set: Record<string, number>) {
  return page.evaluate(async ({ s, set }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    for (const [k, v] of Object.entries(set)) {
      try { h.setLab(k, v) } catch { /* ignore */ }
    }
    const sim = h.session().sim
    while (sim.slots.length > 1) sim.removeSurvivor(sim.slots[1]!.id)
    sim.ai.agents.length = 0
    sim.ai.nextId = 1
    h.pose(s.x, s.y, s.aim)
    const addedSlots: any[] = []
    for (const c of s.companions ?? []) {
      const slot = sim.addSurvivor(c.id, c.index)
      slot.survivor.x = c.x
      slot.survivor.y = c.y
      slot.survivor.aim = c.aim
      slot.survivor.flashlightOn = c.flashlight
      slot.survivor.flashlightOutput = c.flashlight ? 1 : 0
      addedSlots.push({ slot, spec: c })
    }
    const pinActors = () => {
      const p = h.state().player
      p.x = s.x
      p.y = s.y
      p.aim = s.aim
      p.flashlightOn = s.flashlight
      p.flashlightOutput = s.flashlight ? 1 : 0
      for (const { slot, spec } of addedSlots) {
        slot.survivor.x = spec.x
        slot.survivor.y = spec.y
        slot.survivor.aim = spec.aim
        slot.survivor.vx = 0
        slot.survivor.vy = 0
        slot.survivor.flashlightOn = spec.flashlight
        slot.survivor.flashlightOutput = spec.flashlight ? 1 : 0
      }
    }
    ;(s.zombies ?? []).forEach((z, idx) => {
      h.spawnZombie(z.x, z.y, "chase", z.aim)
      const a = sim.ai.agents[sim.ai.agents.length - 1]
      if (a) a.seed = ((idx + 1) * 2654435761) >>> 0
    })
    for (let i = 0; i < (s.walk ?? 18); i++) {
      pinActors()
      ;(s.zombies ?? []).forEach((z, idx) => {
        const a = sim.ai.agents[idx]
        if (a) {
          a.x = z.x + Math.cos(z.aim) * i * 0.024
          a.y = z.y + Math.sin(z.aim) * i * 0.024
          a.aim = z.aim
          a.vx = Math.cos(z.aim) * 1.45
          a.vy = Math.sin(z.aim) * 1.45
        }
      })
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    const zs = h.session().view.zombies.filter((a: any) => a.state !== "dead").map((a: any) => ({ x: a.x, y: a.y }))
    const focusGroup = s.zombies?.length
      ? zs
      : s.companions?.length
        ? [{ x: s.x, y: s.y }, ...s.companions.map(c => ({ x: c.x, y: c.y }))]
        : [{ x: s.x, y: s.y }]
    const mid: [number, number, number] = [
      focusGroup.reduce((t: number, m: any) => t + m.x, 0) / focusGroup.length,
      0.9,
      focusGroup.reduce((t: number, m: any) => t + m.y, 0) / focusGroup.length,
    ]
    const rect = h.resolveTargetRect(s.zombies?.length || s.companions?.length ? { world: mid } : { objectId: "player" })
    return { look: h.state().look, rect, zombies: zs.length, companions: addedSlots.length }
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
  const payload = rows.map(r => r.map(t => ({ label: t.label, src: img(t.file) })))
  const jpegDataUrl = await page.evaluate(
    async ({ title, payload, tileW }) => {
      const loaded = await Promise.all(
        payload.map(r =>
          Promise.all(
            r.map(async t => {
              const image = new Image()
              image.src = t.src
              await image.decode()
              return { label: t.label, image, h: Math.round((image.height / image.width) * tileW) }
            }),
          ),
        ),
      )
      const cols = Math.max(...loaded.map(r => r.length))
      const pad = 12
      const capH = 26
      const titleH = 32
      const rowHeights = loaded.map(r => Math.max(...r.map(t => t.h)) + capH)
      const totalW = cols * (tileW + pad) + pad
      const totalH = pad + titleH + rowHeights.reduce((a, b) => a + b + pad, 0)
      const c = document.createElement("canvas")
      c.width = totalW * 2
      c.height = totalH * 2
      const ctx = c.getContext("2d")!
      ctx.scale(2, 2)
      ctx.fillStyle = "#111"
      ctx.fillRect(0, 0, totalW, totalH)
      ctx.fillStyle = "#ddd"
      ctx.font = "600 18px -apple-system, sans-serif"
      ctx.fillText(title, pad, pad + 20)
      let y = pad + titleH
      ctx.font = "15px -apple-system, sans-serif"
      for (let ri = 0; ri < loaded.length; ri++) {
        const row = loaded[ri]!
        for (let ci = 0; ci < row.length; ci++) {
          const item = row[ci]!
          const x = pad + ci * (tileW + pad)
          ctx.drawImage(item.image, x, y, tileW, item.h)
          ctx.fillStyle = "#ddd"
          ctx.fillText(item.label, x, y + item.h + 19)
        }
        y += rowHeights[ri]! + pad
      }
      return c.toDataURL("image/jpeg", 0.9)
    },
    { title, payload, tileW },
  )
  writeFileSync(file, Buffer.from(jpegDataUrl.split(",")[1]!, "base64"))
}

try {
  const page = await open(W, H, 2)
  await waitForWorldReady(page)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  const files: Record<string, string> = {}
  for (const shot of activeShots) {
    for (const id of looks) {
      const info = await setup(page, shot, LOOKS[id]!.set)
      const name = `${shot.name}-${id}`
      files[name] = resolve(out, `${name}.png`)
      const cx = info.rect ? info.rect.x + info.rect.width / 2 : W / 2
      const cy = info.rect ? info.rect.y + info.rect.height / 2 : H / 2
      const captured = await page.evaluate(
        ({ cx, cy, W, H, hasRect }) => {
          const h = (window as any).__arcadeHarness
          h.renderer.draw(h.render)
          const game = document.querySelector<HTMLCanvasElement>("#game")
          if (!game || game.width === 0) return null
          const fullCanvas = document.createElement("canvas")
          fullCanvas.width = game.width
          fullCanvas.height = game.height
          const fctx = fullCanvas.getContext("2d")!
          fctx.drawImage(game, 0, 0)
          const px = fctx.getImageData(game.width >> 1, game.height >> 1, 1, 1).data
          if (px[0] === 0 && px[1] === 0 && px[2] === 0 && px[3] === 0) return null
          const res: { full: string; x2?: string; x3?: string } = { full: fullCanvas.toDataURL("image/png") }
          if (hasRect) {
            const dpr = game.width / W
            for (const k of [2, 3] as const) {
              const cw = W / k
              const ch = H / k
              const sx = Math.max(0, Math.min(W - cw, cx - cw / 2)) * dpr
              const sy = Math.max(0, Math.min(H - ch, cy - ch / 2)) * dpr
              const sw = Math.round(cw * dpr)
              const sh = Math.round(ch * dpr)
              const c = document.createElement("canvas")
              c.width = sw
              c.height = sh
              c.getContext("2d")!.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh)
              res[k === 2 ? "x2" : "x3"] = c.toDataURL("image/png")
            }
          }
          return res
        },
        { cx, cy, W, H, hasRect: Boolean(info.rect) },
      )
      if (captured) {
        writeFileSync(files[name], Buffer.from(captured.full.split(",")[1]!, "base64"))
        if (captured.x2) {
          files[`${name}-x2`] = resolve(out, `${name}-x2.png`)
          writeFileSync(files[`${name}-x2`]!, Buffer.from(captured.x2.split(",")[1]!, "base64"))
        }
        if (captured.x3) {
          files[`${name}-x3`] = resolve(out, `${name}-x3.png`)
          writeFileSync(files[`${name}-x3`]!, Buffer.from(captured.x3.split(",")[1]!, "base64"))
        }
      } else {
        await page.screenshot({ path: files[name], timeout: 60000 })
      }
      ;(meta.shots as Record<string, unknown>)[name] = { ...shot, ...info, lookId: id }
      console.log(name, JSON.stringify(info.look), `zombies=${info.zombies}`, `companions=${info.companions}`)
    }
  }

  if (bench && looks.length > 1) {
    const baseLookId = looks[0]!
    const nextLookId = looks[1]!
    await page.setViewportSize({ width: 1728, height: 947 })
    meta.gpuViewport = await page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
    const med = (xs: number[]) => {
      const s = [...xs].sort((p, q) => p - q)
      return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2
    }
    const denseHordeZombies: Z[] = Array.from({ length: 60 }, (_, i) => ({
      x: 24.5 + (i % 10) * 0.72,
      y: 41.8 + Math.floor(i / 10) * 0.72,
      aim: Math.PI + ((i % 5) - 2) * 0.08,
    }))
    const benchShots: Shot[] = only
      ? [
          {
            name: "horde-60-night-21h",
            hour: 21,
            zoom: 34,
            x: 21.8,
            y: 44.0,
            aim: 0.02,
            flashlight: true,
            zombies: denseHordeZombies,
            walk: 16,
          },
        ]
      : [
          {
            name: "horde-60-night-21h",
            hour: 21,
            zoom: 34,
            x: 21.8,
            y: 44.0,
            aim: 0.02,
            flashlight: true,
            zombies: denseHordeZombies,
            walk: 16,
          },
          shots[2]!, // coop-night-21h (4 co-op survivors)
          shots[0]!, // solo-night-21h
        ]
    const perf: Record<string, unknown> = {}
    for (const shot of benchShots) {
      await setup(page, shot, LOOKS[baseLookId]!.set)
      const gpuA: number[] = []
      const gpuB: number[] = []
      const cpuA: number[] = []
      const cpuB: number[] = []
      for (let r = 0; r < rounds; r++) {
        for (const after of r % 2 ? [true, false] : [false, true]) {
          const set = LOOKS[after ? nextLookId : baseLookId]!.set
          const res = await page.evaluate(async ({ set, aim }) => {
            const h = (window as any).__arcadeHarness
            for (const [k, v] of Object.entries(set)) h.setLab(k, v)
            await h.step(1 / 60, { mx: 0, my: 0, aim })
            const g: number[] = []
            const c: number[] = []
            for (let i = 0; i < 12; i++) {
              const t0 = performance.now()
              const gpuMs = await h.renderer.measure(h.render)
              const cpuMs = performance.now() - t0
              g.push(gpuMs)
              c.push(cpuMs)
            }
            const gSorted = g.slice(2).sort((x: number, y: number) => x - y)
            const cSorted = c.slice(2).sort((x: number, y: number) => x - y)
            return { gpu: gSorted[gSorted.length >> 1]!, cpu: cSorted[cSorted.length >> 1]! }
          }, { set, aim: shot.aim })
          ;(after ? gpuB : gpuA).push(res.gpu)
          ;(after ? cpuB : cpuA).push(res.cpu)
        }
      }
      const gpuDiffs = gpuA.map((x, i) => gpuB[i]! - x)
      const cpuDiffs = cpuA.map((x, i) => cpuB[i]! - x)
      perf[shot.name] = {
        gpuBeforeMs: med(gpuA),
        gpuAfterMs: med(gpuB),
        gpuPairedDeltaMedianMs: med(gpuDiffs),
        gpuPairedDeltaMadMs: med(gpuDiffs.map(d => Math.abs(d - med(gpuDiffs)))),
        cpuBeforeMs: med(cpuA),
        cpuAfterMs: med(cpuB),
        cpuPairedDeltaMedianMs: med(cpuDiffs),
        cpuPairedDeltaMadMs: med(cpuDiffs.map(d => Math.abs(d - med(cpuDiffs)))),
      }
      console.log(
        `PERF ${shot.name}: GPU before=${med(gpuA).toFixed(3)}ms after=${med(gpuB).toFixed(3)}ms Δ=${med(gpuDiffs).toFixed(3)}ms | CPU before=${med(cpuA).toFixed(3)}ms after=${med(cpuB).toFixed(3)}ms Δ=${med(cpuDiffs).toFixed(3)}ms`,
      )
    }
    meta.perf = perf
  }

  if (looks.length > 1) {
    for (const shot of activeShots) {
      const row = (k: string) =>
        looks.map(id => ({
          label: `${LOOKS[id]!.label}${k ? ` (${k})` : ""}`,
          file: files[`${shot.name}-${id}${k ? `-${k}` : ""}`]!,
        }))
      await sheet(page, resolve(out, `compare-${shot.name}.jpg`), shot.name, [row("x3"), row("x2"), row("")], 760)
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
