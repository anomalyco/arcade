// Headless capture of scripts/corpse-heads.html → captures/heads-<name>.png (one browser).
//   bun scripts/corpse-heads.ts --name before [--q "side=1.2"]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
const name = flag("name") ?? "check"
const q = flag("q") ?? ""
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 1920, height: 840 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`http://localhost:5196/scripts/corpse-heads.html?${q}`)
await page.waitForFunction(() => (globalThis as { __heads?: { ready: boolean } }).__heads?.ready, undefined, { timeout: 240_000 }).catch((e: Error) => errors.push(e.message))
const st = await page.evaluate(() => (globalThis as { __heads?: { errors: string[] } }).__heads?.errors ?? [])
const file = `${import.meta.dir}/../captures/heads-${name}.png`
await page.locator("#c").screenshot({ path: file, timeout: 120_000 })
console.log(JSON.stringify({ file, errors: [...st, ...errors].slice(0, 6) }))
await browser.close()
process.exit(0)
