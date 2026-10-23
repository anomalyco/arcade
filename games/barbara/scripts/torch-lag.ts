// Headless, muted per-frame trace of your own torch's spot (run after `bun run build`, through HiveMind browser):
//   bun scripts/torch-lag.ts [--variants base,lag0,...] [--out dir] [--tag name] [--clip] [--look key=value,...]
// Stands on open ground in the woods with the torch's spot ~4 m ahead, then a fast yaw flick (0.7 rad in 6 frames, about
// 400°/s), a hold, a slow pan (0.6 rad/s) and a hold, on the 60 fps synthetic clock. Every frame it records where the
// view's aim ray lands on the ground (`woods.torchTrace`) and reads the frame back (the canvas, 320×180 luma) to find
// where the brightest beam pixels land. From those: the spot's lag behind the aim (frames, in the pan's steady state and
// at the flick's 50% and 90% crossings) and the ghost left at the old spot after the flick (excess luminance there as a
// share of the hot spot's). Variants switch single layers off to find which one lags. Writes torch-lag.json (and with
// `--clip`, 960×540 JPEG frames of the flick per variant) to the out dir (repo-root captures/torch-lag by default).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { makeWorld, standHeight } from "../shared/world"
import { openTorchPose } from "./capture"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "../../captures/torch-lag"))
const variants = arg("--variants", "base,lag0,bounce0,taa0,exp0,fog0,none").split(",")
const tag = arg("--tag", "")
const clip = process.argv.includes("--clip")
const looks = Object.fromEntries(arg("--look", "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v] }))
const W = 320, H = 180, PITCH = -0.3

type Rec = { origin: number[]; aim: number[]; axis: number[]; eye: number[]; vp: number[] }
type Woods = {
  frames: number; paused: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  torchTrace(): void; torchTraced(): Rec[]
  state: { players: { x: number; z: number; bot: boolean }[]; brains: { mode: string; timer: number }[] }
  world: { camp: { x: number; z: number } }
  camera: { flashlight: boolean; yaw: number; pitch: number }
  renderer: { setTemporal(s: unknown): void }
  view: { forest: { debug: Record<string, boolean> } }
  look: Record<string, unknown>
}
declare const woods: Woods

const world = makeWorld()
const pose = openTorchPose(world)

// ── geometry ────────────────────────────────────────────────────────────────────────────────────────────────────
const groundHit = (o: number[], d: number[]): number[] | null => {
  for (let t = 0.05; t < 40; t += 0.02) {
    const p = [o[0]! + d[0]! * t, o[1]! + d[1]! * t, o[2]! + d[2]! * t]
    if (p[1]! <= standHeight(world, p[0]!, p[2]!)) return p
  }
  return null
}
const project = (p: number[], m: number[]): [number, number] | null => {
  const x = m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!
  const y = m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!
  const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!
  if (w <= 1e-6) return null
  return [(x / w * 0.5 + 0.5) * W, (0.5 - y / w * 0.5) * H]
}
function invert(m: number[]): number[] {
  const a = m.slice(), inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const at = (r: number, c: number) => c * 4 + r
  for (let c = 0; c < 4; c++) {
    let p = c
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[at(r, c)]!) > Math.abs(a[at(p, c)]!)) p = r
    for (let k = 0; k < 4; k++) { [a[at(c, k)], a[at(p, k)]] = [a[at(p, k)]!, a[at(c, k)]!]; [inv[at(c, k)], inv[at(p, k)]] = [inv[at(p, k)]!, inv[at(c, k)]!] }
    const d = a[at(c, c)]!
    for (let k = 0; k < 4; k++) { a[at(c, k)]! /= d; inv[at(c, k)]! /= d }
    for (let r = 0; r < 4; r++) if (r !== c) {
      const f = a[at(r, c)]!
      for (let k = 0; k < 4; k++) { a[at(r, k)]! -= f * a[at(c, k)]!; inv[at(r, k)]! -= f * inv[at(c, k)]! }
    }
  }
  return inv
}
/** The ground point seen at pixel (px, py) of the 320×180 frame. */
function unproject(px: number, py: number, m: number[], eye: number[]): number[] | null {
  const inv = invert(m), nx = (px / W) * 2 - 1, ny = 1 - (py / H) * 2
  const far = [0, 1, 2, 3].map((r) => inv[r]! * nx + inv[4 + r]! * ny + inv[8 + r]! * 1 + inv[12 + r]!)
  const p = [far[0]! / far[3]!, far[1]! / far[3]!, far[2]! / far[3]!]
  const d = [p[0]! - eye[0]!, p[1]! - eye[1]!, p[2]! - eye[2]!], l = Math.hypot(d[0]!, d[1]!, d[2]!)
  return groundHit(eye, d.map((v) => v / l))
}
const yawOf = (p: number[], o: number[]) => Math.atan2(-(p[0]! - o[0]!), -(p[2]! - o[2]!))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const linear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }

