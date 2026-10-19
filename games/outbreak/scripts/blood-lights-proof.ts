/**
 * Stills, a strobe clip, paired GPU cost and a walking flicker metric for Outbreak's blood and night lights (AR-55).
 *
 *   bun scripts/blood-lights-proof.ts --out <dir> --mode stills [--base <tree>]
 *   bun scripts/blood-lights-proof.ts --out <dir> --mode clip
 *   bun scripts/blood-lights-proof.ts --out <dir> --mode gpu --base <tree>
 *   bun scripts/blood-lights-proof.ts --out <dir> --mode flicker [--base <tree>]
 *   bun scripts/blood-lights-proof.ts --out <dir> --mode sheet --refs a.jpg,b.jpg,c.jpg,d.jpg
 *
 * Scenes: a horde shot dead on the street (day and night, captured 35 s later so the wet splatter has faded and only
 * what stays is left), the start house at night (ambient blood where something happened), and the hardware frontage
 * at night with a wailing car alarm, a police car's light bar and the shop's beacon. `--base` serves a `git archive`
 * of main beside this tree on the same GPU. Headless Metal Chromium, muted: run through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/outbreak-blood-lights"))!)
const mode = arg("mode", "stills")!
const tag = arg("tag", "after")!
const baseTree = arg("base")
const rounds = Number(arg("rounds", "6"))
const only = arg("scenes")?.split(",")
const knobs: Record<string, unknown> = JSON.parse(arg("knobs", "{}")!)
mkdirSync(out, { recursive: true })

type Scene = { name: string; label: string; hour: number; zoom: number; x: number; y: number; aim: number; fight?: boolean; alarm?: boolean; after?: number }

const NORTH = -Math.PI / 2
export const SCENES: Scene[] = [
  { name: "fight-day", label: "Street 14:00, 35 s after a horde was shot", hour: 14, zoom: 46, x: 27.7, y: 41.2, aim: NORTH, fight: true, after: 35 },
  { name: "fight-night", label: "Street 21:00, 35 s after a horde was shot", hour: 21, zoom: 46, x: 27.7, y: 41.2, aim: NORTH, fight: true, after: 35 },
  { name: "house-night", label: "Start house 21:00 (Ash was broken into)", hour: 21, zoom: 46, x: 28.4, y: 31.6, aim: -0.5 },
  { name: "alarm-night", label: "Hardware frontage 21:00: car alarm, police bar, shop beacon", hour: 21, zoom: 46, x: 51.5, y: 45.2, aim: -0.15, alarm: true },
]
// Wanderers to the north, shot in this order; one crawler comes in from the west.
const HORDE: [number, number][] = [[27.0, 37.0], [28.6, 37.3], [26.0, 37.9], [29.6, 38.0], [27.9, 36.2], [25.3, 38.6]]
const CRAWLER: [number, number] = [21.8, 39.6]

const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
const errors: string[] = []
const meta: Record<string, any> = { mode, tag, knobs, shots: {}, gpu: {}, flicker: {}, blood: {}, lights: {} }

async function serve(gameRoot: string, repoRoot: string, ownKit = false): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    root: gameRoot,
    configFile: resolve(gameRoot, "vite.config.ts"),
    logLevel: "error",
    resolve: ownKit ? { alias: [{ find: /^@arcade\/kit/, replacement: `${repoRoot}/packages/kit` }] } : undefined,
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repoRoot, resolve(root, "../..")] } },
    plugins: [{
      name: "blood-lights-hooks",
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

function chromiumPath(): string {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const p = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
    .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
  assert(p)
  return p
}

async function open(browser: Browser, url: string, width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  page.setDefaultTimeout(180000)
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

/** Poses, stages and settles a scene; for a fight, shoots the horde dead and waits `after` seconds. */
async function setup(page: Page, s: Scene, k: Record<string, unknown> = knobs) {
  return page.evaluate(async ({ s, k, horde, crawler }) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setQuality("high")
    h.setLab("timeScale", 0)
    h.setZoomRaw(s.zoom)
    h.setLab("propsOn", true)
    try { h.setLab("infiniteAmmo", 1) } catch { /* absent */ }
    h.lookPreset("today")
    for (const [key, v] of Object.entries(k)) {
      try { h.setLab(key, v) } catch { /* knob absent in this tree */ }
    }
    try { h.clearBlood?.() } catch { /* absent in base */ }
    const sim = h.session?.()?.sim
    if (s.alarm) h.stageDiscovery?.("car-alarm")
    h.setLab("hour", s.hour)
    h.pose(s.x, s.y, s.aim)
    const pin = () => Object.assign(h.state().player, { x: s.x, y: s.y, vx: 0, vy: 0, flashlightOn: true, flashlightOutput: 1 })
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
    const shots = { fired: 0, killed: 0 }
    if (s.fight && sim) {
      const zs = horde.map(([x, y]: number[], i: number) => h.spawnZombie(x, y, "wander", Math.PI / 2 + i * 0.1)).filter(Boolean)
      const cr = h.spawnZombie(crawler[0], crawler[1], "crawler", 0)
      for (let i = 0; i < 4; i++) { pin(); await h.step(1 / 60, { aim: s.aim }) }
      for (const z of zs) {
        for (let n = 0; n < 8 && z.state !== "dead"; n++) {
          const aim = Math.atan2(z.y - s.y, z.x - s.x)
          pin()
          await h.step(1 / 60, { aim })
          await h.step(1 / 60, { aim, fire: true })
          shots.fired++
          for (let f = 0; f < 14; f++) { pin(); await h.step(1 / 60, { aim }) }
        }
        if (z.state === "dead") shots.killed++
      }
      // Keep the crawler alive and crawling: it leaves its trail while the pools spread.
      if (cr) cr.hp = Math.max(cr.hp, 60)
      const frames = Math.round((s.after ?? 0) * 30)
      for (let f = 0; f < frames; f++) { pin(); await h.step(1 / 30, { aim: s.aim }) }
    }
    for (let i = 0; i < 12; i++) { pin(); await h.step(1 / 60, { mx: 0, my: 0, aim: s.aim }) }
    const st = h.state()
    return { hour: st.hour, shots, blood: st.blood ?? null, lights: st.nightLights ?? null, splatter: st.splatter ?? null }
  }, { s, k, horde: HORDE, crawler: CRAWLER })
}

