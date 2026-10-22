// Headless, muted 3 s clip of a tape's tails in the forest's wind, close up in your own beam (after `bun run build`,
// through HiveMind):  bun scripts/tape-clip.ts [--out <dir>] [--wind 1]
// Steps the sim on a synthetic 30 fps clock and writes numbered PNG frames to <out>/tape-clip/; encode them with
//   ffmpeg -framerate 30 -i <out>/tape-clip/%03d.png -pix_fmt yuv420p tape-clip.mp4
import { mkdirSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"
import { tapeShot } from "./capture"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods"), "tape-clip")
const wind = Number(arg("--wind", "1"))
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
type W = { frames: number; paused: boolean; step(ms: number): void; look: { wind: number }; camera: { yaw: number; pitch: number } }
declare const woods: W

const browser = await chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 180000 })
await page.evaluate((wind) => { document.getElementById("start")!.style.display = "none"; woods.paused = true; woods.look.wind = wind }, wind)
await page.evaluate(tapeShot, 0.9)
// Look a little down the tails and let them settle into the wind for 4 s.
await page.evaluate(async () => { woods.camera.pitch -= 0.12; for (let i = 0; i < 240; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) } })
for (let f = 0; f < 90; f++) {
  await page.evaluate(() => { woods.step(1000 / 60); woods.step(1000 / 60) })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: `${out}/${String(f).padStart(3, "0")}.png` })
}
await browser.close()
server.stop(true)
