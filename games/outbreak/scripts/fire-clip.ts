import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * One short clip of fire & explosives at night (AR-62): the flamethrower sprayed into the dead coming up the road,
 * then a stick of dynamite thrown into a knot of them. The real game in headless Metal Chromium (`--mute-audio`, no
 * window), stepped at 60 Hz with `harness.step` and captured as JPEG frames; encode with ffmpeg afterwards.
 *
 *   bun scripts/fire-clip.ts      frames in captures/fire-clip/NNNN.jpg
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/fire-clip")

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

type Beat = { frames: number; cmd?: Record<string, unknown>; first?: Record<string, unknown> }

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  const ev = (src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)
  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.session().ai.agents.length = 0; h.setZoomRaw(17)`)
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 18px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  let shot = 0
  const record = async (label: string, setup: string, beats: Beat[], every = 2) => {
    await ev(setup)
    await page.evaluate((label) => {
      document.querySelector("#clip-label")?.remove()
      document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: label }))
    }, label)
    let frame = 0
    for (const beat of beats) {
      for (let i = 0; i < beat.frames; i++) {
        const cmd = { ...(beat.cmd ?? {}), ...(i === 0 ? (beat.first ?? {}) : {}) }
        await page.evaluate(async (cmd) => {
          await (window as any).__arcadeHarness.step(1 / 60, cmd)
        }, cmd)
        if (frame++ % every === 0) await page.screenshot({ path: resolve(out, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
      }
    }
  }
  await record("Flamethrower at night", `h.session().ai.agents.length = 0; h.stageFire("flamethrower")`, [
    { frames: 50, cmd: { aim: 0 } },
    { frames: 170, cmd: { aim: 0, fireHeld: true }, first: { fire: true } },
    { frames: 40, cmd: { aim: 0.25, fireHeld: true } },
    { frames: 150, cmd: { aim: 0 } },
  ])
  await record("Dynamite", `h.session().ai.agents.length = 0; h.stageFire("dynamite")`, [
    { frames: 40, cmd: { aim: 0 } },
    { frames: 280, cmd: { aim: 0 }, first: { fire: true } },
  ])
  const state = (await ev(`return h.state().fire`)) as unknown
  console.log(`fire-clip: ${shot} frames`, JSON.stringify(state))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
