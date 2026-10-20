import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * Door breaches (AR-97): every wear stage and every breach type at Ash's front door, from inside, in the real game in
 * headless Metal Chromium (`--mute-audio`, no window), stepped at 60 Hz with `harness.step` and captured as JPEG
 * frames, plus each scene's harness readout. Encode with ffmpeg afterwards.
 *
 *   bun scripts/breach-clip.ts      frames in captures/breach-clip/NNNN.jpg, readout in captures/breach-clip/state.json
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/breach-clip")

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

const scenes: { scene: string; label: string; frames: number; aim?: number }[] = [
  { scene: "sound", label: "1 · Sound door: each hit jolts it, the handle rattles, dust", frames: 110 },
  { scene: "cracked", label: "2 · Cracked", frames: 100 },
  { scene: "split", label: "3 · Panel split, light through the gaps", frames: 100 },
  { scene: "failing", label: "4 · Failing: hinges and lock bending", frames: 100 },
  { scene: "holed", label: "5 · Punched through: arms reach in", frames: 140 },
  { scene: "giving", label: "6 · Warning beat, then off the hinges", frames: 190 },
  { scene: "split-door", label: "7 · Split down the middle", frames: 190 },
  { scene: "crush", label: "8 · Horde crush bursts the frame", frames: 220 },
  { scene: "boards", label: "9 · Last board hangs, then flies", frames: 200 },
  { scene: "burst", label: "10 · Boarded window bursts", frames: 200, aim: Math.atan2(35.4 - 33.3, 24.5 - 24.6) },
  { scene: "brace", label: "11 · Bracing: buys a few hits against three", frames: 200 },
]

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  const ev = (src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)
  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.session().ai.agents.length = 0; h.setZoomRaw(13)`)
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 18px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  let shot = 0
  const readout: Record<string, unknown> = {}
  for (const s of scenes) {
    await ev(`h.session().ai.agents.length = 0; h.stageBreach(${JSON.stringify(s.scene)})`)
    await page.evaluate((label) => {
      document.querySelector("#clip-label")?.remove()
      document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: label }))
    }, s.label)
    const trace: unknown[] = []
    for (let i = 0; i < s.frames; i++) {
      await page.evaluate(async (aim) => {
        await (window as any).__arcadeHarness.step(1 / 60, { mx: 0, my: 0, aim, interact: false })
      }, s.aim ?? Math.PI / 2)
      if (i % 2 === 0) await page.screenshot({ path: resolve(out, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
      if (i % 30 === 29) trace.push(await ev(`return h.state().breach`))
    }
    readout[s.scene] = trace
  }
  writeFileSync(resolve(out, "state.json"), JSON.stringify(readout, null, 1))
  console.log(`breach-clip: ${shot} frames`)
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
