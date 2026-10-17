// Headless capture of the standalone material sheet (scripts/material-sheet.html) for checking the library.
//
//   bun scripts/material-sheet.ts                               # every material, grid → captures/materials-grid.png
//   bun scripts/material-sheet.ts --q "only=tile_green,linoleum" --name tiles
//   bun scripts/material-sheet.ts --q "mode=floor&mat=asphalt_lot" --name lot
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
const name = flag("name") ?? "grid"
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
await page.goto(`http://localhost:5196/scripts/material-sheet.html?${q}`)
const stats = await page
  .waitForFunction(() => {
    const s = (globalThis as { __sheet?: { ready: boolean; errors: string[] } }).__sheet
    return s && (s.ready || s.errors.length > 0) ? s : null
  }, undefined, { timeout: 120_000 })
  .then((h) => h.jsonValue() as unknown as Promise<{ loadMs: number; textureMB: number }>)
  .catch((e: Error) => (errors.push(e.message), null))
const file = `${outDir}/materials-${name}.png`
await page.screenshot({ path: file })
console.log(JSON.stringify({ file, loadMs: stats ? Math.round(stats.loadMs) : null, textureMB: stats ? +stats.textureMB.toFixed(1) : null, errors: errors.slice(0, 8) }))
await browser.close()
process.exit(0)
