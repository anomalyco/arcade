/**
 * Beauty stills, zoom options, paired GPU cost and a walking flicker metric for Outbreak's look.
 *
 *   bun scripts/look-beauty.ts --out <dir> --mode stills [--tag final] [--preset today] [--knobs '{"k":1}']
 *   bun scripts/look-beauty.ts --out <dir> --mode zoom [--zooms 38,46,32]
 *   bun scripts/look-beauty.ts --out <dir> --mode gpu --base <tree>     paired GPU, base tree vs this tree
 *   bun scripts/look-beauty.ts --out <dir> --mode flicker [--base <tree>]
 *   bun scripts/look-beauty.ts --out <dir> --mode sheet --columns 'v8:dir,Darkwood:ref,final:dir'
 *
 * `--base` serves a second Outbreak tree (a `git archive` of main, e.g. in an untracked `.look-base/`) on
 * its own Vite server with `@arcade/kit` aliased to that tree's copy, so base and branch run in the same browser on
 * the same GPU. Headless Metal Chromium, muted, no visible window: run it through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/outbreak-look-beauty"))!)
const mode = arg("mode", "stills")!
const tag = arg("tag", "final")!
const preset = arg("preset", "today")!
const knobs: Record<string, unknown> = JSON.parse(arg("knobs", "{}")!)
const baseTree = arg("base")
const rounds = Number(arg("rounds", "6"))
const zooms = arg("zooms", "38,46,32")!.split(",").map(Number)
const only = arg("scenes")?.split(",")
mkdirSync(out, { recursive: true })

async function serve(gameRoot: string, repoRoot: string, ownKit = false): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    root: gameRoot,
    configFile: resolve(gameRoot, "vite.config.ts"),
    logLevel: "error",
    // A base tree has no node_modules of its own: point @arcade/kit at its copy (knobs is vendored and shared).
    resolve: ownKit ? { alias: [{ find: /^@arcade\/kit/, replacement: `${repoRoot}/packages/kit` }] } : undefined,
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repoRoot] } },
    plugins: [{
      name: "look-beauty-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(gameRoot, "src/main.ts")) return
        return code.replace("Object.assign(harness, { map })", "Object.assign(harness, { map, renderer, render })")
      },
    }],
  })
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1` }
}

type Companion = { id: string; index: number; x: number; y: number; aim: number; flashlight: boolean }
type Scene = { name: string; label: string; hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; horde?: boolean; companions?: Companion[] }

const COOP_LINEUP: Companion[] = [
  { id: "maya", index: 1, x: 27.15, y: 39.75, aim: Math.PI / 2 - 0.15, flashlight: true },
  { id: "hank", index: 2, x: 27.95, y: 40.0, aim: Math.PI / 2 + 0.08, flashlight: true },
  { id: "tess", index: 3, x: 28.75, y: 40.25, aim: Math.PI / 2 + 0.24, flashlight: true },
]
const NORTH = -Math.PI / 2
/** The game's default camera distance (`DEFAULT_OUTBREAK_VIEW.zoom`, D-35). */
const DEFAULT_ZOOM = 38
const TURNED = Math.PI / 2 - 0.35

/** The beauty set: every scene the brief names, at the default zoom. */
export const SCENES: Scene[] = [
  { name: "street-day-14h", label: "Street day 14:00", hour: 14, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: false },
  { name: "street-day-14h-turned", label: "Day 14:00, turned around (cone edge in daylight)", hour: 14, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: TURNED, flashlight: false },
  { name: "street-dusk-18h30", label: "Street dusk 18:30", hour: 18.5, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: true },
  { name: "street-night-21h", label: "Night 21:00, flashlight facing the house", hour: 21, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: true },
  { name: "street-night-21h-turned", label: "Night 21:00, flashlight turned around", hour: 21, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: TURNED, flashlight: true },
  { name: "street-night-21h-dark", label: "Night 21:00, no flashlight, facing the houses (night sight)", hour: 21, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: false },
  { name: "start-house-21h", label: "Start house 21:00", hour: 21, zoom: DEFAULT_ZOOM, x: 27.7, y: 31.8, aim: NORTH, flashlight: true },
  { name: "horde-night-21h", label: "Horde night 21:00", hour: 21, zoom: DEFAULT_ZOOM, x: 27.7, y: 41.0, aim: NORTH, flashlight: true, horde: true },
  { name: "coop-survivors-21h", label: "Co-op survivors 21:00", hour: 21, zoom: DEFAULT_ZOOM, x: 26.35, y: 39.5, aim: 0.65, flashlight: true, companions: COOP_LINEUP },
]
const scene = (name: string) => SCENES.find(s => s.name === name)!

