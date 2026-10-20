// Headless Body Lab captures (body.html): frame sequences of scripted moves plus the foot-slide numbers.
//
//   bun scripts/player/lab-shots.ts "walk-side|script=walk&cam=side&speed=0.25" "walk-fp|script=walk&fp=1" \
//     [--frames 8] [--every 150] [--warm 1500] [--size 1200x750]
//
// Each setup is `name|query` (body.html?shot=1&<query>); waits for the body, `--warm` ms, then grabs `--frames`
// screenshots `--every` ms apart into captures/body-lab/<name>-<i>.png and a contact sheet <name>.png, and prints the
// slide meter (mean / max planted-foot slide, cm/s) for the scripted move.
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
const frames = Number(flag("frames", "8"))
const every = Number(flag("every", "150"))
const warm = Number(flag("warm", "1500"))
const [w, h] = flag("size", "1200x750").split("x").map(Number) as [number, number]
const out = `${import.meta.dir}/../../captures/body-lab`
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
type Lab = { ready: boolean; frames: number; state: string; slide: number[]; slideAvg: number; slideMax: number; errors: string[]; clips: unknown }
for (const setup of args) {
  const [name, query] = setup.split("|") as [string, string]
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://localhost:5196/body.html?shot=1&${query}`)
  await page.waitForFunction(() => (globalThis as { __bodyLab?: Lab }).__bodyLab?.ready, null, { timeout: 90_000 }).catch((e: Error) => errors.push(e.message))
  // The script clock starts at load; restart it now the body is in.
  await page.evaluate(() => (document.querySelector(`[data-script="${new URLSearchParams(location.search).get("script")}"]`) as HTMLButtonElement | null)?.click())
  await page.evaluate(() => (document.querySelector(`[data-script="${new URLSearchParams(location.search).get("script")}"]`) as HTMLButtonElement | null)?.click())
  await page.waitForTimeout(warm)
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
    const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
    const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
    const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `xstack=inputs=${files.length}:layout=${layout},scale=iw/2:-1`, `${out}/${name}.png`])
    if (p.exitCode !== 0) errors.push(p.stderr.toString())
  }
  const s = (await page.evaluate(() => {
    const l = (globalThis as { __bodyLab?: Lab }).__bodyLab
    return l && { state: l.state, slideAvg: l.slideAvg, slideMax: l.slideMax, errors: l.errors, clips: l.clips }
  })) as Lab
  console.log(JSON.stringify({ name, state: s?.state, slideAvg: s?.slideAvg, slideMax: s?.slideMax, errors: [...errors, ...(s?.errors ?? [])], ...(process.env.CLIPS ? { clips: s?.clips } : {}) }))
  await page.close()
}
await browser.close()
