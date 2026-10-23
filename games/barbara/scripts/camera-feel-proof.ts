// Camera looks and camera feel, as pictures (headless, muted; run after `bun run build`, through HiveMind browser):
//   bun scripts/camera-feel-proof.ts stills [--out <dir>] [--size 1600x900] [--runs eyes,bodycam-ir]
//   bun scripts/camera-feel-proof.ts clip [--out <dir>] [--size 960x540] [--seconds 9] [--runs eyes-off,eyes-on]
// `stills`: every camera look at the camera lab's spot (70 m north of camp, your torch and two friends'), on the same
// sim clock, with the page's HUD showing so its goal line and prompts can be read; plus the body cam with your torch
// off (infrared), the Hi8 zoomed in and the VHS look with the map up. `clip`: the same walk on the old path, walking,
// running, a jump, a stop and two fast turns, recorded four times (eyes and body cam, each with the camera feel off and
// on) as JPEG frames at 30 fps, `clip-<run>/`; ffmpeg tiles them into one comparison video.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

const mode = process.argv[2] === "clip" ? "clip" : "stills"
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/barbara-camera"))
const [w, h] = arg("--size", mode === "clip" ? "960x540" : "1600x900").split("x").map(Number) as [number, number]
const seconds = Number(arg("--seconds", "9"))
const only = arg("--runs", "").split(",").filter(Boolean)

type Woods = {
  frames: number; paused: boolean; autoplay: boolean
  step(ms: number): void
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  hold(code: string, down: boolean): void
  jump(): void
  world: { camp: { x: number; z: number }; trail: { points: (readonly [number, number])[] } }
  state: { t: number; players: { id: number; x: number; z: number; yaw: number; mapRaise: number }[] }
  settings: Record<string, number | boolean>
  camera: { flashlight: boolean; yaw: number; pitch: number; resetWalk(): void }
  panel: { visible: boolean; toggle(): void; sync(): void }
  feel: { settings: Record<string, number | boolean>; reset(): void; trace: Record<string, number> }
  cameraLook: { apply(id: string): void; stage(): boolean; settings: Record<string, unknown>; artifacts: Record<string, unknown>; filter: { settings: Record<string, unknown> }; eyeshine: { clear(): void } }
}
declare const woods: Woods

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

