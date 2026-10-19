// Headless captures (and optional video) of the Creature Forge preview (creature.html), Metal, muted, one browser.
//
//   bun scripts/creature-shot.ts "scene=studio&cam=side&skip=2" [more queries...] [--tag t] [--video 14]
//
// Expects the dev server on :5196. Output: captures/creature-<n>[-tag].png; with --video <seconds>, records the first
// query in real time to captures/creature[-tag].mp4 and .webm, trimmed to start at the first rendered frame.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs"

const args = process.argv.slice(2)
const take = (flag: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const tag = take("--tag")
const video = take("--video")
const queries = args.length ? args : ["scene=studio&cam=q34&skip=1"]
const outDir = `${import.meta.dir}/../captures`
mkdirSync(outDir, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const W = 1280
const H = 720
if (video) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: outDir, size: { width: W, height: H } } })
  const t0 = performance.now()
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  // The page's clock starts with the first frame; `t` lets us trim the loading frames (black) off the front.
  await page.goto(`http://localhost:5196/creature.html?clean=1&${queries[0]}`)
  await page.waitForFunction(() => ((globalThis as { __creature?: { frames: number } }).__creature?.frames ?? 0) > 2, null, { timeout: 120_000 })
  const ready = (performance.now() - t0) / 1000
  await page.waitForTimeout(Number(video) * 1000)
  const path = await page.video()!.path()
  await ctx.close()
  const base = `${outDir}/creature${tag ? `-${tag}` : ""}`
  renameSync(path, `${base}.raw.webm`)
  // Trim to the first rendered frame: scan the raw recording's per-frame mean brightness (1×1 downscale) and cut at
  // the first frame that isn't black (the page-ready time doesn't line up with the recorder's clock).
  const fps = 25
  const scan = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", `${base}.raw.webm`, "-t", "8", "-vf", `fps=${fps},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "gray", "-"])
  const lum = new Uint8Array(scan.stdout)
  const first = lum.findIndex((v) => v > 8)
  const ss = (first >= 0 ? (first + 1) / fps : ready + 0.15).toFixed(2)
  const ff = (args: string[]) => Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-ss", ss, "-i", `${base}.raw.webm`, ...args]).exitCode
  const okW = ff(["-c:v", "libvpx-vp9", "-b:v", "3M", `${base}.webm`])
  const okM = ff(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", `${base}.mp4`])
  if (okW === 0 && okM === 0) unlinkSync(`${base}.raw.webm`)
  console.log(JSON.stringify({ video: `${base}.mp4`, trimmed: ss, errors }))
} else {
  let n = 0
  for (const q of queries) {
    const page = await browser.newPage({ viewport: { width: W, height: H } })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    await page.goto(`http://localhost:5196/creature.html?clean=1&fixed=1&${q}`)
    const ok = await page
      .waitForFunction(() => ((globalThis as { __creature?: { frames: number } }).__creature?.frames ?? 0) > 12, null, { timeout: 120_000 })
      .then(() => true)
      .catch(() => false)
    const file = `${outDir}/creature-${n++}${tag ? `-${tag}` : ""}.png`
    await page.screenshot({ path: file })
    const st = await page.evaluate(() => (globalThis as { __creature?: unknown }).__creature)
    const jank = await page.evaluate(() => (globalThis as { __jank?: () => unknown }).__jank?.())
    console.log(JSON.stringify({ q, file, ok, st, jank, errors }))
    await page.close()
  }
}
await browser.close()
