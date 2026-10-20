import { chromium } from "playwright-core"
import { readdirSync, existsSync } from "node:fs"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on("pageerror", (e) => console.log("ERR", e.message))
await page.goto("http://localhost:5196/bodyb.html?shot=1")
await page.waitForFunction(() => (globalThis as any).__bodyB?.ready, null, { timeout: 90000 })
const clips = process.argv.slice(2)
for (const c of clips) {
  const r = await page.evaluate((c) => (globalThis as any).__bodyB.body.trace(c, 48), c)
  console.log(c, r.duration)
  for (let i = 0; i < 48; i += 2) {
    const f = (j: string) => r.out[j][i].map((x: number) => x.toFixed(3).padStart(7)).join(" ")
    console.log(String(i).padStart(2), "L", f("foot_l"), " R", f("foot_r"), " bL", f("ball_l"), " bR", f("ball_r"), " P", f("pelvis"))
  }
}
await browser.close()