async function capture(page: Page, file: string, s: Scene, k: Record<string, unknown> = knobs) {
  const res = await setup(page, s, k)
  await page.screenshot({ path: file, timeout: 180000 })
  meta.shots[file.split("/").pop()!] = { scene: s.name, ...res }
  console.log("captured", file.split("/").pop(), JSON.stringify(res))
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

async function paired(runA: () => Promise<number>, runB: () => Promise<number>) {
  const a: number[] = [], b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const isB of r % 2 ? [true, false] : [false, true]) (isB ? b : a).push(await (isB ? runB : runA)())
  }
  const d = a.map((x, i) => b[i]! - x)
  const dm = med(d)
  return { aMs: +med(a).toFixed(3), bMs: +med(b).toFixed(3), deltaMs: +dm.toFixed(3), madMs: +med(d.map(x => Math.abs(x - dm))).toFixed(3) }
}

/** Walking flicker (same method as look-beauty.ts): residual luminance and high-pass sparkle between aligned frames. */
async function flicker(page: Page, label: string, s: Scene) {
  await setup(page, s, { ...knobs, dayGrain: 0, nightGrain: 0, shroudGrain: 0 })
  const frames: string[] = []
  for (let i = 0; i < 28; i++) {
    await page.evaluate(async ({ aim }) => {
      const h = (window as any).__arcadeHarness
      await h.step(1 / 60, { mx: 0.78, my: -0.28, aim })
    }, { aim: s.aim })
    if (i >= 8) frames.push((await page.screenshot({ type: "png", timeout: 180000 })).toString("base64"))
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
    const md = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? 0 }
    const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)] ?? 0 }
    return {
      tiles: tiles.length,
      rmsMed: +md(tiles.map(t => t.rms)).toFixed(5),
      rmsP90: +p90(tiles.map(t => t.rms)).toFixed(5),
      jumpPctMed: +md(tiles.map(t => t.jump)).toFixed(3),
      hpRmsMed: +md(tiles.map(t => t.hp)).toFixed(5),
      hpRmsP90: +p90(tiles.map(t => t.hp)).toFixed(5),
    }
  }, frames)
  meta.flicker[`${label}-${s.name}`] = res
  console.log("flicker", label, s.name, JSON.stringify(res))
}

