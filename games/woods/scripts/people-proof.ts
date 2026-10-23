// Headless, muted proof of the realistic people (`@arcade/kit/people`) in the woods, on the production build:
//   bun run build && bun scripts/people-proof.ts [--out <dir>] [--shots close,group,...] [--clip] [--past 4,10] [--gpu] [--size 1600x900]
// Stills on a synthetic clock (deterministic, so headless frame rate never shows): a close-up in your beam (and the
// same with today's blocky friend), the five friends in a group at mid distance with their torches, and with --clip
// the group walking past, one PNG per 1/30 s, encoded to people-group.mp4 with ffmpeg. --gpu times the GPU frame
// (timestamp queries, median of 48) with the five friends in view, realistic against blocky, alternating three times.
// --past 4,10: one friend walking across your beam at each distance (m), you standing still: past-<m>.mp4.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods-people"))
const [w, h] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const only = arg("--shots", "")
const clip = process.argv.includes("--clip"), gpu = process.argv.includes("--gpu")
const past = arg("--past", "").split(",").filter(Boolean).map(Number)
const FRIENDS = 5
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

type P = { id: number; x: number; z: number; yaw: number; pitch: number; bot: boolean }
type B = { id: number; mode: string; timer: number; heading: number; tx: number; tz: number; sweep: number }
type Woods = {
  frames: number; paused: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  face(x: number, z: number, pitch?: number): void
  step(ms: number): void
  measure(n?: number): Promise<{ median: number } | null>
  settings: { botCount: number }
  state: { t: number; players: P[]; brains: B[] }
  world: { camp: { x: number; z: number } }
  camera: { flashlight: boolean }
  friends: { realistic: boolean; realPeople(): { drawn: number } }
}
declare const woods: Woods

type Group = { dx: number; dz: number; ahead: number; spread: number; light: boolean; pitch: number; mode: string; walk?: [number, number] }
/** You at camp + (dx, dz) looking along −z; friends in a loose arc `ahead` m away, facing about, or walking by. */
const group = (page: Page, o: Group) =>
  page.evaluate(({ o, n }) => {
    const c = woods.world.camp, x = c.x + o.dx, z = c.z + o.dz
    woods.setPose(x, z, 0, o.pitch)
    woods.camera.flashlight = o.light
    woods.state.brains.forEach((b, k) => {
      const p = woods.state.players.find((q) => q.id === b.id)!
      const u = n > 1 ? k / (n - 1) - 0.5 : 0
      p.x = x + u * o.spread + (k % 2) * 0.6; p.z = z - o.ahead - (k % 3) * 1.4 + Math.abs(u) * 2
      b.mode = o.mode; b.timer = 99; b.sweep = k * 1.3
      b.heading = Math.atan2(-(x - p.x), -(z - p.z)) + (k - 2) * 0.5
      if (o.walk) { b.tx = p.x + o.walk[0]; b.tz = p.z + o.walk[1]; b.heading = Math.atan2(-o.walk[0], -o.walk[1]) }
    })
    woods.face(x, z - o.ahead, o.pitch)
  }, { o, n: FRIENDS })

/** One friend in your beam at the close-up spot; the others away. */
const CLOSE = { dx: 8, dz: -46, ahead: 4.2, light: true, pitch: -0.3 }
const close = (page: Page) =>
  page.evaluate((o) => {
    const c = woods.world.camp, x = c.x + o.dx, z = c.z + o.dz
    woods.setPose(x, z, 0, o.pitch)
    woods.camera.flashlight = o.light
    woods.state.brains.forEach((b, k) => {
      const p = woods.state.players.find((q) => q.id === b.id)!
      if (k === 0) { p.x = x + 0.3; p.z = z - o.ahead; b.heading = Math.atan2(-(x - p.x), -(z - p.z)) + 0.55 } else { p.x = x + 60 + k; p.z = z + 60 }
      b.mode = "wait"; b.timer = 99; b.sweep = 0
    })
    woods.face(x + 0.3, z - o.ahead, o.pitch)
  }, CLOSE)

const MID: Group = { dx: 10, dz: -70, ahead: 9, spread: 7, light: false, pitch: -0.02, mode: "wait" }
const shots: Record<string, { real: boolean; setup: (page: Page) => Promise<unknown> }> = {
  close: { real: true, setup: close },
  "close-blocky": { real: false, setup: close },
  group: { real: true, setup: (page) => group(page, MID) },
  "group-blocky": { real: false, setup: (page) => group(page, MID) },
  "group-lit": { real: true, setup: (page) => group(page, { ...MID, light: true, ahead: 7, pitch: -0.1 }) },
}

