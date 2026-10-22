// Camera lab proof (headless, muted; run after `bun run build`, through HiveMind):
//   bun scripts/camera-lab.ts [--out <dir>] [--size 1600x900] [--only look-eyes,fx-flare] [--measure]
// Stages the camera lab's fixed night spot (`?lab=camera`), finds the moment a friend's sweep crosses the lens, then
// from that same moment captures every camera look and an off/on pair for each realism effect (pairs that need motion
// share the same scripted pan or focus pull). `--measure` adds paired whole-frame GPU medians (Eyes, then each look and
// effect, interleaved). Writes PNGs and camera-lab.json.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods-camera"))
const [w, h] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const only = arg("--only", "").split(",").filter(Boolean)
const measure = process.argv.includes("--measure")
const rounds = Number(arg("--rounds", "3"))

type Motion = "still" | "pan" | "focus"
type Shot = { id: string; look: string; effect?: string; motion: Motion; label: string }
const LOOKS = ["eyes", "bodycam", "nightshot", "phone", "vhs"]
const EFFECTS: [string, string, Motion][] = [
  ["compression", "Compression starvation", "pan"],
  ["focusHunt", "Autofocus hunting", "focus"],
  ["sensorGain", "Sensor gain in the dark", "pan"],
  ["pwm", "LED PWM banding", "still"],
  ["flare", "Lens flare from torches", "still"],
  ["dirt", "Lens dirt in bright light", "still"],
  ["condensation", "Condensation", "still"],
  ["eyeshine", "Eyeshine", "still"],
]
const shots: Shot[] = [
  ...LOOKS.map((look) => ({ id: `look-${look}`, look, motion: "still" as Motion, label: look })),
  ...EFFECTS.flatMap(([effect, label, motion]) => [
    { id: `fx-${effect}-off`, look: "eyes", motion, label: `${label}: off` },
    { id: `fx-${effect}-on`, look: "eyes", effect, motion, label: `${label}: on` },
  ]),
]

