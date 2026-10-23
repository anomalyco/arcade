/**
 * Headless, muted checks and clips of the spider gait station (`games/lab/spider.html`).
 *
 * `--stills pass,distant` checks the spider is visible before anything is recorded: per camera it draws the same
 * instant without and then with the spider, takes the pixels that changed inside its projected joints' box as its
 * mask, and reports the mask's size and mean luma with and without it (Weber contrast), plus a crop of each.
 * `--clips pass:7,distant:5` records H.264 clips on a synthetic 60 Hz clock at 30 fps and deletes the frames.
 * `camera@seconds` first runs the gait forward to that time. `--review pass` lifts the cameras listed: moonlight
 * `--moon`, exposure `--exposure`, auto exposure locked off. `--dark distant` switches your own torch off.
 *
 *   hivemind run --kind browser --fetch captures/spider -- bun scripts/lab/spider-stills.ts --stills pass@20,distant@45
 *     [--clips pass@20:7,distant@45:5] [--review pass] [--dark distant] [--moon 0.35] [--exposure 2.2] [--at 20]
 *     [--set size=3.5,legs=2.5] [--size 1600x900] [--tag name]
 *
 * It starts the Lab's Vite dev server on a free port, so nothing is built first.
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { browserBudget } from "../browser-budget"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const root = resolve(import.meta.dir, "../..")
const out = resolve(root, "captures/spider", arg("tag", "current"))
await mkdir(out, { recursive: true })
const [width, height] = arg("size", "1600x900").split("x").map(Number) as [number, number]
const at = Number(arg("at", "20"))
const sets = arg("set", "").split(",").filter(Boolean).map(p => p.split("=") as [string, string])

const port = 5300 + Math.floor(Math.random() * 400)
const server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: resolve(root, "games/lab"), stdout: "pipe", stderr: "pipe" })
const base = `http://127.0.0.1:${port}`
for (let i = 0; ; i++) {
  try { if ((await fetch(base + "/spider.html")).ok) break } catch {}
  if (i > 200) throw new Error("vite did not start")
  await Bun.sleep(150)
}

await using budget = browserBudget()
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("headless Chromium missing")
const browser = await budget.chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--enable-features=WebGPUExperimentalFeatures"] })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
type Spider = {
  ready: boolean; frames: number; paused: boolean; hidden: boolean; step(ms: number): void; advance(s: number): void; reshape(): void
  settings: Record<string, number>; scene: { camera: string }; stats(): Record<string, unknown>; camera: { flashlight: boolean }
  project(): { width: number; height: number; body: number[] | null; joints: (number[] | null)[] }
  view: { settings: Record<string, number | boolean>; renderer: { passContext: { device: GPUDevice } } }
}
/** Luma (0–255, BT.601 on the encoded image) of a PNG, via ffmpeg. */
const luma = async (file: string) => new Uint8Array(await Bun.$`ffmpeg -loglevel error -i ${file} -f rawvideo -pix_fmt gray -`.arrayBuffer())
const errors: string[] = []
const report: Record<string, unknown> = { size: [width, height], at, sets, errors, captured: new Date().toISOString() }
try {
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.stack ?? e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`${base}/spider.html?quality=high`, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForFunction(() => { const s = (window as unknown as { spider?: Spider }).spider; return s?.ready && s.frames > 4 }, undefined, { timeout: 150_000 })
  await page.addStyleTag({ content: "#hud,[data-lab-panel]{display:none!important}" })
  await page.evaluate(({ sets, at }) => {
    const s = (window as unknown as { spider: Spider }).spider
    s.paused = true
    for (const [k, v] of sets) s.settings[k] = Number(v)
    if (sets.length) s.reshape()
    s.advance(at)
  }, { sets, at })
  const shots: Record<string, unknown> = {}
  const review = arg("review", "").split(",").filter(Boolean)
  const lift = { moon: Number(arg("moon", "0.35")), exposure: Number(arg("exposure", "2.2")) }
  report.review = { cameras: review, ...lift, autoExposure: false }
  /** Switches camera (a cut: exposure snaps), with the review lift or the game's own look, and lets it settle. */
  // `camera@seconds` first advances the gait to that time (it only runs forward); `--dark` cameras switch your own
  // torch off, so the friend's beam and the dark-adapted eye do the work.
  const dark = arg("dark", "").split(",").filter(Boolean)
  report.dark = dark
  const use = (spec: string) => page.evaluate(({ camera, time, lifted, lift, torch }) => {
    const s = (window as unknown as { spider: Spider & { defaults?: Record<string, number | boolean>; scene: { sweep: boolean } } }).spider
    s.scene.sweep = true
    if (time !== null) s.advance(Math.max(0, time - (s.stats().ticks as number) / 60))
    s.camera.flashlight = torch
    const v = s.view.settings
    s.defaults ??= { moon: v.moon!, exposure: v.exposure!, autoExposure: v.autoExposure! }
    v.moon = lifted ? lift.moon : s.defaults.moon!
    v.exposure = lifted ? lift.exposure : s.defaults.exposure!
    v.autoExposure = lifted ? false : s.defaults.autoExposure!
    s.scene.camera = camera
    for (let i = 0; i < 90; i++) s.step(1000 / 60)
    return s.stats()
  }, { camera: name(spec), time: spec.includes("@") ? Number(spec.split("@")[1]) : null, lifted: review.includes(name(spec)), lift, torch: !dark.includes(name(spec)) })
  const name = (spec: string) => spec.split("@")[0]!
  // Stills hold the friend's beam on it (the moment a sweep crosses its legs); clips sweep.
  const settle = (hidden: boolean) => page.evaluate(async hidden => {
    const s = (window as unknown as { spider: Spider & { scene: { sweep: boolean } } }).spider
    s.hidden = hidden
    s.scene.sweep = false
    // The same instant (a zero step leaves the gait, wind and clock), repeated so temporal history settles.
    for (let i = 0; i < 12; i++) s.step(0)
    await s.view.renderer.passContext.device.queue.onSubmittedWorkDone()
    return s.project()
  }, hidden)

  for (const spec of arg("stills", "").split(",").filter(Boolean)) {
    const camera = name(spec)
    const stats = await use(spec)
    const without = resolve(out, `${camera}-without.png`), withSpider = resolve(out, `${camera}-with.png`)
    await settle(true)
    await page.screenshot({ path: without })
    const projected = await settle(false)
    await page.screenshot({ path: withSpider })
    const points = [projected.body, ...projected.joints].filter((p): p is number[] => !!p)
    const pad = 12
    const x0 = Math.max(0, Math.floor(Math.min(...points.map(p => p[0]!)) - pad)), x1 = Math.min(width - 1, Math.ceil(Math.max(...points.map(p => p[0]!)) + pad))
    const y0 = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]!)) - pad)), y1 = Math.min(height - 1, Math.ceil(Math.max(...points.map(p => p[1]!)) + pad))
    const a = await luma(withSpider), b = await luma(without)
    // Pixels it changes by 10+ levels (it reads), and by 4+ (it is there at all).
    let n = 0, sa = 0, sb = 0, box = 0, faint = 0
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * width + x, d = Math.abs(a[i]! - b[i]!)
      box++
      if (d >= 4) faint++
      if (d >= 10) { n++; sa += a[i]!; sb += b[i]! }
    }
    const meanWith = n ? sa / n : 0, meanWithout = n ? sb / n : 0
    const inFrame = points.length === 1 + projected.joints.length && points.every(p => p[0]! >= 0 && p[0]! < width && p[1]! >= 0 && p[1]! < height)
    const analysis = {
      box: [x0, y0, x1, y1], inFrame, maskPixels: n, faintPixels: faint, maskShare: +(n / Math.max(1, box)).toFixed(3),
      meanWith: +meanWith.toFixed(1), meanWithout: +meanWithout.toFixed(1), weber: +((meanWith - meanWithout) / Math.max(1, meanWithout)).toFixed(2),
      visible: inFrame && n > 1500 && Math.abs(meanWith - meanWithout) >= 8,
    }
    shots[camera] = { stats, analysis }
    console.log(camera, JSON.stringify(analysis), "exposure", stats.exposure)
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    await Bun.$`ffmpeg -y -loglevel error -i ${withSpider} -i ${without} -filter_complex ${`[0]crop=${w}:${h}:${x0}:${y0}[a];[1]crop=${w}:${h}:${x0}:${y0}[b];[a][b]hstack,scale=1600:-2`} ${resolve(out, `${camera}-crop.png`)}`
  }

  // --clips "pass@20:7,distant@45:5": each camera in turn, 30 fps from a 60 Hz sim.
  const clips = arg("clips", "").split(",").filter(Boolean).map(c => c.split(":") as [string, string])
  for (const [spec, seconds] of clips) {
    const camera = name(spec)
    const frames = resolve(out, `frames-${camera}`)
    await mkdir(frames, { recursive: true })
    const stats = await use(spec)
    shots[`clip-${camera}`] = stats
    console.log(camera, JSON.stringify(stats))
    for (let f = 0; f < Number(seconds) * 30; f++) {
      await page.evaluate(async () => {
        const s = (window as unknown as { spider: Spider }).spider
        s.step(1000 / 60); s.step(1000 / 60)
        await s.view.renderer.passContext.device.queue.onSubmittedWorkDone()
      })
      await page.screenshot({ path: resolve(frames, `${String(f).padStart(4, "0")}.jpg`), type: "jpeg", quality: 92 })
    }
  }
  await budget.finish()
  for (const [spec] of clips) {
    const camera = name(spec)
    const frames = resolve(out, `frames-${camera}`)
    await Bun.$`ffmpeg -y -loglevel error -framerate 30 -i ${frames}/%04d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ${resolve(out, `${camera}.mp4`)}`
    await rm(frames, { recursive: true, force: true })
  }
  report.shots = shots
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  server.kill()
}
if (errors.length) console.log("ERRORS:\n" + errors.slice(0, 20).join("\n"))
console.log(`wrote ${out}`)
await budget.exit(errors.length ? 1 : 0)
