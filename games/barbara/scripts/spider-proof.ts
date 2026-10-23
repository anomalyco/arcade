// Headless, muted proof of the spider in the game (run after `bun run build`, through HiveMind, never aloud):
//   bun scripts/spider-proof.ts [--out <dir>] [--size 1280x720] [--spot 0] [--at 41] [--seconds 15]
// Stands you on the trail looking along a straight stretch, your torch on and level, at game exposure. Five seconds in, the
// spider walks slowly across your view `--at` m out, where your beam fades (the schedule's own beat with no friend's
// light to cross); at 13 s it drums the leaves. Records the frames on a synthetic 30 fps clock and what the ears got,
// rendered offline through the game's own mix (clip.mp4), plus the still where it crosses your line of sight (cross.png,
// cross-crop.png), and
// spider.json: how many footfalls and drums were heard, and the crickets' level before and while it's near, and against
// the same tape with the spider taken out (offline renders with the insects layer alone). `--dark`: your torch off, so a
// beat inside 38 m doesn't drive it off (for the crickets' hush).
import { $ } from "bun"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import type { TapeFrame } from "../src/audio"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/spider"))
const [W, H] = arg("--size", "1280x720").split("x").map(Number) as [number, number]
const spot = Number(arg("--spot", "0"))
const AT = Number(arg("--at", "41"))
/** `--pitch`: your view and torch pitch (rad); about 0.09 puts the beam on its body at 30 m, so it flees. */
const PITCH = Number(arg("--pitch", "0.02"))
const DARK = process.argv.includes("--dark")
const SECONDS = Number(arg("--seconds", "15")), FPS = 30, BEAT = 5, DRUM = 13
mkdirSync(out, { recursive: true })
const frames = join(process.env.TMPDIR ?? "/tmp", `woods-spider-frames-${process.pid}`)
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const root = resolve("dist/arcade/barbara"), prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })

type P = { id: number; x: number; z: number }
type Woods = {
  frames: number; paused: boolean; autoplay: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  camera: { yaw: number; flashlight: boolean }
  state: { t: number; players: P[]; brains: { id: number; mode: string; timer: number }[] }
  world: { camp: { x: number; z: number } }
  creature: { stage(): boolean }
  spider: { pose: { body: [number, number, number] } | null; steps: unknown[] }
  spiderLab: { beat(distance?: number, x0?: number, z0?: number, x1?: number, z1?: number): unknown; drum(): unknown }
  view: { forest: { stats(): { exposure: number } } }
  audio: { tape: TapeFrame[] | null; renderTape(tape: readonly TapeFrame[], world: unknown, seconds: number, opts?: { solo?: string; voices?: boolean; footsteps?: boolean }): Promise<AudioBuffer> }
}
declare const woods: Woods

await using budget = browserBudget()
const browser = await budget.chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 150000 }).catch((e) => { console.log(errors.join("\n")); throw e })

// A spot on the trail with a clear line ahead to where it walks: no trunk within 0.6 m of your line of sight (1.2 m for a
// fir: its branches sweep low), nor within 0.3 m of the lines to either end of its walk.
// `--signs`: stills of tonight's web from 5 m with your torch on it (web.png) and of the person-sized bundle from below
// (bundle.png), then exit.
if (process.argv.includes("--signs")) {
  const shots = await page.evaluate(async () => {
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) if (!(el instanceof HTMLCanvasElement) && !el.querySelector("canvas")) el.style.visibility = "hidden"
    woods.paused = true
    woods.autoplay = true
    type Signs = { webs: { x: number; y: number; z: number; ux: number; uz: number }[]; bundles: { x: number; y: number; z: number; size: string }[] }
    const signs = (woods as unknown as { spiderSigns: Signs | null }).spiderSigns
    if (!signs?.webs[0]) return null
    const w = signs.webs[0], nx = -w.uz, nz = w.ux
    const b = signs.bundles.find((q) => q.size === "person") ?? signs.bundles[0]
    return { web: { x: w.x + nx * 5, z: w.z + nz * 5, yaw: Math.atan2(nx, nz), pitch: 0.12 }, bundle: b ? { x: b.x + 6, z: b.z + 2, yaw: Math.atan2(6, 2), pitch: 0.8 } : null }
  })
  if (!shots) throw new Error("no spider signs tonight")
  for (const [name, s] of Object.entries(shots)) {
    if (!s) continue
    await page.evaluate(async (s) => {
      woods.setPose(s.x, s.z, s.yaw, s.pitch)
      woods.camera.flashlight = true
      for (let i = 0; i < 90; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
    }, s)
    await page.screenshot({ path: join(out, `${name}.png`) })
  }
  console.log("signs", JSON.stringify(shots), errors.slice(0, 3))
  server.stop(true)
  process.exit(0)
}

