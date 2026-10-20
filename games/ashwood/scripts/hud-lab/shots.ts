// HUD Lab captures (dev server :5196): a few picked combinations and the objective grid, to captures/hud-lab-*.png.
//
//   bun scripts/hud-lab/shots.ts
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
const COMBOS = [
  { name: "note-context-current", bg: "room", objective: "note", hints: "context", prompt: "current", hint: 0, verb: "Move the body" },
  { name: "dymo-strip-slip", bg: "corridor", objective: "dymo", hints: "strip", prompt: "slip", verb: "Open" },
  { name: "tab-hand-hand", bg: "lot", objective: "tab", hints: "hand", prompt: "hand", verb: "Search" },
  { name: "teletype-corner", bg: "corridor", objective: "teletype", hints: "corner", prompt: "current", verb: "Open" },
]
await page.goto("http://localhost:5196/hud-lab.html")
for (const c of COMBOS) {
  await page.evaluate((c) => {
    localStorage.setItem("hudLab.v1", JSON.stringify({ bg: c.bg, objective: c.objective, hints: c.hints, prompt: c.prompt, verb: c.verb, grid: false, used: [], text: 0, showPrompt: true }))
  }, c)
  await page.reload()
  await page.evaluate(() => document.fonts.ready)
  if (c.hint !== undefined) await page.evaluate((i) => (globalThis as unknown as { __hudLab: { showContext(i: number): void } }).__hudLab.showContext(i), c.hint)
  await page.waitForTimeout(2600)
  await page.locator(".hl-frame").first().screenshot({ path: `${out}/hud-lab-${c.name}.png` })
}
await page.evaluate(() => localStorage.setItem("hudLab.v1", JSON.stringify({ bg: "room", grid: true, hints: "none", showPrompt: false, text: 0 })))
await page.reload()
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(5000)
await page.screenshot({ path: `${out}/hud-lab-grid.png`, fullPage: false })
await browser.close()
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
