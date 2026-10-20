// Play-mode boot-to-ready: loads `/` (the game shell) N times in one headless browser and prints when the world was
// ready (`__ashwood.completeAt`, ms from navigation) per run and the median. For A/B-ing the loading screen's cost.
//
//   bun scripts/shell-boot-time.ts [--runs 3] [--base http://localhost:5196/]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const runs = Number(flag("runs") ?? 3)
const base = flag("base") ?? "http://localhost:5196/"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const times: number[] = []
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  await page.goto(base)
  const t = await page.waitForFunction(() => (globalThis as { __ashwood?: { completeAt: number | null } }).__ashwood?.completeAt ?? null, null, { timeout: 180_000 }).then((h) => h.jsonValue() as Promise<number>)
  times.push(t)
  console.log(`run ${i + 1}: ready at ${Math.round(t)} ms`)
  await ctx.close()
}
await browser.close()
const sorted = [...times].sort((a, b) => a - b)
console.log(`median ${Math.round(sorted[sorted.length >> 1]!)} ms`)
