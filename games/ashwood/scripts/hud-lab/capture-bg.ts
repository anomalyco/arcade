// Renders the HUD Lab's backgrounds once from the game (HUD hidden), 1600×900 JPEGs in src/hud-lab/bg/:
// corridor, 3-08 with the bodies, the dark lot, the clipboard map raised. Needs the dev server on :5196.
//
//   bun scripts/hud-lab/capture-bg.ts
import { chromium, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const out = `${import.meta.dir}/../../src/hud-lab/bg`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
type G = { __ashwood?: { complete: boolean }; __ashwoodPlayer: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; flashlight: boolean; resetMotion(): void }; __static?: { flow: { phase: string }; map: { raise(p?: number): void } | null } }
const HIDE = `#hud,.hints,.objective,.story-subtitles,.door-prompt,[data-lab-panel],.akp,.chapter-select{display:none!important}`
const shot = async (page: Page, name: string) => {
  await page.addStyleTag({ content: HIDE })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 82 })
}
const place = (page: Page, x: number, y: number, z: number, yaw: number, pitch: number, torch = false) =>
  page.evaluate(
    ([x, y, z, yaw, pitch, torch]) => {
      const p = (globalThis as unknown as G).__ashwoodPlayer
      Object.assign(p.pos, { x, y, z })
      p.yaw = yaw as number
      p.pitch = pitch as number
      p.flashlight = !!torch
      p.resetMotion()
    },
    [x, y, z, yaw, pitch, torch] as const,
  )

// Corridor, 3-08 and the lot: the debug sandbox (frames from a placed camera).
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto("http://localhost:5196/?view=corridor")
await page.waitForFunction(() => (globalThis as unknown as G).__ashwood?.complete, null, { timeout: 300_000 })
await page.waitForTimeout(2500)
await shot(page, "corridor")
await place(page, 9.6, 11.56, -4.6, 0.46, -0.28, true)
await page.waitForTimeout(3500)
await shot(page, "room-308")
await place(page, -30, 0, 92, -0.25, 0.04)
await page.waitForTimeout(3500)
await shot(page, "lot")
await page.close()

// The clipboard map: a play run skipped to explore, map raised.
const play = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await play.goto("http://localhost:5196/")
await play.waitForFunction(() => (globalThis as unknown as G).__ashwood?.complete, null, { timeout: 300_000 })
await play.waitForTimeout(1500)
await play.click(".shell-play")
await play.waitForTimeout(1500)
await play.keyboard.press("Space")
await play.waitForTimeout(400)
await play.keyboard.press("Space")
await play.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "intro", null, { timeout: 30_000 })
await play.waitForTimeout(1200)
await play.keyboard.down("Space")
await play.waitForTimeout(1500)
await play.keyboard.up("Space")
await play.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "explore", null, { timeout: 60_000 })
await play.waitForTimeout(2000)
await play.keyboard.press("KeyM")
await play.waitForTimeout(3500)
await shot(play, "map")
await browser.close()
console.log("wrote src/hud-lab/bg/{corridor,room-308,lot,map}.jpg")
