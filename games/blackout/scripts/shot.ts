// Screenshots a practice round with headless Chromium (WebGPU on SwiftShader).
// Usage: bun scripts/shot.ts [url] [--out=dir] [--wait=seconds] [--keys=WWDD...]
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d
const base = args.find((a) => a.startsWith("http")) ?? "https://anoma.ly/arcade/blackout/"
const out = opt("out", "/tmp/opencode/shots")
const wait = Number(opt("wait", "14"))
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--no-sandbox"],
})
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } })
const logs: string[] = []
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(`${base}?practice`, { waitUntil: "networkidle" })
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, "1-lobby.png") })
await page.click("button[data-act=start]")
await page.waitForTimeout(2500)
await page.screenshot({ path: join(out, "2-loadout.png") })
await page.waitForTimeout(wait * 1000)
await page.mouse.move(1000, 400)
for (const k of opt("keys", "")) {
  await page.keyboard.down(`Key${k}`)
  await page.waitForTimeout(400)
  await page.keyboard.up(`Key${k}`)
}
await page.waitForTimeout(500)
await page.screenshot({ path: join(out, "3-live.png") })
console.log(logs.filter((l) => !l.startsWith("debug")).slice(0, 20).join("\n"))
await browser.close()
