// Headless, muted stills of a friend reading the map 1.9 m away with their torch on (run after `bun run build`, HiveMind
// browser): bun scripts/friend-halo.ts [--variants base,glare0,air0,bloom0] [--out dir] [--tag name]
// Each variant turns one layer off (glare0: their lens sprite, air0: their beam in the fog, bloom0: bloom and halation,
// own0: your own torch; face, last: the friend 2.5 m ahead aiming at you, whose lens must still flare)
// and is compared with the same frame with their torch hidden (`woods.debug.dark`): the light their torch adds, and how
// much of it lands more than 0.35 m (on screen, at their distance) from their lens, the halo round their body.
// Realistic and blocky. Writes PNGs and friend-halo.json to the out dir (repo-root captures/friend-halo by default).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/friend-halo"))
const variants = arg("--variants", "base,glare0,air0,bloom0").split(",")
const tag = arg("--tag", "")
const W = 1280, H = 720

type P = { id: number; x: number; z: number; vx: number; vz: number; yaw: number; pitch: number; mapRaise: number; bot: boolean }
type Woods = {
  frames: number; paused: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  state: { players: P[]; brains: { id: number; mode: string; timer: number; heading: number; sweep: number }[] }
  world: { camp: { x: number; z: number } }
  camera: { flashlight: boolean }
  view: { forest: { debug: Record<string, boolean> } }
  friends: { realistic: boolean; realPeople(): { drawn: number } }
  look: Record<string, unknown>
  debug: { dark: number[] }
  trace(): void
  traced(): { id: number; axis: number[] | null }[]
}
declare const woods: Woods

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
await using budget = browserBudget()
const browser = await budget.chromium.launch({ timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const errors: string[] = []
const page = await browser.newPage({ viewport: { width: W, height: H } })
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 120000 })
await page.evaluate(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".arcade-shell, #hud, #objective, #subs, #goal, #prompt, #toast")) el.style.display = "none"
  woods.paused = true
  woods.look.autoExposure = false
})

/** Steps `n` frames holding the friend still with the map up; returns the frame's linear luminance (320×180). */
async function frame(n: number, dark: boolean, png: string | null): Promise<Float32Array> {
  const b64 = await page.evaluate(async ({ n, dark }) => {
    const p = woods.state.players.find((q) => q.bot)!
    woods.debug.dark = dark ? [p.id] : []
    for (let i = 0; i < n; i++) {
      p.mapRaise = (window as unknown as { __face?: boolean }).__face ? 0 : 1; p.vx = 0; p.vz = 0
      const b = woods.state.brains.find((q) => q.id === p.id)
      if (b) { b.sweep = 0; b.mode = "wait"; b.timer = 99 } else { p.yaw = Math.PI; p.pitch = 0.2 }
      woods.step(1000 / 60)
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0))
    }
    const src = document.querySelector<HTMLCanvasElement>("#view")!
    const c = document.createElement("canvas"); c.width = 320; c.height = 180
    const g = c.getContext("2d", { willReadFrequently: true })!
    g.drawImage(src, 0, 0, 320, 180)
    const d = g.getImageData(0, 0, 320, 180).data
    const y = new Float32Array(320 * 180)
    const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
    for (let i = 0; i < y.length; i++) y[i] = 0.2126 * lin(d[i * 4]!) + 0.7152 * lin(d[i * 4 + 1]!) + 0.0722 * lin(d[i * 4 + 2]!)
    const u = new Uint8Array(y.buffer)
    let s = ""
    for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192))
    return btoa(s)
  }, { n, dark })
  if (png) await page.screenshot({ path: png })
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  return new Float32Array(bytes.buffer)
}

