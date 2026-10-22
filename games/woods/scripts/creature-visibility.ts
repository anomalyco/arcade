// Headless, muted measurement of whether the creature reads (run after `bun run build`, through HiveMind, never aloud):
//   bun scripts/creature-visibility.ts [--out <dir>] [--only signal-60,camp-45] [--size 1600x900]
// For each backdrop (a friend's signal, a friend's beam aimed back at you, the mess hall's lit windows from outside camp,
// and today's sideways beam as the baseline) at 45, 60 and 80 m, it stages the scene from the shared world, runs the
// same sighting three times on a synthetic 30 fps clock (as the game draws it, with the creature drawn white for its
// mask, and without it for the pixels behind it) and scores the silhouette from the rendered frames, in display
// luminance: the covered pixels whose backdrop is lit (≥ 0.06), their mean drop and Weber contrast. A frame reads when
// at least 12 lit pixels are covered and they drop by ≥ 0.02 and ≥ 25% (the bar Astra's 60 m signal check uses); a
// sighting reads when at least 3 frames (0.1 s) do. Writes visibility.json, a still at its best frame plus the frames
// just before and after, and a clip with sound per backdrop.
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { chromium } from "playwright-core"
import { trunkBetween, type CreatureEvent } from "../shared/creature"
import { EYE_HEIGHT } from "../shared/sim"
import { isDeepWater, lakeDistance, makeWorld, standHeight, type WoodsWorld } from "../shared/world"
import type { TapeFrame } from "../src/audio"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/creature-vis"))
const [W, H] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const only = arg("--only", "").split(",").filter(Boolean)
/** `--pick signal-60=2`: take that scene's third clear staging instead of its first (foliage the trunk test can't see). */
const picks = new Map(arg("--pick", "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, Number(v)] as const }))
const FPS = 30, TRIGGER = 8, FRAMES = 44, DUR = 0.9, SPEED = 11
mkdirSync(out, { recursive: true })
const tmp = join(process.env.TMPDIR ?? "/tmp", `woods-creature-vis-${process.pid}`)
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

// ── staging, in the shared world ────────────────────────────────────────────────────────────────────────────────
const world: WoodsWorld = makeWorld()
type Kind = "signal" | "aimed" | "camp" | "side"
type Scene = {
  name: string; kind: Kind; cross: number; torch: boolean
  you: [number, number]; light: [number, number, number]; friend?: [number, number]; friendAim?: number
  event: CreatureEvent; yaw: number; pitch: number
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
function blocked(ax: number, az: number, bx: number, bz: number): boolean {
  if (trunkBetween(world, ax, az, bx, bz, 0.35)) return true
  for (const b of world.buildings) {
    if (b.kind === "dock" || b.kind === "canoe") continue
    const [x0, z0, x1, z1] = b.rect
    for (let k = 0.04; k < 0.97; k += 0.02) { const x = ax + (bx - ax) * k, z = az + (bz - az) * k; if (x > x0 && x < x1 && z > z0 && z < z1) return true }
  }
  return false
}
const ok = (x: number, z: number) => Math.abs(x) < world.params.half - 8 && Math.abs(z) < world.params.half - 8 && !isDeepWater(world, x, z) && lakeDistance(world.lake, x, z) > 1.05
const inCamp = (x: number, z: number) => Math.hypot(x - world.camp.x, z - world.camp.z) < world.camp.radius + 4

function stage(name: string, kind: Kind, cross: number, torch: boolean): Scene | null {
  let skip = picks.get(name) ?? 0
  for (const behind of [20, 14, 28, 36]) for (const s of stageAt(name, kind, cross, torch, cross + behind)) if (skip-- <= 0) return s
  return null
}
function* stageAt(name: string, kind: Kind, cross: number, torch: boolean, L: number): Generator<Scene> {
  const tries: { you: [number, number]; light: [number, number, number]; friend?: [number, number]; friendAim?: number }[] = []
  if (kind === "camp") {
    const mess = world.buildings.find((b) => b.kind === "mess-hall")!
    const mx = (mess.rect[0] + mess.rect[2]) / 2, mz = (mess.rect[1] + mess.rect[3]) / 2
    for (const l of world.lamps.filter((l) => l.kind === "window")) for (let a = 0; a < 72; a++) {
      const ang = (a / 72) * Math.PI * 2, x = l.x + Math.cos(ang) * L, z = l.z + Math.sin(ang) * L
      // The face the window is on looks towards you.
      if ((l.x - mx) * (x - l.x) + (l.z - mz) * (z - l.z) <= 0) continue
      tries.push({ you: [x, z], light: [l.x, l.y, l.z] })
    }
  } else {
    for (let x = -170; x <= 170; x += 6) for (let z = -170; z <= 170; z += 6) for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2, fx = x + Math.cos(ang) * L, fz = z + Math.sin(ang) * L
      const back = Math.atan2(-(x - fx), -(z - fz))
      const gy = standHeight(world, fx, fz)
      if (kind === "side") {
        // Beam across your view: crossing in front of its lit air 8 m out from the lens.
        const aim = back + Math.PI / 2, ax = fx - Math.sin(aim) * 8, az = fz - Math.cos(aim) * 8
        tries.push({ you: [x, z], light: [ax, gy + 1.3, az], friend: [fx, fz], friendAim: aim })
      } else tries.push({ you: [x, z], light: [fx, gy + (kind === "signal" ? 2.4 : 1.4), fz], friend: [fx, fz], friendAim: back })
    }
  }
  for (const t of tries) {
    const [x, z] = t.you
    if (!ok(x, z) || (t.friend && !ok(...t.friend))) continue
    if (kind === "camp" ? inCamp(x, z) : inCamp(x, z) || (t.friend && inCamp(...t.friend))) continue
    const [lx, , lz] = t.light, d = Math.hypot(lx - x, lz - z), ux = (lx - x) / d, uz = (lz - z) / d
    const cx = x + ux * cross, cz = z + uz * cross
    if (Math.hypot(cx - world.camp.x, cz - world.camp.z) < world.camp.radius * 0.8) continue
    if (!ok(cx, cz) || blocked(x, z, lx, lz) || (t.friend && blocked(x, z, ...t.friend))) continue
    // The middle of its run is in sight; it runs left to right across your view.
    const len = SPEED * DUR, px = -uz, pz = ux
    const x0 = cx - px * len * 0.5, z0 = cz - pz * len * 0.5, x1 = cx + px * len * 0.5, z1 = cz + pz * len * 0.5
    if (!ok(x0, z0) || !ok(x1, z1) || blocked(x, z, cx - px * 2, cz - pz * 2) || blocked(x, z, cx + px * 2, cz + pz * 2)) continue
    const eye = standHeight(world, x, z) + EYE_HEIGHT
    const yaw = Math.atan2(-ux, -uz), pitch = clamp(Math.atan2(t.light[1] + (kind === "signal" ? 1 : 0) - eye, d), -0.2, 0.2)
    const r = (v: number) => Math.round(v * 100) / 100
    yield { name, kind, cross, torch, ...t, yaw, pitch, event: { kind: "creature", at: 0, x0: r(x0), z0: r(z0), x1: r(x1), z1: r(z1), dur: DUR, seed: 0.5, seq: -7 } }
  }
  return null
}

const scenes: Scene[] = []
for (const kind of ["signal", "aimed", "camp"] as const) for (const c of [45, 60, 80]) scenes.push(stage(`${kind}-${c}`, kind, c, false)!)
scenes.push(stage("side-60", "side", 60, false)!)
if (process.argv.includes("--plan")) { for (const s of scenes) console.log(s ? `${s.name} you ${s.you.map(Math.round)} light ${s.light.map(Math.round)} path ${s.event.x0},${s.event.z0} → ${s.event.x1},${s.event.z1}` : "none"); process.exit(0) }
const run = scenes.filter((s, i) => { if (!s) console.log("no staging for", i); return s && (!only.length || only.includes(s.name)) })

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────
const root = resolve("dist/arcade/woods"), prefix = "/arcade/woods/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })
type P = { id: number; x: number; z: number; vx: number; vz: number; light: boolean }
type Woods = {
  frames: number; paused: boolean; autoplay: boolean; time: number; settings: Record<string, number | boolean>
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  camera: { yaw: number; pitch: number; flashlight: boolean }
  state: { t: number; players: P[]; brains: { id: number; mode: string; timer: number; heading: number; sweep: number }[] }
  creatures: { start(e: CreatureEvent, now: number): void; debugFlash: number }
  audio: { tape: TapeFrame[] | null; event(e: CreatureEvent): void; renderTape(tape: readonly TapeFrame[], world: unknown, seconds: number): Promise<AudioBuffer> }
  view: { forest: { renderer: { resetTemporalHistory(): void }; resetExposure(): void } }
}
declare const woods: Woods
const browser = await chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
console.log("page loading")
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 180000 })
await page.evaluate(() => {
  document.getElementById("start")!.style.display = "none"
  for (const id of ["hud", "prompt", "toast"]) document.getElementById(id)!.style.visibility = "hidden"
  woods.paused = true; woods.autoplay = true
  // No battery dips: the backdrop must hold still between the passes.
  woods.settings.flashFlicker = 0
})

