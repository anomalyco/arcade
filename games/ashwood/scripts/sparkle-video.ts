// Motion video of the wet lot under the burning sodium pole, for specular-aliasing ("sparkle") checks.
//
//   bun scripts/sparkle-video.ts --tag before      # captures/video/sparkle-before.mp4 + -crop3x.mp4 + JSON metrics
//
// Real game page (index.html?shot=1, so the camera is driven here instead of by input), user-like size 1728×1117 at
// DPR 2, default grade (grain on). Path, timed by wall clock: 2 s still · 4 s slow strafe · 1 s still · 4 s slow
// turn. Frames come from the CDP screencast (every compositor frame). Metric: per consecutive-frame pair, the p99 of
// |Δ luma| (0..255) inside the lit wet region; reported as the median over each segment. Expects the dev server on
// :5196. Needs ffmpeg.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const tag = flag("tag") ?? "run"
const W = 1728
const H = 1117
const DPR = 2
const outDir = `${import.meta.dir}/../captures/video`
mkdirSync(outDir, { recursive: true })
const tmp = join(tmpdir(), `ashwood-sparkle-${tag}`)
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

// Camera south of the burning lot pole (x -8.1, z 100), looking north across its pool: the lamp's reflection lies on
// the wet asphalt between camera and pole, at a grazing angle.
const PATH = { x: -6, y: 0.04 + 1.65, z: 109, pitch: -0.16, strafe: 3, turn: 0.28 }
const SEGMENTS = [
  { name: "still", secs: 2 },
  { name: "strafe", secs: 4 },
  { name: "still2", secs: 1 },
  { name: "turn", secs: 4 },
] as const
const TOTAL = SEGMENTS.reduce((s, x) => s + x.secs, 0)
/** Lit wet region in output pixels (fractions of the frame): the ground band in front of the pole. */
const ROI = [0.3, 0.5, 0.8, 0.9] as const

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
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`http://localhost:5196/?shot=1&view=lot`)
await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean; frames: number } }).__ashwood?.complete && (globalThis as { __ashwood?: { frames: number } }).__ashwood!.frames > 30, undefined, { timeout: 240_000 })

// Drive the camera from a rAF loop on the page (wall-clock timed), parked at the start until `go` is set.
await page.evaluate(
  ({ P, segs }) => {
    const cam = (globalThis as unknown as { __ashwoodDebug: { camera: { position: { set(x: number, y: number, z: number): void }; rotation: { set(x: number, y: number, z: number, o: string): void } } } }).__ashwoodDebug.camera
    const state = { go: 0 }
    ;(globalThis as { __drive?: unknown }).__drive = state
    const at = (t: number) => {
      let x = P.x - P.strafe / 2
      let yaw = 0
      let t0 = 0
      for (const s of segs) {
        const u = Math.min(1, Math.max(0, (t - t0) / s.secs))
        const e = u * u * (3 - 2 * u)
        if (s.name === "strafe") x = P.x - P.strafe / 2 + P.strafe * e
        if (s.name === "turn") yaw = P.turn / 2 - P.turn * e
        t0 += s.secs
      }
      if (t < segs[0]!.secs + segs[1]!.secs) yaw = P.turn / 2
      return { x, yaw }
    }
    const loop = (now: number) => {
      const t = state.go ? (now - state.go) / 1000 : 0
      const { x, yaw } = at(t)
      cam.position.set(x, P.y, P.z)
      cam.rotation.set(P.pitch, yaw, 0, "YXZ")
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  },
  { P: PATH, segs: SEGMENTS as unknown as { name: string; secs: number }[] },
)
await page.waitForTimeout(2500)

const cdp = await page.context().newCDPSession(page)
const frames: { file: string; t: number }[] = []
let start = 0
cdp.on("Page.screencastFrame", async (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
  const t = (f.metadata.timestamp ?? performance.now() / 1000) - start
  if (start && t >= 0 && t <= TOTAL) {
    const file = join(tmp, `${String(frames.length).padStart(5, "0")}.jpg`)
    frames.push({ file, t })
    writeFileSync(file, Buffer.from(f.data, "base64"))
  }
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
})
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: W * DPR, maxHeight: H * DPR })
await page.waitForTimeout(300)
const goAt = await page.evaluate(() => {
  const s = (globalThis as unknown as { __drive: { go: number } }).__drive
  s.go = performance.now()
  return Date.now() / 1000
})
start = goAt
await page.waitForTimeout(TOTAL * 1000 + 600)
await cdp.send("Page.stopScreencast")
await browser.close()

// ---- video + crop
const fps = Math.round(frames.length / TOTAL)
const list = join(tmp, "list.txt")
writeFileSync(list, frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 1 / fps) - f.t).toFixed(4)}`).join("\n"))
const mp4 = `${outDir}/sparkle-${tag}.mp4`
const crop = `${outDir}/sparkle-${tag}-crop3x.mp4`
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd)
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().slice(-800))
}
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "scale=1728:-2,format=yuv420p", "-r", "60", "-c:v", "libx264", "-crf", "16", mp4])
// 3× nearest-neighbour crop of the lamp's reflection on the ground (centre of the ROI).
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "crop=iw*0.2:ih*0.2:iw*0.4:ih*0.62,scale=iw*3:ih*3:flags=neighbor,format=yuv420p", "-r", "60", "-c:v", "libx264", "-crf", "14", crop])

// ---- metric
const rw = 864
const rh = 558
const luma = async (file: string) => {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-i", file, "-vf", `scale=${rw}:${rh}:flags=area,format=gray`, "-f", "rawvideo", "-"], { stdout: "pipe" })
  return new Uint8Array(await new Response(p.stdout).arrayBuffer())
}
const [x0, y0, x1, y1] = [Math.floor(ROI[0] * rw), Math.floor(ROI[1] * rh), Math.floor(ROI[2] * rw), Math.floor(ROI[3] * rh)]
const seg = (t: number) => {
  let a = 0
  for (const s of SEGMENTS) {
    if (t < a + s.secs) return s.name
    a += s.secs
  }
  return SEGMENTS[SEGMENTS.length - 1]!.name
}
const perSeg: Record<string, number[]> = {}
let prev: Uint8Array | null = null
const hist = new Uint32Array(256)
for (const f of frames) {
  const cur = await luma(f.file)
  if (prev) {
    hist.fill(0)
    let n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * rw + x
      hist[Math.abs(cur[i]! - prev[i]!)]!++
      n++
    }
    let acc = 0
    let p99 = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!
      if (acc >= n * 0.99) {
        p99 = v
        break
      }
    }
    ;(perSeg[seg(f.t)] ??= []).push(p99)
  }
  prev = cur
}
const median = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1]! : null)
const result = Object.fromEntries(Object.entries(perSeg).map(([k, v]) => [k, { pairs: v.length, p99Median: median(v), p99Max: Math.max(...v) }]))
console.log(JSON.stringify({ tag, mp4, crop, frames: frames.length, fps, deltaP99: result, errors: errors.slice(0, 4) }))
rmSync(tmp, { recursive: true, force: true })
process.exit(0)
