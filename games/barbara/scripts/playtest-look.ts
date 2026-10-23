// Headless, muted proof stills for the Oct 22 playtest fixes (run after `bun run build`, through HiveMind browser):
//   bun scripts/playtest-look.ts [--scenario trail,own,map,edge,start] [--out dir] [--tag name] [--variants base,fog,taa,none]
// trail: you stand still, your light off, and a friend 10 m ahead sweeps their beam across the view at 3 rad/s; the
//   still is taken mid-sweep. own: you turn at 2.5 rad/s with your light on, mid-turn. Variants (trail/own only) turn off
//   the fog's history (fog), TAA (taa) or both (none: the trail-free reference for the same moment).
// map: a friend 3 m away reading the map, realistic and blocky. edge: the world's north edge from 25 m and 4 m in your
//   light, and the held map raised next to it. start: a fresh page, frames before and after Play.
// sign: Kit's Scrawl spot (spawn towards the car, a flare by it, torch off/on) and a POSTED and a STATE FOREST sign at
//   4 m and 15 m in your torch, dark, and with a flare beside it.
// Writes PNGs and `playtest-look.json` to the out dir (repo-root captures/playtest-look by default).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/playtest-look"))
const scenarios = arg("--scenario", "trail,own,map,edge,start").split(",")
const variants = arg("--variants", "base").split(",")
const tag = arg("--tag", "")
const [w, h] = arg("--size", "1280x720").split("x").map(Number) as [number, number]

type P = { id: number; x: number; z: number; vx: number; vz: number; yaw: number; pitch: number; light: boolean; mapRaise: number; bot: boolean }
type Woods = {
  frames: number; paused: boolean; autoplay: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  hold(code: string, down: boolean): void
  step(ms: number): void
  state: { t: number; flares: { list: unknown[] }; players: P[]; brains: { id: number; mode: string; timer: number; heading: number; sweep: number }[] }
  world: { params: { half: number }; camp: { x: number; z: number; spawn: { x: number; z: number; yaw: number } } }
  camera: { flashlight: boolean; yaw: number; pitch: number }
  renderer: { setTemporal(s: unknown): void }
  view: { forest: { debug: Record<string, boolean> } }
  friends: { realistic: boolean; realPeople(): { drawn: number } }
  look: Record<string, unknown>
  debug: { dark: number[] }
  layFlare(x: number, z: number, age?: number, yaw?: number): number
  night: { layout: { clues: { kind: string; x: number; z: number }[] } }
}
declare const woods: Woods

mkdirSync(out, { recursive: true })
const root = resolve(arg("--dist", "dist/arcade/barbara"))
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
const report: Record<string, unknown> = {}
const errors: string[] = []

async function open(query = "?quality=high"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${server.port}${prefix}${query}`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 180000 })
  return page
}
const hideShell = (page: Page) => page.evaluate(() => { for (const el of document.querySelectorAll<HTMLElement>(".arcade-shell, #hud, #objective, #subs")) el.style.display = "none" })
/** Steps `n` frames at 60 fps on the synthetic clock, `each` before every step, yielding so GPU readbacks land. */
async function steps(page: Page, n: number, each = "") {
  await page.evaluate(async ({ n, each }) => {
    const f = each ? new Function("i", each) as (i: number) => void : null
    for (let i = 0; i < n; i++) { f?.(i); woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
  }, { n, each })
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}${tag}.png` })

/** Bots away from the scene, waiting, so only the staged friend is in view. */
const clearBots = `for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999 } for (const p of woods.state.players) if (p.bot) { p.x = woods.world.camp.x; p.z = woods.world.camp.z }`

/** `--pin`: hold the exposure still, so variants compare pixel for pixel. */
const pin = process.argv.includes("--pin")
async function variant(page: Page, v: string) {
  await page.evaluate(({ v, pin }) => {
    if (pin) woods.look.autoExposure = false
    woods.view.forest.debug.beamMotion = v !== "nomotion"
    woods.renderer.setTemporal(v === "taa" || v === "none" ? null : { mode: "taa", renderScale: 0.67, sharpen: 0.15, history: 0.9 })
  }, { v, pin })
}

