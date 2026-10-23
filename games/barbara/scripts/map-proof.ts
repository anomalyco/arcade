// Headless, muted proof of the held map (run after `bun run build`, through HiveMind --kind browser):
//   bun scripts/map-proof.ts [--out <dir>] [--size 1600x900] [--stills a,b] [--clip] [--measure]
// Stills: Today and Held at three hold distances, and a torch sweep across the held sheet. Clip: 5 s at 30 fps of the
// map coming up, the beam passing over it and the needle settling (PNG frames, muxed by ffmpeg when present).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods-map"))
const [w, h] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const only = arg("--stills", "")
const clip = process.argv.includes("--clip")
const measure = process.argv.includes("--measure")
/** `--vary key=a|b|c[,key2=...]`: one held still per combination (first key varies fastest), for tuning in one job. */
const vary = arg("--vary", "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return { key: k!, values: v!.split("|").map((x) => (Number.isFinite(Number(x)) ? Number(x) : x)) } })
const sets = Object.fromEntries(arg("--set", "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, Number.isFinite(Number(v)) ? Number(v) : v] }))

type Woods = {
  frames: number; paused: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  hold(code: string, down: boolean): void
  step(ms: number): void
  state: { t: number; tapes: { id: number; tree: number; x: number; y: number; z: number; yaw: number; by: number; at: number }[]; nextTape: number; players: { id: number; x: number; z: number; map: { trail: number[]; markers: number[]; tapes: number[]; heard: { from: number; trail: number[] }[] } }[]; brains: { id: number; mode: string; timer: number }[] }
  world: { camp: { x: number; z: number; spawn: { x: number; z: number; yaw: number } }; markers: { id: number; x: number; z: number }[]; trail: { points: [number, number][] } }
  camera: { flashlight: boolean; yaw: number; pitch: number }
  held: { settings: Record<string, number | string>; sweep: [number, number]; debug: { raise: number; needle: number; timings: unknown; active: boolean }; layers(): Promise<Record<string, string>> }
  addTape(id: number): void
  measure(n?: number): Promise<{ median: number } | null>
}
declare const woods: Woods

/** A believable map: a walked path from camp out to marker 1 and partway back, a friend's copied path, two finds. */
const story = async (page: Page) => page.evaluate(() => {
  const s = woods.state.players[0]!, c = woods.world.camp
  const m1 = woods.world.markers[0]!, m2 = woods.world.markers[1]!
  const path: number[] = []
  const leg = (ax: number, az: number, bx: number, bz: number, wob: number) => {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 3)
    for (let i = 0; i <= n; i++) { const t = i / n; path.push(ax + (bx - ax) * t + Math.sin(t * 9 + ax) * wob, az + (bz - az) * t + Math.cos(t * 7 + az) * wob) }
  }
  leg(c.x, c.z, c.x - 60, c.z + 20, 4); leg(c.x - 60, c.z + 20, m1.x, m1.z, 6); leg(m1.x, m1.z, c.x - 90, c.z - 60, 5); leg(c.x - 90, c.z - 60, c.x - 30, c.z - 120, 6); leg(c.x - 30, c.z - 120, c.x - 8, c.z - 46, 4)
  s.map.trail = path
  s.map.markers = [m1.id]
  const fr: number[] = []
  const fleg = (ax: number, az: number, bx: number, bz: number) => { const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 3); for (let i = 0; i <= n; i++) { const t = i / n; fr.push(ax + (bx - ax) * t + Math.sin(t * 5) * 5, az + (bz - az) * t) } }
  fleg(c.x, c.z, c.x + 30, c.z - 90); fleg(c.x + 30, c.z - 90, m2.x, m2.z)
  s.map.heard = [{ from: 101, trail: fr }]
  s.map.markers.push(m2.id)
  // Three flagging tapes along the walk (pink crayon crosses on the sheet).
  s.map.tapes = []
  for (const k of [0.18, 0.42, 0.7]) {
    const i = Math.floor((path.length / 2) * k) * 2
    const trees = (woods.world as unknown as { trees: { id: number; x: number; y: number; z: number }[] }).trees
    let tr = trees[0]!
    for (const q of trees) if (Math.hypot(q.x - path[i]!, q.z - path[i + 1]!) < Math.hypot(tr.x - path[i]!, tr.z - path[i + 1]!)) tr = q
    const t = { id: woods.state.nextTape++, tree: tr.id, x: tr.x, y: tr.y + 1.4, z: tr.z, yaw: 0, by: s.id, at: 0 }
    woods.state.tapes.push(t)
    s.map.tapes.push(t.id)
  }
})

let defaults: Record<string, number | string> = {}
const POSE = { dx: -8, dz: -46, yaw: 0.35, pitch: -0.12 }
const pose = async (page: Page, extra: Record<string, number | string> = {}) => page.evaluate(({ P, extra }) => {
  const c = woods.world.camp.spawn
  woods.setPose(c.x + P.dx, c.z + P.dz, P.yaw, P.pitch)
  woods.camera.flashlight = true
  for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999 }
  for (const p of woods.state.players.slice(1)) { p.x = c.x + 60; p.z = c.z + 60 }
  Object.assign(woods.held.settings, extra)
  woods.held.sweep = [0, 0]
}, { P: POSE, extra: { ...defaults, ...sets, ...extra } })

const settle = async (page: Page, n: number) => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
}, n)

