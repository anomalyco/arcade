import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * Teammates' flashlights (playtest Oct 21: "Why can't I see your flashlight?"): at 22:00 your own light is dead, so
 * night sight ends a few metres out, and a teammate beside you sweeps theirs across the street where four of the dead
 * stand 11–14 m off, past what you can see without a light. Once with Today's
 * teammate beams and once with full beams, same frames, in the real game in headless Metal Chromium (`--mute-audio`, no
 * window), stepped at 60 Hz with `harness.step` and captured as JPEG frames plus a side-by-side mp4 (ffmpeg).
 *
 *   bun scripts/team-beams-clip.ts [--out <dir>]
 */
const root = resolve(import.meta.dir, "..")
const argOut = process.argv.indexOf("--out")
const out = resolve(argOut >= 0 ? process.argv[argOut + 1]! : resolve(root, "../../captures/team-beams"))

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

const DOWN = Math.PI / 2
const ME = { x: 24.2, y: 40.0, aim: DOWN }
const MATE = { x: 27.4, y: 40.8 }
const DEAD = [
  { x: 33.5, y: 47.5 },
  { x: 30.0, y: 50.0 },
  { x: 25.0, y: 51.5 },
  { x: 34.5, y: 44.5 },
]
const argHour = process.argv.indexOf("--hour")
const HOUR = argHour >= 0 ? Number(process.argv[argHour + 1]) : 22
const argSteps = process.argv.indexOf("--steps")
const STEPS = argSteps >= 0 ? Number(process.argv[argSteps + 1]) : 300
const passes = [
  { name: "today", label: "Today: a teammate's light is a dim hint", teamBeams: 0 },
  { name: "full", label: "Full beams: what they light, you see", teamBeams: 1 },
]

try {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1&quality=high`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  await page.addStyleTag({
    content: `#clip-label{position:fixed;left:16px;top:12px;z-index:99;font:600 20px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}`,
  })
  const readout: Record<string, unknown> = {}
  for (const pass of passes) {
    const dir = resolve(out, pass.name)
    mkdirSync(dir, { recursive: true })
    await page.evaluate(
      async ({ pass, ME, MATE, DEAD, HOUR }) => {
        const h = (window as any).__arcadeHarness
        h.freeze(true)
        h.setLab("timeScale", 0)
        h.setLab("zombieCount", 0)
        h.setLab("hour", HOUR)
        h.setLab("teamBeams", pass.teamBeams)
        h.setZoomRaw(34)
        const sim = h.session().sim
        while (sim.slots.length > 1) sim.removeSurvivor(sim.slots[1]!.id)
        sim.ai.agents.length = 0
        sim.ai.nextId = 1
        h.pose(ME.x, ME.y, ME.aim)
        const mate = sim.addSurvivor("maya", 1)
        mate.survivor.x = MATE.x
        mate.survivor.y = MATE.y
        for (const z of DEAD) h.spawnZombie(z.x, z.y, "wander", -Math.PI / 2)
        document.querySelector("#clip-label")?.remove()
        document.body.append(Object.assign(document.createElement("div"), { id: "clip-label", textContent: pass.label }))
      },
      { pass, ME, MATE, DEAD, HOUR },
    )
    let shot = 0
    for (let i = 0; i < STEPS; i++) {
      // The teammate's aim sweeps across the street and back; the dead hold still.
      const sweep = DOWN + 1.1 * Math.sin((i / STEPS) * Math.PI * 2 - Math.PI / 2) + 0.1
      await page.evaluate(
        async ({ ME, MATE, DEAD, sweep }) => {
          const h = (window as any).__arcadeHarness
          const sim = h.session().sim
          const p = h.state().player
          p.x = ME.x
          p.y = ME.y
          p.aim = ME.aim
          p.vx = 0
          p.vy = 0
          p.flashlightOn = false
          p.flashlightOutput = 0
          const mate = sim.slots[1].survivor
          mate.x = MATE.x
          mate.y = MATE.y
          mate.vx = 0
          mate.vy = 0
          mate.aim = sweep
          mate.flashlightOn = true
          mate.flashlightOutput = 1
          DEAD.forEach((z: { x: number; y: number }, k: number) => {
            const a = sim.ai.agents[k]
            if (a) {
              a.x = z.x
              a.y = z.y
              a.vx = 0
              a.vy = 0
            }
          })
          await h.step(1 / 60, { mx: 0, my: 0, aim: ME.aim })
        },
        { ME, MATE, DEAD, sweep },
      )
      if (i % 2 === 0) await page.screenshot({ path: resolve(dir, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
    }
    readout[pass.name] = {
      frames: shot,
      at: await page.evaluate(() => {
        const h = (window as any).__arcadeHarness
        const v = h.session().view
        return { view: h.state().world?.viewRect, vel: [v.player.vx, v.player.vy], player: [v.player.x, v.player.y], slots: h.session().sim.slots.map((s: any) => [s.survivor.x, s.survivor.y]) }
      }),
    }
  }
  writeFileSync(resolve(out, "state.json"), JSON.stringify(readout, null, 1))
  const ffmpeg = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    "30",
    "-i",
    resolve(out, "today/%04d.jpg"),
    "-framerate",
    "30",
    "-i",
    resolve(out, "full/%04d.jpg"),
    "-filter_complex",
    "[0:v][1:v]hstack=inputs=2,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "22",
    resolve(out, "team-beams-split.mp4"),
  ])
  if (ffmpeg.exitCode !== 0) console.log(ffmpeg.stderr.toString())
  console.log("team-beams-clip:", JSON.stringify(readout))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
