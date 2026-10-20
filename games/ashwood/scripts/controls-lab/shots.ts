// Controls Lab captures (dev server :5196): a few combinations and the all-variants grid, to
// captures/controls-lab-*.png. Lives in scripts/ (Playwright imports under src/ break the Vite dev server).
//
//   bun scripts/controls-lab/shots.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const out = `${import.meta.dir}/../../captures`
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--mute-audio"] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
type Lab = { start(): void; recall(): void; use(id: string): void; setContext(id: string): void }
const COMBOS: { name: string; s: Record<string, unknown>; act?: (l: Lab) => void }[] = [
  { name: "under-corridor", s: { bg: "corridor", variant: "under", style: "outline" } },
  { name: "row-lot", s: { bg: "lot", variant: "row", style: "typewriter" } },
  { name: "stack-room", s: { bg: "room", variant: "stack", style: "outline" } },
  { name: "index-room", s: { bg: "room", variant: "index", style: "outline" } },
]
await page.goto("http://localhost:5196/controls-lab.html")
for (const c of COMBOS) {
  await page.evaluate((s) => localStorage.setItem("controlsLab.v1", JSON.stringify({ grid: false, ...s })), c.s)
  await page.reload()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1200)
  if (c.act) await page.evaluate(`(${c.act.toString()})(globalThis.__controlsLab)`)
  await page.waitForTimeout(1600)
  await page.locator(".cl-frame").first().screenshot({ path: `${out}/controls-lab-${c.name}.png` })
}
await page.evaluate(() => localStorage.setItem("controlsLab.v1", JSON.stringify({ bg: "corridor", grid: true, style: "outline" })))
// Tall enough that all twelve variants (four rows of three) fit in one capture.
await page.setViewportSize({ width: 1600, height: 1060 })
await page.reload()
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(2500)
await page.screenshot({ path: `${out}/controls-lab-grid.png` })
await browser.close()
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
