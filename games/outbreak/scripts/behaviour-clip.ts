import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * Zombie behaviour montage (AR-91): each staged behaviour (`behaviour.stage`) in the real game, then the same night
 * street with Zombie behaviour: Today and then Alive. Headless Metal Chromium (`--mute-audio`, no window), stepped
 * at 60 Hz with `harness.step`, captured every third frame (20 fps) as JPEG and encoded with ffmpeg when it is on the PATH.
 *
 *   bun scripts/behaviour-clip.ts      captures/behaviour-clip/{frames/NNNN.jpg,behaviour.mp4}
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/behaviour-clip")
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

type Beat = { frames: number; js?: string }
/** `torch`: aim the torch this way after staging (night scenes are pitch dark without it); null leaves it as staged. */
type Scene = { label: string; scene: string; zoom: number; beats: Beat[]; setup?: string; overlay?: number; mode?: number; torch?: number | null; watch?: boolean }

/** A noise `dx`, `dy` metres from the survivor, or from the watched scene's centre. */
const noise = (dx: number, dy: number, radius: number, kind: string) =>
  `const s = h.session(); const c = window.__zb?.watch ? window.__zb.centre : s.view.player; s.ai.emitNoise(c.x + ${dx}, c.y + ${dy}, ${radius}, "${kind}", s.sim.time, "player")`

const scenes: Scene[] = [
  { label: "Stop and listen: a bottle breaks off to one side", scene: "listen", zoom: 19, torch: 0, beats: [{ frames: 45 }, { frames: 255, js: noise(9, -9, 14, "glass") }] },
  { label: "Follow the one that noticed", scene: "follow", zoom: 19, torch: 0, beats: [{ frames: 300 }] },
  { label: "It saw you go in: search, look in at the windows, give up", scene: "search", zoom: 22, torch: Math.PI / 2, beats: [{ frames: 600 }] },
  { label: "Still by day; a shot wakes them", scene: "rest", zoom: 24, watch: true, beats: [{ frames: 180 }, { frames: 210, js: noise(0, 0, 30, "gunshot") }] },
  { label: "A night herd behind its leader", scene: "herd", zoom: 30, watch: true, beats: [{ frames: 360 }] },
  { label: "Feeding on a body", scene: "feed", zoom: 16, watch: true, beats: [{ frames: 330 }] },
  { label: "Climbing the fence after you", scene: "climb", zoom: 17, beats: [{ frames: 270 }] },
  { label: "Drawn to the lamp", scene: "light", zoom: 28, watch: true, beats: [{ frames: 420 }] },
  { label: "Flinching from the beam", scene: "flinch", zoom: 14, beats: [{ frames: 180 }] },
  {
    label: "Lightning freezes them",
    scene: "lightning",
    zoom: 28,
    watch: true,
    setup: `h.setLab("weather.weatherOverride", 3); h.setLab("weather.weatherLightningPerMinute", 20)`,
    beats: [{ frames: 360 }],
  },
  { label: "Night street — Zombie behaviour: Today", scene: "crowd", zoom: 34, overlay: 0, mode: 0, watch: true, beats: [{ frames: 450 }] },
  { label: "Same street — Zombie behaviour: Alive", scene: "crowd", zoom: 34, overlay: 0, mode: 1, watch: true, beats: [{ frames: 450 }] },
]

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&quality=balanced`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 60_000 })
  const ev = (src: string) => page.evaluate(new Function(`const h = window.__arcadeHarness; ${src}`) as () => unknown)
  await ev(`h.freeze(); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.session().ai.agents.length = 0`)
  // Presentation only: a brighter moon so the dead read at night in a small video (the same for Today and Alive).
  // and a wide light shroud, so a small video shows the whole scene.
  for (const [k, v] of [["moonFill", 1.8], ["moonlight", 1.8], ["exposure", 1.3], ["cone", 180], ["range", 40], ["fogStyle", 0], ["fogMemoryDim", 0.9]] as const) {
    await ev(`try { h.setLab("${k}", ${v}) } catch (e) { console.warn("${k}", e) }`)
  }
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 20px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })
  let shot = 0
  const summary: Record<string, unknown> = {}
  for (const sc of scenes) {
    await ev(
      `h.setLab("behaviour.zbMode", ${sc.mode ?? 1}); h.setLab("behaviour.zbOverlay", ${sc.overlay ?? 1}); h.setLab("weather.weatherOverride", 0); ${sc.setup ?? ""}; h.session().ai.agents.length = 0; Object.assign(h.session().view.player, { x: 24, y: 44, vx: 0, vy: 0 }); window.__zb = h.stageBehaviour("${sc.scene}", ${Boolean(sc.watch)}); h.setZoomRaw(${sc.zoom}); ${sc.torch == null ? "" : `Object.assign(h.session().view.player, { aim: ${sc.torch}, flashlightOn: true, flashlightOutput: 1 })`}`,
    )
    await page.evaluate((label) => {
      document.querySelector("#clip-label")?.remove()
      document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: label }))
    }, sc.label)
    let frame = 0
    for (const beat of sc.beats) {
      if (beat.js) await ev(beat.js)
      for (let i = 0; i < beat.frames; i++) {
        await page.evaluate(async () => {
          const h = (window as any).__arcadeHarness
          const p = h.session().view.player
          p.health = p.maxHealth
          await h.step(1 / 60, { aim: p.aim })
        })
        if (frame++ % 3 === 0) {
          const path = resolve(frames, `${String(shot++).padStart(4, "0")}.jpg`)
          await page.screenshot({ path, type: "jpeg", quality: 86, timeout: 300_000 }).catch(() => page.screenshot({ path, type: "jpeg", quality: 86, timeout: 300_000 }))
        }
      }
    }
    summary[sc.label] = await ev(`return h.state().behaviour`)
  }
  console.log(`behaviour-clip: ${shot} frames`)
  console.log(JSON.stringify(summary, null, 1))
  assert.deepEqual(errors, [])
  const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "20", "-i", resolve(frames, "%04d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-preset", "medium", resolve(out, "behaviour.mp4")], { stdio: "inherit" })
  console.log(ff.status === 0 ? `encoded ${resolve(out, "behaviour.mp4")}` : "ffmpeg not available; frames only")
} finally {
  await browser.close()
  await server.close()
}
