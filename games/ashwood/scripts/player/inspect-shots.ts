// Pose-inspector contact sheets (body.html?inspect=1): per clip, rows of 4 phases each:
//   side, front (janitor, plus the source character beside it with --ref), right-hand close-up, left-hand close-up,
//   feet close-up, and with --ref the source character's right hand.
//
//   bun scripts/player/inspect-shots.ts [clips…] [--ref /captures/body-lab/src/UAL1.glb] [--tag t] [--phases 0,0.25,0.5,0.75]
//
// Output: captures/body-lab/inspect/<clip>[-tag].png (each tile 480×360, labelled in the file name order above).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string, def: string | null) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return def
  const v = args[i + 1]!
  args.splice(i, 2)
  return v
}
const ref = flag("ref", null)
const tag = flag("tag", null)
const phases = (flag("phases", "0,0.25,0.5,0.75") ?? "").split(",").map(Number)
const rowsArg = flag("rows", null)
const extra = flag("q", "")
const out = `${import.meta.dir}/../../captures/body-lab/inspect`
const tmp = `${out}/tiles`
mkdirSync(tmp, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 480, height: 360 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`http://localhost:5196/body.html?shot=1&inspect=1&inset=0${extra ? `&${extra}` : ""}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`)
await page.waitForFunction(() => (globalThis as { __bodyInspect?: unknown }).__bodyInspect, null, { timeout: 90_000 })
await page.addStyleTag({ content: "#hud,#bar{display:none!important}" })
const all = await page.evaluate(() => (globalThis as unknown as { __bodyInspect: { clips(): string[] } }).__bodyInspect.clips())
const clips = args.length ? args : all.filter((c) => !c.endsWith("~"))
type Row = [string, string, string]
const rows: Row[] = (rowsArg ?? (ref ? "side,front,hand_r,hand_r@ref,hand_l,feet" : "side,front,hand_r,hand_l,feet"))
  .split(",")
  .map((r) => {
    const [view, who] = r.split("@")
    return [r, view!, who ?? "janitor"]
  })
for (const clip of clips) {
  const files: string[] = []
  for (const [, view, who] of rows) {
    for (const ph of phases) {
      await page.evaluate(
        ([c, p, v, w]) => (globalThis as unknown as { __bodyInspect: { show(...a: unknown[]): void } }).__bodyInspect.show(c, p, v, w),
        [clip, ph, view, who] as const,
      )
      await page.waitForTimeout(120)
      const f = `${tmp}/${clip}-${view}-${who}-${ph}.png`
      await page.screenshot({ path: f })
      files.push(f)
    }
  }
  const cols = phases.length
  const at = (n: number, s: string) => (n ? Array.from({ length: n }, () => s).join("+") : "0")
  const layout = files.map((_, i) => `${at(i % cols, "w0")}_${at(Math.floor(i / cols), "h0")}`).join("|")
  const sheet = `${out}/${clip}${tag ? `-${tag}` : ""}.png`
  const p = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `xstack=inputs=${files.length}:layout=${layout}`, sheet])
  if (p.exitCode !== 0) errors.push(p.stderr.toString())
  console.log(JSON.stringify({ clip, sheet, rows: rows.map((r) => r[0]), phases }))
}
rmSync(tmp, { recursive: true, force: true })
if (errors.length) console.log(JSON.stringify({ errors }))
await browser.close()
