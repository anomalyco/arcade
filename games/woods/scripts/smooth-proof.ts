// Headless, muted proof of friend smoothing and the menus (through HiveMind, after `bun run build`):
//   bun scripts/smooth-proof.ts [--out <dir>] [--clip-only]
// friend.mp4: a camper walking and turning in front of you, drawn raw (left, `?smooth=0`) and smoothed (right), on the
// same synthetic 60 Hz clock with rAF's ±1.5 ms wobble, so both show the same sim. Stills: the title (alone and in a
// room), the Escape menu, and the Lab panel open over the woods.
import { mkdirSync, rmSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium, type Page } from "playwright-core"

const i = process.argv.indexOf("--out")
const out = resolve(i >= 0 ? process.argv[i + 1]! : process.env.LEASE_OUT ?? "captures/smooth")
mkdirSync(out, { recursive: true })
const root = resolve("dist/arcade/woods"), prefix = "/arcade/woods/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })
type P = { x: number; z: number }
type W = { frames: number; autoplay: boolean; paused: boolean; setPose(x: number, z: number, yaw: number, pitch?: number): void; step(ms: number): void
  state: { players: P[]; brains: { mode: string; timer: number; heading: number; since: number }[] }; world: { camp: { x: number; z: number } }; panel: { toggle(): void }; camera: { flashlight: boolean } }
declare const woods: W

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
async function open(query: string, size = { width: 640, height: 400 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport: size })).newPage()
  await page.goto(`http://127.0.0.1:${server.port}${prefix}${query}`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 90000 })
  return page
}

// The clip: in camp facing the lit cabins with your torch off, one camper 6 m out walking from left to right while
// sweeping its beam, then turning sharply away (bots set a new heading in one tick, which is what made beams jump).
const frames = 270
for (const [name, q] of [["raw", "&smooth=0"], ["smoothed", ""]] as const) {
  const page = await open(`?quality=high${q}`)
  const dir = `${out}/frames-${name}`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await page.evaluate((label) => {
    // Paused: only the synthetic steps below draw and tick (the page's own loop would tick in real time between shots).
    woods.paused = true
    woods.autoplay = true
    for (const id of ["hud", "toast", "prompt", "reticle"]) document.getElementById(id)!.style.display = "none"
    const tag = document.createElement("div")
    tag.textContent = label
    tag.style.cssText = "position:fixed;left:14px;top:12px;font:600 16px system-ui;color:#f6eed6;text-shadow:0 1px 4px #000;z-index:9"
    document.body.append(tag)
    const c = woods.world.camp, x = c.x - 2, z = c.z + 9
    woods.setPose(x, z, 0, 0.02)
    woods.camera.flashlight = false
    const [p, ...rest] = woods.state.players.slice(1), [b, ...others] = woods.state.brains
    p!.x = x - 4; p!.z = z - 6
    b!.mode = "wander"; b!.heading = -Math.PI / 2; b!.timer = 99; b!.since = 0
    rest.forEach((q, k) => { q.x = x + 60 + k * 3; q.z = z + 60 })
    for (const o of others) o.mode = "wait", o.timer = 99
    for (let k = 0; k < 20; k++) woods.step(1000 / 60)
  }, name === "raw" ? "Before: drawn as ticked" : "After: smoothed")
  for (let k = 0; k < frames; k++) {
    await page.evaluate((k) => { const b = woods.state.brains[0]!; b.mode = "wander"; b.timer = 99; b.since = 0; b.heading = k < 120 ? -Math.PI / 2 : -Math.PI / 2 + 1.2; woods.step(1000 / 60 + 1.5 * Math.sin(k * 2.3)) }, k)
    await page.screenshot({ path: `${dir}/${String(k).padStart(4, "0")}.jpg`, type: "jpeg", quality: 85 })
  }
  await page.context().close()
}
const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "60", "-i", `${out}/frames-raw/%04d.jpg`, "-framerate", "60", "-i", `${out}/frames-smoothed/%04d.jpg`, "-filter_complex", "[0:v][1:v]hstack=inputs=2,format=yuv420p", "-c:v", "libx264", "-crf", "20", `${out}/friend.mp4`])
console.log(ff.exitCode === 0 ? `wrote ${out}/friend.mp4` : `ffmpeg failed: ${ff.stderr.toString()}`)
if (process.argv.includes("--clip-only")) { await browser.close(); server.stop(true); process.exit(0) }

// Stills at 1280×720.
const still = async (query: string, file: string, prep?: (page: Page) => Promise<void>) => {
  const page = await open(query, { width: 1280, height: 720 })
  await page.evaluate(() => { woods.paused = true })
  await prep?.(page)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/${file}` })
  await page.context().close()
}
await still("", "title.png")
await still("?room=abcd", "title-room.png")
// The Escape menu as it shows once you've played and pressed Escape (headless has no pointer lock to release).
await still("", "escape-menu.png", (page) => page.evaluate(() => {
  document.getElementById("start")!.hidden = true
  const pause = document.getElementById("pause")!
  pause.hidden = false
  pause.querySelector(".card")!.append(document.getElementById("settings")!)
}))
await still("", "panel-open.png", (page) => page.evaluate(() => woods.panel.toggle()))
await browser.close()
server.stop(true)
console.log(`stills in ${out}`)