const report: Record<string, unknown> = {}
for (const real of [true, false]) {
  await page.evaluate(({ real }) => {
    for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999 }
    for (const p of woods.state.players) if (p.bot) { p.x = woods.world.camp.x; p.z = woods.world.camp.z }
    woods.friends.realistic = real
    const c = woods.world.camp, fx = c.x + 2, fz = c.z - 42
    const p = woods.state.players.find((q) => q.bot)!, b = woods.state.brains.find((q) => q.id === p.id)!
    p.x = fx; p.z = fz; p.vx = 0; p.vz = 0
    b.heading = -Math.PI / 2 - 0.5; b.sweep = 0
    const eye = { x: fx + 1.75, z: fz + 0.75 }
    woods.setPose(eye.x, eye.z, Math.atan2(-(fx - eye.x), -(fz - eye.z)), -0.22)
    woods.camera.flashlight = true
  }, { real })
  for (let k = 0; k < 40; k++) {
    await frame(6, false, null)
    if (!real || await page.evaluate(() => woods.friends.realPeople().drawn > 0)) break
    await page.waitForTimeout(250)
  }
  await frame(60, false, null)
  for (const v of variants) {
    await page.evaluate((v) => {
      const L = woods.look as Record<string, unknown>
      const w = window as unknown as { __look?: Record<string, unknown> }
      w.__look ??= { ...L }
      Object.assign(L, w.__look, { autoExposure: false })
      const D = woods.view.forest.debug
      const layer = v.replace(/^face-?/, "")
      D.lensGlare = layer !== "glare0"; D.friendAir = layer !== "air0"
      if (layer === "bloom0") { L.bloom = 0; L.halation = 0 }
      if (layer === "veil0") L.glare = 0
      woods.camera.flashlight = layer !== "own0"
      const w2 = window as unknown as { __face?: boolean }
      w2.__face = v.startsWith("face")
      if (w2.__face) {
        // The same friend 2.5 m ahead aiming their torch straight at you: the lens must still flare over their body.
        const c = woods.world.camp, x = c.x + 2, z = c.z - 46
        const p = woods.state.players.find((q) => q.bot)!, b = woods.state.brains.find((q) => q.id === p.id)!
        woods.setPose(x, z, 0, 0)
        p.x = x; p.z = z - 2.5
        // Brainless, the sim steps the friend on their own yaw and pitch: aimed at your eye from the hip.
        const w3 = window as unknown as { __brain?: unknown }
        w3.__brain = b
        woods.state.brains.splice(woods.state.brains.indexOf(b), 1)
      }
    }, v)
    if (v.startsWith("face")) await frame(60, false, null)
    const name = `${real ? "realistic" : "blocky"}-${v}${tag}`
    const lit = await frame(30, false, `${out}/${name}.png`)
    const dark = await frame(30, true, v === "base" ? `${out}/${real ? "realistic" : "blocky"}-dark${tag}.png` : null)
    // The friend's torch's added light; its peak marks their lens/map, the halo is what lands far from it.
    const add = lit.map((v, i) => Math.max(0, v - dark[i]!))
    let peak = 0, pi = 0, total = 0
    for (let i = 0; i < add.length; i++) { total += add[i]!; if (add[i]! > peak) { peak = add[i]!; pi = i } }
    const px = pi % 320, py = Math.floor(pi / 320)
    let far = 0
    // At 1.9 m with a 60° vertical field, 0.35 m ≈ 0.35 / (2 · 1.9 · tan 30°) · 180 ≈ 29 px.
    for (let i = 0; i < add.length; i++) if (Math.hypot((i % 320) - px, Math.floor(i / 320) - py) > 29) far += add[i]!
    report[name] = { added: +total.toFixed(3), farShare: +(far / Math.max(total, 1e-9)).toFixed(3), far: +far.toFixed(3), peak: +peak.toFixed(3), at: [px, py] }
    console.log(name, JSON.stringify(report[name]))
    if (v.startsWith("face")) await page.evaluate(() => { const w = window as unknown as { __brain?: Woods["state"]["brains"][number] }; if (w.__brain) woods.state.brains.push(w.__brain); w.__brain = undefined })
  }
}
report.errors = errors
writeFileSync(`${out}/friend-halo${tag}.json`, JSON.stringify(report, null, 1))
server.stop(true)
await budget.finish()
