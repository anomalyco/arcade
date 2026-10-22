// Headless, muted proof of the creature sighting (run after `bun run build`, through HiveMind, never aloud):
//   bun scripts/creature-proof.ts [--out <dir>] [--size 1600x900] [--seed 3]
// Stands you in the woods facing a friend 70 m off holding their beam up (the Lab's Trigger now stages exactly this),
// triggers a sighting a second in and records 3.6 s on a synthetic 30 fps clock: the frames, and what the ears got,
// rendered offline through the game's own mix (clip.mp4, and clip-crop.mp4 zoomed on the shaft). Also writes the still
// at the moment it crosses the shaft (ours.png, ours-crop.png) and the run's numbers (creature.json).
import { $ } from "bun"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { chromium } from "playwright-core"
import type { CreatureEvent } from "../shared/creature"
import type { TapeFrame } from "../src/audio"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/creature"))
const [W, H] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const spot = Number(arg("--spot", "0"))
const FPS = 30, SECONDS = 3.6, TRIGGER = 1.0
mkdirSync(out, { recursive: true })
const frames = join(process.env.TMPDIR ?? "/tmp", `woods-creature-frames-${process.pid}`)
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

type P = { id: number; x: number; z: number; yaw: number; pitch: number; light: boolean; bot: boolean }
type Woods = {
  frames: number; paused: boolean; autoplay: boolean; settings: Record<string, number | boolean>
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  camera: { yaw: number; pitch: number; flashlight: boolean }
  state: { t: number; players: P[]; brains: { id: number; mode: string; timer: number }[] }
  world: { camp: { x: number; z: number } }
  creature: { stage(): boolean; trigger(): CreatureEvent | null; last: CreatureEvent | null }
  creatures: { last: { at: [number, number, number] | null; drawn: number } }
  audio: { tape: TapeFrame[] | null; renderTape(tape: readonly TapeFrame[], world: unknown, seconds: number): Promise<AudioBuffer> }
}
declare const woods: Woods

const browser = await chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 180000 }).catch((e) => { console.log(errors.join("\n")); throw e })

// Out in the woods, your light off (as in the concept); the other friends wait behind you; one is staged ahead.
const staged = await page.evaluate((spot) => {
  document.getElementById("start")!.style.display = "none"
  woods.paused = true
  woods.autoplay = true
  const c = woods.world.camp
  const spots = [[c.x + 10, c.z - 70, 0], [c.x - 40, c.z - 90, -0.4], [c.x + 30, c.z - 110, 0.5], [c.x - 70, c.z - 40, 0.9]]
  for (let k = 0; k < spots.length; k++) {
    const [x, z, yaw] = spots[(k + spot) % spots.length]!
    woods.setPose(x!, z!, yaw!, 0.03)
    woods.camera.flashlight = false
    if (!woods.creature.stage()) continue
    const me = woods.state.players[0]!, bot = woods.state.players.find((p) => p.id === woods.state.brains[0]!.id)!
    // Face the friend exactly: their shaft stands in the middle of the frame.
    woods.setPose(me.x, me.z, Math.atan2(-(bot.x - me.x), -(bot.z - me.z)), 0.03)
    woods.camera.flashlight = false
    for (const b of woods.state.brains.slice(1)) {
      const p = woods.state.players.find((q) => q.id === b.id)!
      p.x = me.x + Math.sin(woods.camera.yaw) * 45 + (p.id % 3) * 3; p.z = me.z + Math.cos(woods.camera.yaw) * 45; b.mode = "wait"; b.timer = 999
    }
    return { you: [me.x, me.z], friend: [bot.x, bot.z], yaw: woods.camera.yaw }
  }
  return null
}, spot)
if (!staged) throw new Error("no spot with a clear 60–85 m line of sight")
console.log("staged", JSON.stringify(staged))
// Settle the beam, exposure, TAA and fog history.
await page.evaluate(async () => { for (let i = 0; i < 150; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) } })
await page.evaluate(() => { woods.audio.tape = [] })

