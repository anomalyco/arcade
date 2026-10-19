// Records the play-mode load (the TV tuning in) to captures/shell-load.webm at 1280×720, presses a key early so the
// static's sound starts, and samples the tuner's analyser level (dBFS) with the boot progress every 250 ms (headless
// Chrome can't capture audio, so the levels are the audio check). Muted, one page.
//
//   bun scripts/shell-load-video.ts [--base http://localhost:5196/] [--after 4000]
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const base = flag("base") ?? "http://localhost:5196/"
const after = Number(flag("after") ?? 4000)
const out = `${import.meta.dir}/../captures`
mkdirSync(out, { recursive: true })
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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=user-gesture-required"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: `${out}/tmp-video`, size: { width: 1280, height: 720 } } })
const page = await ctx.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
type G = { __afterhours?: { complete: boolean; completeAt: number | null }; __static?: { tuner: { level(): number; playing(): boolean } } }
const t0 = Date.now()
await page.goto(base)
await page.waitForSelector("#shell", { timeout: 30_000 })
await page.waitForTimeout(600)
await page.keyboard.press("KeyA")
let readyAt: number | null = null
const samples: string[] = []
for (;;) {
  const s = await page.evaluate(() => {
    const g = globalThis as unknown as G
    const el = document.querySelector<HTMLElement>("#shell")
    return { level: g.__static?.tuner.level() ?? null, playing: g.__static?.tuner.playing() ?? false, world: el?.dataset.world, readout: el?.querySelector(".shell-load span")?.textContent ?? "", complete: !!g.__afterhours?.complete }
  })
  const t = Date.now() - t0
  samples.push(`${(t / 1000).toFixed(2).padStart(6)} s  ${String(s.world).padEnd(8)} ${s.level === null || !isFinite(s.level) ? "   silent" : `${s.level.toFixed(1).padStart(6)} dB`}  ${s.readout}`)
  if (s.complete && readyAt === null) readyAt = t
  if (readyAt !== null && t - readyAt > after) break
  if (t > 180_000) break
  await page.waitForTimeout(250)
}
const video = page.video()
await page.close()
await ctx.close()
await browser.close()
const path = await video?.path()
if (path) renameSync(path, `${out}/shell-load.webm`)
console.log(samples.join("\n"))
console.log(`ready at ${readyAt} ms (wall clock from navigation start)`)
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