/** Holds the scene: you at your spot, the friend at theirs with their beam as staged, everyone else far behind. */
async function hold(s: Scene) {
  await page.evaluate((s) => {
    const me = woods.state.players[0]!
    Object.assign(me, { x: s.you[0], z: s.you[1], vx: 0, vz: 0 })
    woods.camera.yaw = s.yaw; woods.camera.pitch = s.pitch; woods.camera.flashlight = s.torch
    woods.state.brains.forEach((b, i) => {
      const p = woods.state.players.find((q) => q.id === b.id)!
      if (i === 0 && s.friend) {
        Object.assign(p, { x: s.friend[0], z: s.friend[1], vx: 0, vz: 0, light: true })
        if (s.kind === "signal") { b.mode = "found"; b.timer = 24; b.sweep = 0; b.heading = s.friendAim! }
        // "wait" sweeps the beam by sin(0.45·sweep)·0.55 in yaw and −0.22 + sin(0.7·sweep)·0.12 in pitch: at
        // sweep 2.244 the pitch is −0.10 (about 6° down) and the yaw offset 0.468, taken off the heading.
        else { b.mode = "wait"; b.timer = 99; b.sweep = 2.244; b.heading = s.friendAim! - Math.sin(2.244 * 0.45) * 0.55 }
      } else {
        Object.assign(p, { x: Math.max(-190, Math.min(190, s.you[0] + Math.sin(s.yaw) * 150 + i * 3)), z: Math.max(-190, Math.min(190, s.you[1] + Math.cos(s.yaw) * 150)), vx: 0, vz: 0 })
        b.mode = "wait"; b.timer = 99
      }
    })
  }, s)
}

