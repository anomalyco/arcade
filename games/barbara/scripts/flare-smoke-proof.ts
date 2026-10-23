// Headless, muted before/after proof of a road flare's smoke (through HiveMind, never aloud):
//   bun scripts/flare-smoke-proof.ts --before <dist root> --after <dist root> [--out <dir>]
// Each build is a `vite build` output (`dist/arcade/barbara`). For each, a flare burns on the ground with trunks behind
// it; stills from 6 m with its smoke between you and the trunks (and the same frame with the smoke cleared), from 14 m
// off to the side (outside the smoke, and again cleared), and mid-turn with a flare 2.5 m ahead. Numbers (smoke.json):
// - through: where the smoke changes the picture, its mean grey with and without smoke, and how much of the woods'
//   detail behind it shows through (`slope`, the high-pass of the smoky frame regressed on the clear one: physical
//   smoke keeps less than 1, more means it sharpens or lifts what it should hide), and the fine detail the smoke adds
//   (`fine`: soft smoke adds little; aliasing and dither that temporal AA stopped averaging under it add a lot).
// - outside: over the column, the plume's mean grey against the same pixels cleared, and the share it darkens (lit smoke
//   in a lit mist should darken almost none of it).
// - moving: how much the frame's fine noise looks like interleaved gradient noise's lattice (`ign`, the best match of
//   its autocorrelation against IGN's at any scale; 0 is unstructured grain) and the noise level (`hp`).
import { $ } from "bun"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { trunkBetween } from "../shared/creature"
import { isDeepWater, makeWorld, treesNear } from "../shared/world"

await using budget = browserBudget()
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/barbara-flare-smoke"))
mkdirSync(out, { recursive: true })
const prefix = "/arcade/barbara/"

function serve(dir: string) {
  const root = resolve(dir)
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
    const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
    const f = Bun.file(file)
    return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
  } })
}

type W = {
  frames: number; autoplay: boolean; paused: boolean; settings: Record<string, number | boolean | string>
  look: Record<string, number | boolean | string>
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  layFlare(x: number, z: number, age?: number, yaw?: number): number
  camera: { flashlight: boolean; yaw: number; pitch: number }
  state: { flares: { list: unknown[] } }
  flares: { stats(): Record<string, number>; look: Record<string, number | boolean>; settings: Record<string, number>; pool: { count: number } }
  view: { forest: { camera: { exposure: number } } }
}
declare const woods: W

// A flare 6 m ahead with nothing between, and trunks 3 to 14 m behind it, near the line of sight.
const world = makeWorld()
const free = (x: number, z: number) => !isDeepWater(world, x, z) && Math.abs(x) < world.params.half - 20 && Math.abs(z) < world.params.half - 20 && treesNear(world, x, z, 0.8).length === 0
function spot() {
  let best: { x: number; z: number; yaw: number; fx: number; fz: number; behind: number } | null = null
  for (let ox = -60; ox <= 60; ox += 6) for (let oz = -110; oz <= -40; oz += 6) {
    const x = world.camp.x + ox, z = world.camp.z + oz
    if (!free(x, z)) continue
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * Math.PI * 2, fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const px = x + fx * 6, pz = z + fz * 6
      // Room to the side for the outside view, 14 m off square to the line.
      if (!free(px, pz) || !free(px - fz * 14, pz + fx * 14) || trunkBetween(world, x, z, px, pz, 0.3) || trunkBetween(world, px - fz * 14, pz + fx * 14, px, pz, 0.3)) continue
      const behind = treesNear(world, px + fx * 8, pz + fz * 8, 7).filter((t) => {
        const ax = t.x - px, az = t.z - pz, along = ax * fx + az * fz, side = Math.abs(ax * fz - az * fx)
        return along > 3 && along < 14 && side < 2.5
      }).length
      if (behind >= 2 && (!best || behind > best.behind)) best = { x, z, yaw, fx, fz, behind }
    }
  }
  if (!best) throw new Error("no spot")
  return best
}
const at = spot()
console.log("spot", at)

const { chromium } = budget
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] })
const errors: string[] = []
const shots: Record<string, unknown> = {}

