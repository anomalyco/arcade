// Renders the Title Lab's background once: the real home-screen view (the menu's drift camera, gate and dish in the
// fog) at 1920×1080 with the menu overlay hidden, full render resolution, written to src/title-lab/home-bg.jpg.
//
//   bun scripts/title-lab/capture-bg.ts        # needs the dev server on :5196
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto("http://localhost:5196/")
await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 180_000 })
await page.waitForTimeout(1500)
await page.evaluate(() => {
  const g = globalThis as unknown as { __ashwoodBody?: { settings: Record<string, unknown> }; __static?: { flow: { phase: string } } }
  // Full resolution, no dynamic scaling; freeze the drift where it is (the flow's camera only moves in "menu").
  const s = g.__ashwoodBody!.settings
  s["post.autoRes"] = false
  s["post.renderScale"] = 1
  s["post.maxDpr"] = 1
  g.__static!.flow.phase = "title"
  for (const sel of ["#shell", "#hud", ".title-card"]) document.querySelectorAll<HTMLElement>(sel).forEach((e) => (e.style.display = "none"))
})
await page.waitForTimeout(4000)
await page.screenshot({ path: `${import.meta.dir}/../../src/title-lab/home-bg.jpg`, type: "jpeg", quality: 90 })
await browser.close()
console.log("wrote src/title-lab/home-bg.jpg")