if (scenarios.includes("trail") || scenarios.includes("own")) {
  const page = await open()
  await hideShell(page)
  await page.evaluate(() => { woods.paused = true })
  for (const v of variants) {
    await variant(page, v)
    if (scenarios.includes("trail")) {
      // Out over the lake's mist: a friend 9 m to your left on the shore swings their beam out across the water in
      // front of you, left to right, while your own light is off.
      await page.evaluate((clear) => {
        new Function(clear)()
        const l = (woods as unknown as { world: { lake: { x: number; z: number; rz: number } } }).world.lake
        const x = l.x + 18, z = l.z - l.rz + 1
        woods.setPose(x, z, Math.PI, 0.0)
        woods.camera.flashlight = false
        const p = woods.state.players.find((q) => q.bot)!, b = woods.state.brains.find((q) => q.id === p.id)!
        p.x = x + 9; p.z = z - 1; b.heading = Math.PI - 0.2; b.sweep = 0
      }, clearBots)
      const f = Number(arg("--fps", "60")), turn = Number(arg("--turn", "0")), own = process.argv.includes("--own-light")
      await page.evaluate((own) => { woods.camera.flashlight = own }, own)
      await steps(page, 120, "woods.state.brains[0].sweep = 0")
      // 3 rad/s (a quick swing), heading π − 0.2 → π − 1.1 over 0.3 s, then 0.1 s more for the strip. `--turn` turns
      // your view too (rad/s), `--own-light` keeps your own light on.
      for (const k of [0, 1, 2]) {
        await page.evaluate(async ({ n, f, turn }) => {
          for (let i = 0; i < n; i++) { const b = woods.state.brains[0]!; b.sweep = 0; b.heading -= 3 / f; woods.camera.yaw -= turn / f; woods.step(1000 / f); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) }
        }, { n: Math.round((k ? 0.05 : 0.3) * f), f, turn })
        await shot(page, `trail-${v}${k ? `-${k}` : ""}`)
      }
    }
    if (scenarios.includes("own")) {
      await page.evaluate((clear) => {
        new Function(clear)()
        const c = woods.world.camp, x = c.x + 10, z = c.z - 70
        woods.setPose(x, z, 0.9, -0.08)
        woods.camera.flashlight = true
      }, clearBots)
      await steps(page, 120)
      await steps(page, 22, "woods.camera.yaw -= 2.5 / 60")
      await shot(page, `own-${v}`)
    }
  }
  await page.close()
}

if (scenarios.includes("live")) for (const v of variants) {
  // Real time (the page's own rAF clock and frame dropping), not the synthetic step: a friend at the lake shore swings
  // their beam back and forth at 3 rad/s while you stand still; every presented frame for 3 s via the screencast.
  const page = await open()
  await hideShell(page)
  await variant(page, v)
  await page.evaluate(({ clear, own }) => {
    new Function(clear)()
    const l = (woods as unknown as { world: { lake: { x: number; z: number; rz: number } } }).world.lake
    const x = l.x + 18, z = l.z - l.rz + 1
    woods.setPose(x, z, Math.PI, 0.0)
    woods.camera.flashlight = own
    const p = woods.state.players.find((q) => q.bot)!
    p.x = x + 9; p.z = z - 1
    woods.autoplay = true
    const t0 = performance.now()
    const tick = () => {
      const t = (performance.now() - t0) / 1000, b = woods.state.brains[0]!
      b.sweep = 0; b.mode = "wait"; b.timer = 99
      b.heading = Math.PI - 0.65 - 0.55 * Math.sin(t * 5.4)
      requestAnimationFrame(tick)
    }
    tick()
  }, { clear: clearBots, own: !process.argv.includes("--own-off") })
  await page.waitForTimeout(2000)
  const cdp = await page.context().newCDPSession(page)
  let n = 0
  cdp.on("Page.screencastFrame", async (e: { data: string; sessionId: number }) => {
    await Bun.write(`${out}/live-${v}${tag}-${String(n++).padStart(3, "0")}.jpg`, Buffer.from(e.data, "base64"))
    await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId })
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 })
  await page.waitForTimeout(3000)
  await cdp.send("Page.stopScreencast")
  report[`live-${v}`] = { frames: n, drawn: await page.evaluate(() => woods.frames) }
  await page.close()
}

