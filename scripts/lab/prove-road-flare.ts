/// <reference types="@webgpu/types" />
// Road flare stills (and an optional short clip) from the Lab's road-flare station on a fixed 60 Hz clock, headless
// Metal WebGPU, muted. Also times the frame with and without the flare (GPU ms).
//   bun scripts/lab/prove-road-flare.ts [--out dir] [--clip] [--only throw,rest5,...]
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
    out: { type: "string", default: resolve(import.meta.dir, "../../captures/road-flare") },
    clip: { type: "boolean", default: false },
    only: { type: "string", default: "" },
    set: { type: "string", multiple: true, default: [] },
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
const set = (page: Page, key: string, value: unknown) => invoke(page, "scene.set-param", { key, value })
const advance = (page: Page, seconds: number) => page.evaluate(async (n) => {
  const lab = (window as any).lab
  for (let i = 0; i < n; i++) lab.advance(1 / 60)
  await lab.render()
}, Math.round(seconds * 60))
/** Orbit camera on the flare: yaw/pitch in degrees, distance in metres. */
const camera = (page: Page, at: { yaw: number; pitch: number; dist: number; y?: number }) => page.evaluate((c) => {
  const lab = (window as any).lab, stage = lab.context.stage, t = lab.sections.find((x: any) => x.id === "effects").frameTarget()
  stage.camYaw = c.yaw * Math.PI / 180
  stage.camPitch = c.pitch * Math.PI / 180
  stage.frameTarget(t.x, c.y ?? 0.4, t.z, c.dist)
  stage.camYaw = c.yaw * Math.PI / 180
  stage.camPitch = c.pitch * Math.PI / 180
  stage.targetYaw = stage.camYaw
  stage.targetPitch = stage.camPitch
}, at)
const shot = async (page: Page, name: string) => {
  await page.evaluate(async () => { await (window as any).lab.render() })
  await page.locator("canvas").first().screenshot({ path: resolve(out, `${name}.png`) })
  const telemetry = await page.evaluate(() => (window as any).lab.sections.find((x: any) => x.id === "effects").telemetry())
  console.log(`${name}: ${telemetry}`)
}

const errors: string[] = []
const report: Record<string, unknown> = {}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${addr.port}/arcade/lab/?bench#effects`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 60000 })
  const start = async (variant: "throw" | "burning" | "gutter", lamps = 0) => {
    for (const [k, v] of [["backdrop", "world"], ["worldHour", 0], ["worldLook", "current"], ["worldLamps", lamps], ["effect", "flare"], ["loop", false], ["flareStart", variant]] as const) await set(page, k, v)
    for (const kv of flags.set ?? []) { const [k, v] = kv.split("="); await set(page, k!, Number.isNaN(Number(v)) ? v : Number(v)) }
    await invoke(page, "effect.trigger", { seed: 7 })
  }
  const want = (name: string) => !flags.only || flags.only.split(",").includes(name)

  await start("throw")
  await camera(page, { yaw: 25, pitch: 12, dist: 7, y: 0.9 })
  await advance(page, 0.45)
  if (want("hand")) await shot(page, "hand")
  await advance(page, 0.75)
  if (want("flight")) await shot(page, "flight")
  await advance(page, 4)
  await camera(page, { yaw: 25, pitch: 12, dist: 5 })
  if (want("rest5")) await shot(page, "rest5")
  await camera(page, { yaw: 25, pitch: 10, dist: 14, y: 1.5 })
  if (want("rest14")) await shot(page, "rest14")
  await camera(page, { yaw: 35, pitch: 24, dist: 30, y: 2 })
  if (want("rest30")) await shot(page, "rest30")
  await camera(page, { yaw: 25, pitch: 8, dist: 1.2, y: 0.08 })
  if (want("macro")) await shot(page, "macro")

  // GPU cost: the same view with the flare burning and with it gone (the effect set to sparks with no rate).
  await camera(page, { yaw: 25, pitch: 12, dist: 7 })
  const measure = () => page.evaluate(async () => {
    const lab = (window as any).lab, w = lab.context.world, st = lab.context.stage
    const samples: number[] = []
    for (let i = 0; i < 7; i++) { const ms = await w.render(st.width, st.height, st.outputView, true); if (typeof ms === "number") samples.push(ms) }
    samples.sort((a, b) => a - b)
    return samples.length ? samples[samples.length >> 1] : null
  }).catch(() => null)
  report.gpuWithFlare = await measure()
  await set(page, "flareSmoke", 0)
  await advance(page, 10)
  report.gpuNoSmoke = await measure()
  await set(page, "flareSmoke", 1)
  await advance(page, 6)

  if (flags.clip) {
    const frames = resolve(out, "frames")
    rmSync(frames, { recursive: true, force: true })
    mkdirSync(frames)
    await camera(page, { yaw: 25, pitch: 10, dist: 4, y: 0.7 })
    for (let i = 0; i < 90; i++) {
      await advance(page, 1 / 30)
      await page.locator("canvas").first().screenshot({ path: resolve(frames, `${String(i).padStart(4, "0")}.png`) })
    }
  }

  await start("gutter")
  await camera(page, { yaw: 25, pitch: 12, dist: 5 })
  await advance(page, 8)
  if (want("gutter")) await shot(page, "gutter")
  await start("burning", 1)
  await camera(page, { yaw: 30, pitch: 20, dist: 16, y: 1 })
  await advance(page, 3)
  if (want("lamps")) await shot(page, "lamps")
  await set(page, "effect", "sparks")
  await set(page, "rate", 5)
  await advance(page, 3)
  report.gpuWithout = await measure()
  report.errors = errors
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report))
} finally {
  await server.close()
  await browser.close()
}
if (flags.clip) {
  await budget.finish()
  const frames = resolve(out, "frames")
  Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(frames, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", resolve(out, "flare.mp4")])
  rmSync(frames, { recursive: true, force: true })
}
if (errors.length) { console.error(errors.slice(0, 5).join("\n")); process.exit(1) }
