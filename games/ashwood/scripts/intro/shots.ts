// Stills of the intro cutscene at chosen times (frozen while each settles), for checking framing, lights and the car.
//
//   bun scripts/intro/shots.ts 5 20 40 58 61 64 --tag a [--size 1280x720] [--q "extra=1"]
//
// Boots `/?intro` once on the dev server (:5196), seeks the cutscene to each time, freezes it, waits for TAA and the
// lamp fades to settle, and writes captures/intro/<tag>-<t>.png. One headless browser, muted, closed at the end.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const tag = flag("tag") ?? "shot"
const extra = flag("q") ?? ""
const [w, h] = (flag("size") ?? "1280x720").split("x").map(Number) as [number, number]
const settle = Number(flag("settle") ?? 45)
const times = args.map(Number)
const outDir = `${import.meta.dir}/../../captures/intro`
mkdirSync(outDir, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.goto(`http://localhost:5196/?intro${extra ? `&${extra}` : ""}`)
  await page.waitForFunction(() => (globalThis as { __ashwoodIntro?: unknown; __ashwood?: { complete: boolean } }).__ashwoodIntro && (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, undefined, { timeout: 240_000 })
  const frames = () => page.evaluate(() => (globalThis as unknown as { __ashwood: { frames: number } }).__ashwood.frames)
  for (const t of times) {
    await page.evaluate((t) => {
      const i = (globalThis as unknown as { __ashwoodIntro: { seek(t: number): void; rate: number } }).__ashwoodIntro
      i.rate = 1
      i.seek(t - 0.3)
    }, t)
    const f0 = await frames()
    await page.waitForFunction((n) => (globalThis as unknown as { __ashwood: { frames: number } }).__ashwood.frames >= n, f0 + 12, { timeout: 60_000 })
    await page.evaluate(() => ((globalThis as unknown as { __ashwoodIntro: { rate: number } }).__ashwoodIntro.rate = 0))
    const f1 = await frames()
    await page.waitForFunction((n) => (globalThis as unknown as { __ashwood: { frames: number } }).__ashwood.frames >= n, f1 + settle, { timeout: 60_000 })
    const file = `${outDir}/${tag}-${String(t).padStart(5, "0")}.png`
    await page.screenshot({ path: file })
    console.log(file)
  }
  if (errors.length) console.log("errors:", errors.slice(0, 8))
} finally {
  await browser.close()
}
