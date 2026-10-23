// Headless, muted proof of BARBARA's road flares (run after `bun run build`, through HiveMind, never aloud):
//   bun scripts/flare-proof.ts [--out <dir>]
// 1. Stills in the woods at night, your flashlight off: one held lit in your hand, then one burning on the ground 5 m,
//    30 m and 120 m ahead through the trees, and the same 120 m view with none (the dark it has to beat).
// 2. GPU cost at High and Low: the frame with a flare 5 m ahead against the same frame without (median of 24).
// 3. Sound, rendered offline through the game's own mix: a strike, catch, hold and throw recorded as you'd hear it
//    (flares soloed and in the woods), and the hiss alone at 1, 5, 30 and 120 m, measured with EBU R128 (levels.json).
import { $ } from "bun"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { trunkBetween } from "../shared/creature"
import { isDeepWater, makeWorld, treesNear } from "../shared/world"
import type { TapeFrame } from "../src/audio"
import type { SoundLayer } from "../src/audio/soundscape"

await using budget = browserBudget()
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/barbara-flare"))
mkdirSync(out, { recursive: true })

const root = resolve("dist/arcade/barbara"), prefix = "/arcade/barbara/"
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
  layFlare(x: number, z: number, age?: number, yaw?: number): number
  camera: { flashlight: boolean }
  state: { t: number; flares: { list: unknown[] } }
  flares: { stats(): Record<string, number>; look: Record<string, number | boolean>; settings: Record<string, number> }
  quality: { setMode(mode: string, save?: boolean): void }
  measure(n?: number): Promise<{ median: number } | null>
  audio: { tape: TapeFrame[] | null; renderTape(tape: readonly TapeFrame[], world: unknown, seconds: number, opts?: { solo?: SoundLayer | null; footsteps?: boolean; voices?: boolean; volume?: { master: number; effects: number; ambience: number; voice?: number } }): Promise<AudioBuffer> }
  world: unknown
}
declare const woods: W

// A spot in the woods north of camp with dry ground 5, 30 and 120 m ahead, none of them inside a trunk.
const world = makeWorld()
function spot() {
  const free = (x: number, z: number) => !isDeepWater(world, x, z) && Math.abs(x) < world.params.half - 15 && Math.abs(z) < world.params.half - 15 && treesNear(world, x, z, 0.6).length === 0
  for (const [ox, oz] of [[0, -70], [20, -80], [-25, -75], [10, -100], [-40, -60]] as const) {
    const x = world.camp.x + ox, z = world.camp.z + oz
    if (!free(x, z)) continue
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * Math.PI * 2, fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      if ([5, 30, 120].every((d) => free(x + fx * d, z + fz * d)) && Math.hypot(x + fx * 120 - world.camp.x, z + fz * 120 - world.camp.z) > 60) return { x, z, yaw, fx, fz }
    }
  }
  throw new Error("no spot")
}
const at = spot()

/** A standpoint in the woods with no trunk on the line to a spot 120 m off (the far haze seen where it can be). */
function gapLine() {
  for (let x = -110; x <= 110; x += 5) for (let z = -110; z <= 110; z += 5) {
    if (isDeepWater(world, x, z) || Math.hypot(x - world.camp.x, z - world.camp.z) < 50 || treesNear(world, x, z, 0.6).length) continue
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, bx = x + Math.cos(a) * 120, bz = z + Math.sin(a) * 120
      if (Math.abs(bx) > 180 || Math.abs(bz) > 180 || isDeepWater(world, bx, bz) || isDeepWater(world, (x + bx) / 2, (z + bz) / 2)) continue
      if (!trunkBetween(world, x, z, bx, bz, 0.15)) return { x, z, bx, bz, yaw: Math.atan2(-(bx - x), -(bz - z)) }
    }
  }
  throw new Error("no gap")
}
console.log("spot", at)

