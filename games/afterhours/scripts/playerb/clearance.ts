// Flashlight-carry clearance for Body B (bodyb.html), headless and deterministic: steps the lab clock 1/30 s per frame
// through scripted moves and reports the minimum signed distance (cm) between the carrying arm / torch and the torso
// and thighs (negative = interpenetration), where it happened, and the per-frame trace for the worst move.
//   bun scripts/playerb/clearance.ts torch:0 torch:0.9 torch:-1.1 torch_run:0 torch_all [--secs 6]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const si = args.indexOf("--secs")
const secs = si >= 0 ? Number(args.splice(si, 2)[1]) : 6
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal"] })
for (const arg of args) {
  const [script, pitch] = arg.split(":") as [string, string | undefined]
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
  await page.goto(`http://localhost:5196/bodyb.html?shot=1${pitch !== undefined ? `&pitch=${pitch}` : ""}`)
  await page.waitForFunction(() => (globalThis as { __bodyB?: { ready: boolean } }).__bodyB?.ready, null, { timeout: 90_000 })
  type B = { pause(): void; advance(n: number): void; pending(): number; startScript(n: string): void; clear: number; clearMin: number; clearAt: string }
  await page.evaluate((n) => {
    const b = (globalThis as unknown as { __bodyB: B }).__bodyB
    b.pause()
    b.startScript(n)
  }, script)
  const n = Math.round(secs * 30)
  const trace: number[] = []
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => (globalThis as unknown as { __bodyB: B }).__bodyB.advance(1))
    await page.waitForFunction(() => (globalThis as unknown as { __bodyB: B }).__bodyB.pending() === 0)
    trace.push(await page.evaluate(() => (globalThis as unknown as { __bodyB: B }).__bodyB.clear))
  }
  const r = await page.evaluate(() => {
    const b = (globalThis as unknown as { __bodyB: B }).__bodyB
    return { min: b.clearMin, at: b.clearAt }
  })
  console.log(`${arg.padEnd(14)} min ${String(r.min).padStart(5)} cm  (${r.at})  frames<1cm ${trace.filter((x) => x < 1).length}/${n}`)
  await page.close()
}
await browser.close()