async function capture(build: "before" | "after", dir: string) {
  const server = serve(dir)
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on("pageerror", (e) => errors.push(`${build}: ${e}`))
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${build}: ${m.text()}`) })
  await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as unknown as { woods?: W }).woods && woods.frames > 2, null, { timeout: 90000 })
  await page.addStyleTag({ content: "body * { visibility: hidden !important } #view { visibility: visible !important }" })
  const run = (seconds: number) => page.evaluate((s) => { for (let i = 0; i < s * 30; i++) woods.step(1000 / 30) }, seconds)
  const shot = async (name: string) => {
    const file = join(out, `${build}-${name}.png`)
    await page.screenshot({ path: file })
    shots[`${build}-${name}`] = await page.evaluate(() => ({ ...woods.flares.stats(), exposure: Math.round(woods.view.forest.camera.exposure * 1000) / 1000 }))
    console.log(build, name, shots[`${build}-${name}`])
    return file
  }
  // Still air, so the column stands over the flare in both builds.
  await page.evaluate(({ x, z, yaw, fx, fz }) => {
    woods.paused = true
    woods.autoplay = true
    Object.assign(woods.settings, { botCount: 0, creature: "off", distantRate: 0, chatter: 0 })
    woods.camera.flashlight = false
    woods.flares.look.drift = 0
    woods.setPose(x, z, yaw, 0.12)
    woods.layFlare(x + fx * 6, z + fz * 6, 30, yaw + 1.2)
  }, at)
  await run(9)
  await shot("through")
  await page.evaluate(() => { woods.flares.settings.smoke = 0; woods.flares.pool.count = 0 })
  await run(0.7)
  await shot("through-clear")
  await page.evaluate(() => { woods.flares.settings.smoke = 1 })
  await run(9)
  await shot("through-again")
  // Outside the smoke: 14 m off to the side, looking at the column.
  await page.evaluate(({ x, z, fx, fz }) => {
    const px = x + fx * 6, pz = z + fz * 6, sx = px - fz * 14, sz = pz + fx * 14
    woods.setPose(sx, sz, Math.atan2(-(px - sx), -(pz - sz)), 0.1)
  }, at)
  await run(3)
  await shot("outside")
  await page.evaluate(() => { woods.flares.settings.smoke = 0; woods.flares.pool.count = 0 })
  await run(0.7)
  await shot("outside-clear")
  await page.evaluate(() => { woods.flares.settings.smoke = 1 })
  // Mid-turn with a flare 2.5 m ahead (the fog history keeps only about half in motion).
  await page.evaluate(({ x, z, yaw, fx, fz }) => {
    woods.state.flares.list.length = 0
    woods.flares.pool.count = 0
    woods.setPose(x, z, yaw, 0.02)
    woods.layFlare(x + fx * 2.5, z + fz * 2.5, 30, yaw + 1.2)
  }, at)
  await run(3)
  await shot("near-still")
  await page.evaluate(() => { for (let i = 0; i < 24; i++) { woods.camera.yaw += 0.025; woods.step(1000 / 30) } })
  await shot("near-moving")
  await page.close()
  server.stop()
}

await capture("before", arg("--before", "dist-before/arcade/barbara"))
await capture("after", arg("--after", "dist/arcade/barbara"))
await browser.close()

// ── numbers ────────────────────────────────────────────────────────────────────────────────────────────────────
const W = 1280, H = 720
async function gray(name: string) {
  const raw = await $`ffmpeg -v error -i ${join(out, `${name}.png`)} -vf format=gray -f rawvideo -`.quiet().arrayBuffer()
  return Float64Array.from(new Uint8Array(raw))
}
function highPass(g: Float64Array) {
  const hp = new Float64Array(W * H)
  for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
    let s = 0
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) s += g[(y + j) * W + x + i]!
    hp[y * W + x] = g[y * W + x]! - s / 49
  }
  return hp
}
const r3 = (v: number) => Math.round(v * 1000) / 1000

async function through(build: string, smoky: string) {
  const s = await gray(`${build}-${smoky}`), c = await gray(`${build}-through-clear`)
  const hs = highPass(s), hc = highPass(c)
  let n = 0, ms = 0, mc = 0, sc = 0, cc = 0, ss = 0
  for (let y = 8; y < H - 8; y++) for (let x = 8; x < W - 8; x++) {
    const i = y * W + x
    if (Math.abs(s[i]! - c[i]!) < 6) continue
    n++; ms += s[i]!; mc += c[i]!; sc += hs[i]! * hc[i]!; cc += hc[i]! ** 2; ss += hs[i]! ** 2
  }
  // Fine detail the smoke adds that the clear frame lacks (smoke itself is soft): aliasing and dither that temporal AA
  // stopped averaging under it.
  let nd = 0, dd = 0
  for (let y = 8; y < H - 8; y++) for (let x = 8; x < W - 8; x++) {
    const i = y * W + x
    if (Math.abs(s[i]! - c[i]!) < 6) continue
    let m = 0
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) m += s[i + j * W + k]! - c[i + j * W + k]!
    dd += (s[i]! - c[i]! - m / 9) ** 2; nd++
  }
  return { area: r3(n / (W * H)), grey: r3(ms / Math.max(n, 1)), clearGrey: r3(mc / Math.max(n, 1)), slope: r3(sc / Math.max(cc, 1e-9)), corr: r3(sc / Math.sqrt(Math.max(cc * ss, 1e-9))), fine: r3(Math.sqrt(dd / Math.max(nd, 1))) }
}

const ign = (x: number, y: number) => (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1
const offsets: [number, number][] = []
for (let dy = 0; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) if (Math.max(Math.abs(dx), dy) >= 2 && (dy > 0 || dx > 0)) offsets.push([dx, dy])
function autocorr(g: Float64Array, w: number, h: number) {
  let v = 0
  for (const x of g) v += x * x
  return offsets.map(([dx, dy]) => {
    let a = 0
    for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) a += g[y * w + x]! * g[(y + dy) * w + x + dx]!
    return a / v
  })
}
const ignTables = Array.from({ length: 15 }, (_, k) => {
  const s = 0.3 + k * 0.05, w = 160, h = 120, g = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = ign(Math.floor(x * s) + 0.5, Math.floor(y * s) + 0.5) - 0.5
  return { s, ac: autocorr(g, w, h) }
})
function pearson(a: number[], b: number[]) {
  const ma = a.reduce((p, v) => p + v, 0) / a.length, mb = b.reduce((p, v) => p + v, 0) / b.length
  let ab = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { ab += (a[i]! - ma) * (b[i]! - mb); aa += (a[i]! - ma) ** 2; bb += (b[i]! - mb) ** 2 }
  return ab / Math.sqrt(aa * bb)
}
async function lattice(name: string) {
  const hp = highPass(await gray(name))
  // The middle of the frame, where the flare's glow in the mist is.
  const w = 640, h = 360, crop = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = hp[(y + 180) * W + x + 320]!
  const ac = autocorr(crop, w, h)
  let bestS = 0, best = -1
  for (const t of ignTables) { const r = pearson(ac, t.ac); if (r > best) { best = r; bestS = t.s } }
  let e = 0
  for (const v of crop) e += v * v
  return { ign: r3(best), scale: r3(bestS), hp: r3(Math.sqrt(e / crop.length)) }
}

// Outside: over the column (where the first build's smoke changes its picture), the plume's mean grey against the same
// pixels with the smoke cleared, and the share of them the smoke darkens by more than 3 levels.
const plume = await (async () => {
  const s = await gray("before-outside"), c = await gray("before-outside-clear")
  return s.map((v, i) => (Math.abs(v - c[i]!) >= 6 ? 1 : 0))
})()
async function outside(build: string) {
  const s = await gray(`${build}-outside`), c = await gray(`${build}-outside-clear`)
  let n = 0, ms = 0, mc = 0, dark = 0
  for (let i = 0; i < W * H; i++) if (plume[i]) { n++; ms += s[i]!; mc += c[i]!; if (s[i]! < c[i]! - 3) dark++ }
  return { area: r3(n / (W * H)), grey: r3(ms / Math.max(n, 1)), clearGrey: r3(mc / Math.max(n, 1)), darker: r3(dark / Math.max(n, 1)) }
}

const numbers: Record<string, unknown> = {}
for (const build of ["before", "after"]) {
  numbers[`${build}-through`] = await through(build, "through")
  numbers[`${build}-through-again`] = await through(build, "through-again")
  numbers[`${build}-outside`] = await outside(build)
  numbers[`${build}-near-still`] = await lattice(`${build}-near-still`)
  numbers[`${build}-near-moving`] = await lattice(`${build}-near-moving`)
}
console.log(JSON.stringify(numbers, null, 1))
writeFileSync(join(out, "smoke.json"), JSON.stringify({ spot: at, shots, numbers, errors }, null, 1))
if (errors.length) console.log("errors", errors.slice(0, 8))
await budget.exit(0)