async function pass(s: Scene, mode: "black" | "white" | "bare", dir: string, tape: boolean) {
  const white = mode === "white"
  console.log(`  ${s.name} ${mode} pass, ${Math.round(performance.now() / 1000)} s`)
  mkdirSync(dir, { recursive: true })
  await hold(s)
  // Same clock every pass, so fog, wind and sway behind the figure match between them.
  await page.evaluate(() => { woods.state.t = 1000 })
  await page.evaluate((s) => { woods.setPose(s.you[0], s.you[1], s.yaw, s.pitch); woods.view.forest.renderer.resetTemporalHistory(); woods.view.forest.resetExposure() }, s)
  for (let i = 0; i < 180; i++) {
    await hold(s)
    await page.evaluate(() => woods.step(1000 / 60))
    if (i % 6 === 5) await page.evaluate(() => new Promise((r) => setTimeout(r, 0)))
  }
  await page.evaluate(({ white, tape }) => { woods.creatures.debugFlash = white ? 1 : 0; woods.audio.tape = tape ? [] : null }, { white, tape })
  for (let f = 0; f < FRAMES; f++) {
    await hold(s)
    if (f === TRIGGER && mode !== "bare") await page.evaluate((e) => { const ev = { ...e, at: woods.state.t }; woods.creatures.start(ev, woods.time); woods.audio.event(ev) }, s.event)
    await page.evaluate((ms) => woods.step(ms), 1000 / FPS)
    for (let k = 0; ; k++) {
      try { await page.screenshot({ path: join(dir, `${String(f).padStart(3, "0")}.png`), timeout: 90000 }); break }
      catch (e) { if (k >= 2) throw e; console.log("screenshot retry", s.name, f) }
    }
  }
  await page.evaluate(() => { woods.creatures.debugFlash = 0 })
}

/** Display luminance (0..1) of a frame, as gray bytes from ffmpeg. */
async function gray(file: string): Promise<Uint8Array> {
  const r = await $`ffmpeg -v error -i ${file} -f rawvideo -pix_fmt gray -`.quiet()
  return new Uint8Array(r.stdout)
}
const N = W * H

