// Headless captures of the Monster Lab (monster.html) on the Metal adapter, muted, one browser.
//
//   bun scripts/monster-shot.ts "monster=wendigo&scene=forest&cam=approach&skip=8" [more queries...] [--tag t]
//
// Expects the dev server on :5196. Output: captures/monster-<n>[-tag].png, plus a JSON line per capture (errors, frames).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const ti = args.indexOf("--tag")
const tag = ti >= 0 ? args.splice(ti, 2)[1] : undefined
const queries = args.length ? args : ["scene=studio&cam=orbit&behaviour=0"]
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
let n = 0
for (const q of queries) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://localhost:5196/monster.html?${q}`)
  const ok = await page
    .waitForFunction(() => ((globalThis as { __monsterLab?: { frames: number } }).__monsterLab?.frames ?? 0) > 40, null, { timeout: 90_000 })
    .then(() => true)
    .catch(() => false)
  const file = `${outDir}/monster-${n++}${tag ? `-${tag}` : ""}.png`
  await page.screenshot({ path: file })
  const lab = await page.evaluate(() => (globalThis as { __monsterLab?: unknown }).__monsterLab)
  console.log(JSON.stringify({ q, file, ok, lab, errors }))
  await page.close()
}
await browser.close()
