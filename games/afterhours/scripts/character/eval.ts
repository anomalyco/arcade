// Evaluate a JS expression in a headless page (bodyb.html by default) once the body is ready; prints JSON.
//   bun scripts/character/eval.ts '<expr using B = __bodyB>' [--page "bodyb.html?character=kate"]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const pi = args.indexOf("--page")
const pageUrl = pi >= 0 ? args.splice(pi, 2)[1]! : "bodyb.html?shot=1"
const expr = args[0] ?? "B.state"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await (await browser.newContext({ viewport: { width: 640, height: 480 } })).newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.routeWebSocket(/.*/, () => {})
await page.goto(`http://localhost:5196/${pageUrl}`)
await page.waitForFunction(() => (globalThis as { __bodyB?: { ready: boolean } }).__bodyB?.ready, null, { timeout: 90_000 })
const out = await page.evaluate(`(async () => { const B = globalThis.__bodyB; return (${expr}) })()`)
console.log(JSON.stringify(out, null, 1))
if (errors.length) console.log("errors:", errors.slice(0, 5))
await browser.close()