const staged = await page.evaluate(({ spot, AT, PITCH, DARK }) => {
  // Only the woods: every overlay (the shell, the HUD, the story's card and subtitles) hidden.
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) if (!(el instanceof HTMLCanvasElement) && !el.querySelector("canvas")) el.style.visibility = "hidden"
  woods.paused = true
  woods.autoplay = true
  const trees = (woods.world as unknown as { trees: { x: number; z: number; radius: number; species: string }[] }).trees
  const clear = (ax: number, az: number, bx: number, bz: number, m: number, fir: number) => trees.every((t) => {
    const dx = bx - ax, dz = bz - az, k = Math.max(0, Math.min(1, ((t.x - ax) * dx + (t.z - az) * dz) / (dx * dx + dz * dz)))
    return Math.hypot(t.x - ax - dx * k, t.z - az - dz * k) > t.radius + (t.species === "fir" ? fir : m)
  })
  // On the trail (the renderer keeps it clear of undergrowth), looking along a straight stretch of it.
  const pts = (woods.world as unknown as { trail: { points: [number, number][] } }).trail.points
  let found = -1
  for (let i = 0; i + 1 < pts.length; i++) for (const back of [0, 4, 8, 12]) {
    const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!
    const l = Math.hypot(bx - ax, bz - az), fx = (bx - ax) / l, fz = (bz - az) / l
    const x = ax - fx * back, z = az - fz * back, yaw = Math.atan2(-fx, -fz)
    const mx = x + fx * AT, mz = z + fz * AT
    if (!clear(x, z, mx, mz, 0.6, 1.2)) continue
    if (!clear(x, z, mx - fz * 4, mz + fx * 4, 0.3, 0.6) || !clear(x, z, mx + fz * 10, mz - fx * 10, 0.3, 0.6)) continue
    if (++found < spot) continue
    woods.setPose(x, z, yaw, PITCH)
    woods.camera.flashlight = !DARK
    const me = woods.state.players[0]!
    // The friends wait well behind you, so their beams don't light the view.
    for (const b of woods.state.brains) {
      const p = woods.state.players.find((q) => q.id === b.id)!
      p.x = me.x + Math.sin(yaw) * 45 + (p.id % 3) * 3; p.z = me.z + Math.cos(yaw) * 45; b.mode = "wait"; b.timer = 999
    }
    return { you: [x, z], yaw }
  }
  return null
}, { spot, AT, PITCH, DARK })
if (!staged) throw new Error("no spot with a clear line ahead")
const [yx, yz] = staged.you as [number, number]
const ux = -Math.sin(staged.yaw), uz = -Math.cos(staged.yaw)
// Across your line of sight at `AT` m, from 4 m on one side to 10 m on the other: it crosses it about 3.5 s into its walk.
const cx = yx + ux * AT, cz = yz + uz * AT
const path = [cx + uz * 4, cz - ux * 4, cx - uz * 10, cz + ux * 10] as const
console.log("staged", JSON.stringify({ ...staged, path }))

await page.evaluate(async () => { for (let i = 0; i < 150; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) } })
await page.evaluate(() => { woods.audio.tape = [] })

const total = Math.round(SECONDS * FPS)
const drawn: { f: number; body: [number, number, number] | null; mode: string }[] = []
for (let f = 0; f < total; f++) {
  if (f === Math.round(BEAT * FPS)) await page.evaluate((p) => woods.spiderLab.beat(undefined, p[0], p[1], p[2], p[3]), path)
  if (f === Math.round(DRUM * FPS)) await page.evaluate(() => woods.spiderLab.drum())
  await page.evaluate((ms) => woods.step(ms), 1000 / FPS)
  drawn.push({ f, ...(await page.evaluate(() => ({ body: woods.spider.pose?.body ?? null, mode: (woods.state as unknown as { stalker: { mode: string } }).stalker.mode }))) })
  await page.screenshot({ path: join(frames, `${String(f).padStart(4, "0")}.png`) })
  if (f % 5 === 4) await page.evaluate(() => new Promise((r) => setTimeout(r, 0)))
}
const exposure = await page.evaluate(() => woods.view.forest.stats().exposure)
const full = await page.evaluate(() => { const t = woods.audio.tape!; woods.audio.tape = null; return t })
const tape = full

