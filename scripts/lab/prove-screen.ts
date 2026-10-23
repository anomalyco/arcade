/// <reference types="@webgpu/types" />
// The shared screen display (`@arcade/kit/gpu/screen`) on the Lab world's screen bench, on a fixed 60 Hz clock, headless
// Metal WebGPU, muted: stills of the programme's cuts with the screen's light on the room, each display preset, a macro
// of the mask and scanlines, the power and degauss animations, the practicals, tape and snow; the light's readback
// values per still; GPU ms with the screen on and off. `--clip` adds a 30 fps clip of power off, on and degauss.
//   bun scripts/lab/prove-screen.ts [--out dir] [--clip] [--only name,name]
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Page } from "playwright-core"
import { createServer } from "vite"
import { browserBudget } from "../browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const { values: flags } = parseArgs({
  options: {
    out: { type: "string", default: resolve(import.meta.dir, "../../captures/screen-display") },
    clip: { type: "boolean", default: false },
    only: { type: "string", default: "" },
  },
})
const out = resolve(flags.out!)
mkdirSync(out, { recursive: true })
const root = resolve(import.meta.dir, "../..")
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("Playwright Chromium headless shell required")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), logLevel: "warn", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No port")

const invoke = (page: Page, command: string, args: Record<string, unknown>) =>
  page.evaluate(([c, a]) => (window as any).lab.workbench.invoke(c, a), [command, args] as const)
const set = async (page: Page, key: string, value: unknown) => {
  const res = await invoke(page, "world.set", { key, value })
  if (!res.ok) throw new Error(`world.set ${key}=${String(value)}: ${JSON.stringify(res)}`)
}
const advance = (page: Page, seconds: number) => page.evaluate(async (n) => {
  const lab = (window as any).lab
  // Yield a task after each render: WebGPU resolves the light's mapAsync readbacks only between tasks.
  const tick = () => new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < n; i++) { lab.advance(1 / 60); if (i % 6 === 5) { await lab.render(); await tick() } }
  await lab.render()
}, Math.max(1, Math.round(seconds * 60)))
const camera = (page: Page, at: { yaw: number; pitch: number; dist: number; target: readonly number[] }) => page.evaluate((c) => {
  const stage = (window as any).lab.context.stage
  stage.focus[0] = c.target[0]; stage.focus[1] = c.target[1]; stage.focus[2] = c.target[2]
  stage.targetFocus?.set?.(c.target)
  stage.camYaw = stage.targetYaw = c.yaw
  stage.camPitch = stage.targetPitch = c.pitch
  stage.camDist = stage.targetDist = c.dist
  stage.hasDampedTarget = false
  stage.camCustom = true
  stage.updateCamera()
}, at)
const telemetry = (page: Page) => page.evaluate(() => (window as any).lab.sections.find((x: any) => x.id === "world").telemetry() as string)
const want = (name: string) => !flags.only || flags.only.split(",").includes(name)
const lights: Record<string, unknown> = {}
const shot = async (page: Page, name: string) => {
  if (!want(name)) return
  // Let the light's readback catch up with this picture (no clock advance): a few renders a frame apart.
  await page.evaluate(async () => { for (let i = 0; i < 8; i++) { await (window as any).lab.render(); await new Promise(r => setTimeout(r, 16)) } })
  await page.locator("canvas").first().screenshot({ path: resolve(out, `${name}.png`) })
  const t = await telemetry(page)
  const screen = /"screen":(\{[^}]*\})/.exec(t)?.[1]
  lights[name] = screen ? JSON.parse(screen) : null
  console.log(`${name}: ${screen ?? t}`)
}

