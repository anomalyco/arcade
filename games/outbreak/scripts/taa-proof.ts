/**
 * One combined run for the anti-aliasing modes (AR-72): MSAA (today) vs TAA vs TAA + upscale.
 *
 *   bun scripts/taa-proof.ts --out <dir> [--rounds 5] [--scale 0.67] [--only gpu,flicker,ghost,stills,clip]
 *
 * - gpu: paired GPU time (timestamp queries, `renderer.measure`) and frame time (wall time of a harness step: sim,
 *   draw, GPU done) at 1728×947 CSS × 2 (3456×1894), the three modes rotated each round on the same pose.
 * - flicker: the look's walking flicker metric (`look-beauty.ts --mode flicker`) per mode.
 * - ghost: a fast zombie crossing, a flashlight swing, rain and a burning scene (kit fire, smoke and sparks), each
 *   mode against MSAA frame for frame;
 *   reports the worst 32-px tile difference while moving over the same in a converged still, plus crop sheets.
 * - stills: converged 3456×1894 stills per mode and a 1:1 crop sheet.
 * - clip: a muted 60 fps side-by-side (MSAA | TAA | TAA + upscale) of a night walk with the flashlight swinging,
 *   1:1 device pixels from the middle of the screen.
 *
 * Headless Metal Chromium, muted, no visible window: run it through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Browser, type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer, type ViteDevServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/taa-proof"))!)
const rounds = Number(arg("rounds", "5"))
const scale = Number(arg("scale", "0.67"))
const only = new Set(arg("only", "gpu,flicker,ghost,stills,clip")!.split(","))
mkdirSync(out, { recursive: true })

const MODES = [
  { id: "msaa", label: "MSAA (today)", knobs: { aaMode: 0 } },
  { id: "taa", label: "TAA", knobs: { aaMode: 1 } },
  { id: "taau", label: `TAA + upscale ${scale}`, knobs: { aaMode: 2, aaRenderScale: scale } },
] as const
type Mode = (typeof MODES)[number]

type Scene = { name: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; horde?: boolean; rain?: boolean }
const NORTH = -Math.PI / 2
const ZOOM = 38
const SCENES: Scene[] = [
  { name: "street-night-21h", hour: 21, zoom: ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: true },
  { name: "horde-night-21h", hour: 21, zoom: ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: true, horde: true },
  { name: "start-house-21h", hour: 21, zoom: ZOOM, x: 27.7, y: 31.8, aim: NORTH, flashlight: true },
  { name: "street-day-14h", hour: 14, zoom: ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: false },
]
const scene = (name: string) => SCENES.find((s) => s.name === name)!
const HORDE: [number, number, number][] = [
  [27.4, 37.6, Math.PI / 2], [28.3, 37.2, Math.PI / 2 + 0.18], [26.6, 38.2, Math.PI / 2 - 0.22], [28.9, 38.5, Math.PI / 2 + 0.25],
  [27.8, 36.2, Math.PI / 2], [26.1, 36.9, Math.PI / 2 - 0.15], [29.5, 37.4, Math.PI / 2 + 0.3], [24.8, 39.2, 0.35],
]
const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
const errors: string[] = []
const meta: Record<string, any> = { scale, rounds, gpu: {}, frame: {}, flicker: {}, ghost: {}, stills: {}, clip: null }
const save = () => writeFileSync(resolve(out, "meta.json"), JSON.stringify({ ...meta, errors }, null, 2))

function chromiumPath(): string {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const p = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
  assert(p)
  return p
}

async function serve(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(root, "../..")] } },
  })
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1` }
}

async function open(browser: Browser, url: string, width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  return page
}

/** Resets to seed 7 at the scene's pose with the clock stopped, applies `knobs`, and waits for props and rugs. */
async function setup(page: Page, s: Scene, knobs: Record<string, unknown>) {
  return page.evaluate(async ({ s, k, horde }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("propsOn", true)
    h.setLab("weather.weatherOverride", s.rain ? 2 : -1)
    h.lookPreset("today")
    for (const [key, v] of Object.entries(k)) {
      try {
        h.setLab(key, v)
      } catch (e) {
        if (key.startsWith("aa")) throw e // the modes under test must apply; look knobs may be absent
      }
    }
    h.pose(s.x, s.y, s.aim)
    const sim = h.session?.()?.sim
    if (sim) while (sim.slots.length > 1) sim.removeSurvivor(sim.slots[1]!.id)
    if (s.horde && sim?.ai && sim?.town) {
      horde.forEach(([zx, zy, za]: number[], i: number) => {
        const z = sim.ai.spawnZombie(sim.town, zx, zy, "chase", i)
        if (z) z.h = za
      })
    }
    const pin = () => Object.assign(h.state().player, { x: s.x, y: s.y, aim: s.aim, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    pin()
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if (props?.ready && (rugs?.settled ?? true) && performance.now() - t0 > 120) break
      await new Promise((r) => setTimeout(r, 15))
    }
    for (let i = 0; i < 12; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    return h.state().antiAliasing ?? null
  }, { s, k: knobs, horde: HORDE })
}

/** Holds still for `n` frames (converges the history). */
async function hold(page: Page, s: Scene, n: number) {
  await page.evaluate(async ({ s, n }) => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < n; i++) {
      Object.assign(h.state().player, { x: s.x, y: s.y, aim: s.aim, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
  }, { s, n })
}

const med = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q)
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2
}

/** Switches mode in place, warms 4 frames, then GPU ms (median of 8 timestamped frames) and 12 timed steps. */
async function sample(page: Page, s: Scene, mode: Mode) {
  return page.evaluate(async ({ s, k }) => {
    const h = (window as any).__arcadeHarness
    for (const [key, v] of Object.entries(k)) h.setLab(key, v)
    const pin = () => Object.assign(h.state().player, { x: s.x, y: s.y, aim: s.aim, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
    for (let i = 0; i < 4; i++) { pin(); await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim }) }
    const gpu: number[] = []
    for (let i = 0; i < 10; i++) gpu.push(await h.renderer.measure(h.render))
    const step: number[] = []
    const queue: number[] = []
    for (let i = 0; i < 12; i++) {
      pin()
      const t = performance.now()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      step.push(performance.now() - t)
      queue.push(h.renderer.lastGpuMs)
    }
    const m = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return (v[(v.length - 1) >> 1]! + v[v.length >> 1]!) / 2 }
    return { gpu: m(gpu.slice(2)), step: m(step), queue: m(queue), aa: h.state().antiAliasing, canvas: [h.renderer.width, h.renderer.height], internal: [h.renderer.internalWidth, h.renderer.internalHeight] }
  }, { s, k: mode.knobs })
}

