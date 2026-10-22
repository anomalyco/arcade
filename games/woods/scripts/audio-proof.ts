// Headless, muted proof of the woods soundscape (run after `bun run build`, through HiveMind, never aloud):
//   bun scripts/audio-proof.ts [--out <dir>] [--seconds 45] [--no-video]
// 1. Walks from the lakefront through camp and up the old path into the woods on a synthetic 30 fps clock, recording
//    the frames and what the ears got (`WoodsAudio.tape`), with three distant sounds auditioned on the way.
// 2. Renders that tape through the game's own mix in an OfflineAudioContext and muxes it with the frames (walk.mp4).
// 3. Renders each layer soloed along the same walk, indoors, ridge vs hollow, and every distant sound soloed and in the
//    mix, for the listening page; measures each with ffmpeg's EBU R128 meter (levels.json).
import { $ } from "bun"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { chromium } from "playwright-core"
import { DISTANT_SOUNDS, placeDistant, type DistantEvent, type DistantSound } from "../shared/distant"
import { makeWorld, terrainHeight } from "../shared/world"
import { windExposure } from "../src/audio/space"
import type { TapeFrame } from "../src/audio"
import type { SoundLayer } from "../src/audio/soundscape"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods-audio"))
const seconds = Number(arg("--seconds", "45"))
const video = !process.argv.includes("--no-video")
const FPS = 30
mkdirSync(out, { recursive: true })
const frames = join(process.env.TMPDIR ?? "/tmp", `woods-audio-frames-${process.pid}`)
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const root = resolve("dist/arcade/woods"), prefix = "/arcade/woods/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })

type Audio = {
  tape: TapeFrame[] | null
  audition(sound: DistantSound, seed?: number): DistantEvent | null
  renderTape(tape: readonly TapeFrame[], world: unknown, seconds: number, opts?: { solo?: SoundLayer | null; footsteps?: boolean; sound?: Record<string, number>; volume?: { master: number; effects: number; ambience: number } }): Promise<AudioBuffer>
}
type W = {
  frames: number; autoplay: boolean; paused: boolean; settings: Record<string, number | boolean>
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  camera: { yaw: number; pitch: number; flashlight: boolean; body: { x: number; y: number }; keys: Set<string> }
  world: { camp: { x: number; z: number; spawn: { x: number; z: number; yaw: number } }; trail: { points: [number, number][] } }
  audio: Audio
}
declare const woods: W

const world = makeWorld()
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 60000 })

// ── 1. the walk ────────────────────────────────────────────────────────────────────────────────────────────────
const camp = world.camp
// Face the lake under the string lights, turn round, walk between the cabins and up the old path.
const path: [number, number][] = [[camp.x + 3.5, camp.z - 4], [camp.x + 3.2, camp.z - 13], ...world.trail.points.map((p) => [p[0], p[1]] as [number, number])]
const auditions: [number, DistantSound, number][] = [[6.5, "far.loon", 11], [21, "far.knock", 5], [33, "far.steps", 3]]
await page.evaluate(([sx, sz]) => {
  // Stop the page's own frame loop: every frame below is one synthetic 1/30 s step, so video and tape share a clock.
  woods.paused = true
  woods.autoplay = true
  woods.settings.walkSpeed = 2.2
  woods.setPose(sx!, sz!, Math.PI - 0.25, -0.04)
  woods.audio.tape = []
}, [camp.spawn.x, camp.spawn.z])
let target = 0
const total = Math.round(seconds * FPS)
for (let f = 0; f < total; f++) {
  const t = f / FPS
  const cmd = await page.evaluate(({ t, path, target }) => {
    const c = woods.camera
    let i = target
    if (t < 4) { c.keys.delete("KeyW"); return { i } }
    const [px, pz] = path[i]!
    if (Math.hypot(px - c.body.x, pz - c.body.y) < 2.5 && i < path.length - 1) i++
    const [tx, tz] = path[i]!
    const want = Math.atan2(-(tx - c.body.x), -(tz - c.body.y))
    let d = want - c.yaw
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    c.yaw += d * (t < 6 ? 0.06 : 0.1)
    c.pitch += (-0.06 - c.pitch) * 0.05
    if (t > 4.6) c.keys.add("KeyW")
    return { i }
  }, { t, path, target })
  target = cmd.i
  for (const [at, sound, seed] of auditions) if (Math.abs(t - at) < 0.5 / FPS) await page.evaluate(([s, seed]) => { woods.audio.audition(s as DistantSound, seed as number) }, [sound, seed] as const)
  await page.evaluate((ms) => woods.step(ms), 1000 / FPS)
  if (video) await page.screenshot({ path: join(frames, `${String(f).padStart(5, "0")}.jpg`), type: "jpeg", quality: 82 })
}
const tape = await page.evaluate(() => { const t = woods.audio.tape!; woods.audio.tape = null; return t })
writeFileSync(join(out, "tape.json"), JSON.stringify({ frames: tape.length, distant: tape.flatMap((f) => f.distant.map((e) => ({ t: f.t, ...e, listener: f.l }))), end: tape.at(-1)?.l, tape }))
const started = Date.now()
/** HiveMind stops browser jobs at 30 min; the solos after the walk stop early rather than lose the walk. */
const budget = () => Date.now() - started < 18 * 60_000

