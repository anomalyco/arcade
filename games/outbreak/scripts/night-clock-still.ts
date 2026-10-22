import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * The night clock (playtest Oct 21, 1:38:07 "I have no concept of how much time is left"): stills of the real game in
 * headless Metal Chromium (`--mute-audio`, no window) at the hours where the chip changes: just before dark, deep in
 * the night, just before dawn, and with a HUD style that also shows the top-left summary. Writes PNGs and a readout.
 *
 *   bun scripts/night-clock-still.ts [--out <dir>]
 */
const root = resolve(import.meta.dir, "..")
const argOut = process.argv.indexOf("--out")
const out = resolve(argOut >= 0 ? process.argv[argOut + 1]! : resolve(root, "captures/night-clock"))

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium not found")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const shots = [
  { name: "1-dusk", hour: 15.6, style: null },
  { name: "2-night", hour: 23.2, style: null },
  { name: "3-dawn", hour: 6.75, style: null },
  { name: "4-today-style", hour: 23.2, style: 0 },
]

try {
  mkdirSync(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  const readout: Record<string, unknown> = {}
  for (const shot of shots) {
    readout[shot.name] = await page.evaluate(async (shot) => {
      const h = (window as any).__arcadeHarness
      h.setLab("zombieCount", 0)
      h.setLab("timeScale", 120)
      h.setLab("hour", shot.hour)
      if (shot.style !== null) h.setLab("hudStyle", shot.style)
      for (let i = 0; i < 6; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: Math.PI / 2 })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return h.state().nightClock ?? null
    }, shot)
    await page.screenshot({ path: resolve(out, `${shot.name}.png`), timeout: 120_000 })
    await page.screenshot({ path: resolve(out, `${shot.name}-corner.png`), clip: { x: 0, y: 0, width: 300, height: 80 }, timeout: 120_000 })
  }
  writeFileSync(resolve(out, "readout.json"), JSON.stringify({ readout, errors }, null, 2))
  console.log(JSON.stringify({ readout, errors }, null, 2))
  assert.equal(errors.length, 0, errors.join("\n"))
  assert.equal((readout["1-dusk"] as { mode: string } | null)?.mode, "dusk")
  assert.equal((readout["2-night"] as { mode: string } | null)?.mode, "night")
} finally {
  await browser.close()
  await server.close()
}