async function sheet(browser: Browser, file: string, title: string, rows: { label: string; tiles: { label: string; file: string }[] }[]) {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const img = (f: string) => `data:image/${/\.jpe?g$/.test(f) ? "jpeg" : "png"};base64,${readFileSync(f).toString("base64")}`
  const cols = rows[0]!.tiles.length
  await page.setViewportSize({ width: cols * 640 + 36, height: rows.length * 500 + 70 })
  await page.setContent(`<body style="margin:0;padding:16px;background:#0e1013;color:#e6e8ec;font:600 15px -apple-system,BlinkMacSystemFont,sans-serif">
    <div style="font-size:19px;margin:0 0 12px;letter-spacing:-0.01em">${title}</div>
    ${rows.map(r => `<div style="font-size:14px;color:#aab1bc;margin:10px 0 6px">${r.label}</div><div style="display:grid;grid-template-columns:repeat(${cols},628px);gap:12px">
    ${r.tiles.map(t => `<figure style="margin:0;background:#171a20;border:1px solid #282d37;border-radius:6px;overflow:hidden"><img src="${img(t.file)}" style="width:628px;height:419px;object-fit:cover;display:block"><figcaption style="padding:6px 10px;font-size:13px;color:#cfd4dc">${t.label}</figcaption></figure>`).join("")}
    </div>`).join("")}</body>`)
  await page.locator("body").screenshot({ path: file })
  await page.close()
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const servers: ViteDevServer[] = []
const set = SCENES.filter(s => !only || only.includes(s.name))
try {
  if (mode === "sheet") {
    const refs = arg("refs")!.split(",")
    const rows = set.map((s, i) => ({
      label: s.label,
      tiles: [
        { label: `Darkwood · ${refs[i % refs.length]!.split("/").pop()!.replace(/\.\w+$/, "")}`, file: refs[i % refs.length]! },
        { label: "Before (main)", file: resolve(out, `base-${s.name}.png`) },
        { label: "After", file: resolve(out, `${tag}-${s.name}.png`) },
      ],
    }))
    await sheet(browser, resolve(out, arg("file", "sheet.png")!), arg("title", "Outbreak blood and night lights (AR-55): Darkwood | before | after")!, rows)
  } else {
    const cur = await serve(root, resolve(root, "../.."))
    servers.push(cur.server)
    const base = baseTree ? await serve(resolve(baseTree, "games/outbreak"), resolve(baseTree), true) : undefined
    if (base) servers.push(base.server)
    meta.base = baseTree ?? null

    if (mode === "stills") {
      const page = await open(browser, cur.url, 1536, 1024, 1)
      meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
      for (const s of set) await capture(page, resolve(out, `${tag}-${s.name}.png`), s)
      await page.close()
      if (base) {
        const bp = await open(browser, base.url, 1536, 1024, 1)
        for (const s of set) await capture(bp, resolve(out, `base-${s.name}.png`), s, {})
        await bp.close()
      }
    } else if (mode === "clip") {
      // The red strobes at the hardware frontage: 4 s at 30 fps, then H.264 with no audio track.
      const page = await open(browser, cur.url, 1280, 854, 1)
      const s = SCENES.find(x => x.name === "alarm-night")!
      await setup(page, s)
      const dir = resolve(out, "clip-frames")
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      for (let i = 0; i < 120; i++) {
        await page.evaluate(async ({ s }) => {
          const h = (window as any).__arcadeHarness
          Object.assign(h.state().player, { x: s.x, y: s.y, vx: 0, vy: 0 })
          await h.step(1 / 30, { mx: 0, my: 0, aim: s.aim })
        }, { s })
        await page.screenshot({ path: resolve(dir, `f${String(i).padStart(4, "0")}.jpg`), type: "jpeg", quality: 92, timeout: 180000 })
      }
      meta.lights = await page.evaluate(() => (window as any).__arcadeHarness.state().nightLights)
      await page.close()
      const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(dir, "f%04d.jpg"), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", resolve(out, "strobe.mp4")])
      console.log("ffmpeg", ff.exitCode, ff.stderr.toString())
    } else if (mode === "gpu") {
      assert(base, "--mode gpu needs --base <tree>")
      const pa = await open(browser, base.url, 1728, 947, 2)
      const pb = await open(browser, cur.url, 1728, 947, 2)
      meta.gpuViewport = await pb.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])
      meta.adapter = await pb.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
      for (const s of set) {
        // Stage each scene once per tree, then alternate measurements on the settled frame.
        await setup(pa, s, {})
        await setup(pb, s)
        const res = await paired(() => frameMs(pa), () => frameMs(pb))
        meta.gpu[s.name] = res
        console.log("GPU base→branch", s.name, JSON.stringify(res))
      }
    } else if (mode === "flicker") {
      const walk: Scene[] = [
        { ...SCENES[2]!, name: "walk-house-night", x: 25.2, y: 31.4, aim: -0.35 },
        { ...SCENES[3]!, name: "walk-alarm-night", x: 47.5, y: 45.6, aim: -0.1 },
        { ...SCENES[0]!, name: "walk-street-day", fight: false, x: 22.5, y: 42.6, aim: -0.35 },
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