// ── 2. render + mux ─────────────────────────────────────────────────────────────────────────────────────────────
async function render(name: string, tape: readonly TapeFrame[], secs: number, opts: Parameters<Audio["renderTape"]>[3] = {}) {
  const b64 = await page.evaluate(async ({ tape, secs, opts }) => {
    const buf = await woods.audio.renderTape(tape, (woods as unknown as { world: unknown }).world, secs, opts)
    const n = buf.length, ch = buf.numberOfChannels
    const pcm = new Int16Array(n * ch)
    const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c))
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) pcm[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(data[c]![i]! * 32767)))
    const bytes = new Uint8Array(pcm.buffer)
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }, { tape: tape as TapeFrame[], secs, opts })
  const pcm = Buffer.from(b64, "base64")
  const header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(48000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
  const wav = join(out, `${name}.wav`)
  writeFileSync(wav, Buffer.concat([header, pcm]))
  return wav
}

const levels: Record<string, { I: number; LRA: number; peak: number; Mmax: number; rms: number; max100: number }> = {}
/** Whole-file RMS and loudest 100 ms RMS (dBFS, mono sum), the measure #398 compared footsteps and beds by. */
function rmsOf(wav: string) {
  const bytes = readFileSync(wav)
  const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length))
  const n = pcm.length / 2, win = 4800
  let sum = 0, max = 0
  for (let s = 0; s + win <= n; s += win / 2) {
    let w = 0
    for (let i = s; i < s + win; i++) { const v = (pcm[2 * i]! + pcm[2 * i + 1]!) / 65534; w += v * v }
    max = Math.max(max, w / win)
    if (((s / (win / 2)) & 1) === 0) sum += w
  }
  const db = (v: number) => Math.round(10 * Math.log10(Math.max(1e-12, v)) * 10) / 10
  return { rms: db(sum / n), max100: db(max) }
}
async function measure(name: string, wav: string) {
  const log = await $`ffmpeg -hide_banner -nostats -i ${wav} -filter_complex ebur128=peak=sample:metadata=0 -f null -`.quiet().nothrow()
  const text = log.stderr.toString()
  const summary = text.slice(text.lastIndexOf("Summary:"))
  const num = (re: RegExp) => Number(summary.match(re)?.[1] ?? NaN)
  let mmax = -Infinity
  for (const m of text.matchAll(/ M:\s*(-?[\d.]+)/g)) mmax = Math.max(mmax, Number(m[1]))
  levels[name] = { I: num(/I:\s*(-?[\d.]+) LUFS/), LRA: num(/LRA:\s*(-?[\d.]+) LU/), peak: num(/Peak:\s*(-?[\d.]+) dBFS/), Mmax: mmax, ...rmsOf(wav) }
  writeFileSync(join(out, "levels.json"), JSON.stringify({ levels }, null, 1))
}
async function mp3(name: string, wav: string) {
  await $`ffmpeg -v error -y -i ${wav} -c:a libmp3lame -b:a 160k ${join(out, `${name}.mp3`)}`.quiet()
}

