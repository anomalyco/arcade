import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * House radios proof (AR-56) in headless Metal Chromium, muted, no window:
 *   hivemind run --kind browser --fetch captures/outbreak-radios -- bun games/outbreak/scripts/radios-proof.ts
 * Stills of a radio off, playing and knocked down, then a muted clip of the lure: the radio playing in Ash's house
 * with its front door open, six of the dead on the street turning and going in to it until they knock it down.
 * Writes captures/outbreak-radios/{proof.json,*.png,lure.mp4}.
 */
const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-radios")
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const server = await createServer({ root: game, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Install Chromium for Playwright")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = {}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  await page.goto(`${url}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  report.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)

  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) })
  const stage = (scene: string, hour: number) => page.evaluate(({ scene, hour }) => {
    const h = (window as any).__arcadeHarness
    h.reset(7); h.setLab("timeScale", 0); h.setLab("zombieCount", 0)
    const site = h.stageRadio(scene)
    h.setLab("hour", hour)
    return site
  }, { scene, hour })
  const step = (n: number) => page.evaluate(async (n) => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < n; i++) await h.step(1 / 60, { mx: 0, my: 0 })
    const s = h.state()
    return { radios: s.radios, zombies: (h.session?.().ai?.agents ?? []).filter((z: any) => z.state !== "dead").map((z: any) => `${z.state}@${z.x.toFixed(1)},${z.y.toFixed(1)}`) }
  }, n)

  for (const [scene, hour] of [["radio-off", 21], ["radio-playing", 21], ["radio-broken", 21]] as const) {
    await stage(scene, hour)
    const s = await step(20)
    report[scene] = s.radios
    await shot(scene)
  }
  assert.deepEqual((report["radio-playing"] as any).shown.playing, ["radio:ash"])
  assert.deepEqual((report["radio-broken"] as any).shown.broken, ["radio:ash"])

  // The lure, as a clip: 30 frames a second, two sim ticks a frame (real time).
  const site = await stage("radio-lure", 20.5)
  report.site = site
  const frames = join(out, "clip-frames")
  mkdirSync(frames, { recursive: true })
  const timeline: unknown[] = []
  let brokenAt = -1
  for (let i = 0; i < 30 * 40; i++) {
    const s = await step(2)
    if (i % 15 === 0) timeline.push({ t: (i / 30).toFixed(1), radio: s.radios.states["radio:ash"], zombies: s.zombies })
    await page.screenshot({ path: join(frames, `${String(i).padStart(4, "0")}.png`) })
    if (brokenAt < 0 && s.radios.states["radio:ash"] === "broken") brokenAt = i
    if (brokenAt >= 0 && i > brokenAt + 60) break
  }
  report.lure = { timeline, brokenAtSeconds: brokenAt >= 0 ? brokenAt / 30 : null }
  const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", join(frames, "%04d.png"), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", join(out, "lure.mp4")])
  report.clip = ff.exitCode === 0 ? "lure.mp4" : `ffmpeg failed (${ff.exitCode})`
  assert.deepEqual(errors, [])
  report.ok = true
} finally {
  writeFileSync(join(out, "proof.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2).slice(0, 4000))
  await browser.close()
  await server.close()
}