/**
 * Where the beam's brightest light lands: the peak of the frame's linear luminance box-blurred over 21×21 px (the hot
 * spot's scale at 320×180, so ground texture averages out), refined to the weighted centroid within 92% of that peak.
 */
function spotOf(y: Uint8Array): { x: number; y: number; peak: number } {
  const R = 10, lin = new Float32Array(W * H), row = new Float32Array(W * H), s = new Float32Array(W * H)
  for (let k = 0; k < lin.length; k++) lin[k] = linear(y[k]!)
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0, n = 0
    for (let a = Math.max(0, i - R); a <= Math.min(W - 1, i + R); a++) { sum += lin[j * W + a]!; n++ }
    row[j * W + i] = sum / n
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0, n = 0
    for (let b = Math.max(0, j - R); b <= Math.min(H - 1, j + R); b++) { sum += row[b * W + i]!; n++ }
    s[j * W + i] = sum / n
  }
  let best = 0, bi = 0
  for (let k = 0; k < s.length; k++) if (s[k]! > best) { best = s[k]!; bi = k }
  const mx = bi % W, my = Math.floor(bi / W)
  let sx = 0, sy = 0, sw = 0
  for (let j = Math.max(0, my - 30); j < Math.min(H, my + 30); j++) for (let i = Math.max(0, mx - 40); i < Math.min(W, mx + 40); i++) {
    const v = s[j * W + i]! - best * 0.92
    if (v <= 0) continue
    sx += i * v; sy += j * v; sw += v
  }
  return { x: sx / sw + 0.5, y: sy / sw + 0.5, peak: best }
}
const diskMean = (y: Uint8Array, cx: number, cy: number, r: number) => {
  let sum = 0, n = 0
  for (let j = Math.floor(cy - r); j <= cy + r; j++) for (let i = Math.floor(cx - r); i <= cx + r; i++) {
    if (i < 0 || j < 0 || i >= W || j >= H || (i - cx) ** 2 + (j - cy) ** 2 > r * r) continue
    sum += linear(y[j * W + i]!); n++
  }
  return n ? sum / n : 0
}

// ── the motion: per frame, the yaw change (rad) before the step ─────────────────────────────────────────────────
const SETTLE = 150
const still = (n: number) => Array(n).fill(0) as number[]
const FLICK = 6, FLICK_RAD = 0.7, PAN = 60, PAN_RATE = 0.6 / 60
const plan = [...still(12), ...Array(FLICK).fill(FLICK_RAD / FLICK), ...still(40), ...Array(PAN).fill(-PAN_RATE), ...still(30)] as number[]
const flickStart = 12, flickEnd = flickStart + FLICK, panStart = flickEnd + 40, panEnd = panStart + PAN

// ── the browser ─────────────────────────────────────────────────────────────────────────────────────────────────
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 120000 })
await page.evaluate(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".arcade-shell, #hud, #objective, #subs, #goal, #prompt, #toast")) el.style.display = "none"
  woods.paused = true
})