const errors: string[] = []
const report: Record<string, unknown> = {}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${addr.port}/arcade/lab/?bench#world`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 60000 })
  // The bench's own preset camera (`SCREEN_CAMERA`): off to one side, the set, the rug and the chair in view.
  const benchCam = { yaw: 0.95, pitch: 0.24, dist: 2.6, target: [16.15 - 19 - 0.3, 0.86, 9.85 - 21] }
  // A hand's breadth from the glass: about six pixels a scanline and a triad at 1280×800.
  const macroCam = { yaw: 0.04, pitch: 0.03, dist: 0.24, target: [16.15 - 19 + 0.05, 1.29, 8.83 - 21] }

  // Before: the same room and camera with the set switched off and cooled.
  await invoke(page, "world.preset", { preset: "screen-bench" })
  await camera(page, benchCam)
  await set(page, "screen.power", false)
  await advance(page, 3)
  await shot(page, "before-screen-off")
  await set(page, "screen.power", true)
  await advance(page, 3)

  // The screen light's gain: 1 is physical; the preset's choice sits among these.
  await set(page, "programme", "white")
  for (const gain of [1, 4, 8, 12]) {
    await set(page, "screen.light", gain)
    await advance(page, 0.2)
    await shot(page, `gain-${gain}`)
  }
  await invoke(page, "world.preset", { preset: "screen-bench" })
  await set(page, "screen.power", true)
  await camera(page, benchCam)
  // The programme loop: sunset 0–4, sea 4–7.5, studio 7.5–11.5, storm 11.5–14.1, forest 14.1–17.6, cartoon 17.6–20.6.
  const shots: [string, number][] = [["sunset", 2], ["sea", 5.5], ["studio", 9.5], ["storm-flash", 11.5 + 1.33], ["forest", 15.5], ["cartoon", 19]]
  let clock = 0
  for (const [name, at] of shots) {
    await advance(page, at - clock)
    clock = at
    await shot(page, `show-${name}`)
  }
  await camera(page, macroCam)
  await set(page, "programme", "card")
  await advance(page, 0.5)
  await shot(page, "macro-card")
  for (const preset of ["pvm", "arcade", "portable", "terminal", "lcd"]) {
    await set(page, "screen.preset", preset)
    await advance(page, 0.3)
    await shot(page, `macro-${preset}`)
  }
  await set(page, "screen.preset", "tv")
  await set(page, "programme", "show")
  await camera(page, benchCam)
  await set(page, "programme", "show")
  for (const preset of ["pvm", "lcd"]) {
    await set(page, "screen.preset", preset)
    await advance(page, 0.3)
    await shot(page, `room-${preset}`)
  }
  await set(page, "screen.preset", "tv")

  // Power off: the field folds to a line, the line to a dot, the dot cools. Then on, with the degauss coil.
  await set(page, "programme", "bars")
  await advance(page, 0.5)
  const closer = { ...benchCam, dist: 1.4, yaw: 0.12, pitch: 0.08, target: [16.15 - 19, 1.22, 8.85 - 21] }
  await camera(page, closer)
  await shot(page, "power-on-steady")
  await set(page, "screen.power", false)
  let off = 0
  for (const ms of [50, 130, 300, 900]) {
    await advance(page, (ms - off) / 1000)
    off = ms
    await shot(page, `power-off-${String(ms).padStart(4, "0")}ms`)
  }
  await advance(page, 2)
  await set(page, "screen.power", true)
  let t = 0
  for (const ms of [80, 200, 450, 900, 2500]) {
    await advance(page, (ms - t) / 1000)
    t = ms
    await shot(page, `power-on-${String(ms).padStart(4, "0")}ms`)
  }

  if (flags.clip) {
    const frames = resolve(out, "frames")
    rmSync(frames, { recursive: true, force: true })
    mkdirSync(frames)
    await set(page, "programme", "show")
    await advance(page, 1)
    let f = 0
    const record = async (seconds: number) => {
      for (let i = 0; i < seconds * 30; i++) {
        await advance(page, 1 / 30)
        await page.locator("canvas").first().screenshot({ path: resolve(frames, `${String(f++).padStart(4, "0")}.png`) })
      }
    }
    await record(1)
    await set(page, "screen.power", false)
    await record(1.6)
    await set(page, "screen.power", true)
    await record(3)
    await page.evaluate(() => (window as any).lab.context.world.degauss?.())
    await record(2.5)
  }

  await camera(page, benchCam)
  await set(page, "programme", "show")
  await set(page, "tube", true)
  await advance(page, 1)
  await shot(page, "tube")
  await set(page, "tube", false)
  await set(page, "bulb", true)
  await advance(page, 1)
  await shot(page, "bulb")
  await set(page, "bulb", false)
  await set(page, "screen.vhs", true)
  await camera(page, closer)
  await advance(page, 1)
  await shot(page, "vhs")
  await set(page, "screen.vhs", false)
  await set(page, "screen.snow", 0.6)
  await advance(page, 0.5)
  await shot(page, "snow")
  await set(page, "screen.snow", 0)

  // GPU: the bench view with the screen on, and with it off (the world's own cost).
  await camera(page, benchCam)
  const measure = () => page.evaluate(async () => {
    const lab = (window as any).lab, w = lab.context.world, st = lab.context.stage
    const samples: number[] = []
    for (let i = 0; i < 9; i++) { const ms = await w.render(st.width, st.height, st.outputView, true); if (typeof ms === "number") samples.push(ms) }
    samples.sort((a, b) => a - b)
    return samples.length ? samples[samples.length >> 1] : null
  }).catch(() => null)
  await advance(page, 0.5)
  report.gpuScreenOn = await measure()
  await set(page, "screen", false)
  await advance(page, 0.5)
  report.gpuScreenOff = await measure()
  report.lights = lights
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ gpuScreenOn: report.gpuScreenOn, gpuScreenOff: report.gpuScreenOff, errors: errors.slice(0, 5) }))
} finally {
  await server.close()
  await browser.close()
}
if (flags.clip) {
  await budget.finish()
  const frames = resolve(out, "frames")
  Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(frames, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", resolve(out, "power-degauss.mp4")])
  rmSync(frames, { recursive: true, force: true })
}
if (errors.length) { console.error(errors.slice(0, 5).join("\n")); process.exit(1) }