// Grain: the renderer adds sensor noise re-rolled every frame (what you see too), so single pixels can't be compared
// between passes; region means over the covered pixels average it out.
type Frame = { f: number; covered: number; lit: number; behind: number; figure: number; drop: number; weber: number }
const LIT = 0.06, LIT_PX = 12, DROP = 0.02, WEBER = 0.25
const jsonPath = join(out, "visibility.json")
const results: Record<string, unknown> = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")).scenes : {}
const save = () => writeFileSync(jsonPath, JSON.stringify({ size: [W, H], fps: FPS, readBar: { litBehind: LIT, litPixels: LIT_PX, drop: DROP, weber: WEBER, frames: 3 }, scenes: results, errors }, null, 2))
for (const s of run) {
  const dir = join(tmp, s.name)
  await pass(s, "black", join(dir, "fg"), true)
  const tape = await page.evaluate(() => { const t = woods.audio.tape!; woods.audio.tape = null; return t })
  await pass(s, "white", join(dir, "mask"), false)
  await pass(s, "bare", join(dir, "bare"), false)
  // Three passes of the same scene on the same clock: as drawn (black), drawn white (its mask: white minus black),
  // and without it (the pixels behind it in that frame). Outside the mask, the mean black − bare is the passes'
  // brightness offset (exposure), which should be ~0.
  const frames: Frame[] = []
  let offSum = 0, offN = 0
  for (let f = TRIGGER; f < FRAMES; f++) {
    const at = (d: string) => join(dir, d, `${String(f).padStart(3, "0")}.png`)
    const fg = await gray(at("fg")), mk = await gray(at("mask")), bare = await gray(at("bare"))
    let covered = 0, lit = 0, sb = 0, sf = 0
    for (let i = 0; i < N; i++) {
      if (mk[i]! - fg[i]! <= 20) { if ((i & 63) === 0) { offSum += fg[i]! - bare[i]!; offN++ } continue }
      covered++
      const b = bare[i]! / 255
      if (b < LIT) continue
      lit++; sb += b; sf += fg[i]! / 255
    }
    frames.push({ f, covered, lit, behind: lit ? +(sb / lit).toFixed(4) : 0, figure: lit ? +(sf / lit).toFixed(4) : 0, drop: lit ? +((sb - sf) / lit).toFixed(4) : 0, weber: sb > 0 ? +((sb - sf) / sb).toFixed(3) : 0 })
  }
  const on = frames.filter((x) => x.covered > 0), readFrames = frames.filter((x) => x.lit >= LIT_PX && x.drop >= DROP && x.weber >= WEBER)
  const score = (x: Frame) => (x.lit >= LIT_PX ? x.weber * Math.sqrt(x.lit) : -1)
  const best = on.reduce((a, b) => (score(b) > score(a) ? b : a), on[0] ?? frames[0]!)
  const enter = on[0]?.f ?? TRIGGER, exit = on.at(-1)?.f ?? TRIGGER
  const litFrames = on.filter((x) => x.lit >= LIT_PX)
  const summary = {
    kind: s.kind, cross: s.cross, torch: s.torch, light: s.light, you: s.you, friend: s.friend, event: s.event,
    visibleSeconds: +(on.length / FPS).toFixed(2), readSeconds: +(readFrames.length / FPS).toFixed(2), reads: readFrames.length >= 3,
    peak: { frame: best.f, coveredPx: best.covered, litPx: best.lit, behind: best.behind, figure: best.figure, drop: best.drop, weber: best.weber },
    meanLitWeber: litFrames.length ? +(litFrames.reduce((a, x) => a + x.weber, 0) / litFrames.length).toFixed(3) : 0,
    passOffset: offN ? +(offSum / offN / 255).toFixed(4) : 0, frames,
  }
  results[s.name] = summary
  save()
  console.log(s.name, JSON.stringify({ reads: summary.reads, readSeconds: summary.readSeconds, peak: summary.peak, meanLitWeber: summary.meanLitWeber, passOffset: summary.passOffset }))
  // Stills: just before it comes, the best frame, just after; and the clip with its sound.
  const pick = (f: number) => join(dir, "fg", `${String(clamp(f, 0, FRAMES - 1)).padStart(3, "0")}.png`)
  await $`cp ${pick(enter - 1)} ${join(out, `${s.name}-before.png`)}`
  await $`cp ${pick(best.f)} ${join(out, `${s.name}.png`)}`
  await $`cp ${pick(exit + 1)} ${join(out, `${s.name}-after.png`)}`
  const b64 = await page.evaluate(async ({ tape, secs }) => {
    const buf = await woods.audio.renderTape(tape, (woods as unknown as { world: unknown }).world, secs)
    const n = buf.length, chn = buf.numberOfChannels, pcm = new Int16Array(n * chn), data = Array.from({ length: chn }, (_, c) => buf.getChannelData(c))
    for (let i = 0; i < n; i++) for (let c = 0; c < chn; c++) pcm[i * chn + c] = Math.max(-32768, Math.min(32767, Math.round(data[c]![i]! * 32767)))
    const bytes = new Uint8Array(pcm.buffer)
    let str = ""
    for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(str)
  }, { tape, secs: FRAMES / FPS })
  const pcm = Buffer.from(b64, "base64"), header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(48000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
  const wav = join(dir, "clip.wav")
  writeFileSync(wav, Buffer.concat([header, pcm]))
  await $`ffmpeg -v error -y -framerate ${FPS} -i ${join(dir, "fg", "%03d.png")} -i ${wav} -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest ${join(out, `${s.name}.mp4`)}`
  rmSync(dir, { recursive: true, force: true })
}
save()
if (errors.length) console.log("browser messages:", errors.slice(0, 8))
rmSync(tmp, { recursive: true, force: true })
await browser.close()
server.stop(true)

