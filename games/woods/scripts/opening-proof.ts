// Headless, muted proof of the Find Barbara opening (run after `bun run build`, through HiveMind, never aloud):
//   bun scripts/opening-proof.ts [--out <dir>] [--seconds 26] [--night 1]
// Plays the trailhead opening on a synthetic 30 fps clock (Walt, then the searchers calling for Barbara around and
// ahead, the FIND BARBARA card and subtitles, which are page DOM so the frames carry them), walking a little up the old
// path from 7 s to show it never holds you. Records what the ears got (`WoodsAudio.tape`), renders it offline through
// the game's own mix and muxes opening.mp4; renders the voices alone for their levels and a waveform; and lists each
// line as it reached you (distance, trunks in the way, the loudest 400 ms there) in opening.json.
import { $ } from "bun"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { chromium } from "playwright-core"
import { VOICE_LINES } from "../shared/lines.gen"
import type { VoiceEvent } from "../shared/voices"
import { makeWorld } from "../shared/world"
import type { TapeFrame } from "../src/audio"
import { voiceHeard } from "../src/audio/voices"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods-opening"))
const seconds = Number(arg("--seconds", "26"))
const night = Number(arg("--night", "1"))
const FPS = 30
mkdirSync(out, { recursive: true })
const frames = join(process.env.TMPDIR ?? "/tmp", `woods-opening-frames-${process.pid}`)
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

type W = {
  frames: number; autoplay: boolean; paused: boolean; settings: Record<string, number | boolean>
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  hold(code: string, down: boolean): void
  camera: { yaw: number; pitch: number }
  world: unknown
  audio: { tape: TapeFrame[] | null; renderTape(tape: readonly TapeFrame[], world: unknown, seconds: number, opts?: { footsteps?: boolean; sound?: Record<string, number>; volume?: { master: number; effects: number; ambience: number; voice?: number } }): Promise<AudioBuffer> }
}
declare const woods: W

const world = makeWorld()
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.addInitScript((n) => localStorage.setItem("woods.nights", String(n - 1)), night)
await page.goto(`http://127.0.0.1:${server.port}${prefix}`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 60000 })

// Stand at the camp spawn facing up the old path; every frame below is one synthetic 1/30 s step.
const s = world.camp.spawn, aim = world.trail.points[1]!
const yaw = Math.atan2(-(aim[0] - s.x), -(aim[1] - s.z))
await page.evaluate(([x, z, yaw]) => {
  woods.paused = true
  woods.autoplay = true
  woods.settings.walkSpeed = 1.5
  woods.setPose(x!, z!, yaw!, -0.03)
  woods.audio.tape = []
}, [s.x, s.z, yaw])
const total = Math.round(seconds * FPS)
for (let f = 0; f < total; f++) {
  const t = f / FPS
  if (Math.abs(t - 7) < 0.5 / FPS) await page.evaluate(() => woods.hold("KeyW", true))
  if (Math.abs(t - 19) < 0.5 / FPS) await page.evaluate(() => woods.hold("KeyW", false))
  // A slow look round to the voices on the right, then back up the path.
  await page.evaluate(([t, yaw]) => { woods.camera.yaw = yaw! + 0.35 * Math.sin(Math.max(0, t! - 9) * 0.32) * Math.min(1, Math.max(0, t! - 9) / 3) }, [t, yaw])
  await page.evaluate((ms) => woods.step(ms), 1000 / FPS)
  await page.screenshot({ path: join(frames, `${String(f).padStart(5, "0")}.jpg`), type: "jpeg", quality: 84 })
}
const tape = await page.evaluate(() => { const t = woods.audio.tape!; woods.audio.tape = null; return t })

