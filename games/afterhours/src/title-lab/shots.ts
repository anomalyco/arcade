// Title Lab captures: the grid and one fullscreen card, to captures/title-lab-*.png (dev server on :5196).
//
//   bun src/title-lab/shots.ts [--card <index>]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const i = process.argv.indexOf("--card")
const card = i > 0 ? Number(process.argv[i + 1]) : 0
const out = `${import.meta.dir}/../../captures`
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--mute-audio"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto("http://localhost:5196/title-lab.html")
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(2500)
await page.screenshot({ path: `${out}/title-lab-grid.png` })
await page.evaluate((n) => (globalThis as unknown as { __titleLab: { openFull(i: number): void } }).__titleLab.openFull(n), card)
await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/title-lab-full.png` })
await browser.close()
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