const total = Math.round(SECONDS * FPS)
let event: CreatureEvent | null = null
const drawn: { f: number; at: [number, number, number] | null }[] = []
for (let f = 0; f < total; f++) {
  if (f === Math.round(TRIGGER * FPS)) event = await page.evaluate(() => woods.creature.trigger())
  await page.evaluate((ms) => woods.step(ms), 1000 / FPS)
  drawn.push({ f, at: await page.evaluate(() => woods.creatures.last.at) })
  await page.screenshot({ path: join(frames, `${String(f).padStart(4, "0")}.png`) })
  if (f % 5 === 4) await page.evaluate(() => new Promise((r) => setTimeout(r, 0)))
}
if (!event) throw new Error(`no sighting: ${errors.slice(0, 5).join(" | ")}`)
const tape = await page.evaluate(() => { const t = woods.audio.tape!; woods.audio.tape = null; return t })

// The frame where it is in front of the shaft: its chest nearest your line of sight to the friend.
const [yx, yz] = staged.you as [number, number], [fx, fz] = staged.friend as [number, number]
const ux = (fx - yx) / Math.hypot(fx - yx, fz - yz), uz = (fz - yz) / Math.hypot(fx - yx, fz - yz)
const side = (p: [number, number, number]) => Math.abs((p[0] - yx) * -uz + (p[2] - yz) * ux)
const visible = drawn.filter((d) => d.at)
const best = visible.reduce((a, b) => (side(b.at!) < side(a.at!) ? b : a))
const cross = Math.hypot(best.at![0] - yx, best.at![2] - yz)
const name = (f: number) => join(frames, `${String(f).padStart(4, "0")}.png`)
await $`cp ${name(best.f)} ${join(out, "ours.png")}`
// Crop on the shaft: centred horizontally (you face the friend), a little under the horizon where it runs.
const cw = Math.round(W / 3), ch = Math.round(H / 3), cx = Math.round(W / 2 - cw / 2), cy = Math.round(H * 0.52 - ch / 2)
await $`ffmpeg -v error -y -i ${join(out, "ours.png")} -vf crop=${cw}:${ch}:${cx}:${cy},scale=${cw * 3}:${ch * 3}:flags=lanczos ${join(out, "ours-crop.png")}`

// Audio: the tape through the game's own mix, offline.
const b64 = await page.evaluate(async ({ tape, secs }) => {
  const buf = await woods.audio.renderTape(tape, (woods as unknown as { world: unknown }).world, secs)
  const n = buf.length, chn = buf.numberOfChannels
  const pcm = new Int16Array(n * chn)
  const data = Array.from({ length: chn }, (_, c) => buf.getChannelData(c))
  for (let i = 0; i < n; i++) for (let c = 0; c < chn; c++) pcm[i * chn + c] = Math.max(-32768, Math.min(32767, Math.round(data[c]![i]! * 32767)))
  const bytes = new Uint8Array(pcm.buffer)
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}, { tape, secs: SECONDS })
const pcm = Buffer.from(b64, "base64")
const header = Buffer.alloc(44)
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12)
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24)
header.writeUInt32LE(48000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
const wav = join(out, "clip.wav")
writeFileSync(wav, Buffer.concat([header, pcm]))

await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(frames, "%04d.png")} -i ${wav} -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest ${join(out, "clip.mp4")}`
await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(frames, "%04d.png")} -i ${wav} -vf crop=${cw}:${ch}:${cx}:${cy},scale=${cw * 3}:${ch * 3}:flags=lanczos -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest ${join(out, "clip-crop.mp4")}`
const loud = await $`ffmpeg -hide_banner -nostats -i ${wav} -filter_complex ebur128=peak=sample:metadata=0 -f null -`.quiet().nothrow()
const log = loud.stderr.toString()
const level = { I: Number(/I:\s*(-?[\d.]+) LUFS/.exec(log)?.[1]), peak: Number(/Peak:\s*(-?[\d.]+) dBFS/.exec(log)?.[1]) }
writeFileSync(join(out, "creature.json"), JSON.stringify({ staged, event, frames: total, visibleFrames: visible.length, visibleSeconds: visible.length / FPS, crossFrame: best.f, crossDistance: +cross.toFixed(1), heard: tape.flatMap((t) => t.creature ?? []).length, level, errors }, null, 2))
console.log(JSON.stringify({ event, visibleSeconds: visible.length / FPS, crossFrame: best.f, crossDistance: +cross.toFixed(1), level }))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
rmSync(frames, { recursive: true, force: true })
await browser.close()
server.stop(true)