async function render(name: string, opts: Parameters<W["audio"]["renderTape"]>[3]) {
  const b64 = await page.evaluate(async ({ tape, secs, opts }) => {
    const buf = await woods.audio.renderTape(tape, woods.world, secs, opts)
    const n = buf.length, ch = buf.numberOfChannels
    const pcm = new Int16Array(n * ch)
    const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c))
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) pcm[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(data[c]![i]! * 32767)))
    const bytes = new Uint8Array(pcm.buffer)
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }, { tape, secs: seconds, opts })
  const pcm = Buffer.from(b64, "base64")
  const header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(48000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
  const wav = join(out, `${name}.wav`)
  writeFileSync(wav, Buffer.concat([header, pcm]))
  return wav
}
async function ebu(wav: string) {
  const text = (await $`ffmpeg -hide_banner -nostats -i ${wav} -filter_complex ebur128=peak=sample:metadata=0 -f null -`.quiet().nothrow()).stderr.toString()
  const summary = text.slice(text.lastIndexOf("Summary:"))
  const moments = [...text.matchAll(/t:\s*([\d.]+)\s+TARGET.*? M:\s*(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const)
  return { I: Number(summary.match(/I:\s*(-?[\d.]+) LUFS/)?.[1]), peak: Number(summary.match(/Peak:\s*(-?[\d.]+) dBFS/)?.[1]), moments }
}

const volume = { master: 0.8, effects: 1, ambience: 1, voice: 1 }
const mixWav = await render("opening", { volume })
const zero = { soundWind: 0, soundLeaves: 0, soundInsects: 0, soundLake: 0, soundCamp: 0, soundRoom: 0, distantLevel: 0 }
const voiceWav = await render("opening-voices", { volume, sound: zero, footsteps: false })
const bedWav = await render("opening-bed", { volume: { ...volume, voice: 0 } })
await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(frames, "%05d.jpg")} -i ${mixWav} -c:v libx264 -pix_fmt yuv420p -crf 21 -preset medium -c:a aac -b:a 192k -shortest -movflags +faststart ${join(out, "opening.mp4")}`.quiet()
await $`ffmpeg -v error -y -i ${voiceWav} -filter_complex showwavespic=s=1600x300:split_channels=0:colors=#f2c96b -frames:v 1 ${join(out, "opening-voices-wave.png")}`.quiet()
await $`ffmpeg -v error -y -i ${mixWav} -c:a libmp3lame -b:a 160k ${join(out, "opening.mp3")}`.quiet()
for (const f of [0, 4, 6, 8, 13, 17, 21]) await $`cp ${join(frames, `${String(f * FPS).padStart(5, "0")}.jpg`)} ${join(out, `still-${String(f).padStart(2, "0")}s.jpg`)}`.quiet().nothrow()
rmSync(frames, { recursive: true, force: true })

// Each line where it reached you: distance, trunks between, and the loudest momentary loudness of the voices-only
// render over its arrival.
const mix = await ebu(mixWav), voices = await ebu(voiceWav), bed = await ebu(bedWav)
const lines = tape.flatMap((f) => (f.voices ?? []).map((e: VoiceEvent) => {
  const h = voiceHeard(world, e, f.l)
  const line = VOICE_LINES.find((l) => l.id === e.line)!
  const arrive = f.t + Math.max(0, h.delay - (f.sim - e.at))
  const m = voices.moments.filter(([t]) => t >= arrive + 0.2 && t <= arrive + line.seconds + 0.4).map(([, v]) => v)
  const b = bed.moments.filter(([t]) => t >= arrive + 0.2 && t <= arrive + line.seconds + 0.4).map(([, v]) => v)
  return { at: +arrive.toFixed(2), cast: e.cast, line: e.line, text: line.text, distance: Math.round(h.distance), trees: h.trees, cutoffHz: Math.round(h.cutoff), estLufs: +h.lufs.toFixed(1), voiceMmax: m.length ? Math.max(...m) : null, bedM: b.length ? +(b.reduce((s, v) => s + v, 0) / b.length).toFixed(1) : null }
}))
const report = { night, seconds, mix: { I: mix.I, peak: mix.peak }, voices: { I: voices.I, peak: voices.peak }, bed: { I: bed.I, peak: bed.peak }, lines, errors: errors.slice(0, 20) }
writeFileSync(join(out, "opening.json"), JSON.stringify(report, null, 1))
await $`rm -f ${out}/opening-bed.wav ${out}/opening.wav`.quiet().nothrow()
await $`ffmpeg -v error -y -i ${voiceWav} -c:a libmp3lame -b:a 160k ${join(out, "opening-voices.mp3")}`.quiet()
await $`rm -f ${voiceWav}`.quiet().nothrow()
await browser.close()
server.stop(true)
console.log(JSON.stringify({ ...report, lines: lines.map((l) => `${l.at}s ${l.cast} ${l.distance}m ${l.trees} trunks est ${l.estLufs} heard ${l.voiceMmax} over bed ${l.bedM}: ${l.text}`) }, null, 1))