async function gpuRun(page: Page) {
  meta.gpuViewport = await page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  for (const s of SCENES) {
    await setup(page, s, MODES[0].knobs)
    const acc: Record<string, { gpu: number[]; step: number[]; queue: number[] }> = {}
    for (const m of MODES) acc[m.id] = { gpu: [], step: [], queue: [] }
    for (let r = 0; r < rounds; r++) {
      const order = [0, 1, 2].map((i) => MODES[(i + r) % 3]!)
      for (const m of order) {
        const res = await sample(page, s, m)
        acc[m.id]!.gpu.push(res.gpu)
        acc[m.id]!.step.push(res.step)
        acc[m.id]!.queue.push(res.queue)
        meta.sizes ??= {}
        meta.sizes[m.id] = { canvas: res.canvas, internal: res.internal }
      }
    }
    const row: Record<string, unknown> = {}
    for (const m of MODES) {
      const a = acc[m.id]!
      const dGpu = a.gpu.map((x, i) => x - acc.msaa!.gpu[i]!)
      const dStep = a.step.map((x, i) => x - acc.msaa!.step[i]!)
      row[m.id] = {
        gpuMs: +med(a.gpu).toFixed(3),
        stepMs: +med(a.step).toFixed(3),
        queueMs: +med(a.queue).toFixed(3),
        gpuDeltaVsMsaa: +med(dGpu).toFixed(3),
        stepDeltaVsMsaa: +med(dStep).toFixed(3),
        gpuMadMs: +med(dGpu.map((x) => Math.abs(x - med(dGpu)))).toFixed(3),
      }
    }
    meta.gpu[s.name] = row
    console.log("GPU", s.name, JSON.stringify(row))
    save()
  }
}

/** Luminance of a screenshot at its own size (or downsampled to w×h). */
const LUMA_FN = `async (b64, w, h) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const W = w || img.width, H = h || img.height
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, W, H)
  const d = ctx.getImageData(0, 0, W, H).data
  const L = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255
  return { L, W, H }
}`

