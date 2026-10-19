import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * A short clip and stills of storm weather (AR-71): a storm night on the street with rain in the flashlight and two
 * lightning strikes (one near, on screen; one far), the wet street with puddles in the beam, and a drizzle by day.
 * The real game in headless Metal Chromium (`--mute-audio`, no window), stepped at 60 Hz with `harness.step` and
 * captured as JPEG frames (every second step, so 30 fps); stills are PNG. Encode with ffmpeg afterwards.
 *
 *   bun scripts/weather-clip.ts      frames in captures/weather-clip/frames/NNNN.jpg, stills in captures/weather-clip/
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/weather-clip")
const frames = resolve(out, "frames")

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

/** One beat of steps: `at` runs (as harness source) on its first step, `still` saves a PNG after `stillAfter` steps. */
type Beat = { frames: number; aim?: number | [number, number]; at?: string; still?: string; stillAfter?: number }

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  const ev = (src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)
  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.session().ai.agents.length = 0`)
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 18px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })
  let shot = 0
  const log: Record<string, unknown> = {}
  const record = async (name: string, label: string, setup: string, beats: Beat[]) => {
    await ev(setup)
    await page.evaluate((label) => {
      document.querySelector("#clip-label")?.remove()
      document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: label }))
    }, label)
    let frame = 0
    for (const beat of beats) {
      for (let i = 0; i < beat.frames; i++) {
        if (i === 0 && beat.at) log[`${name}.${frame}`] = await ev(beat.at)
        const t = beat.frames > 1 ? i / (beat.frames - 1) : 0
        const aim = Array.isArray(beat.aim) ? beat.aim[0] + (beat.aim[1] - beat.aim[0]) * t : beat.aim
        await page.evaluate(async (aim) => {
          await (window as any).__arcadeHarness.step(1 / 60, aim === undefined ? {} : { aim })
        }, aim)
        if (beat.still && i === (beat.stillAfter ?? beat.frames - 1)) {
          await page.screenshot({ path: resolve(out, `${beat.still}.png`), timeout: 120_000 })
          log[`${beat.still}.state`] = await ev(`return h.state().weather`)
        }
        if (frame++ % 2 === 0) await page.screenshot({ path: resolve(frames, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
      }
    }
  }
  const scene = (hour: number, zoom: number, x: number, y: number, aim: number, state: string, zombies: [number, number][] = []) => `
    h.session().ai.agents.length = 0
    h.setLab("hour", ${hour})
    h.setLab("zoom", ${zoom})
    h.setWeatherState(${JSON.stringify(state)})
    h.pose(${x}, ${y}, ${aim})
    const p = h.session().view.player
    p.flashlightOn = true
    p.flashlightOutput = 1
    for (const [zx, zy] of ${JSON.stringify(zombies)}) h.spawnZombie(zx, zy, "wander")
  `

  // The street at 22:00, the beam east along the road, three of the dead out in the dark beyond it.
  await record("storm", "Storm night, 22:00: rain in the flashlight, lightning", scene(22, 42, 24, 44, 0.12, "storm", [[14, 37], [36, 52], [44, 36]]), [
    { frames: 50, aim: 0.12, still: "storm-night", stillAfter: 48 },
    { frames: 130, aim: 0.12, at: `return h.flashLightning(true, { bearing: -0.55, dist: 22 })`, still: "storm-flash", stillAfter: 2 },
    { frames: 50, aim: [0.12, -0.25] },
    { frames: 110, aim: -0.25, at: `return h.flashLightning(false)` },
  ])
  // Rain held at night: the road soaked, standing water in the gutters, gloss only in the beam.
  await record("wet", "Rain, 22:00: the wet street and its puddles in the beam", scene(22, 36, 24, 44, 0.3, "rain"), [
    { frames: 40, aim: 0.3 },
    { frames: 120, aim: [0.3, 0.75], still: "wet-street", stillAfter: 20 },
  ])
  // A drizzle front by day: fine streaks against the shade, a damp road, no puddles yet.
  await record("drizzle", "Drizzle, 14:00", scene(14, 42, 24, 44, 0.12, "drizzle"), [{ frames: 90, aim: 0.12, still: "drizzle-day", stillAfter: 60 }])

  writeFileSync(resolve(out, "log.json"), JSON.stringify(log, null, 2))
  console.log(`weather-clip: ${shot} frames`, JSON.stringify(log["storm-flash.state"]))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
