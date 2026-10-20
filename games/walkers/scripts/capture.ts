// Records a from-scratch training run in headless Chromium (muted) and cuts a short clip: early flailing, the first
// generation that reaches the goal, and a replay of the best walker next to the pre-trained one. Also saves a still
// with the fitness chart. Run against a built dist, through HiveMind:
//   hivemind run --kind browser --fetch -- bash -c "cd games/walkers && bun run build && bun scripts/capture.ts"
// Writes to $LEASE_OUT (or the repo's captures/walkers). Needs ffmpeg.
// --heist: a short live quadruped heist run (the from-scratch flail), then "Watch the best heist" (the pro thief).
// The replay is deterministic, so a throttled browser lease only changes the frame rate, not what happens.

import { mkdirSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright-core"

const { values } = parseArgs({ options: { creature: { type: "string", default: "biped" }, task: { type: "string", default: "room" }, max: { type: "string", default: "170" }, speed: { type: "string", default: "2" }, heist: { type: "boolean", default: false }, train: { type: "string", default: "22" } } })
const out = resolve(process.env.LEASE_OUT ?? "../../captures/walkers")
mkdirSync(out, { recursive: true })
const prefix = "/arcade/walkers/"
const root = resolve("dist/arcade/walkers")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
    const asset = Bun.file(file)
    return (await asset.exists()) ? new Response(asset) : new Response("Not found", { status: 404 })
  },
})

type Stats = { gens: number; finished: number; best: number; distance: number }
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
const t0 = Date.now()
const at = () => (Date.now() - t0) / 1000
const query = values.heist ? "creature=quadruped&task=heist&speed=1.5&panel=0&compare=0" : `creature=${values.creature}&task=${values.task}&speed=${values.speed}&panel=0`
await page.goto(`http://127.0.0.1:${server.port}${prefix}?${query}`, { waitUntil: "load" })
await page.waitForSelector("#app[data-ready]", { state: "attached" })
const marks: Record<string, number> = { loaded: at() }
const read = () =>
  page.evaluate((): Stats => {
    const w = (window as unknown as { walkers: { history(): { finished: number; bestEver: number; bestDistance: number }[] } }).walkers
    const h = w.history()
    const last = h[h.length - 1]
    return { gens: h.length, finished: last?.finished ?? 0, best: last?.bestEver ?? 0, distance: last?.bestDistance ?? 0 }
  })
const log: string[] = []
if (values.heist) await heist()
let s = await read()
while (at() < Number(values.max)) {
  await page.waitForTimeout(1000)
  s = await read()
  log.push(`${at().toFixed(0)}s gen ${s.gens} best ${s.best.toFixed(2)} finished ${s.finished}`)
  if (log.length % 10 === 0) console.log(log[log.length - 1])
  if (s.finished > 0 && marks.firstFinish === undefined) marks.firstFinish = at()
  // Keep training a little past the first finisher so most of the population gets there.
  if (marks.firstFinish !== undefined && at() - marks.firstFinish > 25) break
}
marks.trained = at()
await page.keyboard.press("KeyB")
marks.replay = at()
await page.waitForTimeout(9000)
await page.screenshot({ path: join(out, "still-replay.png"), timeout: 90_000 })
await page.keyboard.press("Space")
await page.waitForTimeout(1500)
await page.screenshot({ path: join(out, "still-training.png"), timeout: 90_000 })
marks.end = at()
const video = page.video()
await context.close()
await browser.close()
server.stop(true)
const webm = await video!.path()
await Bun.write(join(out, "timeline.json"), JSON.stringify({ marks, log, errors, final: s }, null, 2))
console.log(log.join("\n"))
console.log(JSON.stringify(marks), errors.length ? `errors: ${errors.join("; ")}` : "no page errors")

// Clip: 10 s of the first generations, 12 s around the first finisher, 9 s of the replay.
const seg = (start: number, len: number) => [Math.max(0, start), len] as const
const parts = [seg(marks.loaded! + 0.5, 10), seg((marks.firstFinish ?? marks.trained! - 12) - 2, 12), seg(marks.replay!, 9)]
const inputs = parts.flatMap(([ss, t]) => ["-ss", ss.toFixed(2), "-t", String(t), "-i", webm])
const filter = parts.map((_, i) => `[${i}:v]fps=30,setpts=PTS-STARTPTS[v${i}]`).join(";") + `;${parts.map((_, i) => `[v${i}]`).join("")}concat=n=${parts.length}:v=1:a=0[out]`
const ffmpeg = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-movflags", "+faststart", join(out, "walkers-training.mp4")])
if (ffmpeg.exitCode !== 0) console.error(ffmpeg.stderr.toString())
const full = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", join(out, "walkers-full.mp4")])
if (full.exitCode !== 0) console.error(full.stderr.toString())
console.log(`wrote ${out}`)

async function heist(): Promise<never> {
  const m: Record<string, number> = { loaded: at() }
  await page.waitForTimeout(Number(values.train) * 1000)
  await page.screenshot({ path: join(out, "still-heist-training.png"), timeout: 90_000 })
  m.trained = at()
  await page.keyboard.press("KeyP")
  m.replay = at()
  // Wait for the thief to get out (or 60 s), taking a still when it is in among the lasers.
  const lead = () => page.evaluate(() => {
    const t = document.getElementById("stats")!.textContent ?? ""
    return t
  })
  let still = false
  while (at() - m.replay! < 60) {
    await page.waitForTimeout(500)
    const t = await lead()
    if (!still && at() - m.replay! > 9) {
      await page.screenshot({ path: join(out, "still-heist-replay.png"), timeout: 90_000 })
      still = true
    }
    if (/escaped in/.test(t) && /replay matches|replay scored/.test(t)) break
  }
  await page.waitForTimeout(1500)
  m.end = at()
  const video = page.video()
  await context.close()
  await browser.close()
  server.stop(true)
  const webm = await video!.path()
  await Bun.write(join(out, "heist-timeline.json"), JSON.stringify({ marks: m, errors }, null, 2))
  console.log(JSON.stringify(m), errors.length ? `errors: ${errors.join("; ")}` : "no page errors")
  // The last 9 s of live training (the first seconds only show the placeholder while generation 0 runs), then the replay.
  const parts = [[Math.max(m.loaded! + 0.5, m.trained! - 9), 9], [m.replay! - 0.2, m.end! - m.replay! + 0.2]] as const
  const inputs = parts.flatMap(([ss, t]) => ["-ss", ss.toFixed(2), "-t", t.toFixed(2), "-i", webm])
  const filter = parts.map((_, i) => `[${i}:v]fps=30,setpts=PTS-STARTPTS[v${i}]`).join(";") + `;${parts.map((_, i) => `[v${i}]`).join("")}concat=n=${parts.length}:v=1:a=0[out]`
  const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-movflags", "+faststart", join(out, "walkers-heist.mp4")])
  if (ff.exitCode !== 0) console.error(ff.stderr.toString())
  console.log(`wrote ${out}`)
  process.exit(0)
}
