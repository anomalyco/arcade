// Headless frame sequences of the player's body (one browser, several setups), for checking the animation.
//
//   bun scripts/player/shots.ts "fp-walk|view=corridor&bodyDemo=walk&bodyPitch=-1.1" "3p|view=lot&bodyCam=3p" \
//     [--frames 4] [--every 120] [--size 960x640] [--wait 40]
//
// Each setup is `name|query`; it loads `?shot=1&<query>`, waits `--wait` complete frames, then grabs `--frames`
// screenshots `--every` ms apart into captures/body/<name>-<i>.png plus a contact sheet captures/body/<name>.png.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return def
  const v = args[i + 1]!
  args.splice(i, 2)
  return v
}
const frames = Number(flag("frames", "4"))
const every = Number(flag("every", "120"))
const wait = Number(flag("wait", "40"))
const [w, h] = flag("size", "960x640").split("x").map(Number) as [number, number]
const out = `${import.meta.dir}/../../captures/body`
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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
for (const setup of args) {
  const [name, query] = setup.split("|") as [string, string]
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://localhost:5196/?shot=1&${query}`)
  await page
    .waitForFunction((n) => ((globalThis as { __afterhours?: { frames: number } }).__afterhours?.frames ?? 0) >= n, wait, { timeout: 120_000 })
    .catch((e: Error) => errors.push(e.message))
  const files: string[] = []
  for (let i = 0; i < frames; i++) {
    const f = `${out}/${name}-${i}.png`
    await page.screenshot({ path: f })
    files.push(f)
    if (i < frames - 1) await page.waitForTimeout(every)
  }
  if (frames > 1) {
    const cols = Math.min(frames, 4)
    const inputs = files.flatMap((f) => ["-i", f])
    const layout = files.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => "w0").join("+") : "0"}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+") : "0"}`).join("|")
    const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw/2:-1`, `${out}/${name}.png`])
    if (p.exitCode !== 0) errors.push(p.stderr.toString())
  }
  const ms = await page.evaluate(() => (globalThis as { __afterhours?: { frameMs: number[] } }).__afterhours?.frameMs.slice(-60) ?? [])
  ms.sort((a, b) => a - b)
  console.log(JSON.stringify({ name, sheet: `${out}/${name}.png`, frameMedianMs: ms[ms.length >> 1] ?? null, errors }))
  await page.close()
}
await browser.close()