/** look-beauty's walking flicker metric: 28 frames east at night, tile-aligned residual and high-pass change. */
async function flicker(page: Page, mode: Mode, s: Scene) {
  await setup(page, s, { ...mode.knobs, dayGrain: 0, nightGrain: 0, shroudGrain: 0 })
  const frames: string[] = []
  for (let i = 0; i < 28; i++) {
    await page.evaluate(async ({ aim }) => {
      await (window as any).__arcadeHarness.step(1 / 60, { mx: 0.78, my: -0.28, aim })
    }, { aim: s.aim })
    if (i >= 8) frames.push((await page.screenshot({ type: "png" })).toString("base64"))
  }
  const res = await page.evaluate(async ({ frames, luma }) => {
    const lumOf = eval(luma)
    const W = 768, H = 512
    const lum = async (b64: string) => (await lumOf(b64, W, H)).L as Float32Array
    const at = (L: Float32Array, x: number, y: number) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
      const i = y0 * W + x0
      return (L[i]! * (1 - fx) + L[i + 1]! * fx) * (1 - fy) + (L[i + W]! * (1 - fx) + L[i + W + 1]! * fx) * fy
    }
    const hp = (L: Float32Array, x: number, y: number) => {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(L, x + dx, y + dy)
      return at(L, x, y) - s / 9
    }
    const T = 64, R = 6
    const tiles: { rms: number; jump: number; hp: number }[] = []
    let prev = await lum(frames[0]!)
    for (let f = 1; f < frames.length; f++) {
      const cur = await lum(frames[f]!)
      for (let ty = R + 2; ty + T < H - R - 2; ty += T) {
        for (let tx = R + 2; tx + T < W - R - 2; tx += T) {
          const sad = (dx: number, dy: number) => {
            let s = 0
            for (let y = ty; y < ty + T; y += 2) for (let x = tx; x < tx + T; x += 2) s += Math.abs(cur[y * W + x]! - at(prev, x + dx, y + dy))
            return s
          }
          let best = [0, 0], bestS = Infinity
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const v = sad(dx, dy)
            if (v < bestS) { bestS = v; best = [dx, dy] }
          }
          let [bx, by] = best as [number, number]
          for (const step of [0.5, 0.25, 0.125]) {
            for (const [ox, oy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
              const v = sad(bx + ox, by + oy)
              if (v < bestS) { bestS = v; bx += ox; by += oy }
            }
          }
          let s2 = 0, jumps = 0, h2 = 0, m = 0, n = 0
          for (let y = ty + 1; y < ty + T - 1; y++) for (let x = tx + 1; x < tx + T - 1; x++) {
            const c = cur[y * W + x]!
            const d = c - at(prev, x + bx, y + by)
            const dh = hp(cur, x, y) - hp(prev, x + bx, y + by)
            s2 += d * d
            h2 += dh * dh
            m += c
            if (Math.abs(d) > 0.025) jumps++
            n++
          }
          if (m / n > 0.012) tiles.push({ rms: Math.sqrt(s2 / n), jump: (100 * jumps) / n, hp: Math.sqrt(h2 / n) })
        }
      }
      prev = cur
    }
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? 0 }
    const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)] ?? 0 }
    return {
      tiles: tiles.length,
      rmsMed: +med(tiles.map((t) => t.rms)).toFixed(5),
      rmsP90: +p90(tiles.map((t) => t.rms)).toFixed(5),
      jumpPctMed: +med(tiles.map((t) => t.jump)).toFixed(3),
      hpRmsMed: +med(tiles.map((t) => t.hp)).toFixed(5),
      hpRmsP90: +p90(tiles.map((t) => t.hp)).toFixed(5),
    }
  }, { frames, luma: LUMA_FN })
  meta.flicker[`${mode.id}-${s.name}`] = res
  console.log("flicker", mode.id, s.name, JSON.stringify(res))
  save()
}

