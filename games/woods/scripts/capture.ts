// Headless, muted stills of the production build at scripted poses (run after `bun run build`, through HiveMind):
//   bun scripts/capture.ts [--out <dir>] [--shots name,name] [--size 1600x900]
// Each shot sets the pose, holds keys or edits the state through `window.woods`, steps the sim on a synthetic clock and
// screenshots the canvas. Writes PNGs and a JSON of timings and errors to the out dir ($LEASE_OUT by default).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/woods"))
const [w, h] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const only = arg("--shots", "")
const sets = Object.fromEntries(arg("--set", "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, v === "true" ? true : v === "false" ? false : Number(v)] }))
const tag = arg("--tag", "")
mkdirSync(out, { recursive: true })
const root = resolve("dist/arcade/woods")
const prefix = "/arcade/woods/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })

type Woods = {
  frames: number; paused: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  hold(code: string, down: boolean): void
  addTape(id: number, fx?: number, fz?: number): void
  step(ms: number): void
  state: { t: number; players: { id: number; x: number; z: number; yaw: number; pitch: number; light: boolean }[]; brains: { id: number; mode: string; timer: number; heading: number }[]; tapes: unknown[] }
  world: { camp: { x: number; z: number; spawn: { x: number; z: number; yaw: number } }; trees: { id: number; x: number; z: number; radius: number }[]; markers: { x: number; z: number }[]; ridgeLight: { x: number; z: number } }
  settings: Record<string, number | boolean>
  camera: { flashlight: boolean }
}
declare const woods: Woods

const shots: Record<string, (page: Page) => Promise<void>> = {
  // Default view out of camp at spawn.
  camp: async (page) => { await page.evaluate(() => { const s = woods.world.camp.spawn; woods.setPose(s.x, s.z, s.yaw, 0.02); woods.camera.flashlight = false }) },
  // Looking back at camp from the woods: the lit mess hall through the trunks.
  hall: async (page) => { await page.evaluate(() => { const c = woods.world.camp; woods.setPose(c.x - 30, c.z - 75, Math.PI + 0.25, 0.02) }) },
  // A friend's beam through mist far off: you dark, a friend 35 m away sweeping their light, another signalling.
  beam: async (page) => {
    await page.evaluate(() => {
      const c = woods.world.camp, x = c.x + 10, z = c.z - 70
      woods.setPose(x, z, 0, 0.05)
      woods.camera.flashlight = false
      const fr = woods.state.players.slice(1)
      const place = (i: number, dx: number, dz: number, yaw: number, pitch: number, mode: string) => {
        const p = fr[i]; const b = woods.state.brains[i]
        if (!p || !b) return
        p.x = x + dx; p.z = z + dz; b.mode = mode; b.timer = 99; b.heading = yaw
      }
      place(0, -9, -38, 0.7, -0.2, "wait")
      place(1, 14, -60, 0, 1.3, "signal")
      place(2, 30, -25, 1.9, -0.2, "wait")
      woods.state.brains[0]!.timer = 12
      woods.state.brains[2]!.timer = 12
    })
  },
  // A friend 22 m ahead pointing their light straight up.
  signal: async (page) => {
    await page.evaluate(() => {
      const c = woods.world.camp, x = c.x + 10, z = c.z - 70
      woods.setPose(x, z, 0, 0.25)
      woods.camera.flashlight = false
      const p = woods.state.players[1]!, b = woods.state.brains[0]!
      p.x = x + 3; p.z = z - 22; b.mode = "signal"; b.timer = 99
      for (const o of woods.state.brains.slice(1)) o.mode = "wait", o.timer = 99
    })
  },
  // Mid-forest, looking north towards the ridge mast's red light.
  ridge: async (page) => {
    await page.evaluate(() => {
      const r = woods.world.ridgeLight
      woods.setPose(r.x - 40, r.z + 150, Math.atan2(-(r.x - (r.x - 40)), -(r.z - (r.z + 150))), 0.12)
      woods.camera.flashlight = false
      for (const b of woods.state.brains) b.mode = "wait", b.timer = 99
    })
    // The beacon blinks: land on its bright phase.
    await page.evaluate(() => { for (let i = 0; i < 400 && (i < 60 || Math.abs((woods.state.t % 1.6) / 1.6 - 0.15) > 0.02); i++) woods.step(1000 / 60) })
  },
  // A survey marker in the beam.
  marker: async (page) => {
    await page.evaluate(() => {
      const m = woods.world.markers[0]!
      woods.setPose(m.x, m.z + 5, 0, -0.3)
      for (const b of woods.state.brains) b.mode = "wait", b.timer = 99
    })
  },
  // Looking back down a tape trail: tie tapes along a line north of camp, then stand at the end and look back.
  trail: async (page) => {
    await page.evaluate(() => {
      // Walk a line north from the camp's edge, tying a tape every ~10 m on the trunk nearest the line, then turn round.
      const c = woods.world.camp, sx = c.x - 26, sz = c.z - 38
      woods.state.tapes.length = 0
      const used: number[] = []
      let end = sz
      for (let k = 1; k <= 8; k++) {
        const tz = sz - k * 10, tx = sx + (k % 2 ? 1.6 : -1.6)
        const t = woods.world.trees.filter((t) => !used.includes(t.id) && Math.hypot(t.x - tx, t.z - tz) < 6).sort((a, b) => Math.hypot(a.x - tx, a.z - tz) - Math.hypot(b.x - tx, b.z - tz))[0]
        if (!t) continue
        used.push(t.id)
        woods.addTape(t.id, 0, 1)
        end = t.z - 4
      }
      woods.setPose(sx, end, Math.PI, -0.05)
      for (const b of woods.state.brains) b.mode = "wait", b.timer = 99
    })
  },
  // The map raised next to the camp, flashlight on it.
  map: async (page) => { await page.evaluate(() => { const s = woods.world.camp.spawn; woods.setPose(s.x, s.z - 40, 0.4, -0.1); woods.hold("KeyG", true) }) },
}

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const page = await browser.newPage({ viewport: { width: w, height: h } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 60000 })
await page.evaluate((sets) => { document.getElementById("start")!.style.display = "none"; woods.paused = true; Object.assign(woods.settings, sets) }, sets)
const timing: Record<string, number> = {}
for (const [name, setup] of Object.entries(shots)) {
  if (only && !only.split(",").includes(name)) continue
  await page.evaluate(() => { woods.hold("KeyG", false); woods.camera.flashlight = true })
  await setup(page)
  const t0 = Date.now()
  // Settle the walk, TAA and fog history at 60 fps.
  await page.evaluate((name) => { for (let i = 0; i < (name === "ridge" ? 0 : 90); i++) woods.step(1000 / 60) }, name)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  timing[name] = Date.now() - t0
  console.log(name, JSON.stringify(await page.evaluate(() => ({ debug: (woods as unknown as { debug: unknown }).debug, players: woods.state.players.map((p) => [p.id, Math.round(p.x), Math.round(p.z), +p.pitch.toFixed(2), p.light]) }))))
  await page.screenshot({ path: `${out}/${name}${tag}.png` })
  console.log(`${name}: ${timing[name]} ms for 90 steps`)
}
writeFileSync(`${out}/capture.json`, JSON.stringify({ timing, errors }, null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
await browser.close()
server.stop(true)
