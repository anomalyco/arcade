// The ending (road ambush) in play mode: chapter `ending` (the drive starts 5 s before the ambush), the Wendigo in the
// headlights, the hit, the cut, the end card typed out and its options; then "Play again". Records the page and cuts
// captures/road-ambush.mp4 (first person, from 2 s before it appears to the options), plus stills.
// Headless, muted, 1280×720, one page.
//
//   bun scripts/road-check.ts [--base http://localhost:5196/]
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"

const args = process.argv.slice(2)
const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "http://localhost:5196/"
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
const t0 = Date.now()
const page = await ctx.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const road = () => page.evaluate(() => (globalThis as Any).__ashwoodRoad?.phase ?? null)
const shot = (n: string) => page.screenshot({ path: `${out}/road-${n}.png` })
let appearAt = 0
try {
  await page.goto(`${base}?play&start=ending`)
  await page.waitForFunction(() => (globalThis as Any).__ashwood?.complete, null, { timeout: 180_000 })
  await page.waitForTimeout(1500)
  if ((await page.evaluate(() => (globalThis as Any).__static?.flow.phase)) === "menu") await page.click("text=Play")
  await page.waitForTimeout(3500)
  await shot("drive")
  await page.waitForFunction(() => (globalThis as Any).__ashwoodRoad?.phase === "rush", null, { timeout: 30_000 })
  appearAt = Date.now() - t0
  const hold = await page.evaluate(() => (globalThis as Any).__static.flow.hold)
  check(hold === true, "input locked the instant it appears")
  await page.waitForTimeout(60)
  await shot("appear")
  await page.waitForFunction(() => (globalThis as Any).__ashwoodRoad?.phase === "glass", null, { timeout: 5_000 })
  await page.waitForTimeout(80)
  await shot("impact")
  await page.waitForTimeout(700)
  await shot("glass")
  await page.waitForFunction(() => (globalThis as Any).__ashwoodRoad?.phase === "card", null, { timeout: 8_000 })
  await page.waitForTimeout(12_000)
  await shot("card")
  await page.waitForSelector("text=Play again", { timeout: 10_000 })
  await page.waitForTimeout(1500)
  await shot("options")
  const st = await page.evaluate(() => ({ s: (globalThis as Any).__ashwoodRoad.stats, text: document.querySelector(".ending-card .title-card-text")?.textContent }))
  const fm = st.s.frameMs as number[]
  console.log(`rush→impact ${(st.s.impactAt - st.s.appearAt).toFixed(0)} ms, impact→cut ${(st.s.cutAt - st.s.impactAt).toFixed(0)} ms, frames max ${Math.max(...fm)} ms, >33 ms: ${fm.filter((x) => x > 33).length}/${fm.length}`)
  check(st.text === "October 20, 1984.County units reached Ashwood Station at 6:12 a.m.No survivors were found.", `end card text (${st.text})`)
  await Promise.all([page.waitForEvent("load", { timeout: 60_000 }), page.click("text=Play again")])
  let ph = ""
  for (let i = 0; i < 240 && !["title", "intro"].includes(ph); i++) {
    await page.waitForTimeout(1000)
    ph = await page.evaluate(() => (globalThis as Any).__static?.flow.phase ?? "").catch(() => "")
  }
  if (!["title", "intro"].includes(ph)) throw new Error(`Play again: phase ${ph}`)
  check(true, "Play again: a new run (title card)")
  check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ")})`)
} catch (e) {
  failures.push(String(e))
  console.log("FAIL", e)
  await shot("error").catch(() => {})
}
const raw = await page.video()!.path()
await ctx.close()
renameSync(raw, `${out}/road-raw.webm`)
if (appearAt) {
  const ss = Math.max(0, appearAt / 1000 - 2.5)
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", ss.toFixed(2), "-i", `${out}/road-raw.webm`, "-t", "26", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", `${out}/road-ambush.mp4`])
  console.log(`video: ${out}/road-ambush.mp4`)
}
await browser.close()
console.log(failures.length ? `${failures.length} failure(s)` : "all ok")
process.exit(failures.length ? 1 : 0)
