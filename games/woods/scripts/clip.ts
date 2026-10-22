// Headless, muted clip of the two verbs: tie a tape on the trunk in front of you, then raise the map (through HiveMind):
//   bun scripts/clip.ts [--out <dir>]
// Records the page with Playwright's screencast in real time and writes clip.webm to the out dir.
import { mkdirSync, renameSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const i = process.argv.indexOf("--out")
const out = resolve(i >= 0 ? process.argv[i + 1]! : process.env.LEASE_OUT ?? "captures/woods")
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
type W = { frames: number; autoplay: boolean; setPose(x: number, z: number, yaw: number, pitch?: number): void; hold(code: string, down: boolean): void
  camera: { yaw: number; pitch: number; body: { x: number; y: number } }; state: { tapes: unknown[]; brains: { mode: string; timer: number }[] }
  world: { camp: { x: number; z: number }; trees: { id: number; x: number; z: number; radius: number; species: string }[] } }
declare const woods: W

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
const page = await context.newPage()
await page.goto(`http://127.0.0.1:${server.port}${prefix}`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 60000 })
// A pine 45 m into the woods north of camp; stand 2.6 m south of it, look a little away, then turn onto it.
const pose = await page.evaluate(() => {
  const c = woods.world.camp
  const t = woods.world.trees.filter((t) => t.species === "pine" && Math.abs(t.x - (c.x - 20)) < 8 && Math.abs(t.z - (c.z - 50)) < 8)[0]!
  woods.autoplay = true
  for (const b of woods.state.brains) b.mode = "wait", b.timer = 99
  woods.setPose(t.x + 1.2, t.z + t.radius + 2.4, 0.9, -0.1)
  return { x: t.x, z: t.z + t.radius + 1.0 }
})
const ease = async (ms: number, f: (k: number) => Promise<void>) => { const t0 = Date.now(); for (;;) { const k = Math.min(1, (Date.now() - t0) / ms); await f(k); if (k >= 1) break; await page.waitForTimeout(16) } }
await page.waitForTimeout(1200)
// Walk up and turn onto the trunk.
await ease(1800, async (k) => { const e = k * k * (3 - 2 * k); await page.evaluate(([e, x, z]) => { const b = woods.camera.body; b.x = b.x + ((x! + 0.0) - b.x) * e * 0.08; b.y = b.y + (z! - b.y) * e * 0.08; woods.camera.yaw = 0.9 * (1 - e); woods.camera.pitch = -0.1 - 0.05 * e }, [e, pose.x, pose.z]) })
await page.waitForTimeout(500)
await page.evaluate(() => woods.hold("KeyE", true))
await page.waitForTimeout(1700)
await page.evaluate(() => woods.hold("KeyE", false))
await page.waitForTimeout(700)
// Step back to see the tape, then raise the map.
await ease(1200, async (k) => { await page.evaluate((k) => { woods.camera.body.y += 0.02 * (1 - k); woods.camera.yaw = -0.25 * k }, k) })
await page.waitForTimeout(600)
await page.evaluate(() => woods.hold("KeyG", true))
await ease(2400, async (k) => { await page.evaluate((k) => { woods.camera.yaw = -0.25 + 0.5 * Math.sin(k * Math.PI) * 0.4 }, k) })
await page.waitForTimeout(1200)
await page.evaluate(() => woods.hold("KeyG", false))
await page.waitForTimeout(1200)
const video = page.video()
await context.close()
if (video) renameSync(await video.path(), `${out}/clip.webm`)
await browser.close()
server.stop(true)
console.log(`clip: ${out}/clip.webm`)