type Api = {
  frames: number; paused: boolean; autoplay: boolean
  step(ms: number): void
  measure(n?: number): Promise<{ median: number } | null>
  camera: { yaw: number; pitch: number; flashlight: boolean }
  panel: { sync(): void }
  state: { players: { id: number; x: number; z: number }[] }
  cameraLook: {
    apply(id: string): void
    settings: Record<string, unknown>
    artifacts: Record<string, unknown>
    lens: { input: { sources: { intensity: number }[] }; state: unknown }
    eyeshine: { clear(): void }
    showEyes(): void
    stage(): boolean
  }
}
declare const woods: Api

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
const browser = await chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&lab=camera`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Api }).woods && woods.frames > 2 && woods.state.players.length >= 3, null, { timeout: 180000 }).catch((e) => { console.log(errors.join("\n")); throw e })

/** Re-stage at the fixed spot, reset every camera setting to `look`, then run `frames` 60 fps steps. */
async function stage(look: string, effect: string | undefined, motion: Motion, frames: number) {
  await page.evaluate(async ({ look, effect, motion, frames }) => {
    woods.paused = true
    woods.cameraLook.stage()
    // Same sim clock every shot: wind, mist and the friends' sweeps line up.
    ;(woods.state as unknown as { t: number }).t = 100
    woods.cameraLook.eyeshine.clear()
    woods.cameraLook.apply(look)
    if (effect === "eyeshine") woods.cameraLook.settings.eyeshine = true
    else if (effect) woods.cameraLook.artifacts[effect] = true
    woods.panel.sync()
    const yaw0 = woods.camera.yaw, pitch0 = woods.camera.pitch
    for (let i = 0; i < frames; i++) {
      const left = frames - i
      if (effect === "eyeshine" && i === frames - 150) woods.cameraLook.showEyes()
      // Pan: a 70°/s turn right over the last 0.4 s. Focus: the beam on the ground at your feet, then up to the far
      // trees 0.3 s before the frame.
      if (motion === "pan" && left <= 24) woods.camera.yaw = yaw0 - (24 - left) * (70 / 60) * (Math.PI / 180)
      if (motion === "focus") woods.camera.pitch = left > 90 ? pitch0 : left > 18 ? -0.75 : pitch0 + 0.04
      woods.step(1000 / 60)
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0))
    }
  }, { look, effect, motion, frames })
}

// Find the step count (2–10 s in) when the far friend's beam is most nearly on the lens: every shot uses it.
const best = await page.evaluate(async () => {
  woods.paused = true
  woods.cameraLook.stage()
  ;(woods.state as unknown as { t: number }).t = 100
  woods.cameraLook.apply("eyes")
  woods.cameraLook.artifacts.flare = true
  let top = { frame: 300, glare: 0 }
  for (let i = 0; i < 600; i++) {
    woods.step(1000 / 60)
    const g = woods.cameraLook.lens.input.sources[0]?.intensity ?? 0
    if (i >= 120 && g > top.glare) top = { frame: i + 1, glare: g }
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0))
  }
  woods.cameraLook.apply("eyes")
  return top
})
console.log("moment", JSON.stringify(best))

// Today is the same pixels: Eyes through the (inactive) chain, again, and with no final pass at all.
for (const [id, chain] of [["control-eyes-again", true], ["control-no-final-pass", false]] as const) {
  if (only.length && !only.includes(id)) continue
  await page.evaluate((chain) => { const r = (woods as unknown as { renderer: { setFinalPass(p: unknown): void } }).renderer; r.setFinalPass(chain ? (woods.cameraLook as unknown as { chain: unknown }).chain : null) }, chain)
  await stage("eyes", undefined, "still", best.frame)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: `${out}/${id}.png` })
  await page.evaluate(() => (woods as unknown as { renderer: { setFinalPass(p: unknown): void } }).renderer.setFinalPass((woods.cameraLook as unknown as { chain: unknown }).chain))
}

const results: Record<string, unknown> = {}
for (const s of shots) {
  if (only.length && !only.includes(s.id)) continue
  await stage(s.look, s.effect, s.motion, best.frame)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: `${out}/${s.id}.png` })
  results[s.id] = await page.evaluate(() => {
    const look = woods.cameraLook as unknown as { lens: { input: unknown; state: unknown; data: Float32Array }; eyeshine: { sightings: { x: number; y: number; z: number }[] }; blocked(a: readonly number[], b: readonly number[]): boolean }
    const eye = (woods.camera as unknown as { eye: number[] }).eye
    return { lens: look.lens.state, input: look.lens.input, uniform: Array.from(look.lens.data.slice(0, 28)).map((v) => +v.toFixed(3)), eyes: look.eyeshine.sightings.map((s) => ({ ...s, blocked: look.blocked(eye, [s.x, s.y, s.z]), d: Math.hypot(s.x - eye[0]!, s.z - eye[2]!) })) }
  })
  console.log(s.id, JSON.stringify(results[s.id]))
}

// Paired GPU: each candidate against Eyes at the same moment, interleaved, `rounds` times.
const gpu: Record<string, number[]> = {}
if (measure) {
  const candidates = [...LOOKS.map((l) => ({ id: `look-${l}`, look: l, effect: undefined as string | undefined })), ...EFFECTS.map(([e]) => ({ id: `fx-${e}`, look: "eyes", effect: e }))]
  for (let r = 0; r < rounds; r++) for (const c of candidates) {
    for (const [key, look, effect] of [["eyes", "eyes", undefined], [c.id, c.look, c.effect]] as const) {
      await stage(look, effect, "still", 90)
      const ms = await page.evaluate(async () => (await woods.measure(16))?.median ?? -1)
      ;(gpu[key] ??= []).push(ms)
      if (key !== "eyes") (gpu[`${key}:base`] ??= []).push(gpu.eyes!.at(-1)!)
    }
    console.log("gpu", c.id, gpu[c.id]!.at(-1), "eyes", gpu.eyes!.at(-1))
  }
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
const deltas = Object.fromEntries(Object.keys(gpu).filter((k) => k !== "eyes" && !k.endsWith(":base")).map((k) => {
  const d = gpu[k]!.map((v, i) => v - gpu[`${k}:base`]![i]!)
  return [k, { median: +median(gpu[k]!).toFixed(3), base: +median(gpu[`${k}:base`]!).toFixed(3), delta: +median(d).toFixed(3), deltas: d.map((x) => +x.toFixed(3)) }]
}))
writeFileSync(`${out}/camera-lab.json`, JSON.stringify({ size: [w, h], moment: best, shots: shots.map((s) => ({ ...s, file: `${s.id}.png` })), results, gpu: deltas, errors }, null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
await browser.close()
server.stop(true)
