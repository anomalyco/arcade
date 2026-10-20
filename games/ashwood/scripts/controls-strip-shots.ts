// Play-mode controls strip ([C] crouch, [F] flashlight, [M] map): a run skipped to explore, then the player placed in
// the corridor, at the entrance and in 3-08. Dev server :5196, headless, muted, 1280×720.
// Output: captures/controls-strip-<place>.png.
//
//   bun scripts/controls-strip-shots.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

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
type G = { __ashwood?: { complete: boolean }; __static?: { flow: { phase: string } }; __ashwoodPlayer: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; flashlight: boolean; resetMotion(): void; teleport(v: string): void } }
await page.goto("http://localhost:5196/")
await page.evaluate(() => localStorage.removeItem("static.settings"))
await page.reload()
await page.waitForFunction(() => (globalThis as unknown as G).__ashwood?.complete, null, { timeout: 300_000 })
await page.waitForTimeout(1500)
await page.click(".shell-play")
await page.waitForTimeout(1500)
await page.keyboard.press("Space")
await page.waitForTimeout(400)
await page.keyboard.press("Space")
await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "intro", null, { timeout: 30_000 })
await page.waitForTimeout(1200)
await page.keyboard.down("Space")
await page.waitForTimeout(1500)
await page.keyboard.up("Space")
await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "explore", null, { timeout: 60_000 })
// Let the intro's hand-over finish (it places the player itself) before moving them.
await page.waitForTimeout(3000)
// The look prompt (no pointer lock headless) and the arriving objective title would sit over the frame.
await page.addStyleTag({ content: "#hud, .objective-title { display: none !important; }" })
const places: [string, () => void][] = [
  // teleport("corridor") picks the highest floor under the point (the roof), so the ground-floor spine is set directly.
  [
    "corridor",
    () => {
      const p = (globalThis as unknown as G).__ashwoodPlayer
      Object.assign(p.pos, { x: -11, y: 0.2, z: 0.2 })
      p.yaw = Math.PI / 2
      p.pitch = -0.04
      p.flashlight = false
      p.resetMotion()
    },
  ],
  ["entrance", () => (globalThis as unknown as G).__ashwoodPlayer.teleport("entrance")],
  [
    "room-308",
    () => {
      const p = (globalThis as unknown as G).__ashwoodPlayer
      Object.assign(p.pos, { x: 9.6, y: 11.56, z: -4.6 })
      p.yaw = 0.46
      p.pitch = -0.28
      p.flashlight = true
      p.resetMotion()
    },
  ],
]
for (const [name, place] of places) {
  await page.evaluate(place)
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${out}/controls-strip-${name}.png` })
}
const strip = await page.evaluate(() => document.querySelector(".hints-strip")?.textContent)
await browser.close()
console.log({ strip, errors })
