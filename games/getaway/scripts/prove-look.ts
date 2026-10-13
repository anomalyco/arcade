import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createServer } from "vite"

// The switch-by-switch experiment is preserved in git history. The approved look
// now has one path; prove the retained Lab and a representative native-GPU frame.
const out = join(import.meta.dir, "../../../captures/getaway-look")
mkdirSync(out, { recursive: true })
const fixture = await createServer({ server: { host: "127.0.0.1", port: 0 }, configFile: join(import.meta.dir, "../vite.config.ts") })
await fixture.listen()
const host = fixture.resolvedUrls!.local[0]!
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)!
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  await page.goto(`${host}?solo&peaceful=1&seed=7&bench&nohud&lab=1`)
  await page.waitForFunction(() => (window as any).__getawayBench)
  await page.evaluate(async () => {
    const bench = (window as any).__getawayBench
    await bench.ready
    if (!bench.adapterInfo.architecture.includes("metal")) throw new Error("Expected Metal")
    bench.reset()
    for (let i = 0; i < 12; i++) await bench.step(i, 1 / 30, true)
    const root = document.querySelector("[data-lab]")!.shadowRoot!
    if (root.querySelector("input") || !root.querySelector<HTMLElement>("nav")!.hidden) throw new Error("Retired controls still visible")
    if (!root.querySelector("header")) throw new Error("Missing performance readout")
  })
  await page.screenshot({ path: join(out, "locked-look.png") })
  if (errors.length) throw new Error(errors.join("\n"))
  console.log("Metal look and telemetry-only Lab passed")
} finally {
  await browser.close()
  await fixture.close()
}