const walkWav = await render("walk", tape, seconds)
await measure("walk", walkWav)
if (video) {
  await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(frames, "%05d.jpg")} -i ${walkWav} -c:v libx264 -pix_fmt yuv420p -crf 21 -preset medium -c:a aac -b:a 192k -shortest -movflags +faststart ${join(out, "walk.mp4")}`.quiet()
}
await mp3("walk", walkWav)
rmSync(frames, { recursive: true, force: true })
const zero = { soundWind: 0, soundLeaves: 0, soundInsects: 0, soundLake: 0, soundCamp: 0, soundRoom: 0, distantLevel: 0 }
const feet = await render("walk-footsteps", tape, seconds, { sound: zero })
await measure("walk-footsteps", feet)
await mp3("walk-footsteps", feet)

// ── 3. solos ────────────────────────────────────────────────────────────────────────────────────────────────────
for (const layer of ["wind", "creaks", "leaves", "insects", "room", "lake", "dock", "lights", "distant"] as SoundLayer[]) {
  if (!budget()) break
  const wav = await render(`layer-${layer}`, tape, seconds, { solo: layer, footsteps: false })
  await measure(`layer-${layer}`, wav)
  await mp3(`layer-${layer}`, wav)
}
/** A still listener for `secs` (frames at 30 Hz), optionally with distant events at given times. */
const still = (x: number, z: number, yaw: number, secs: number, sim0: number, events: { t: number; e: DistantEvent }[] = [], y?: number): TapeFrame[] =>
  Array.from({ length: Math.round(secs * FPS) }, (_, i) => {
    const t = i / FPS
    return { t, sim: sim0 + t, l: { x, y: y ?? 0, z, yaw }, steps: [], distant: events.filter((ev) => Math.abs(ev.t - t) < 0.5 / FPS).map((ev) => ev.e) }
  })
const eye = (x: number, z: number) => terrainHeight(world.terrain, x, z) + 1.7

// Indoors: the mess hall.
const hall = world.buildings.find((b) => b.kind === "mess-hall")!
const hx = (hall.rect[0] + hall.rect[2]) / 2, hz = (hall.rect[1] + hall.rect[3]) / 2
if (budget()) for (const [name, opts] of [["indoors-walls", { solo: "walls" as SoundLayer }], ["indoors-mix", {}]] as const) {
  const wav = await render(name, still(hx, hz, 0.3, 20, 400, [], eye(hx, hz)), 20, opts)
  await measure(name, wav)
  await mp3(name, wav)
}
// Ridge vs hollow: the most and least exposed spots on a grid in the woods.
let ridge = { x: 0, z: 0, e: -1 }, hollow = { x: 0, z: 0, e: 9 }
for (let x = -180; x <= 180; x += 12) for (let z = -180; z <= 60; z += 12) {
  const e = windExposure(world, x, z)
  if (Math.hypot(x - camp.x, z - camp.z) < 60) continue
  if (e > ridge.e) ridge = { x, z, e }
  if (e < hollow.e) hollow = { x, z, e }
}
if (budget()) for (const [name, p] of [["wind-ridge", ridge], ["wind-hollow", hollow]] as const) {
  const wav = await render(name, still(p.x, p.z, 0, 25, 900, [], eye(p.x, p.z)), 25, {})
  await measure(name, wav)
  await mp3(name, wav)
}
// Every distant sound, from a spot 90 m up the old path: soloed, and in the mix.
const spot = { x: world.trail.points[3]![0], z: world.trail.points[3]![1] }
const placed: Record<string, { distance: number; x: number; y: number; z: number; take: number }> = {}
for (const sound of DISTANT_SOUNDS) {
  for (let take = 0; take < 3 && budget(); take++) {
    const e = placeDistant(world, sound, spot, 1, 101 + take * 7 + sound.length)
    if (!e) continue
    e.take = take
    const tp = still(spot.x, spot.z, 0, 9, 1200, [{ t: 0.6, e }], eye(spot.x, spot.z))
    const name = `event-${sound.slice(4)}-${take + 1}`
    const wav = await render(name, tp, 9, { solo: "distant", footsteps: false })
    await measure(name, wav)
    await mp3(name, wav)
    if (take === 0) {
      placed[sound] = { distance: Math.round(Math.hypot(e.x - spot.x, e.y - eye(spot.x, spot.z), e.z - spot.z)), x: Math.round(e.x), y: Math.round(e.y), z: Math.round(e.z), take }
      const mix = await render(`${name}-mix`, tp, 9, {})
      await measure(`${name}-mix`, mix)
      await mp3(`${name}-mix`, mix)
    }
  }
}
writeFileSync(join(out, "levels.json"), JSON.stringify({ levels, placed, ridge, hollow, spot, errors: errors.slice(0, 20) }, null, 1))
await $`rm -f ${out}/*.wav`.quiet().nothrow()
await browser.close()
server.stop(true)
console.log(JSON.stringify({ levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, `I ${v.I} M ${v.Mmax.toFixed(1)} pk ${v.peak} rms ${v.rms} max100 ${v.max100}`])), errors: errors.slice(0, 5) }, null, 1))