/** `stillFrom`: compare against another sequence's still (a burning scene is never still). */
type Seq = { name: string; label: string; scene: Scene; frames: number; prepare: string; frame: string; stillFrom?: string }
const SEQS: Seq[] = [
  {
    name: "fast-zombie",
    label: "Fast zombie crossing (8 m/s) at night",
    scene: { ...scene("street-night-21h"), aim: NORTH + 0.35 },
    frames: 30,
    prepare: `const sim = h.session().sim; ctx.z = sim.ai.spawnZombie(sim.town, s.x - 5, s.y - 3.2, "wander", 0)`,
    frame: `if (ctx.z) { ctx.z.x = s.x - 5 + i * 0.14; ctx.z.y = s.y - 3.2; ctx.z.h = 0; ctx.z.vx = 8.4; ctx.z.vy = 0 }`,
  },
  {
    name: "flashlight-swing",
    label: "Flashlight swing (4.8 rad/s) at night",
    scene: scene("street-night-21h"),
    frames: 30,
    prepare: ``,
    frame: `aim = s.aim - 1.2 + i * 0.08`,
  },
  {
    name: "rain",
    label: "Rain through a slow flashlight sweep",
    scene: { ...scene("street-night-21h"), rain: true },
    frames: 40,
    prepare: ``,
    frame: `aim = s.aim - 0.6 + i * 0.03`,
  },
  {
    name: "fire",
    label: "Burning dead and a fuel fire",
    scene: { ...scene("street-night-21h"), flashlight: false },
    frames: 30,
    prepare: `const at = h.stageFire("burning"); s.x = at.x; s.y = at.y; s.aim = 0; aim = 0`,
    frame: ``,
    stillFrom: "flashlight-swing",
  },
]