type Frame = { aimYaw: number; spotYaw: number | null; aimPx: [number, number] | null; spot: { x: number; y: number; peak: number }; ghost: number }
const report: Record<string, unknown> = { pose, plan: { flickStart, flickEnd, flickRad: FLICK_RAD, panStart, panEnd, panRate: PAN_RATE * 60 }, looks }

for (const v of variants) {
  await page.evaluate(({ v, pose, looks, PITCH }) => {
    const L = woods.look as Record<string, unknown>
    ;(window as unknown as { __defaults?: Record<string, unknown> }).__defaults ??= { ...L }
    Object.assign(L, (window as unknown as { __defaults: Record<string, unknown> }).__defaults, looks)
    const has = (k: string) => v.split("+").includes(k) || v === "none"
    if (has("lag0")) L.torchLag = 0
    if (has("bounce0")) L.bounce = 0
    if (has("exp0")) L.autoExposure = false
    if (has("fog0")) { L.beamAir = 0; L.beamMist = 0; L.shafts = false }
    if (has("shadow0")) L.torchShadows = "off"
    // motion0: your torch stays out of the TAA reactive mask (the history smears its spot on a pan).
    woods.view.forest.debug.torchMotion = !has("motion0")
    woods.renderer.setTemporal(has("taa0") ? null : { mode: "taa", renderScale: 0.67, sharpen: 0.15, history: 0.9 })
    for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999 }
    for (const p of woods.state.players) if (p.bot) { p.x = woods.world.camp.x; p.z = woods.world.camp.z }
    woods.camera.flashlight = true
    woods.setPose(pose.x, pose.z, pose.yaw, PITCH)
  }, { v, pose, looks, PITCH })
  await page.evaluate(async (n) => { for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0)) } }, SETTLE)
  await page.evaluate(() => woods.torchTrace())
  const lumas: Uint8Array[] = []
  const clipDir = `${out}/clip-${v}${tag}`
  if (clip) mkdirSync(clipDir, { recursive: true })
  for (let f = 0; f < plan.length; f++) {
    const r = await page.evaluate(({ dy, W, H, jpeg }) => {
      woods.camera.yaw += dy
      woods.step(1000 / 60)
      const src = document.querySelector<HTMLCanvasElement>("#view")!
      const c = document.createElement("canvas"); c.width = W; c.height = H
      const g = c.getContext("2d", { willReadFrequently: true })!
      g.drawImage(src, 0, 0, W, H)
      const d = g.getImageData(0, 0, W, H).data
      const y = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) y[i] = Math.round(0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!)
      let s = ""
      for (let i = 0; i < y.length; i += 8192) s += String.fromCharCode(...y.subarray(i, i + 8192))
      let shot = ""
      if (jpeg) { const b = document.createElement("canvas"); b.width = 960; b.height = 540; b.getContext("2d")!.drawImage(src, 0, 0, 960, 540); shot = b.toDataURL("image/jpeg", 0.9) }
      return { y: btoa(s), shot }
    }, { dy: plan[f]!, W, H, jpeg: clip && f >= flickStart - 4 && f < flickEnd + 30 })
    lumas.push(Uint8Array.from(atob(r.y), (ch) => ch.charCodeAt(0)))
    if (r.shot) writeFileSync(`${clipDir}/${String(f).padStart(4, "0")}.jpg`, Buffer.from(r.shot.split(",")[1]!, "base64"))
  }
  const recs = await page.evaluate(() => woods.torchTraced())
  if (recs.length !== plan.length) throw new Error(`${v}: ${recs.length} trace records for ${plan.length} frames`)

  // Per frame: the aim's ground point and yaw from the lens, the spot's pixel, its ground point and yaw.
  const frames: Frame[] = []
  const p0 = groundHit(recs[flickStart - 1]!.origin, recs[flickStart - 1]!.aim)
  for (let f = 0; f < plan.length; f++) {
    const r = recs[f]!, aim = groundHit(r.origin, r.aim)
    const spot = spotOf(lumas[f]!)
    const g = unproject(spot.x, spot.y, r.vp, r.eye)
    const old = p0 ? project(p0, r.vp) : null
    frames.push({ aimYaw: aim ? yawOf(aim, r.origin) : NaN, spotYaw: g ? yawOf(g, r.origin) : null, aimPx: aim ? project(aim, r.vp) : null, spot, ghost: old ? diskMean(lumas[f]!, old[0], old[1], 6) : NaN })
  }
  // The spot's yaw relative to the aim, less its offset at rest (the beam's spot sits a little off the aim's ground point).
  const rel = frames.map((fr) => fr.spotYaw === null ? NaN : wrap(fr.spotYaw - fr.aimYaw))
  const restOff = rel.slice(2, flickStart).reduce((a, b) => a + b, 0) / (flickStart - 2)
  const lagRad = rel.map((x) => x - restOff)
  // Pan: lag in frames = trailing angle / angular rate, over the pan's second half (an exponential has settled).
  const panLag = lagRad.slice(panStart + 30, panEnd).map((x) => x / PAN_RATE)
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
  // Flick: the frame (fractional) where the spot and the aim cross 50% and 90% of the turn.
  const yaw0 = frames[flickStart - 1]!.aimYaw
  const progress = (k: "aim" | "spot") => frames.map((fr) => wrap((k === "aim" ? fr.aimYaw : (fr.spotYaw ?? NaN) - restOff) - yaw0) / FLICK_RAD)
  const crossing = (p: number[], level: number) => { for (let f = flickStart; f < panStart; f++) if (p[f]! >= level) { const a = p[f - 1]!, b = p[f]!; return f - 1 + (level - a) / (b - a) } return NaN }
  const pa = progress("aim"), ps = progress("spot")
  // Ghost: excess luminance at the old spot after the flick over its level 30 frames on, as a share of the hot spot.
  const hot = mean(frames.slice(2, flickStart).map((fr) => fr.spot.peak))
  const settled = mean(frames.slice(panStart - 6, panStart).map((fr) => fr.ghost))
  const ghost = frames.slice(flickEnd - 1, flickEnd + 12).map((fr) => (fr.ghost - settled) / hot)
  const summary = {
    panLagFrames: +mean(panLag).toFixed(2),
    flickLag50: +(crossing(ps, 0.5) - crossing(pa, 0.5)).toFixed(2),
    flickLag90: +(crossing(ps, 0.9) - crossing(pa, 0.9)).toFixed(2),
    flickMaxTrailDeg: +((Math.max(...lagRad.slice(flickStart, panStart).map((x) => -x)) * 180) / Math.PI).toFixed(2),
    settleFrames: (() => { for (let f = panStart - 1; f >= flickEnd; f--) if (Math.abs(lagRad[f]!) > (1.5 * Math.PI) / 180) return f + 1 - flickEnd; return 0 })(),
    ghostAtEnd: +ghost[0]!.toFixed(4), ghostPeak: +Math.max(...ghost).toFixed(4), ghostAt4: +ghost[4]!.toFixed(4),
    ghostSeries: ghost.map((g) => +g.toFixed(4)),
    hotPeak: +hot.toFixed(4),
  }
  report[v] = { summary, frames: frames.map((fr, i) => ({ i, aimYaw: +fr.aimYaw.toFixed(4), lagDeg: +((lagRad[i]! * 180) / Math.PI).toFixed(3), spot: [+fr.spot.x.toFixed(1), +fr.spot.y.toFixed(1)], aimPx: fr.aimPx?.map((x) => +x.toFixed(1)) ?? null, peak: +fr.spot.peak.toFixed(4), ghost: +fr.ghost.toFixed(5) })) }
  console.log(v, JSON.stringify(summary))
}
report.errors = errors
writeFileSync(`${out}/torch-lag${tag}.json`, JSON.stringify(report, null, 1))
server.stop(true)
await budget.finish()