const { chromium } = budget
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 90000 })
// The picture only: no key line, story card or toasts over it.
await page.addStyleTag({ content: "body * { visibility: hidden !important } #view { visibility: visible !important }" })
await page.evaluate(({ x, z, yaw }) => {
  woods.paused = true
  woods.autoplay = true
  Object.assign(woods.settings, { botCount: 0, creature: false, distantRate: 0, chatter: 0 })
  woods.camera.flashlight = false
  woods.setPose(x, z, yaw, -0.06)
}, at)
const run = (seconds: number) => page.evaluate((s) => { for (let i = 0; i < s * 30; i++) woods.step(1000 / 30) }, seconds)
const clear = () => page.evaluate(() => { woods.state.flares.list.length = 0 })
await run(2)

// ── 1. stills ──────────────────────────────────────────────────────────────────────────────────────────────────
const shots: Record<string, unknown> = {}
async function shot(name: string) {
  await page.screenshot({ path: join(out, `${name}.png`) })
  shots[name] = await page.evaluate(() => woods.flares.stats())
  console.log(name, shots[name])
}
await page.evaluate(() => woods.hold("KeyQ", true))
await run(4)
await shot("hand")
await page.evaluate(() => woods.hold("KeyQ", false))
await run(1)
await clear()
for (const d of [5, 30, 60, 120]) {
  await page.evaluate(({ x, z, yaw, d, fx, fz }) => { woods.state.flares.list.length = 0; woods.setPose(x, z, yaw, d > 50 ? 0.02 : d > 20 ? -0.04 : -0.18); woods.layFlare(x + fx * d, z + fz * d, 30, yaw + 1.2) }, { ...at, d })
  await run(d > 50 ? 4 : 7)
  await shot(`ground-${d}m`)
}
// Down a line through the woods with a gap all the way, 120 m: the haze at its default and at half and double it.
const gap = gapLine()
console.log("gap", gap)
for (const haze of [1, ...(process.env.FLARE_HAZES ?? "0.5,2").split(",").map(Number)]) {
  await page.evaluate(({ g, h }) => { woods.flares.look.haze = h; woods.state.flares.list.length = 0; woods.setPose(g.x, g.z, g.yaw, 0.03); woods.layFlare(g.bx, g.bz, 30, g.yaw + 1.2) }, { g: gap, h: haze })
  await run(4)
  await shot(haze === 1 ? "gap-120m" : `gap-120m-haze${haze}`)
}
await page.evaluate(({ x, z, yaw }) => { woods.flares.look.haze = 1; woods.setPose(x, z, yaw, 0.02) }, at)
await clear()
await run(4)
await shot("none-120m")

if (process.argv.includes("--stills")) {
  writeFileSync(join(out, "flare-proof.json"), JSON.stringify({ spot: at, shots, errors }, null, 1))
  server.stop()
  await budget.exit(0)
}

// ── 2. GPU ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Each variant against "none" on the same frame: the flare whole, then without its trunk shadows, its mist glow or its smoke.
const gpu: Record<string, number> = {}
const variants: [string, string, boolean, Record<string, number | boolean>, Record<string, number>][] = [
  ["high", "none", false, {}, {}], ["high", "flare", true, {}, {}], ["high", "no-light", true, { power: 0 }, {}], ["high", "no-mist", true, { fog: 0, glow: 0 }, {}],
  ["low", "none", false, {}, {}], ["low", "flare", true, {}, {}],
]
// Settle each tier before timing it, then time every variant twice, interleaved, and keep the faster.
for (const [tier, name, lit, look, fxs] of [...variants, ...variants]) {
  await page.evaluate(({ x, z, yaw, fx, fz, lit, tier, look, fxs }) => {
    woods.quality.setMode(tier, false)
    Object.assign(woods.flares.look, { shadows: true, fog: 2, glow: 1, power: 4 }, look)
    Object.assign(woods.flares.settings, { smoke: 1 }, fxs)
    woods.state.flares.list.length = 0
    woods.setPose(x, z, yaw, -0.18)
    if (lit) woods.layFlare(x + fx * 5, z + fz * 5, 30, yaw + 1.2)
  }, { ...at, lit, tier, look, fxs })
  await run(3)
  const m = await page.evaluate(() => woods.measure(24))
  const ms = Math.round((m?.median ?? -1) * 1000) / 1000, key = `${tier}-${name}`
  gpu[key] = Math.min(gpu[key] ?? Infinity, ms)
}
await page.evaluate(() => { Object.assign(woods.flares.look, { shadows: true, fog: 2, glow: 1, power: 4 }); woods.flares.settings.smoke = 1 })
console.log("gpu ms", gpu)

