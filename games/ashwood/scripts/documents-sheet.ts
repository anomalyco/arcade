// Headless capture of scripts/documents-sheet.html → captures/documents-<name>.png.
//   bun scripts/documents-sheet.ts                                    # grid of every document on a cork wall
//   bun scripts/documents-sheet.ts --q "view=close&id=roster_duty" --name roster
//   bun scripts/documents-sheet.ts --q "view=desk" --name desk
// Uses the running dev server on :5196.
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
const q = flag("q") ?? ""
const name = flag("name") ?? "sheet"
const [w, h] = (flag("size") ?? "2400x1500").split("x").map(Number) as [number, number]
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.goto(`http://localhost:5196/scripts/documents-sheet.html?${q}`)
await page
  .waitForFunction(() => (globalThis as { __sheet?: { ready: boolean } }).__sheet?.ready, undefined, { timeout: 180_000 })
  .catch((e: Error) => errors.push(e.message))
const file = `${import.meta.dir}/../captures/documents-${name}.png`
await page.screenshot({ path: file, timeout: 120_000 })
console.log(JSON.stringify({ file, errors: errors.slice(0, 8) }))
await browser.close()
process.exit(0)