if (scenarios.includes("sweep")) {
  // Your own light swung off a trunk 1.6 m away onto the woods behind it (2.5 rad/s): a strip of frames as it leaves.
  const page = await open()
  await hideShell(page)
  await page.evaluate(() => { woods.paused = true })
  for (const v of variants) {
    await variant(page, v)
    await page.evaluate(({ clear, v }) => {
      new Function(clear)()
      woods.look.bounce = v === "nobounce" ? 0 : 1
      const c = woods.world.camp
      const t = (woods as unknown as { world: { trees: { x: number; z: number; radius: number }[] } }).world.trees.filter((t) => t.radius > 0.28).sort((a, b) => Math.hypot(a.x - c.x - 10, a.z - c.z + 70) - Math.hypot(b.x - c.x - 10, b.z - c.z + 70))[0]!
      // Stand 1.6 m south of the trunk, looking at it, then turn right (yaw decreasing) away from it.
      woods.setPose(t.x, t.z + t.radius + 1.6, 0, -0.1)
      woods.camera.flashlight = true
    }, { clear: clearBots, v })
    await steps(page, 120)
    for (const k of [0, 1, 2, 3]) {
      await steps(page, k ? 3 : 12, "woods.camera.yaw -= 2.5 / 60")
      await shot(page, `sweep-${v}-${k}`)
    }
  }
  await page.close()
}

if (scenarios.includes("map")) {
  // A friend reading the map 1.9 m away, lit by your torch: from the front (turned three-quarters to you) and from
  // over their right shoulder; realistic and blocky.
  const page = await open()
  await hideShell(page)
  await page.evaluate(() => { woods.paused = true })
  for (const real of [true, false]) {
    for (const view of ["front", "shoulder"] as const) {
      await page.evaluate(({ real, clear, view }) => {
        new Function(clear)()
        woods.friends.realistic = real
        const c = woods.world.camp, fx = c.x + 2, fz = c.z - 42
        const p = woods.state.players.find((q) => q.bot)!, b = woods.state.brains.find((q) => q.id === p.id)!
        p.x = fx; p.z = fz; p.vx = 0; p.vz = 0
        // The friend faces +x turned 0.5 rad towards the camera; yaw such that viewDir(yaw) = (-sin, -cos).
        b.heading = view === "front" ? -Math.PI / 2 - 0.5 : -Math.PI / 2; b.sweep = 0
        const eye = view === "front" ? { x: fx + 1.75, z: fz + 0.75 } : { x: fx - 0.55, z: fz + 0.6 }
        const toF = { x: fx + (view === "front" ? 0 : 0.45) - eye.x, z: fz - eye.z }
        woods.setPose(eye.x, eye.z, Math.atan2(-toF.x, -toF.z), view === "front" ? -0.22 : -0.6)
        woods.camera.flashlight = true
      }, { real, clear: clearBots, view })
      const hold = "const p = woods.state.players.find((q) => q.bot); p.mapRaise = 1; p.vx = 0; p.vz = 0; const b = woods.state.brains.find((q) => q.id === p.id); b.sweep = 0; b.mode = 'wait'; b.timer = 99"
      for (let k = 0; k < 40; k++) {
        await steps(page, 6, hold)
        if (!real || await page.evaluate(() => woods.friends.realPeople().drawn > 0)) break
        await page.waitForTimeout(250)
      }
      await steps(page, 60, hold)
      await shot(page, `map-${real ? "realistic" : "blocky"}-${view}`)
    }
  }
  await page.close()
}

if (scenarios.includes("edge")) {
  const page = await open()
  await hideShell(page)
  await page.evaluate(() => { woods.paused = true })
  // Distances from the boundary fence (3 m inside the map's edge).
  for (const d of [14, 3]) {
    await page.evaluate(({ d, clear }) => {
      new Function(clear)()
      const half = woods.world.params.half, c = woods.world.camp
      woods.setPose(c.x + 30, -half + 3 + d, 0.15, d > 10 ? -0.06 : -0.12)
      woods.camera.flashlight = true
    }, { d, clear: clearBots })
    await steps(page, 120)
    await shot(page, `edge-${d}m`)
  }
  await page.evaluate(() => woods.hold("KeyG", true))
  await steps(page, 90)
  await shot(page, "edge-map")
  await page.evaluate(() => woods.hold("KeyG", false))
  await page.close()
}

