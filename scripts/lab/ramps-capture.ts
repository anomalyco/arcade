// Deterministic Lab Effects captures (seed 7, frozen camera, fixed frame counts) for pixel-diffing two builds: the
// particle effects that take the over-life ramps, at a few points of their life. Works on a tree without ramps too
// (copy it into an older export), so a capture of main and one of a branch can be compared pixel for pixel.
// RAMPS_OUT=<dir> [RAMPS_SETTINGS='{"sizeOverLife":"…"}'] [RAMPS_PANEL=1] bun scripts/lab/ramps-capture.ts
/// <reference types="@webgpu/types" />
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "../..")
const out = resolve(process.env.RAMPS_OUT ?? resolve(root, "captures/lab-ramps"))
mkdirSync(out, { recursive: true })
const overrides: Record<string, unknown> = JSON.parse(process.env.RAMPS_SETTINGS ?? "{}")
const EFFECTS = ["sparks", "debris", "water", "fire", "nitro"] as const
const FRAMES = [12, 40, 90] as const

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Chromium not found in ~/Library/Caches/ms-playwright")

const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const addr = server.httpServer!.address()
assert(addr && typeof addr !== "string")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const meta: Record<string, unknown> = { overrides }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(() => {
    window.AudioContext = class { constructor() { throw new Error("Live audio is disabled in this capture") } } as any
  })
  await page.goto(`http://127.0.0.1:${addr.port}/arcade/lab/?section=effects&bench`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 120000 })
  await page.waitForTimeout(1500)
  // Readout panels add canvases inside the viewport; the scene is the viewport's own canvas.
  const canvas = page.locator(".lab-viewport > canvas").first()
  for (const effect of EFFECTS) {
    const counts: number[] = []
    let frame = 0
    await page.evaluate(async ({ effect, overrides }) => {
      const l = (window as any).lab
      const s = l.sections.find((x: any) => x.id === "effects")
      Object.assign(s.settings, { effect, seed: 7, targetX: -1, targetZ: 0, loop: false, playing: false, rate: 75, size: 1, speed: 1, density: 1 })
      for (const [k, v] of Object.entries(overrides)) if (k in s.settings) s.settings[k] = v
      s.retrigger()
      const st = l.context.stage
      st.resetCamera()
      st.frameTarget(-1, 0.9, 0, 9)
      await l.render()
    }, { effect, overrides })
    for (const target of FRAMES) {
      const count = await page.evaluate(async (n) => {
        const l = (window as any).lab
        const s = l.sections.find((x: any) => x.id === "effects")
        for (let i = 0; i < n; i++) {
          s.settings.playing = true
          l.advance(1 / 60)
          s.settings.playing = false
        }
        await l.render()
        return l.context.particles.count as number
      }, target - frame)
      frame = target
      counts.push(count)
      await canvas.screenshot({ path: resolve(out, `${effect}-f${String(target).padStart(3, "0")}.png`) })
    }
    meta[effect] = { frames: FRAMES, particles: counts }
  }
  if (process.env.RAMPS_PANEL) {
    await page.evaluate(async () => {
      const l = (window as any).lab
      const s = l.sections.find((x: any) => x.id === "effects")
      s.settings.effect = "fire"
      s.settings.playing = true
      s.retrigger()
      for (let i = 0; i < 40; i++) l.advance(1 / 60)
      await l.render()
    })
    const row = page.locator('.knobs-row[data-field="sizeOverLife"]').first()
    if (await row.count()) await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(out, "panel.png") })
    meta.panelRows = await page.evaluate(() => ["tintOverLife", "sizeOverLife", "opacityOverLife"].filter(k => document.querySelector(`.knobs-row[data-field="${k}"]`)))
  }
  meta.errors = errors
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`)
} finally {
  await browser.close()
  await server.close()
}