const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
const HORDE: [number, number, number][] = [
  [27.4, 37.6, Math.PI / 2], [28.3, 37.2, Math.PI / 2 + 0.18], [26.6, 38.2, Math.PI / 2 - 0.22], [28.9, 38.5, Math.PI / 2 + 0.25],
  [27.8, 36.2, Math.PI / 2], [26.1, 36.9, Math.PI / 2 - 0.15], [29.5, 37.4, Math.PI / 2 + 0.3], [24.8, 39.2, 0.35],
  [30.6, 39.4, Math.PI - 0.35], [25.4, 41.6, -0.25], [30.2, 41.8, Math.PI + 0.2], [23.6, 40.5, 0.15],
]
const errors: string[] = []
const meta: Record<string, any> = { mode, tag, preset, knobs, shots: {}, gpu: {}, flicker: {} }

function chromiumPath(): string {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const p = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
  assert(p)
  return p
}

async function open(browser: Browser, url: string, width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  return page
}

async function setup(page: Page, s: Scene, k: Record<string, unknown> = knobs, p = preset) {
  return page.evaluate(async ({ s, k, p, horde }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour)
    h.setZoomRaw(s.zoom)
    h.setLab("propsOn", true)
    h.lookPreset(p)
    for (const [key, v] of Object.entries(k)) {
      try { h.setLab(key, v) } catch { /* knob absent in this tree */ }
    }
    h.pose(s.x, s.y, s.aim)
    const sim = h.session?.()?.sim
    if (sim) while (sim.slots.length > 1) sim.removeSurvivor(sim.slots[1]!.id)
    const added: any[] = []
    if (s.companions && sim) {
      for (const c of s.companions) {
        const slot = sim.addSurvivor(c.id, c.index)
        Object.assign(slot.survivor, { x: c.x, y: c.y, aim: c.aim, flashlightOn: c.flashlight, flashlightOutput: c.flashlight ? 1 : 0 })
        added.push({ slot, c })
      }
    }
    if (s.horde && sim?.ai && sim?.town) {
      horde.forEach(([zx, zy, za]: number[], i: number) => {
        const z = sim.ai.spawnZombie(sim.town, zx, zy, "chase", i)
        if (z) z.h = za
      })
    }
    const pin = () => {
      Object.assign(h.state().player, { x: s.x, y: s.y, aim: s.aim, flashlightOn: s.flashlight, flashlightOutput: s.flashlight ? 1 : 0 })
      for (const { slot, c } of added) Object.assign(slot.survivor, { x: c.x, y: c.y, aim: c.aim, vx: 0, vy: 0, flashlightOn: c.flashlight, flashlightOutput: c.flashlight ? 1 : 0 })
    }
    pin()
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
      const props = h.state().props
      const rugs = h.interiors?.()
      if (props?.ready && (rugs?.settled ?? true) && performance.now() - t0 > 120) break
      await new Promise(r => setTimeout(r, 15))
    }
    for (let i = 0; i < 12; i++) {
      pin()
      await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim })
    }
    return { hour: h.state().hour }
  }, { s, k, p, horde: HORDE })
}

/** Luminance and saturation summary of a still (downsampled to 384×256 in the page). */
async function stats(page: Page, file: string) {
  const url = `data:image/png;base64,${readFileSync(file).toString("base64")}`
  return page.evaluate(async (url: string) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const w = 384, h = 256
    const c = document.createElement("canvas")
    c.width = w
    c.height = h
    const ctx = c.getContext("2d")!
    ctx.drawImage(img, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    const lums: number[] = []
    const lit: number[] = []
    let sumL = 0, sumS = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      const s = mx > 1e-4 ? (mx - mn) / mx : 0
      lums.push(l)
      sumL += l
      sumS += s
      if (l > 0.14) lit.push(s)
    }
    lums.sort((a, b) => a - b)
    const n = lums.length
    const pct = (q: number) => lums[Math.min(n - 1, Math.floor(n * q))]!
    const brightShare = lums.filter(l => l > 0.2).length / n
    return {
      meanL: +(sumL / n).toFixed(3),
      p50L: +pct(0.5).toFixed(3),
      p90L: +pct(0.9).toFixed(3),
      p99L: +pct(0.99).toFixed(3),
      meanS: +(sumS / n).toFixed(3),
      litMeanS: +(lit.length ? lit.reduce((a, b) => a + b, 0) / lit.length : 0).toFixed(3),
      brightShare: +brightShare.toFixed(3),
    }
  }, url)
}

async function capture(page: Page, file: string, s: Scene, k: Record<string, unknown> = knobs, p = preset) {
  await setup(page, s, k, p)
  await page.screenshot({ path: file })
  const st = await stats(page, file)
  meta.shots[file.split("/").pop()!] = { scene: s.name, zoom: s.zoom, preset: p, knobs: k, stats: st }
  console.log("captured", file.split("/").pop(), JSON.stringify(st))
  return file
}

const med = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q)
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2
}

