// Static loudness check: the loading screen's own static (its analyser) and the whole mix (a tap on the master) in
// RMS dBFS, sampled through the load, under the menu, and into the title card and the intro's car radio. Headless
// Chrome can't capture audio, so these levels are the audio check. Muted, one page, 1280×720.
//
//   bun scripts/static-levels.ts [--base http://localhost:5196/]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const i = process.argv.indexOf("--base")
const base = i > 0 ? process.argv[i + 1]! : "http://localhost:5196/"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(base)
await page.evaluate(() => localStorage.removeItem("static.settings"))
await page.reload()
await page.waitForSelector("#shell", { timeout: 30_000 })
await page.waitForTimeout(400)
await page.keyboard.press("KeyA")
// The whole mix: the master tapped into a MediaStream, measured in a second context.
await page.evaluate(() => {
  const g = globalThis as unknown as { __afterhoursAudio?: { tap(): MediaStream | null }; __mix?: () => number }
  const mix = () => {
    const s = g.__afterhoursAudio?.tap()
    if (!s) return false
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    an.fftSize = 2048
    ctx.createMediaStreamSource(s).connect(an)
    const buf = new Float32Array(2048)
    g.__mix = () => {
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      return 10 * Math.log10(sum / buf.length + 1e-12)
    }
    return true
  }
  const t = setInterval(() => mix() && clearInterval(t), 200)
})
type G = { __afterhours?: { complete: boolean }; __static?: { flow: { phase: string }; tuner: { level(): number } }; __mix?: () => number }
const sample = () =>
  page.evaluate(() => {
    const g = globalThis as unknown as G
    const el = document.querySelector<HTMLElement>("#shell")
    const intro = (g as { __afterhoursIntro?: { sound?: { levels(): Record<string, number> | null } } }).__afterhoursIntro?.sound?.levels()
    const parts = intro ? Object.entries(intro).map(([k, v]) => `${k} ${v < -119 ? "silent" : v.toFixed(1)}`).join(" · ") : ""
    return { world: el?.dataset.world, phase: g.__static?.flow.phase, tuner: g.__static?.tuner.level() ?? -Infinity, mix: g.__mix?.() ?? null, readout: (el?.querySelector(".shell-load span")?.textContent ?? "") + parts }
  })
const fmt = (v: number | null) => (v === null ? "   n/a" : !isFinite(v) || v < -119 ? "silent" : `${v.toFixed(1).padStart(6)}`)
const rows: string[] = []
const log = async (t0: number) => {
  const s = await sample()
  rows.push(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${String(s.phase === "menu" ? s.world : s.phase).padEnd(8)} static ${fmt(s.tuner)} dB   whole mix ${fmt(s.mix)} dB  ${s.readout}`)
}
const t0 = Date.now()
for (;;) {
  await log(t0)
  if (await page.evaluate(() => (globalThis as unknown as G).__afterhours?.complete)) break
  await page.waitForTimeout(300)
}
for (let k = 0; k < 10; k++) {
  await page.waitForTimeout(400)
  await log(t0)
}
await page.click(".shell-play")
for (let k = 0; k < 8; k++) {
  await page.waitForTimeout(500)
  await log(t0)
}
await page.keyboard.press("Space")
// Into the drive long enough for the radio to come up and a voice fragment or two (the first at ~4 s, then every 7–13 s).
for (let k = 0; k < 40; k++) {
  await page.waitForTimeout(500)
  await log(t0)
}
await browser.close()
console.log(rows.join("\n"))
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