const stills: Record<string, (page: Page) => Promise<void>> = {
  down: async (page) => { await pose(page, { mapStyle: "held" }); await page.evaluate(() => woods.hold("KeyG", false)) },
  today: async (page) => { await pose(page, { mapStyle: "today" }); await page.evaluate(() => woods.hold("KeyG", true)) },
  held: async (page) => { await pose(page, { mapStyle: "held" }); await page.evaluate(() => woods.hold("KeyG", true)) },
  near: async (page) => { await pose(page, { mapStyle: "held", distance: 0.25 }); await page.evaluate(() => woods.hold("KeyG", true)) },
  far: async (page) => { await pose(page, { mapStyle: "held", distance: 0.4 }); await page.evaluate(() => woods.hold("KeyG", true)) },
  sweepA: async (page) => { await pose(page, { mapStyle: "held" }); await page.evaluate(() => { woods.hold("KeyG", true); woods.held.sweep = [-0.32, -0.3] }) },
  sweepB: async (page) => { await pose(page, { mapStyle: "held" }); await page.evaluate(() => { woods.hold("KeyG", true); woods.held.sweep = [0.3, 0.32] }) },
  compass: async (page) => { await pose(page, { mapStyle: "held", distance: 0.22, drop: -0.04, side: 0.1, tilt: 36, aimU: 0.3, aimV: 0.64, vmFov: 42 }); await page.evaluate(() => woods.hold("KeyG", true)) },
}

mkdirSync(out, { recursive: true })
const root = resolve("dist/arcade/barbara")
const prefix = "/arcade/barbara/"
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
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=${arg("--quality", "high")}`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 180000 }).catch((e) => { console.log(errors.join("\n")); throw e })
await page.evaluate((sets) => { document.getElementById("start")!.style.display = "none"; document.getElementById("hud")!.style.display = "none"; for (const id of ["objective", "subs", "toast"]) { const el = document.getElementById(id); if (el) el.style.visibility = "hidden" }; woods.paused = true; Object.assign(woods.held.settings, sets) }, sets)
await story(page)
defaults = await page.evaluate(() => ({ ...woods.held.settings }))
const dumpCanvases = async () => {
  const c = await page.evaluate(() => woods.held.layers())
  for (const [k, v] of Object.entries(c)) if (v) writeFileSync(`${out}/layer-${k}.png`, Buffer.from(v.split(",")[1]!, "base64"))
}
const report: Record<string, unknown> = {}
for (const [name, setup] of Object.entries(stills)) {
  if ((clip || vary.length) && !only) break
  if (only && !only.split(",").includes(name)) continue
  await page.evaluate(() => woods.hold("KeyG", false))
  await settle(page, 60)
  await setup(page)
  await settle(page, 150)
  // Printing runs on wall time, not the stepped clock. Its last texture may
  // arrive after settling; draw again once the overlay can actually render.
  if (name !== "down" && name !== "today") {
    await page.waitForFunction(() => woods.held.debug.active, null, { timeout: 60000 })
    await settle(page, 60)
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.screenshot({ path: `${out}/${name}.png` })
  const info = await page.evaluate(() => woods.held.debug)
  console.log(name, JSON.stringify(info))
  report[name] = info
  if (measure) report[`${name}.gpu`] = (await page.evaluate(() => woods.measure(16)))?.median
  if (measure) console.log(name, "gpu ms", report[`${name}.gpu`])
}
if (vary.length) {
  const combos: Record<string, number | string>[] = [{}]
  for (const v of vary) { const next: Record<string, number | string>[] = []; for (const c of combos) for (const x of v.values) next.push({ ...c, [v.key]: x }); combos.splice(0, combos.length, ...next) }
  for (const c of combos) {
    const name = "vary-" + Object.entries(c).map(([k, v]) => `${k}=${v}`).join("_")
    await page.evaluate(() => woods.hold("KeyG", false))
    await settle(page, 40)
    await pose(page, { mapStyle: "held", ...c })
    await page.evaluate(() => woods.hold("KeyG", true))
    await settle(page, 150)
    await page.screenshot({ path: `${out}/${name}.png` })
    console.log(name, JSON.stringify(await page.evaluate(() => woods.held.debug)))
  }
}
if (clip) {
  page.setDefaultTimeout(120000)
  mkdirSync(`${out}/clip`, { recursive: true })
  await page.evaluate(() => woods.hold("KeyG", false))
  await pose(page, { mapStyle: "held" })
  await settle(page, 90)
  // 5 s at 30 fps: 0.4 s still, raise (G), the beam sweeps across and back, the view turns a little and settles.
  for (let f = 0; f < 150; f++) {
    const t = f / 30
    await page.evaluate((t) => {
      if (t >= 0.4) woods.hold("KeyG", true)
      const s = Math.max(0, Math.min(1, (t - 1.6) / 2.2))
      const ease = s * s * (3 - 2 * s)
      woods.held.sweep = [Math.sin(ease * Math.PI * 1.5) * 0.3, -0.25 + ease * 0.4]
      // A small turn at 1.2 s sets the needle swinging; it settles by the end.
      if (t > 1.1 && t < 1.5) woods.camera.yaw += 0.012
      woods.step(1000 / 60); woods.step(1000 / 60)
    }, t)
    await page.screenshot({ path: `${out}/clip/${String(f).padStart(4, "0")}.png`, timeout: 120000 })
  }
  const ff = Bun.spawnSync(["ffmpeg", "-y", "-framerate", "30", "-i", `${out}/clip/%04d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", `${out}/raise.mp4`], { stdout: "ignore", stderr: "pipe" })
  console.log("ffmpeg", ff.exitCode, ff.exitCode ? ff.stderr.toString().slice(-400) : "")
}
if (process.argv.includes("--layers")) await dumpCanvases()
writeFileSync(`${out}/map-proof.json`, JSON.stringify({ report, errors }, null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 12))
await browser.close()
server.stop(true)