async function frameMs(page: Page) {
  return page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const v: number[] = []
    for (let i = 0; i < 10; i++) v.push(await h.renderer.measure(h.render))
    return v.slice(2).sort((x: number, y: number) => x - y)[3]!
  })
}

/** Alternates A and B (A first on even rounds) and reports medians and the paired delta B − A. */
async function paired(runA: () => Promise<number>, runB: () => Promise<number>) {
  const a: number[] = [], b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const isB of r % 2 ? [true, false] : [false, true]) (isB ? b : a).push(await (isB ? runB : runA)())
  }
  const d = a.map((x, i) => b[i]! - x)
  const dm = med(d)
  return { aMs: +med(a).toFixed(3), bMs: +med(b).toFixed(3), deltaMs: +dm.toFixed(3), madMs: +med(d.map(x => Math.abs(x - dm))).toFixed(3) }
}

/**
 * Walk 28 frames east along the street at night (grain off so only surfaces count). Each frame pair is aligned per
 * 64-px tile by a sub-pixel shift search, the previous frame is resampled bilinearly, and the residual luminance is
 * summarised: `rms` (RMS ΔL), `jumpPct` (|ΔL| > 2.5%) and `hpRms` (RMS change of the 3×3 high-pass, i.e. sparkle).
 * Tiles are scored separately and the median tile is reported, so a moving actor or the beam edge does not dominate.
 */
async function flicker(page: Page, label: string, s: Scene) {
  const k = { ...knobs, dayGrain: 0, nightGrain: 0, shroudGrain: 0 }
  await setup(page, s, k)
  const frames: string[] = []
  for (let i = 0; i < 28; i++) {
    await page.evaluate(async ({ aim }) => {
      const h = (window as any).__arcadeHarness
      await h.step(1 / 60, { mx: 0.78, my: -0.28, aim })
    }, { aim: s.aim })
    if (i >= 8) frames.push((await page.screenshot({ type: "png" })).toString("base64"))
  }
  const res = await page.evaluate(async (frames: string[]) => {
    const W = 768, H = 512
    const lum = async (b64: string) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement("canvas")
      c.width = W
      c.height = H
      const ctx = c.getContext("2d")!
      ctx.drawImage(img, 0, 0, W, H)
      const d = ctx.getImageData(0, 0, W, H).data
      const L = new Float32Array(W * H)
      for (let i = 0; i < W * H; i++) L[i] = (0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255
      return L
    }
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
    const tiles: { rms: number; jump: number; hp: number; mean: number }[] = []
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
          if (m / n > 0.012) tiles.push({ rms: Math.sqrt(s2 / n), jump: (100 * jumps) / n, hp: Math.sqrt(h2 / n), mean: m / n })
        }
      }
      prev = cur
    }
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? 0 }
    const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)] ?? 0 }
    return {
      tiles: tiles.length,
      rmsMed: +med(tiles.map(t => t.rms)).toFixed(5),
      rmsP90: +p90(tiles.map(t => t.rms)).toFixed(5),
      jumpPctMed: +med(tiles.map(t => t.jump)).toFixed(3),
      hpRmsMed: +med(tiles.map(t => t.hp)).toFixed(5),
      hpRmsP90: +p90(tiles.map(t => t.hp)).toFixed(5),
    }
  }, frames)
  meta.flicker[`${label}-${s.name}`] = res
  console.log("flicker", label, s.name, JSON.stringify(res))
  return res
}

