// Headless capture of the standalone model sheet (scripts/models-sheet.html) for checking the model library.
//
//   bun scripts/models-sheet.ts                                   # every model → captures/models-sheet.png
//   bun scripts/models-sheet.ts --q "only=car_wagon,van&cell=768x480" --name cars
//   bun scripts/models-sheet.ts --q "night=1" --name night
//
// Uses the running dev server on :5196 (`bun run dev`).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const q = flag("q") ?? ""
const name = flag("name") ?? "sheet"
const [w, h] = (flag("size") ?? "1536x1024").split("x").map(Number) as [number, number]
const outDir = `${import.meta.dir}/../captures`
mkdirSync(outDir, { recursive: true })

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
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.goto(`http://localhost:5196/scripts/models-sheet.html?${q}`)
await page
  .waitForFunction(() => {
    const s = (globalThis as { __sheet?: { ready: boolean; errors: string[] } }).__sheet
    return s && s.ready
  }, undefined, { timeout: 180_000 })
  .catch((e: Error) => errors.push(e.message))
const pageErrors = await page.evaluate(() => (globalThis as { __sheet?: { errors: string[] } }).__sheet?.errors ?? [])
const stats = await page.evaluate(() => (globalThis as { __sheet?: { stats?: unknown } }).__sheet?.stats ?? null)
if (stats) console.log(JSON.stringify(stats))
const file = `${outDir}/models-${name}.png`
await page.locator("#sheet").screenshot({ path: file })
console.log(JSON.stringify({ file, errors: [...pageErrors, ...errors].slice(0, 12) }))
await browser.close()
process.exit(0)
