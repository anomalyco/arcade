// Play-mode control hints: Play → skip the title and intro → explore, capture the controls strip and the first
// contextual hint (M with the first objective), toggle with H, measure the darkness check's frame luminance at a few
// spots, and count the low spaces (colliders 0.9–1.6 m over the floor below them) the C hint can fire at.
// Headless, muted, 1280×720. Captures: captures/hints-*.png.
//
//   bun scripts/hints-check.ts [--base http://localhost:5196/]
import { chromium, type Page } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const i = process.argv.indexOf("--base")
const base = i > 0 ? process.argv[i + 1]! : "http://localhost:5196/"
const out = `${import.meta.dir}/../captures`
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
type G = { __afterhours?: { complete: boolean }; __static?: { flow: { phase: string }; hints: { lastLuma: number } }; __afterhoursPlayer?: { teleport(v: string): void; flashlight: boolean } }
const phase = (p: Page) => p.evaluate(() => (globalThis as unknown as G).__static?.flow.phase)

await page.goto(base)
await page.evaluate(() => localStorage.removeItem("ashwood.hints.seen"))
await page.waitForFunction(() => (globalThis as unknown as G).__afterhours?.complete, null, { timeout: 180_000 })
await page.waitForTimeout(1500)
await page.click(".shell-play")
await page.waitForTimeout(1500)
await page.keyboard.press("Space")
await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "intro", null, { timeout: 10_000 })
await page.waitForTimeout(1500)
await page.keyboard.down("Space")
await page.waitForTimeout(1400)
await page.keyboard.up("Space")
await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "explore", null, { timeout: 30_000 })
await page.waitForTimeout(3500)
await page.screenshot({ path: `${out}/hints-strip.png` })
const state = () =>
  page.evaluate(() => ({
    strip: (["on", "dim"] as const).find((c) => document.querySelector(".hints-strip")?.classList.contains(c)) ?? "off",
    debugKeys: (globalThis as unknown as { __afterhoursPlayer: { debugKeys: boolean } }).__afterhoursPlayer.debugKeys,
    lab: !!document.querySelector("[data-lab-panel]"),
    toast: document.querySelector(".hints-toast.on")?.textContent ?? null,
    seen: localStorage.getItem("ashwood.hints.seen"),
    luma: (globalThis as unknown as G).__static!.hints.lastLuma,
  }))
console.log("explore:", await state())
// The fade: past the full-strip minutes, then H brings it back up.
await page.evaluate(() => (globalThis as unknown as { __static: { hints: { advance(s: number): void } } }).__static.hints.advance(400))
await page.waitForTimeout(4500)
console.log("after the first minutes:", await state())
await page.screenshot({ path: `${out}/hints-dim.png` })
await page.keyboard.press("KeyH")
await page.waitForTimeout(900)
console.log("H brings it back:", await state())
await page.screenshot({ path: `${out}/hints-h.png` })
await page.keyboard.press("KeyH")
await page.waitForTimeout(900)
console.log("H again, back to the faded line:", await state())
for (const k of ["KeyN", "Digit3", "Backquote"]) await page.keyboard.press(k)
await page.waitForTimeout(300)
console.log("after N / 3 / \`:", await state())

for (const v of ["lobby", "corridor", "dock", "forest"]) {
  await page.evaluate((v) => (globalThis as unknown as G).__afterhoursPlayer!.teleport(v), v)
  await page.waitForTimeout(2500)
  const s = await state()
  console.log(`${v}: luma ${s.luma.toFixed(3)} toast ${s.toast}`)
  if (s.toast && /flashlight/i.test(s.toast)) await page.screenshot({ path: `${out}/hints-dark.png` })
}
const low = await page.evaluate(() => {
  const g = globalThis as unknown as { __afterhoursDebug: { scene: unknown }; __afterhoursPlayer: { groundAt(x: number, z: number, y: number): number; ctx: { colliders: { min: number[]; max: number[] }[] } } }
  const p = g.__afterhoursPlayer
  let n = 0
  for (const c of p.ctx.colliders) {
    if (c.max[1]! - c.min[1]! > 2.5) continue
    const x = (c.min[0]! + c.max[0]!) / 2
    const z = (c.min[2]! + c.max[2]!) / 2
    const above = c.min[1]! - p.groundAt(x, z, c.min[1]! - 0.05)
    if (above >= 0.9 && above <= 1.6) n++
  }
  return n
})
console.log(`low-space colliders: ${low}`)
console.log("phase", await phase(page), errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
await browser.close()