if (scenarios.includes("sign")) {
  // Kit's Scrawl (Oct 22): from the spawn towards her car in the lot with a flare burning by it, your torch off then on;
  // then a fence sign 4 m away in your torch, with it off, and with a flare burning a metre in front of it; then 15 m.
  const page = await open()
  await hideShell(page)
  await page.evaluate(() => { woods.paused = true })
  const clearFlares = "woods.state.flares.list.length = 0"
  const stage = async (name: string, fn: string, light: boolean, n = 150) => {
    await page.evaluate(({ fn, light, clear, clearFlares }) => {
      new Function(clear)(); new Function(clearFlares)(); new Function(fn)()
      woods.camera.flashlight = light
    }, { fn, light, clear: clearBots, clearFlares })
    await steps(page, n)
    await shot(page, name)
  }
  // South of the middle cabin, 15 m from the car, the flare 4 m short of it (as Kit threw his).
  const car = `const c = woods.night.layout.clues.find((q) => q.kind === "car"), s = { x: woods.world.camp.x + 9, z: woods.world.camp.z - 12 }
    const dx = c.x - s.x, dz = c.z - s.z, l = Math.hypot(dx, dz)
    woods.setPose(s.x, s.z, Math.atan2(-dx, -dz) + 0.15, -0.05)
    woods.layFlare(s.x + (dx / l) * (l - 4), s.z + (dz / l) * (l - 4), 15)`
  await stage("sign-car-dark", car, false)
  await stage("sign-car-torch", car, true)
  // The fence's north side (z = −L, signs face +z); post 63 carries a POSTED sign, post 57 the state forest's.
  const sign = (post: number, d: number, flare: boolean) => `const L = woods.world.params.half - 3, n = Math.ceil(2 * L / 3.5), x = -L + 2 * L * ${post} / n
    woods.setPose(x + 0.3, -L + ${d}, 0, ${d > 6 ? -0.02 : -0.08})
    ${flare ? "woods.layFlare(x + 0.8, -L + 1.2, 15)" : ""}`
  for (const [post, kind] of [[63, "posted"], [57, "forest"]] as const) {
    await stage(`sign-${kind}-torch`, sign(post, 4, false), true)
    await stage(`sign-${kind}-dark`, sign(post, 4, false), false)
    await stage(`sign-${kind}-flare`, sign(post, 4, true), false)
    await stage(`sign-${kind}-flare-15m`, sign(post, 15, true), false)
    await stage(`sign-${kind}-torch-15m`, sign(post, 15, false), true)
  }
  await page.close()
}

if (scenarios.includes("start")) {
  // A fresh page as a player meets it: the woods behind the title, then Play (here: autoplay) and the first seconds.
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  page.on("pageerror", (e) => errors.push(e.message))
  const t0 = Date.now()
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 180000 })
  const timeline: unknown[] = []
  const probe = async (label: string) => {
    timeline.push({ label, ms: Date.now() - t0, ...(await page.evaluate(() => ({ frames: woods.frames, people: woods.friends.realPeople().drawn, players: woods.state.players.length }))) })
    await page.screenshot({ path: `${out}/start-${label}${tag}.png` })
  }
  await probe("title")
  await hideShell(page)
  await page.evaluate(() => { woods.autoplay = true })
  for (const ms of [50, 250, 750, 1500, 3000, 6000]) {
    await page.waitForTimeout(ms - (timeline.length > 1 ? [50, 250, 750, 1500, 3000, 6000][timeline.length - 2]! : 0))
    await probe(`play-${ms}ms`)
  }
  report.start = timeline
  report.marks = await page.evaluate(() => performance.getEntriesByType("mark").map((m) => [m.name, Math.round(m.startTime)]))
  await page.close()
}

report.errors = errors
writeFileSync(`${out}/playtest-look${tag}.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
server.stop(true)