// The still where its body is nearest your line of sight.
const side = (p: [number, number, number]) => Math.abs((p[0] - yx) * -uz + (p[2] - yz) * ux)
const seen = drawn.filter((d) => d.body && d.f > BEAT * FPS)
const best = seen.reduce((a, b) => (side(b.body!) < side(a.body!) ? b : a))
const name = (f: number) => join(frames, `${String(f).padStart(4, "0")}.png`)
await $`cp ${name(best.f)} ${join(out, "cross.png")}`
const cw = Math.round(W / 2.2), ch = Math.round(H / 2.2), ox = Math.round(W / 2 - cw / 2), oy = Math.round(H * 0.42 - ch / 2)
await $`ffmpeg -v error -y -i ${join(out, "cross.png")} -vf crop=${cw}:${ch}:${ox}:${oy},scale=${cw * 2}:${ch * 2}:flags=lanczos ${join(out, "cross-crop.png")}`

// The ears, offline through the game's own mix: everything, then the crickets alone.
const render = (solo: string | null, tape: TapeFrame[] = full) => page.evaluate(async ({ tape, secs, solo }) => {
  const buf = await woods.audio.renderTape(tape, (woods as unknown as { world: unknown }).world, secs, solo ? { solo, voices: false, footsteps: false } : {})
  const n = buf.length, chn = buf.numberOfChannels, data = Array.from({ length: chn }, (_, c) => buf.getChannelData(c))
  const rms = (a: number, b: number) => { let s = 0, k = 0; for (let i = Math.floor(a * buf.sampleRate); i < Math.min(n, b * buf.sampleRate); i++) for (const d of data) { s += d[i]! * d[i]!; k++ } return Math.sqrt(s / Math.max(1, k)) }
  const pcm = new Int16Array(n * chn)
  for (let i = 0; i < n; i++) for (let c = 0; c < chn; c++) pcm[i * chn + c] = Math.max(-32768, Math.min(32767, Math.round(data[c]![i]! * 32767)))
  const bytes = new Uint8Array(pcm.buffer)
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const series = Array.from({ length: Math.floor(secs) }, (_, i) => +(20 * Math.log10(Math.max(1e-9, rms(i, i + 1)))).toFixed(1))
  return { b64: btoa(s), before: rms(2.5, 5), near: rms(8.5, 12.5), series }
}, { tape, secs: SECONDS, solo })
const wavOf = (b64: string, file: string) => {
  const pcm = Buffer.from(b64, "base64"), h = Buffer.alloc(44)
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24)
  h.writeUInt32LE(48000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40)
  writeFileSync(file, Buffer.concat([h, pcm]))
}
// The same tape with the spider taken out, for the crickets' level without it (the bed's own swells cancel). A soloed
// render still plays voices and your feet, so those are off for it.
const all = await render(null), insects = await render("insects"), without = await render("insects", full.map(({ spider: _, ...f }) => f))
const wav = join(out, "clip.wav")
wavOf(all.b64, wav)
await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(frames, "%04d.png")} -i ${wav} -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest ${join(out, "clip.mp4")}`
await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(frames, "%04d.png")} -i ${wav} -vf crop=${cw}:${ch}:${ox}:${oy},scale=${cw * 2}:${ch * 2}:flags=lanczos -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest ${join(out, "clip-crop.mp4")}`
rmSync(frames, { recursive: true, force: true })
const steps = tape.flatMap((t) => t.spider?.steps ?? [])
const drums = tape.flatMap((t) => t.spider?.drums ?? [])
const db = (a: number, b: number) => +(20 * Math.log10(Math.max(1e-9, a) / Math.max(1e-9, b))).toFixed(1)
const report = {
  staged, path, exposure, crossFrame: best.f, crossSeconds: +(best.f / FPS).toFixed(2), crossDistance: +Math.hypot(best.body![0] - yx, best.body![2] - yz).toFixed(1),
  fledAt: (() => { const d = drawn.find((x) => x.mode === "flee"); return d ? +(d.f / FPS).toFixed(2) : null })(),
  footfalls: steps.length, nearestFootfall: steps.length ? +Math.min(...steps.map((s) => Math.hypot(s[0]! - yx, s[2]! - yz))).toFixed(1) : null, drums: drums.length,
  spiderDistanceBySecond: Array.from({ length: Math.floor(SECONDS) }, (_, i) => {
    const f = full.filter((x) => x.t >= i && x.t < i + 1 && x.spider?.at)
    return f.length ? +Math.min(...f.map((x) => Math.hypot(x.spider!.at![0]! - x.l.x, x.spider!.at![1]! - x.l.z))).toFixed(1) : null
  }),
  cricketsNearVsBeforeDb: db(insects.near, insects.before), cricketsHushDb: db(insects.near, without.near), cricketsHushBySecond: insects.series.map((v, i) => +(v - without.series[i]!).toFixed(1)), cricketsDbBySecond: insects.series, mixNearVsBeforeDb: db(all.near, all.before), errors,
}
writeFileSync(join(out, "spider.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
server.stop(true)