await using budget = browserBudget()
const browser = await budget.chromium.launch({ headless: true, timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page: Page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&lab=camera`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2 && woods.state.players.filter((p) => p.id >= 100).length >= 2, null, { timeout: 120000 }).catch((e) => { console.log(errors.join("\n")); throw e })
await page.evaluate(() => { woods.paused = true; if (woods.panel.visible) woods.panel.toggle() })
const frame2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const steps = (n: number) => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
}, n)
const FEEL_OFF = { bob: 0, nod: 0, landJolt: 0, strafeLean: 0, turnRoll: 0, turnLag: 0, sprintFov: 0, shake: 0, blur: 0, handSway: 0, breath: 0, kick: 0 }
const defaults = await page.evaluate(() => ({ ...woods.feel.settings }))
const summary: Record<string, unknown> = { mode, size: [w, h] }

if (mode === "stills") {
  // The game's HUD stays (goal line, key strip): every look must keep them readable. The Lab hint is hidden.
  await page.addStyleTag({ content: "#tuning { display: none !important; }" })
  const shots: [string, string, (() => Promise<void>) | null][] = [
    ["eyes", "eyes", null], ["bodycam", "bodycam", null],
    ["bodycam-ir", "bodycam", async () => { await page.evaluate(() => { woods.camera.flashlight = false }); await steps(90) }],
    ["nightshot", "nightshot", null], ["phone", "phone", null], ["vhs", "vhs", null], ["hi8", "hi8", null],
    ["hi8-zoom", "hi8", async () => { await page.evaluate(() => woods.hold("Mouse2", true)); await steps(150); await page.evaluate(() => woods.hold("Mouse2", false)) }],
    ["trail", "trail", null],
    ["vhs-map", "vhs", async () => { await page.evaluate(() => woods.hold("KeyG", true)); await steps(60) }],
  ]
  for (const [name, look, then] of shots) {
    if (only.length && !only.includes(name)) continue
    await page.evaluate((look) => {
      woods.cameraLook.stage()
      woods.state.t = 100
      woods.cameraLook.eyeshine.clear()
      woods.cameraLook.apply(look)
      woods.panel.sync()
      woods.autoplay = true
    }, look)
    await steps(180)
    if (then) await then()
    await frame2()
    await page.screenshot({ path: `${out}/look-${name}.png` })
    await page.evaluate(() => { woods.hold("KeyG", false); woods.hold("Mouse2", false); woods.camera.flashlight = true })
    console.log("shot", name)
  }
  summary.stills = shots.map(([n]) => `look-${n}.png`)
} else {
  // The old path's second bend, heading on up it: open enough to walk, run and jump without a trunk.
  const start = await page.evaluate(() => {
    const [a, b] = [woods.world.trail.points[1]!, woods.world.trail.points[2]!]
    return { x: a[0], z: a[1], yaw: Math.atan2(-(b[0] - a[0]), -(b[1] - a[1])) }
  })
  const runs: [string, string, boolean][] = [["eyes-off", "eyes", false], ["eyes-on", "eyes", true], ["bodycam-off", "bodycam", false], ["bodycam-on", "bodycam", true]]
  const traces: Record<string, unknown[]> = {}
  for (const [name, look, on] of runs) {
    if (only.length && !only.includes(name)) continue
    const dir = `${out}/clip-${name}`
    mkdirSync(dir, { recursive: true })
    await page.evaluate(({ look, on, start, off, defaults }) => {
      woods.settings.botCount = 0
      woods.cameraLook.apply(look)
      if (!on && look === "bodycam") {
        // The body cam as it was before this change: the 140° fisheye night preset, no IR switch, no turn blur.
        Object.assign(woods.cameraLook.filter.settings, { bodyLens: 140, bodyFisheye: 1, bodyMount: 0.35, bodyExposure: 1, bodyRolling: 1, bodyCompression: 0.9 })
        Object.assign(woods.cameraLook.artifacts, { compressionAmount: 0.8, gainAmount: 0.7, flareAmount: 0.7 })
        woods.cameraLook.settings.irAuto = false
      }
      Object.assign(woods.feel.settings, defaults, on ? {} : off)
      woods.setPose(start.x, start.z, start.yaw, -0.12)
      woods.state.t = 100
      woods.camera.flashlight = true
      woods.autoplay = true
    }, { look, on, start, off: FEEL_OFF, defaults })
    await steps(60)
    await page.addStyleTag({ content: "body > *:not(#view) { visibility: hidden !important; }" })
    const n = seconds * 30, trace: unknown[] = []
    for (let i = 0; i < n; i++) {
      const t = i / 30
      // 0–2 s walk, 2–4.2 s run (a jump at 3.3 s), 4.2–5.6 s stop, 5.6–6.4 s a fast turn right, 6.6–7.4 s back left.
      const row = await page.evaluate(({ t, yaw0 }) => {
        woods.hold("KeyW", t < 4.2)
        woods.hold("ShiftLeft", t >= 2 && t < 4.2)
        if (Math.abs(t - 3.3) < 1 / 60) woods.jump()
        const turn = (a: number, b: number, deg: number) => t >= a && t < b ? Math.sin(((t - a) / (b - a)) * Math.PI) ** 2 * deg : 0
        const rate = turn(5.6, 6.4, -2.6) + turn(6.6, 7.4, 2.6)
        for (let k = 0; k < 2; k++) { woods.camera.yaw += rate / 60; woods.step(1000 / 60) }
        void yaw0
        return { t, ...woods.feel.trace }
      }, { t, yaw0: start.yaw })
      trace.push(row)
      await frame2()
      await page.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 })
    }
    await page.evaluate(() => { woods.hold("KeyW", false); woods.hold("ShiftLeft", false) })
    traces[name] = trace
    console.log("clip", name, dir)
  }
  summary.start = start
  summary.traces = traces
}
writeFileSync(`${out}/camera-feel-${mode}.json`, JSON.stringify({ ...summary, errors: errors.slice(0, 20) }, null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
server.stop(true)
await budget.finish()
