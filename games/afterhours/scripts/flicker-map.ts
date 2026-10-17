// Stand-still flicker map: holds a camera still in the Look Lab (real frame loop, TAA jitter running, film grain off),
// screenshots ~3 s of frames and writes the per-pixel max−min range (max over RGB) as a heat map.
//
//   bun scripts/flicker-map.ts                       # default cameras (corridor tile + door, grazing tile, lobby terrazzo)
//   bun scripts/flicker-map.ts --tag before --secs 3
//
// Output: captures/flicker/<cam>[-tag].png (frame | range map ×4) and a JSON line per camera with the count of pixels
// whose range exceeds 24 and 8 (of 255) and the mean range. Expects the dev server on :5196. Needs ffmpeg.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const tag = flag("tag")
const secs = Number(flag("secs") ?? 3)
const W = 1280
const H = 800
/** roi: [x0, y0, x1, y1] as fractions of the frame, the material region scored separately (`roi*` fields). */
const CAMS: Record<string, { eye: [number, number, number]; yaw: number; pitch: number; fov: number; roi: [number, number, number, number] }> = {
  // Tile wall beside a lab door (r5-05 framing).
  door: { eye: [-18, 1.6, 0.9], yaw: 1.0, pitch: -0.03, fov: 60, roi: [0.64, 0.26, 1, 0.95] },
  // Grazing view down the tiled corridor wall: grout far below a pixel.
  grazing: { eye: [-12, 1.6, 1.1], yaw: Math.PI / 2 + 0.22, pitch: -0.05, fov: 55, roi: [0, 0.3, 0.55, 1] },
  // Lobby terrazzo at a walking angle.
  terrazzo: { eye: [2, 1.6, 14], yaw: Math.PI, pitch: -0.38, fov: 60, roi: [0, 0.55, 1, 1] },
}
const cams = args.length ? args : Object.keys(CAMS)
const outDir = `${import.meta.dir}/../captures/flicker`
mkdirSync(outDir, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`http://localhost:5196/look.html?shot=1&cam=r5-05`)
await page.waitForFunction(() => {
  const s = (globalThis as { __afterhours?: { complete: boolean; frames: number } }).__afterhours
  return !!(globalThis as { __look?: unknown }).__look && !!s && s.complete && s.frames >= 10
}, undefined, { timeout: 240_000 })

const tmp = join(tmpdir(), "afterhours-flicker")
const raw = async (png: string) => {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" })
  return new Uint8Array(await new Response(p.stdout).arrayBuffer())
}

for (const cam of cams) {
  const c = CAMS[cam]!
  await page.evaluate((p) => {
    const look = (globalThis as unknown as { __look: { setCamera(p: unknown): void; ctx: { settings: Record<string, unknown> } } }).__look
    look.ctx.settings["grade.grain"] = 0
    look.setCamera({ id: "flicker", label: "flicker", ...p })
  }, c)
  await page.waitForTimeout(1500)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const files: string[] = []
  const t0 = performance.now()
  while (performance.now() - t0 < secs * 1000) {
    const f = join(tmp, `${files.length}.png`)
    await page.screenshot({ path: f })
    files.push(f)
  }
  const n = W * H
  const lo = new Uint8Array(n * 3).fill(255)
  const hi = new Uint8Array(n * 3)
  for (const f of files) {
    const px = await raw(f)
    for (let i = 0; i < n * 3; i++) {
      const v = px[i]!
      if (v < lo[i]!) lo[i] = v
      if (v > hi[i]!) hi[i] = v
    }
  }
  const range = new Uint8Array(n * 3)
  let over = 0
  let over8 = 0
  let sum = 0
  let roi24 = 0
  let roi8 = 0
  let roiSum = 0
  let roiN = 0
  const [rx0, ry0, rx1, ry1] = c.roi
  for (let i = 0; i < n; i++) {
    const r = Math.max(hi[i * 3]! - lo[i * 3]!, hi[i * 3 + 1]! - lo[i * 3 + 1]!, hi[i * 3 + 2]! - lo[i * 3 + 2]!)
    if (r > 24) over++
    if (r > 8) over8++
    const x = i % W
    const y = (i / W) | 0
    if (x >= rx0 * W && x < rx1 * W && y >= ry0 * H && y < ry1 * H) {
      roiN++
      roiSum += r
      if (r > 24) roi24++
      if (r > 8) roi8++
    }
    sum += r
    const v = Math.min(255, r * 4)
    range[i * 3] = v
    range[i * 3 + 1] = r > 24 ? 0 : v
    range[i * 3 + 2] = r > 24 ? 0 : v
  }
  const rangeFile = join(tmp, "range.raw")
  await Bun.write(rangeFile, range)
  const out = `${outDir}/${cam}${tag ? `-${tag}` : ""}.png`
  const ff = Bun.spawnSync([
    "ffmpeg", "-y", "-loglevel", "error", "-i", files[files.length - 1]!,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", rangeFile,
    "-filter_complex", "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]hstack", "-frames:v", "1", out,
  ])
  if (ff.exitCode !== 0) errors.push(ff.stderr.toString())
  console.log(JSON.stringify({ cam, file: out, frames: files.length, over24: over, over8, meanRange: +(sum / n).toFixed(2), roi24, roi8, roiMean: +(roiSum / Math.max(1, roiN)).toFixed(2), errors: errors.slice(0, 3) }))
}
await browser.close()
process.exit(0)