// ── 3. sound ───────────────────────────────────────────────────────────────────────────────────────────────────
await clear()
await page.evaluate(({ x, z, yaw }) => { woods.setPose(x, z, yaw, 0.1); (woods.state as unknown as { players: { id: number; flares: number }[] }).players.find((p) => p.id === 0)!.flares = 1; woods.audio.tape = [] }, at)
await page.evaluate(() => woods.hold("KeyQ", true))
await run(2.5)
await page.evaluate(() => woods.hold("KeyQ", false))
await run(5)
const tape = await page.evaluate(() => { const t = woods.audio.tape!; woods.audio.tape = null; return t })

async function render(name: string, t: readonly TapeFrame[], secs: number, opts: Parameters<W["audio"]["renderTape"]>[3] = {}) {
  const b64 = await page.evaluate(async ({ t, secs, opts }) => {
    const buf = await woods.audio.renderTape(t, woods.world, secs, opts)
    const n = buf.length, ch = buf.numberOfChannels
    const pcm = new Int16Array(n * ch)
    const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c))
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) pcm[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(data[c]![i]! * 32767)))
    const bytes = new Uint8Array(pcm.buffer)
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }, { t: t as TapeFrame[], secs, opts })
  const pcm = Buffer.from(b64, "base64")
  const header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(48000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
  const wav = join(out, `${name}.wav`)
  writeFileSync(wav, Buffer.concat([header, pcm]))
  return wav
}
const levels: Record<string, { I: number; Mmax: number; peak: number }> = {}
async function measure(name: string, wav: string) {
  const log = await $`ffmpeg -hide_banner -nostats -i ${wav} -filter_complex ebur128=peak=sample:metadata=0 -f null -`.quiet().nothrow()
  const text = log.stderr.toString()
  const num = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : NaN }
  const mmax = Math.max(...[...text.matchAll(/M:\s*(-?[\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite))
  levels[name] = { I: num(/I:\s*(-?[\d.]+) LUFS/), Mmax: mmax, peak: num(/Peak:\s*(-?[\d.]+) dBFS/) }
  await $`ffmpeg -v error -y -i ${wav} -c:a libmp3lame -b:a 160k ${join(out, `${name}.mp3`)}`.quiet()
}
const secs = Math.min(8, tape.at(-1)?.t ?? 8)
await measure("strike-throw-flares", await render("strike-throw-flares", tape, secs, { solo: "flares", footsteps: false, voices: false }))
await measure("strike-throw-woods", await render("strike-throw-woods", tape, secs, { footsteps: false, voices: false }))
const l = tape[0]!.l
for (const d of [1, 5, 30, 120]) {
  const frames: TapeFrame[] = Array.from({ length: 4 * 30 }, (_, i) => ({ t: i / 30, sim: 100 + i / 30, l, steps: [], distant: [], burning: [{ id: 1, x: l.x - Math.sin(l.yaw) * d, y: l.y - 1.2, z: l.z - Math.cos(l.yaw) * d, level: 1 }] }))
  await measure(`hiss-${d}m`, await render(`hiss-${d}m`, frames, 4, { solo: "flares", footsteps: false, voices: false }))
}
await $`rm -f ${out}/*.wav`.quiet().nothrow()
writeFileSync(join(out, "flare-proof.json"), JSON.stringify({ spot: at, shots, gpu, levels, errors }, null, 1))
console.log(JSON.stringify({ gpu, levels, errors: errors.slice(0, 8) }, null, 1))
server.stop()
await budget.exit(0)
