// Captures frames of the dev animation viewer (anim.html) with headless Chromium.
// Usage: bun scripts/anim-shot.ts [--base=url] [--q=only=a&zoom=9] [--start=2000] [--step=60] [--n=8] [--out=dir] [--clip=x,y,w,h]
import { chromium } from "playwright-core"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://blackout.lwoyjcaeyxv6.opentunnel.xyz/anim.html")
const out = opt("out", "/tmp/opencode/anim")
const start = Number(opt("start", "2000"))
const step = Number(opt("step", "60"))
const n = Number(opt("n", "8"))
const clip = opt("clip", "")
const vw = Number(opt("w", "1280"))
const vh = Number(opt("h", "800"))
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--no-sandbox"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh } })
const logs: string[] = []
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(`${base}?manual&${opt("q", "")}`, { waitUntil: "networkidle" })
await page.waitForFunction("window.ready === true", null, { timeout: 30000 }).catch(async (e) => {
  console.log(logs.join("\n"))
  await browser.close()
  throw e
})
await page.evaluate((ms) => (window as unknown as { advance(ms: number): Promise<void> }).advance(ms), start)
const c = clip ? clip.split(",").map(Number) : null
for (let i = 0; i < n; i++) {
  if (i > 0) await page.evaluate((ms) => (window as unknown as { advance(ms: number): Promise<void> }).advance(ms), step)
  await page.screenshot({ path: join(out, `f${String(i).padStart(2, "0")}.png`), clip: c ? { x: c[0]!, y: c[1]!, width: c[2]!, height: c[3]! } : undefined })
}
console.log(logs.filter((l) => !l.startsWith("debug")).slice(0, 20).join("\n"))
await browser.close()
