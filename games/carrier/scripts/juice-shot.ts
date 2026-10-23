// Flight juice captures on a real GPU (src/flight/juice.ts, src/render/flight-fx.ts): air streaks (chase and cockpit),
// vapour in a hard pull, the vapour cone, the burner's light-up and heat shimmer, sea spray and wake, and a short clip.
// Runs ON hailmary (Mac Studio, Metal) against a dev server serving flight.html:
//
//   ssh hailmary 'cd <repo>/games/carrier && ~/.bun/bin/bun scripts/juice-shot.ts --base=http://localhost:5297/ --out=/tmp/juice'
//
// Options: --base=URL  --out=DIR  --seed=7  --size=1600x900  --only=streaks,vapour,cone,burner,spray,clip
// The clip is Playwright's page video (webm) turned into <out>/juice.mp4 with ffmpeg.
import type { Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://localhost:5297/")
const out = opt("out", "/tmp/juice")
const seed = opt("seed", "7")
const only = opt("only", "streaks,vapour,cone,burner,spray,clip").split(",")
const [vw, vh] = opt("size", "1600x900").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--mute-audio"],
})
const logs: string[] = []

async function open(video = false): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, ...(video ? { recordVideo: { dir: join(out, "video"), size: { width: vw, height: vh } } } : {}) })
  const page = await ctx.newPage()
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
  await page.goto(`${base}flight.html?seed=${seed}`, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { juice?: unknown } }).carrier?.juice, null, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  return page
}

const run = (page: Page, js: string) => page.evaluate(`(() => { const c = globalThis.carrier; ${js} })()`)
const stick = (page: Page, pitch: number, roll: number) => run(page, `c.input.override = { pitch: ${pitch}, roll: ${roll} }`)
/** Warps the jet `ahead` of the carrier, flying away from the islands it steams toward, at height `y` and `speed`. */
const warp = (page: Page, y: number, speed: number, pitch = 0) =>
  run(page, `const s = c.ship; const h = s.heading + Math.PI; c.warp(s.x + Math.sin(h) * 1500, ${y}, s.z - Math.cos(h) * 1500, h, ${pitch}, ${speed}); c.input.override = { pitch: 0, roll: 0 }`)

async function shot(page: Page, name: string): Promise<void> {
  writeFileSync(join(out, `${name}.png`), await page.screenshot({ type: "png" }))
  const s = await page.evaluate(() => {
    const p = (globalThis as unknown as { carrier: { flight: { draw: { vx: number; vy: number; vz: number; g: number; y: number; boosting: number } } } }).carrier.flight.draw
    return { speed: Math.hypot(p.vx, p.vy, p.vz), g: p.g, y: p.y, burner: p.boosting }
  })
  console.log(`${name}: ${s.speed.toFixed(0)} m/s g ${s.g.toFixed(1)} y ${s.y.toFixed(0)} burner ${s.burner}`)
}

if (only.some((o) => o !== "clip")) {
  const page = await open()
  if (only.includes("streaks")) {
    await warp(page, 600, 225)
    await page.waitForTimeout(1200)
    await shot(page, "streaks-chase")
    await run(page, `c.flight.cam.mode = "cockpit"`)
    await page.waitForTimeout(900)
    await shot(page, "streaks-cockpit")
    await run(page, `c.flight.cam.mode = "chase"`)
  }
  if (only.includes("vapour")) {
    await warp(page, 700, 160)
    await page.waitForTimeout(300)
    await stick(page, 1, 0)
    await page.waitForTimeout(700)
    await shot(page, "vapour-chase")
    await run(page, `c.inspect = { yaw: 2.3, pitch: 0.55, dist: 24 }`)
    await page.waitForTimeout(150)
    await shot(page, "vapour-top")
    await run(page, `c.inspect = null`)
  }
  if (only.includes("cone")) {
    for (const [name, view] of [
      ["cone-chase", "null"],
      ["cone-side", "{ yaw: 1.9, pitch: 0.2, dist: 34 }"],
    ] as const) {
      await warp(page, 800, 195)
      await page.keyboard.down("Shift")
      await run(page, `c.inspect = ${view}; c.boomAt = 0; c.juice.onBoom = () => { c.boomAt = performance.now() }`)
      await page.waitForFunction(() => (globalThis as unknown as { carrier: { boomAt: number } }).carrier.boomAt > 0, null, { timeout: 15_000 })
      await page.waitForTimeout(90)
      await shot(page, name)
      await page.keyboard.up("Shift")
      await run(page, `c.inspect = null`)
    }
  }
  if (only.includes("burner")) {
    await warp(page, 700, 150)
    await run(page, `c.inspect = { yaw: 2.75, pitch: 0.12, dist: 20 }`)
    await page.waitForTimeout(600)
    await shot(page, "burner-off")
    await page.keyboard.down("Shift")
    await page.waitForTimeout(110)
    await shot(page, "burner-lightup")
    await page.waitForTimeout(900)
    await shot(page, "burner-steady")
    await run(page, `c.inspect = { yaw: 3.04, pitch: 0.05, dist: 26 }`)
    await page.waitForTimeout(300)
    await shot(page, "shimmer-on")
    await run(page, `c.juiceFx.shimmerPx = 12`)
    await page.waitForTimeout(100)
    await shot(page, "shimmer-strong")
    await run(page, `c.juiceFx.shimmerPx = 1.6; c.juiceFx.shimmer = false`)
    await page.waitForTimeout(100)
    await shot(page, "shimmer-off")
    await run(page, `c.juiceFx.shimmer = true`)
    await page.keyboard.up("Shift")
    await run(page, `c.inspect = null`)
  }
  if (only.includes("spray")) {
    await warp(page, 9, 175)
    await page.waitForTimeout(1200)
    await shot(page, "spray-chase")
    await run(page, `c.inspect = { yaw: 2.2, pitch: 0.3, dist: 55 }`)
    await page.waitForTimeout(250)
    await shot(page, "spray-side")
    await run(page, `c.inspect = null`)
  }
  await page.context().close()
}

if (only.includes("clip")) {
  // ~14 s: a low pass kicking up spray, a hard pull into the vertical (vapour), the burner lighting and the cone, then
  // the cockpit with the streaks.
  const page = await open(true)
  await warp(page, 14, 170)
  await page.waitForTimeout(3500)
  await stick(page, 0.8, 0)
  await page.waitForTimeout(1500)
  await stick(page, 0.15, 0)
  await page.waitForTimeout(800)
  await stick(page, 0, 0)
  await warp(page, 900, 192)
  await page.waitForTimeout(500)
  await page.keyboard.down("Shift")
  await page.waitForTimeout(3500)
  await stick(page, 1, 0.6)
  await page.waitForTimeout(1500)
  await stick(page, 0, 0)
  await run(page, `c.flight.cam.mode = "cockpit"`)
  await page.waitForTimeout(2500)
  await page.keyboard.up("Shift")
  const video = page.video()
  await page.context().close()
  const src = video ? await video.path() : join(out, "video", readdirSync(join(out, "video"))[0]!)
  renameSync(src, join(out, "juice.webm"))
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, "juice.webm"), "-ss", "1.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "fast", "-movflags", "+faststart", join(out, "juice.mp4")], { stdio: "inherit" })
  console.log(r.status === 0 ? `clip: ${join(out, "juice.mp4")}` : "clip: ffmpeg failed")
}

console.log(logs.length ? logs.slice(0, 20).join("\n") : "no console errors")
await browser.close()
