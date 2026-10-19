import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage()
page.on("pageerror", (e) => console.log("ERR", e.message))
await page.routeWebSocket(/.*/, () => {})
await page.goto(`http://localhost:5196/?${process.argv[3] ?? "intro&introAt=30"}`)
await page.waitForFunction(() => (globalThis as any).__afterhours?.complete, null, { timeout: 240_000 })
await page.waitForTimeout(1500)
console.log(await page.evaluate(process.argv[2]!))
await browser.close()
