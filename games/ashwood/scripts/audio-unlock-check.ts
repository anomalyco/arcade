// First-input cost of the audio: loads the game (one headless browser, 960×600), waits for the world and a few idle
// seconds, then presses a key and reports the long tasks (> 50 ms) in the next 2 s and the longest frame gap, plus
// whether every one-shot was already decoded before the key (it should be: decoding happens behind boot, in idle
// time, and the key only resumes the context). Expects the dev server on :5196.
//
//   bun scripts/audio-unlock-check.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.routeWebSocket(/.*/, () => {})
  await page.goto("http://localhost:5196/?view=corridor&only=terrain,interior")
  await page.waitForFunction(() => {
    const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
    return !!s?.complete && s.ready
  }, null, { timeout: 240_000 })
  await page.waitForTimeout(12_000)
  const before = await page.evaluate(() => {
    const A = (globalThis as unknown as { __afterhoursAudio: { sfx: { stats: { decoded: number } } } }).__afterhoursAudio
    return A.sfx.stats.decoded
  })
  await page.evaluate(() => {
    const g = globalThis as unknown as { __long: number[]; __gap: number }
    g.__long = []
    g.__gap = 0
    new PerformanceObserver((l) => l.getEntries().forEach((e) => g.__long.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: false })
    let last = performance.now()
    const tick = (t: number) => {
      g.__gap = Math.max(g.__gap, t - last)
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => ((globalThis as unknown as { __gap: number }).__gap = 0))
  await page.keyboard.press("KeyQ")
  await page.waitForTimeout(2000)
  const r = await page.evaluate(() => {
    const g = globalThis as unknown as { __long: number[]; __gap: number; __afterhoursAudio: { sfx: { stats: { decoded: number } } } }
    return { long: g.__long, gap: Math.round(g.__gap), decoded: g.__afterhoursAudio.sfx.stats.decoded }
  })
  console.log(`decoded before the key: ${before}; after: ${r.decoded}`)
  console.log(`after the key: long tasks ${JSON.stringify(r.long)} ms, longest frame gap ${r.gap} ms`)
  console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors")
} finally {
  await browser.close()
}