async function sheet(browser: Browser, file: string, title: string, tiles: { label: string; file: string }[], columns: number) {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const img = (f: string) => `data:image/${/\.jpe?g$/.test(f) ? "jpeg" : "png"};base64,${readFileSync(f).toString("base64")}`
  await page.setViewportSize({ width: columns * 760 + 36, height: Math.ceil(tiles.length / columns) * 545 + 64 })
  await page.setContent(`<body style="margin:0;padding:16px;background:#0e1013;color:#e6e8ec;font:600 15px -apple-system,BlinkMacSystemFont,sans-serif">
    <div style="font-size:19px;margin:0 0 12px;letter-spacing:-0.01em">${title}</div>
    <div style="display:grid;grid-template-columns:repeat(${columns},748px);gap:14px">
    ${tiles.map(t => `<figure style="margin:0;background:#171a20;border:1px solid #282d37;border-radius:6px;overflow:hidden"><img src="${img(t.file)}" style="width:748px;height:498px;object-fit:cover;display:block"><figcaption style="padding:7px 10px;font-size:14px;color:#cfd4dc">${t.label}</figcaption></figure>`).join("")}
    </div></body>`)
  await page.locator("body").screenshot({ path: file })
  await page.close()
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const servers: ViteDevServer[] = []
try {
  if (mode === "sheet") {
    // --columns 'Label:dir:prefix,...' where a dir of "ref" takes --refs (one image per scene, in scene order).
    const columns = arg("columns")!.split(",").map(c => c.split(":"))
    const refs = (arg("refs") ?? "").split(",")
    const set = SCENES.filter(s => !only || only.includes(s.name))
    const tiles: { label: string; file: string }[] = []
    set.forEach((s, i) => {
      for (const [label, dir, prefix] of columns) {
        const file = dir === "ref" ? refs[i % refs.length]! : resolve(dir!, `${prefix}-${s.name}.png`)
        tiles.push({ label: `${label} · ${dir === "ref" ? file.split("/").pop()!.replace(/\.\w+$/, "") : s.label}`, file })
      }
    })
    await sheet(browser, resolve(out, arg("file", "sheet.png")!), arg("title", "Outbreak look")!, tiles, columns.length)
  } else {
    const cur = await serve(root, resolve(root, "../.."))
    servers.push(cur.server)
    const base = baseTree ? await serve(resolve(baseTree, "games/outbreak"), resolve(baseTree), true) : undefined
    if (base) servers.push(base.server)
    meta.base = baseTree ?? null

    if (mode === "stills") {
      const page = await open(browser, cur.url, 1536, 1024, 1)
      meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
      // --variants '{"name":{knobs}}' captures each knob set (on top of --knobs) as <name>-<scene>.png.
      const variants: Record<string, Record<string, unknown>> = JSON.parse(arg("variants", "null")!) ?? { [tag]: {} }
      for (const [name, v] of Object.entries(variants)) {
        for (const s of SCENES.filter(s => !only || only.includes(s.name))) await capture(page, resolve(out, `${name}-${s.name}.png`), s, { ...knobs, ...v })
      }
      await page.close()
      if (base) {
        const bp = await open(browser, base.url, 1536, 1024, 1)
        for (const s of SCENES.filter(s => !only || only.includes(s.name))) await capture(bp, resolve(out, `base-${tag}-${s.name}.png`), s, {}, preset)
        await bp.close()
      }
    } else if (mode === "zoom") {
      const set = ["street-day-14h", "street-night-21h", "horde-night-21h", "coop-survivors-21h"].map(scene)
      const page = await open(browser, cur.url, 1536, 1024, 1)
      for (const z of zooms) for (const s of set) await capture(page, resolve(out, `zoom${z}-${s.name}.png`), { ...s, zoom: z })
      await page.close()
      const gp = await open(browser, cur.url, 1728, 947, 2)
      meta.gpuViewport = await gp.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
      for (const z of zooms.slice(1)) {
        for (const s of set) {
          const res = await paired(
            async () => { await setup(gp, { ...s, zoom: zooms[0]! }); return frameMs(gp) },
            async () => { await setup(gp, { ...s, zoom: z }); return frameMs(gp) },
          )
          meta.gpu[`zoom${z}-vs-${zooms[0]}-${s.name}`] = res
          console.log("GPU", `zoom ${z} vs ${zooms[0]}`, s.name, JSON.stringify(res))
        }
      }
      await gp.close()
    } else if (mode === "gpu") {
      assert(base, "--mode gpu needs --base <tree>")
      const pa = await open(browser, base.url, 1728, 947, 2)
      const pb = await open(browser, cur.url, 1728, 947, 2)
      meta.gpuViewport = await pb.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
      meta.adapter = await pb.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
      for (const s of SCENES.filter(s => !only || only.includes(s.name))) {
        const res = await paired(
          async () => { await setup(pa, s, {}, "today"); return frameMs(pa) },
          async () => { await setup(pb, s); return frameMs(pb) },
        )
        meta.gpu[s.name] = res
        console.log("GPU base→branch", s.name, JSON.stringify(res))
      }
    } else if (mode === "flicker") {
      const walk: Scene[] = [
        { ...scene("street-night-21h"), name: "walk-street-night", x: 24.5, y: 42.5, aim: -0.35 },
        { ...scene("start-house-21h"), name: "walk-start-house-night", x: 24.6, y: 31.2, aim: -0.35 },
        { ...scene("street-day-14h"), name: "walk-street-day", x: 24.5, y: 42.5, aim: -0.35 },
      ]
      const page = await open(browser, cur.url, 1536, 1024, 1)
      for (const s of walk) await flicker(page, tag, s)
      await page.close()
      if (base) {
        const bp = await open(browser, base.url, 1536, 1024, 1)
        for (const s of walk) await flicker(bp, "base", s)
        await bp.close()
      }
    }
  }
  meta.errors = errors
  writeFileSync(resolve(out, `meta-${mode}-${tag}.json`), JSON.stringify(meta, null, 2))
  if (errors.length) console.log("ERRORS", errors.slice(0, 8).join("\n"))
} finally {
  await browser.close()
  for (const s of servers) await s.close()
}
