// The escape drive, recorded: `?play&start=escape-truck`, the player gets in (E), starts the truck (E), the shed's
// roll-up is opened from its button, and the autopilot (the same pure pursuit the ending chapter uses) drives out of
// the shed, across the court, through the north gate and along the logging road until the road ambush takes over.
// Records the CDP screencast in real time → captures/escape/drive-<tag>.mp4, and logs the truck's state every second.
//
//   bun scripts/escape/drive-video.ts [--tag t] [--seconds 60] [--hunter 0]   # --hunter 0: the hunter sleeps
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i < 0 ? undefined : args[i + 1]
}
const tag = flag("tag") ?? "a"
const seconds = Number(flag("seconds") ?? 70)
const hunterOn = flag("hunter") !== "0"
const W = 1280
const H = 720
const outDir = `${import.meta.dir}/../../captures/escape`
mkdirSync(outDir, { recursive: true })
const tmp = join(tmpdir(), `ashwood-escape-${tag}`)
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const frames: { file: string; t: number }[] = []
const log: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)))
  await page.goto(`http://localhost:5196/?play&start=escape-truck`)
  await page.waitForFunction(() => (globalThis as any).__ashwoodEscape && (globalThis as any).__static?.flow.phase === "explore", undefined, { timeout: 240000 })
  await page.waitForTimeout(2500)
  if (!hunterOn) await page.evaluate(async () => (await import("/src/game/hunter/index.ts" as string)).hunterHandle()?.sleep())
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
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1, maxWidth: W, maxHeight: H })
  start = Date.now() / 1000
  const info = () => page.evaluate(() => (globalThis as any).__ashwoodEscape.info)
  await page.waitForTimeout(1200)
  await page.keyboard.press("KeyE") // get in
  await page.waitForTimeout(1500)
  await page.keyboard.press("KeyE") // start
  await page.waitForTimeout(2500)
  // The roll-up's button (the door system's control, as E on it would press it).
  await page.evaluate(() => (globalThis as any).__afterhoursPlayer.ctx.doors.get("motor-pool-button").open())
  await page.waitForTimeout(4500)
  await page.evaluate(() => ((globalThis as any).__ashwoodEscape.autopilot = true))
  const t0 = Date.now()
  while (Date.now() - t0 < seconds * 1000) {
    const s = await info()
    const road = await page.evaluate(() => (globalThis as any).__ashwoodRoad?.phase ?? null)
    log.push(`${((Date.now() - start * 1000) / 1000).toFixed(1)}s ${JSON.stringify(s)} ${road ?? ""}`)
    if (road === "card") break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(2000)
  await cdp.send("Page.stopScreencast")
  if (errors.length) log.push("errors: " + errors.slice(0, 5).join(" | "))
} finally {
  await browser.close()
}
console.log(log.join("\n"))
const list = join(tmp, "list.txt")
writeFileSync(list, frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t).toFixed(4)}`).join("\n") + "\n")
const out = join(outDir, `drive-${tag}.mp4`)
const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "21", out])
if (ff.exitCode !== 0) console.error(ff.stderr.toString())
console.log(out, frames.length, "frames")