const browser = await chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&people=real`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 180000 }).catch((e) => { console.log(errors.join("\n")); throw e })
await page.evaluate((n) => { document.getElementById("start")!.style.display = "none"; woods.paused = true; woods.settings.botCount = n }, FRIENDS)
const settle = (n: number) => page.evaluate(async (n) => { for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) } }, n)
await settle(10)
// Every friend drawn as their person (each is assigned and fetched on first sight).
await group(page, MID)
await settle(30)
await page.waitForFunction(async (n) => {
  woods.step(1000 / 60)
  await new Promise((r) => setTimeout(r, 50))
  return woods.friends.realPeople().drawn >= n
}, FRIENDS, { timeout: 120000, polling: 200 }).catch((e) => { console.log(errors.join("\n")); throw e })
const shot = (path: string) => page.screenshot({ path, timeout: 180000 })
const timing: Record<string, number> = {}
for (const [name, s] of Object.entries(shots)) {
  if (only && !only.split(",").includes(name)) continue
  const t0 = Date.now()
  await page.evaluate((r) => { woods.friends.realistic = r }, s.real)
  await s.setup(page)
  await settle(150)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await shot(`${out}/${name}.png`)
  timing[name] = Date.now() - t0
  console.log(name, timing[name], "ms")
}

const gpuMs: Record<string, number[]> = { real: [], blocky: [] }
if (gpu) {
  await group(page, { ...MID, light: true, ahead: 8, pitch: -0.06 })
  for (let round = 0; round < 3; round++) {
    for (const real of [true, false]) {
      await page.evaluate((r) => { woods.friends.realistic = r }, real)
      await settle(20)
      const m = await page.evaluate(() => woods.measure(48))
      if (m) gpuMs[real ? "real" : "blocky"]!.push(Math.round(m.median * 1000) / 1000)
    }
  }
  await page.evaluate(() => { woods.friends.realistic = true })
  await settle(10)
  await shot(`${out}/gpu-frame.png`)
  console.log("gpu ms", JSON.stringify(gpuMs))
}

if (clip) {
  // The group walks past left to right 8 m ahead, your torch on them.
  await page.evaluate(() => { woods.friends.realistic = true })
  // At the clear spot of the group stills: they start off to the left and cross 6 m ahead in your beam.
  await group(page, { ...MID, light: true, ahead: 6, spread: 3, pitch: -0.12, mode: "regroup", walk: [30, 3] })
  await page.evaluate(() => woods.state.brains.forEach((b, k) => { const p = woods.state.players.find((q) => q.id === b.id)!; p.x -= 6 + k * 0.5; b.tx -= 6 }))
  await settle(20)
  mkdirSync(`${out}/clip`, { recursive: true })
  for (let f = 0; f < 150; f++) {
    await page.evaluate(async () => { woods.step(1000 / 60); woods.step(1000 / 60); await new Promise((r) => setTimeout(r, 0)) })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
    await shot(`${out}/clip/${String(f).padStart(4, "0")}.png`)
  }
  const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", `${out}/clip/%04d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "21", "-movflags", "+faststart", `${out}/people-group.mp4`])
  console.log("ffmpeg", await ff.exited)
}
for (const d of past) {
  // You at the close-up spot, torch on, aimed at chest height where the friend will cross; they walk from 5 m left to
  // 5 m right of it, the others far away.
  await page.evaluate(() => { woods.friends.realistic = true })
  await page.evaluate(({ o, d }) => {
    const c = woods.world.camp, x = c.x + o.dx, z = c.z + o.dz
    woods.setPose(x, z, 0, 0)
    woods.camera.flashlight = true
    woods.state.brains.forEach((b, k) => {
      const p = woods.state.players.find((q) => q.id === b.id)!
      if (k === 0) { p.x = x - 5; p.z = z - d; b.mode = "regroup"; b.tx = x + 30; b.tz = z - d; b.heading = Math.atan2(-30, 0) }
      else { p.x = x + 60 + k; p.z = z + 60; b.mode = "wait" }
      b.timer = 99; b.sweep = 0
    })
    woods.face(x, z - d, Math.atan2(1.25 - 1.6, d))
  }, { o: CLOSE, d })
  await settle(4)
  mkdirSync(`${out}/past-${d}`, { recursive: true })
  for (let f = 0; f < 120; f++) {
    await page.evaluate(async () => { woods.step(1000 / 60); woods.step(1000 / 60); await new Promise((r) => setTimeout(r, 0)) })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
    await shot(`${out}/past-${d}/${String(f).padStart(4, "0")}.png`)
  }
  const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", `${out}/past-${d}/%04d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", `${out}/past-${d}.mp4`])
  console.log(`past-${d}`, await ff.exited)
}
writeFileSync(`${out}/people-proof.json`, JSON.stringify({ timing, gpuMs, errors }, null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 12))
await browser.close()
server.stop(true)
