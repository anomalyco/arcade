// Drives headless Chromium with WebGPU enabled, joins a room, starts a bot match and saves screenshots.
// Usage: bun scripts/shot.ts [url] [outDir] [--start] [--seconds=N]
import { chromium } from "playwright-core"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith("http")) ?? "http://localhost:5191/?room=demo"
const out = args.find((a) => !a.startsWith("http") && !a.startsWith("--")) ?? "/tmp/opencode/shots"
const start = args.includes("--start")
const secs = Number(args.find((a) => a.startsWith("--seconds="))?.split("=")[1] ?? 8)
mkdirSync(out, { recursive: true })

const exe = join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome")
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"],
})
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 })
const logs: string[] = []
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(url, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(1500)
await page.screenshot({ path: join(out, "00-landing.png") })

if (start) {
  await page.fill("input[data-act=name-enter]", "mara")
  await page.click("button[data-act=enter]")
  await page.waitForSelector("button[data-act=start]", { timeout: 15000 })
  await page.screenshot({ path: join(out, "01-lobby.png") })
  await page.click("button[data-act=start]")
  await page.waitForTimeout(9000)
  await page.screenshot({ path: join(out, "02-loadout.png") })
  await page.waitForTimeout(secs * 1000)
  await page.mouse.move(800, 500)
  await page.screenshot({ path: join(out, "03-live.png") })
}
const webgpu = await page.evaluate(() => !!navigator.gpu)
console.log(JSON.stringify({ webgpu, errors: logs.filter((l) => /error|pageerror|warn/i.test(l)).slice(0, 30), logs: logs.slice(0, 40) }, null, 2))
await browser.close()