/** Runs a sequence and returns the last 10 frames as PNGs (CSS-pixel viewport, dpr 1). */
async function runSeq(page: Page, q: Seq, mode: Mode, still: boolean) {
  await setup(page, q.scene, mode.knobs)
  const frames: string[] = []
  const pre = await page.evaluate(async ({ s, prepare }) => {
    const h = (window as any).__arcadeHarness
    const ctx: any = ((window as any).__taaSeq = {})
    let aim = s.aim
    new Function("h", "s", "ctx", "aim", prepare)(h, s, ctx, aim)
    return { x: s.x, y: s.y, aim: s.aim }
  }, { s: q.scene, prepare: q.prepare })
  const s = { ...q.scene, ...pre }
  for (let i = 0; i < q.frames; i++) {
    await page.evaluate(async ({ s, i, frame, still }) => {
      const h = (window as any).__arcadeHarness
      const ctx = (window as any).__taaSeq
      const k = still ? 0 : i
      const aim = new Function("h", "s", "ctx", "i", `let aim = ${s.aim}; ${frame}; return aim`)(h, s, ctx, k)
      Object.assign(h.state().player, { x: s.x, y: s.y, aim, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
      await h.step(1 / 60, { mx: 0, my: 0, aim })
    }, { s, i, frame: q.frame, still })
    if (i >= q.frames - 10) frames.push((await page.screenshot({ type: "png" })).toString("base64"))
  }
  return frames
}

async function ghostRun(browser: Browser, url: string) {
  const page = await open(browser, url, 1536, 1024, 1)
  const sheetTiles: { label: string; file: string }[] = []
  const stills: Record<string, Record<string, string[]>> = {}
  for (const q of [...SEQS].sort((a, b) => Number(!!a.stillFrom) - Number(!!b.stillFrom))) {
    const seqs: Record<string, { moving: string[]; still: string[] }> = {}
    for (const m of MODES) {
      const moving = await runSeq(page, q, m, false)
      const still = q.stillFrom ? stills[q.stillFrom]![m.id]! : await runSeq(page, q, m, true)
      seqs[m.id] = { moving, still }
      ;(stills[q.name] ??= {})[m.id] = still
    }
    const res: Record<string, unknown> = {}
    for (const m of MODES.slice(1)) {
      const score = async (a: string[], b: string[]) =>
        page.evaluate(async ({ a, b, luma }) => {
          const lumOf = eval(luma)
          const T = 32
          let maxTile = 0
          const tiles: number[] = []
          for (let f = 0; f < a.length; f++) {
            const A = await lumOf(a[f], 0, 0), B = await lumOf(b[f], 0, 0)
            for (let ty = 0; ty + T <= A.H; ty += T) for (let tx = 0; tx + T <= A.W; tx += T) {
              let s = 0
              for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) s += Math.abs(A.L[y * A.W + x] - B.L[y * A.W + x])
              const v = s / (T * T)
              tiles.push(v)
              maxTile = Math.max(maxTile, v)
            }
          }
          tiles.sort((p, q) => p - q)
          return { maxTile: +maxTile.toFixed(4), p999Tile: +tiles[Math.floor(tiles.length * 0.999)]!.toFixed(4), p99Tile: +tiles[Math.floor(tiles.length * 0.99)]!.toFixed(4) }
        }, { a, b, luma: LUMA_FN })
      const moving = await score(seqs[m.id]!.moving, seqs.msaa!.moving)
      const still = await score(seqs[m.id]!.still, seqs.msaa!.still)
      res[m.id] = { moving, still, ghostRatio: +(moving.maxTile / Math.max(1e-4, still.maxTile)).toFixed(2) }
    }
    meta.ghost[q.name] = res
    console.log("ghost", q.name, JSON.stringify(res))
    for (const m of MODES) {
      const file = resolve(out, `ghost-${q.name}-${m.id}.png`)
      writeFileSync(file, Buffer.from(seqs[m.id]!.moving.at(-1)!, "base64"))
      sheetTiles.push({ label: `${q.label} · ${m.label}`, file })
    }
    save()
  }
  await page.close()
  await sheet(browser, resolve(out, "ghost-sheet.png"), "Ghosting: last frame of each motion, 1:1 crop of the middle", sheetTiles, 3, { x: 0.3, y: 0.28, w: 0.4, h: 0.44 })
}

async function stillsRun(page: Page, browser: Browser) {
  const tiles: { label: string; file: string }[] = []
  for (const s of SCENES) {
    for (const m of MODES) {
      await setup(page, s, m.knobs)
      await hold(page, s, 40)
      const file = resolve(out, `still-${s.name}-${m.id}.png`)
      await page.screenshot({ path: file })
      // A 1:1 device-pixel crop of the middle for the sheet.
      const vw = await page.evaluate(() => [innerWidth, innerHeight])
      const crop = resolve(out, `crop-${s.name}-${m.id}.png`)
      await page.screenshot({ path: crop, clip: { x: vw[0]! * 0.36, y: vw[1]! * 0.32, width: vw[0]! * 0.28, height: vw[1]! * 0.36 } })
      tiles.push({ label: `${s.name} · ${m.label}`, file: crop })
      meta.stills[`${s.name}-${m.id}`] = file.split("/").pop()
      console.log("still", s.name, m.id)
    }
    save()
  }
  await sheet(browser, resolve(out, "stills-sheet.png"), "Converged stills at 3456×1894, 1:1 device-pixel crop of the middle", tiles, 3, { x: 0, y: 0, w: 1, h: 1 })
}

/** Crops each image (fractions of its size) and lays them out `columns` wide with labels. */
async function sheet(browser: Browser, file: string, title: string, tiles: { label: string; file: string }[], columns: number, crop: { x: number; y: number; w: number; h: number }) {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.setViewportSize({ width: 1600, height: 900 })
  const urls = tiles.map((t) => `data:image/png;base64,${readFileSync(t.file).toString("base64")}`)
  const size = await page.evaluate(async ({ urls, crop, columns, title, labels }) => {
    const imgs = await Promise.all(urls.map(async (u) => { const i = new Image(); i.src = u; await i.decode(); return i }))
    const cw = Math.round(imgs[0]!.width * crop.w), ch = Math.round(imgs[0]!.height * crop.h)
    const pad = 12, head = 40, cap = 26
    const rows = Math.ceil(imgs.length / columns)
    const c = document.createElement("canvas")
    c.width = pad + columns * (cw + pad)
    c.height = head + rows * (ch + cap + pad)
    const g = c.getContext("2d")!
    g.fillStyle = "#0e1013"
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = "#e6e8ec"
    g.font = "600 20px -apple-system, sans-serif"
    g.fillText(title, pad, 28)
    imgs.forEach((img, i) => {
      const x = pad + (i % columns) * (cw + pad), y = head + Math.floor(i / columns) * (ch + cap + pad)
      g.drawImage(img, Math.round(img.width * crop.x), Math.round(img.height * crop.y), cw, ch, x, y, cw, ch)
      g.fillStyle = "#cfd4dc"
      g.font = "500 15px -apple-system, sans-serif"
      g.fillText(labels[i]!, x, y + ch + 19)
    })
    document.body.style.margin = "0"
    document.body.appendChild(c)
    return [c.width, c.height]
  }, { urls, crop, columns, title, labels: tiles.map((t) => t.label) })
  await page.setViewportSize({ width: size[0]!, height: size[1]! })
  await page.locator("canvas").screenshot({ path: file })
  await page.close()
}

async function clipRun(page: Page) {
  const s = { ...scene("street-night-21h"), x: 24.5, y: 42.5, aim: -0.35 }
  const N = 240
  const dir = resolve(out, "clip-frames")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const vw = await page.evaluate(() => [innerWidth, innerHeight])
  const clip = { x: vw[0]! / 2 - 240, y: vw[1]! / 2 - 150, width: 480, height: 300 }
  for (const m of MODES) {
    await setup(page, s, { ...m.knobs })
    for (let i = 0; i < N; i++) {
      await page.evaluate(async ({ i, base }) => {
        const h = (window as any).__arcadeHarness
        const aim = base + 0.9 * Math.sin((i / 60) * Math.PI * 2 * 0.75)
        Object.assign(h.state().player, { aim, flashlightOn: true, flashlightOutput: 1 })
        await h.step(1 / 60, { mx: 0.78, my: -0.28 * Math.cos(i / 50), aim })
      }, { i, base: s.aim })
      await page.screenshot({ path: resolve(dir, `${m.id}-${String(i).padStart(4, "0")}.jpg`), clip, type: "jpeg", quality: 95 })
    }
    console.log("clip", m.id)
  }
  const font = "/System/Library/Fonts/Helvetica.ttc"
  const label = (t: string) => existsSync(font) ? `,drawtext=fontfile=${font}:text='${t.replace(/[':]/g, "")}':x=14:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6` : ""
  const file = resolve(out, "taa-walk-swing.mp4")
  const encode = (labels: boolean) =>
    spawnSync("ffmpeg", [
      "-y", "-v", "error",
      ...MODES.flatMap((m) => ["-framerate", "60", "-i", resolve(dir, `${m.id}-%04d.jpg`)]),
      "-filter_complex",
      `${MODES.map((m, i) => `[${i}:v]null${labels ? label(m.label) : ""}[v${i}]`).join(";")};[v0][v1][v2]hstack=inputs=3,format=yuv420p[out]`,
      "-map", "[out]", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-an", "-movflags", "+faststart", file,
    ], { encoding: "utf8" })
  let r = encode(true)
  if (r.status !== 0) {
    meta.clipLabelError = r.stderr
    r = encode(false)
  }
  if (r.status !== 0) errors.push(`ffmpeg: ${r.stderr}`)
  meta.clip = r.status === 0 ? file.split("/").pop() : null
  if (r.status === 0) rmSync(dir, { recursive: true, force: true })
  save()
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
let server: ViteDevServer | undefined
try {
  const cur = await serve()
  server = cur.server
  const gp = await open(browser, cur.url, 1728, 947, 2)
  // Smoke first: every mode draws without a WebGPU error, or nothing else is worth running.
  for (const m of [...MODES].reverse()) {
    meta.smoke ??= {}
    meta.smoke[m.id] = await setup(gp, scene("street-night-21h"), m.knobs)
  }
  const gpuErrors = errors.filter((e) => /wgsl|validation|webgpu|gpu|pipeline|bind ?group|texture|shader/i.test(e))
  if (gpuErrors.length) throw new Error(`smoke failed: ${gpuErrors.slice(0, 4).join(" | ")}`)
  save()
  if (only.has("gpu")) await gpuRun(gp)
  if (only.has("stills")) await stillsRun(gp, browser)
  if (only.has("clip")) await clipRun(gp)
  await gp.close()
  if (only.has("flicker")) {
    const fp = await open(browser, cur.url, 1536, 1024, 1)
    const walk: Scene[] = [
      { ...scene("street-night-21h"), name: "walk-street-night", x: 24.5, y: 42.5, aim: -0.35 },
      { ...scene("start-house-21h"), name: "walk-start-house-night", x: 24.6, y: 31.2, aim: -0.35 },
      { ...scene("street-day-14h"), name: "walk-street-day", x: 24.5, y: 42.5, aim: -0.35 },
    ]
    for (const s of walk) for (const m of MODES) await flicker(fp, m, s)
    await fp.close()
  }
  if (only.has("ghost")) await ghostRun(browser, cur.url)
} finally {
  save()
  if (errors.length) console.log("ERRORS", errors.slice(0, 8).join("\n"))
  await browser.close()
  await server?.close()
}
