// Real-time video of the whole intro cutscene, for checking motion, popping and hitches.
//
//   bun scripts/intro/video.ts [--tag run] [--size 1280x720] [--from 0] [--to <end>]
//
// `--from/--to` (cutscene seconds) record just that stretch: the cutscene is seeked and frozen there first.
// Boots `/?intro` on the dev server (:5196), holds the cutscene at its start until the page is up, then lets it play in
// real time while the CDP screencast records every compositor frame; writes captures/intro/video-<tag>.mp4 and prints
// frame-interval stats (hitches over 50 ms) measured in the page. One headless browser, muted. Needs ffmpeg.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const tag = flag("tag") ?? "run"
const [W, H] = (flag("size") ?? "1280x720").split("x").map(Number) as [number, number]
const from = Number(flag("from") ?? 0)
const to = flag("to") === undefined ? Infinity : Number(flag("to"))
const outDir = `${import.meta.dir}/../../captures/intro`
mkdirSync(outDir, { recursive: true })
const tmp = join(tmpdir(), `ashwood-intro-${tag}`)
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
type Intro = { rate: number; seek(t: number): void; time: number; total: number }
const frames: { file: string; t: number }[] = []
let total = 0
let stats: { n: number; median: number; p99: number; max: number; hitches: { at: number; ms: number }[] } | null = null
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://localhost:5196/?intro`)
  await page.waitForFunction(() => (globalThis as { __afterhoursIntro?: unknown }).__afterhoursIntro, undefined, { timeout: 240_000 })
  await page.evaluate((from) => {
    const i = (globalThis as unknown as { __afterhoursIntro: Intro }).__afterhoursIntro
    i.rate = 0
    i.seek(from)
  }, from)
  await page.waitForFunction(() => (globalThis as { __afterhours?: { frames: number } }).__afterhours!.frames > 30, undefined, { timeout: 120_000 })
  total = await page.evaluate(() => (globalThis as unknown as { __afterhoursIntro: Intro }).__afterhoursIntro.total)
  const cdp = await page.context().newCDPSession(page)
  let start = 0
  cdp.on("Page.screencastFrame", async (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const t = (f.metadata.timestamp ?? Date.now() / 1000) - start
    if (start && t >= 0) {
      const file = join(tmp, `${String(frames.length).padStart(5, "0")}.jpg`)
      frames.push({ file, t })
      writeFileSync(file, Buffer.from(f.data, "base64"))
    }
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1, maxWidth: W, maxHeight: H })
  await page.waitForTimeout(300)
  start = await page.evaluate(() => {
    const g = globalThis as unknown as { __afterhoursIntro: Intro; __gaps: { at: number; ms: number }[] }
    g.__gaps = []
    let last = performance.now()
    const t0 = last
    const loop = (now: number) => {
      g.__gaps.push({ at: (now - t0) / 1000, ms: now - last })
      last = now
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    g.__afterhoursIntro.rate = 1
    return Date.now() / 1000
  })
  await page.waitForFunction((to) => {
    const i = (globalThis as unknown as { __afterhoursIntro: Intro }).__afterhoursIntro
    return i.time >= Math.min(to, i.total)
  }, to, { timeout: (total + 60) * 1000, polling: 250 })
  await page.waitForTimeout(1500)
  await cdp.send("Page.stopScreencast")
  stats = await page.evaluate(() => {
    const gaps = (globalThis as unknown as { __gaps: { at: number; ms: number }[] }).__gaps.slice(2)
    const ms = gaps.map((g) => g.ms).sort((a, b) => a - b)
    return {
      n: ms.length,
      median: ms[ms.length >> 1]!,
      p99: ms[Math.floor(ms.length * 0.99)]!,
      max: ms[ms.length - 1]!,
      hitches: gaps.filter((g) => g.ms > 50).map((g) => ({ at: +g.at.toFixed(2), ms: +g.ms.toFixed(1) })),
    }
  })
  if (errors.length) console.log("errors:", errors.slice(0, 8))
} finally {
  await browser.close()
}

const dur = frames.length ? frames[frames.length - 1]!.t : 0
const list = join(tmp, "list.txt")
writeFileSync(list, frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t).toFixed(4)}`).join("\n") + "\n")
const out = join(outDir, `video-${tag}.mp4`)
const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", out])
if (ff.exitCode !== 0) console.error(ff.stderr.toString())
console.log(JSON.stringify({ out, frames: frames.length, seconds: +dur.toFixed(1), intro: +total.toFixed(1), frameStats: stats && { n: stats.n, median: +stats.median.toFixed(1), p99: +stats.p99.toFixed(1), max: +stats.max.toFixed(1) }, hitches: stats?.hitches.slice(0, 30) }))
