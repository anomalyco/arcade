// Planted-foot slide (cm/s) of Body B per scripted move and walk speed, headless:
//   bun scripts/playerb/slide.ts walk:1.9 walk:2.123 run:1.9 back:1.9 strafe_r:1.9
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
const page = await browser.newPage({ viewport: { width: 480, height: 360 } })
await page.goto("http://localhost:5196/bodyb.html?shot=1")
await page.waitForFunction(() => (globalThis as { __bodyB?: { ready: boolean } }).__bodyB?.ready, null, { timeout: 90_000 })
type B = { settings: Record<string, unknown>; startScript(n: string): void; slideAvg: number; slideMax: number; body: { debug: { weights: Record<string, number> } } }
for (const arg of process.argv.slice(2)) {
  const [script, walk] = arg.split(":") as [string, string]
  await page.evaluate(([s, w]) => {
    const b = (globalThis as unknown as { __bodyB: B }).__bodyB
    b.settings["lab.walk"] = Number(w ?? 1.9)
    b.startScript(s)
  }, [script, walk] as const)
  await page.waitForTimeout(4000)
  const r = await page.evaluate(() => {
    const b = (globalThis as unknown as { __bodyB: B }).__bodyB
    const w = Object.entries(b.body.debug.weights).filter(([, v]) => v > 0.01).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" ")
    return `${b.slideAvg} avg / ${b.slideMax} max cm/s  [${w}]`
  })
  console.log(arg.padEnd(16), r)
}
await browser.close()
