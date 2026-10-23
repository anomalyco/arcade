// Headless, muted stills of the title's voice item and Settings' Voice section with a fake mic (run after `bun run build`, through HiveMind):
//   bun scripts/voice-ui.ts [--out <dir>]
import { mkdirSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const i = process.argv.indexOf("--out")
const out = resolve(i >= 0 ? process.argv[i + 1]! : process.env.LEASE_OUT ?? "captures/voice-ui")
mkdirSync(out, { recursive: true })
const root = resolve("dist/arcade/barbara"), prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket: { message() {} }, async fetch(req, srv) {
  if (req.headers.get("upgrade") === "websocket" && srv.upgrade(req)) return undefined as unknown as Response
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })
const browser = await chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["microphone"] })
const page = await ctx.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=low&room=abcd&shell`, { waitUntil: "load" })
await page.waitForSelector("[data-act=voice-toggle]", { timeout: 60000 }).catch(async (e) => { console.log(errors, await page.evaluate(() => document.querySelector(".arcade-shell, [data-screen]")?.outerHTML.slice(0, 1500))); await page.screenshot({ path: `${out}/debug.png` }); throw e })
await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/title.png` })
await page.click("[data-act=voice-toggle]")
await page.waitForSelector("[data-act=settings]:not([disabled])")
await page.click("[data-act=settings]")
await page.waitForSelector("[data-voice=volume]", { timeout: 20000 })
await page.locator(".as-head", { hasText: "Voice" }).scrollIntoViewIfNeeded()
await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/settings-voice.png` })
console.log("errors", errors)
await browser.close()
server.stop(true)
