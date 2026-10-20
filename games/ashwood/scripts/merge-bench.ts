// Headless run of scripts/merge-bench.html for each placement mode; prints node builds / programs / pipelines.
//   bun scripts/merge-bench.ts [small inst merge]
// Uses the running dev server on :5196.
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["small", "inst", "merge"]
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
for (const mode of modes) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } })
  await page.goto(`http://localhost:5196/scripts/merge-bench.html?mode=${mode}`)
  const s = await page
    .waitForFunction(() => {
      const b = (globalThis as { __bench?: { ready: boolean; errors: string[] } }).__bench
      return b && (b.ready || b.errors.length) ? b : null
    }, undefined, { timeout: 180_000 })
    .then((h) => h.jsonValue())
    .catch((e: Error) => ({ errors: [e.message] }))
  console.log(JSON.stringify(s))
  await page.close()
}
await browser.close()
process.exit(0)
