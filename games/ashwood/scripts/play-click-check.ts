// First-click-on-Play check: cold cache, CPU throttled (default ×4), clicks Play the moment it is visible and records
// what happened in the next seconds: the phase, whether the menu hid, the title card showed, long tasks, and the
// page's console volume. Headless, muted, 1280×720.
//
//   bun scripts/play-click-check.ts [--url https://anoma.ly/arcade/ashwood/] [--cpu 4] [--chrome]
//
// --chrome uses the installed Google Chrome in new headless mode (real compositor and GPU back-pressure).
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const url = arg("url") ?? "http://localhost:5196/"
const cpu = Number(arg("cpu") ?? 4)
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const real = process.argv.includes("--chrome")
const browser = await chromium.launch({ executablePath: real ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send("Network.enable")
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true })
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
const errors: string[] = []
let logs = 0
let logBytes = 0
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => {
  logs++
  logBytes += m.text().length
})
await page.addInitScript(() => {
  const g = globalThis as unknown as { __long: number[]; __input: string[] }
  g.__long = []
  g.__input = []
  // Input delay of every pointer/click event: when it happened vs when its handlers ran and the next frame painted.
  try {
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => {
        const ev = e as PerformanceEventTiming
        if (/pointer|click|mouse/.test(ev.name)) g.__input.push(`${ev.name} delay ${Math.round(ev.processingStart - ev.startTime)} ms, to paint ${Math.round(ev.duration)} ms`)
      }),
    ).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit)
  } catch {}
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => g.__long.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true })
  } catch {}
})
const t0 = Date.now()
await page.goto(url)
await page.waitForSelector(".shell-play", { state: "visible", timeout: 300_000 })
// "The moment it appears": as soon as the menu is visible to the eye (its fade-up has begun).
await page.waitForFunction(() => {
  const m = document.querySelector(".shell-main")
  return m && Number(getComputedStyle(m).opacity) > 0.15
}, null, { timeout: 300_000, polling: 16 })
const shownAt = Date.now() - t0
const logsBefore = logs
await page.evaluate(() => ((globalThis as unknown as { __long: number[] }).__long.length = 0))
await page.click(".shell-play", { timeout: 15000 }).catch((e) => errors.push(`click: ${e.message}`))
const clickAt = Date.now()
const timeline: string[] = []
for (let k = 0; k < 24; k++) {
  const s = await page.evaluate(() => {
    const g = globalThis as unknown as { __static?: { flow: { phase: string } }; __long: number[] }
    const shell = document.querySelector<HTMLElement>("#shell")
    const card = document.querySelector<HTMLElement>(".title-card")
    const play = document.querySelector<HTMLElement>(".shell-play")
    return {
      phase: g.__static?.flow.phase,
      screen: shell?.dataset.screen,
      world: shell?.dataset.world,
      card: card?.classList.contains("on") ?? false,
      play: play?.textContent,
      long: g.__long.splice(0).join(","),
    }
  })
  timeline.push(`${String(Date.now() - clickAt).padStart(5)} ms  phase ${s.phase}  menu ${s.screen}  world ${s.world}  card ${s.card}  play "${s.play}"  long [${s.long}]`)
  if (s.card && k > 4) break
  await page.waitForTimeout(250)
}
console.log(`url ${url}  cpu ×${cpu}  menu shown at ${shownAt} ms`)
console.log(timeline.join("\n"))
console.log((await page.evaluate(() => (globalThis as unknown as { __input: string[] }).__input)).join("\n") || "no slow input events")
console.log(`console messages: ${logsBefore} before Play (${logBytes} chars total), ${logs - logsBefore} after`)
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
await browser.close()
