// Every sound a fresh solo start triggers, from the real client, with nothing reaching a speaker: headless Metal
// Chromium launched with --mute-audio, the game's audio graph unmuted after a trusted key press (as a player's first
// input does). Samples the audio telemetry four times a second: sounds played by id, voices per bus, held loops, ambience
// beds and vehicle cues, while idling (or walking east with --walk).
//
//   bun scripts/audio-start-browser.ts [--seconds 12] [--walk] [--slow-net 3000]   (from games/outbreak; via hivemind run --kind browser)
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const seconds = arg("seconds", 12)
const walk = process.argv.includes("--walk")
// --slow-net <ms>: hold every audio file this long, as a real connection to anoma.ly does on a cold cache.
const slowNet = arg("slow-net", 0)
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  if (slowNet > 0) await page.route(/\.(ogg|wav|mp3)(\?|$)/, async route => { await new Promise(r => setTimeout(r, slowNet)); await route.continue() })
  await page.goto(`http://127.0.0.1:${port}/?seed=7`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate(() => { (window as any).__t0 = performance.now() })
  await page.keyboard.press("Shift")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("audioMuted", 0))
  await page.waitForFunction(() => (window as any).__arcadeHarness.audio().state === "running", undefined, { timeout: 15_000 })
  if (walk) await page.keyboard.down("KeyD")
  const samples: unknown[] = []
  for (let i = 0; i < seconds * 4; i++) {
    await page.waitForTimeout(250)
    samples.push(await page.evaluate(() => {
      const a = (window as any).__arcadeHarness.audio()
      return { t: Math.round(performance.now() - (window as any).__t0), loaded: a.loadedSamples, voices: a.voices, byBus: a.byBus, holds: a.holds, beds: a.beds, horde: a.horde, played: a.playedById, vehicle: a.vehicle }
    }))
  }
  if (walk) await page.keyboard.up("KeyD")
  let prev: Record<string, number> = {}
  for (const s of samples as any[]) {
    const fresh = Object.entries(s.played as Record<string, number>).filter(([k, n]) => n !== (prev[k] ?? 0)).map(([k, n]) => `${k}×${n - (prev[k] ?? 0)}`)
    prev = s.played
    console.log(`${String(s.t).padStart(6)} ms decoded ${s.loaded} voices ${s.voices} ${JSON.stringify(s.byBus)} holds ${JSON.stringify(s.holds)} beds ${JSON.stringify(s.beds)} horde ${s.horde} new ${fresh.join(" ")} vehicle screech ${s.vehicle.screech} horns ${s.vehicle.horns} engines ${s.vehicle.activeEngines}`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
