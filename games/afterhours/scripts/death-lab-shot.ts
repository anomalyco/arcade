// Death Lab captures: for each variant, a measured run (exact whole-mesh nearest point and eye-inside test) and a
// recorded run cut into a frame strip, from the corridor (or --place lobby). Headless, muted, 1280×720, one page at a time.
//
//   bun scripts/death-lab-shot.ts [A B C] [--place corridor|lobby]
// Output: captures/death-<V>-<place>.mp4, captures/death-<V>-<place>-strip.png, and a JSON line of measurements.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"

const args = process.argv.slice(2)
const pi = args.indexOf("--place")
const place = pi >= 0 ? args.splice(pi, 2)[1]! : "corridor"
const variants = args.length ? args : ["charge", "spin"]
const out = `${import.meta.dir}/../captures`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
for (const v of variants) {
  // 1. Measured run.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(`http://localhost:5196/death-lab.html?auto=${v}&place=${place}&clean=1&measure=1`)
    await page.waitForFunction(() => (globalThis as Any).__deathLab?.done, null, { timeout: 240_000 })
    const f = (await page.evaluate(() => (globalThis as Any).__deathLab.frames)) as Any[]
    const all = f.filter((x) => x.minAll !== undefined)
    const peak = f.reduce((a, b) => (b.fill > a.fill ? b : a), f[0])
    const pre = f.filter((x) => x.phase !== "strike")
    const strikeAt = f.find((x) => x.phase === "strike")?.t ?? 0
    console.log(
      JSON.stringify({
        v,
        place,
        wholeBodyPct: Math.round((100 * pre.filter((x) => x.body >= 0.99).length) / Math.max(1, pre.length)),
        mostBodyPct: Math.round((100 * pre.filter((x) => x.body >= 0.7).length) / Math.max(1, pre.length)),
        strikeAt,
        total: f[f.length - 1]?.t,
        faceNearestMin: Math.min(...f.map((x) => x.nearest)),
        meshNearestMin: Math.min(...all.map((x) => x.minAll)),
        eyeInside: all.filter((x) => x.inside).map((x) => `${x.t.toFixed(2)}s`),
        peakFill: peak.fill,
        peakAt: peak.t,
        peakCentre: [peak.cx, peak.cy],
        checked: all.length,
        errors,
      }),
    )
    await page.close()
  }
  // 2. Recorded run, cut to a strip.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
    const t0 = Date.now()
    const page = await ctx.newPage()
    await page.goto(`http://localhost:5196/death-lab.html?place=${place}&clean=1`)
    await page.waitForFunction(() => (globalThis as Any).__deathLab?.ready, null, { timeout: 240_000 })
    await page.waitForTimeout(1500)
    const at = (Date.now() - t0) / 1000
    await page.evaluate((x) => (globalThis as Any).__deathLab.play(x), v)
    await page.waitForFunction(() => (globalThis as Any).__deathLab?.done, null, { timeout: 30_000 })
    const dur = (await page.evaluate(() => (globalThis as Any).__deathLab.frames.at(-1).t)) as number
    await page.waitForTimeout(1800)
    const raw = await page.video()!.path()
    await ctx.close()
    const base = `${out}/death-${v}-${place}`
    renameSync(raw, `${base}.webm`)
    Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", (at + 0.35).toFixed(2), "-i", `${base}.webm`, "-t", (dur + 1.2).toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${base}.mp4`])
    Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", `${base}.mp4`, "-t", (dur + 0.5).toFixed(2), "-vf", `fps=${(18 / (dur + 0.5)).toFixed(3)},scale=320:-1,tile=6x3`, "-frames:v", "1", `${base}-strip.png`])
    Bun.spawnSync(["rm", `${base}.webm`])
    console.log(`strip: ${base}-strip.png`)
  }
}
await browser.close()
