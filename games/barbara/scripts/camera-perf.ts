// Camera look GPU cost by pass (headless, muted; run after `bun run build`, through HiveMind browser):
//   bun scripts/camera-perf.ts [--out <dir>] [--dist dist] [--size 1600x900] [--dpr 1] [--rounds 3] [--samples 16] [--stills] [--looks eyes,bodycam]
// At the camera lab's fixed spot (`?lab=camera`, High), each look against Eyes at the same moment, interleaved: whole
// frame GPU times over consecutive 60 Hz frames (`woods.measure` with its clock stepping, so a 30 fps camera holds
// every other frame as in play; `camera`/`held` split those frames; fastest samples, see `halves`) for the full look,
// the scene with no final pass (what the look changes in the world: the body cam's wide render, the IR lamp), and the
// chain with each active pass left out, so a pass's cost is full minus without it. `--stills` also writes one still per
// look from a fixed staged moment (before/after diffs).
// `--dpr 2` is Retina: High caps the canvas at 1.5× the CSS size. Writes camera-perf.json.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/barbara-camera-perf"))
const [w, h] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const dpr = Number(arg("--dpr", "1"))
const rounds = Number(arg("--rounds", "3"))
const samples = Number(arg("--samples", "16"))
const stills = process.argv.includes("--stills")
const LOOKS = arg("--looks", "eyes,bodycam,nightshot,phone,vhs,hi8").split(",").filter(Boolean)
const PASS_NAMES = ["blur", "lens", "filter", "codec"]
const STAGE_FRAMES = 120
const started = Date.now()
/** Rounds stop before the browser budget would: a round starts only if one more fits. */
const BUDGET_MS = (Number(process.env.ARCADE_BROWSER_BUDGET_S ?? 180) - 20) * 1000

type Pass = { active: boolean }
type Api = {
  frames: number; paused: boolean
  step(ms: number): void
  measure(n?: number, step?: number): Promise<{ median: number; mean: number; samples: number[] } | null>
  panel: { sync(): void }
  state: { players: unknown[]; t: number }
  renderer: { setFinalPass(p: unknown): void }
  cameraLook: { apply(id: string): void; stage(): boolean; eyeshine: { clear(): void }; chain: { passes: Pass[] } }
}
declare const woods: Api

mkdirSync(out, { recursive: true })
const root = resolve(arg("--dist", "dist"), "arcade/barbara"), prefix = "/arcade/barbara/"
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
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&lab=camera`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Api }).woods && woods.frames > 2 && woods.state.players.length >= 3, null, { timeout: 120000 }).catch((e) => { console.log(errors.join("\n")); throw e })
const canvas = await page.evaluate(() => { const c = document.querySelector("canvas")!; return [c.width, c.height] })
console.log("canvas", canvas.join("x"), "dpr", dpr)

/** Re-stage at the fixed spot on the same sim clock, apply `look`, then step `frames` at 60 fps. Returns CPU ms per step. */
const stage = (look: string, frames = STAGE_FRAMES) => page.evaluate(async ({ look, frames }) => {
  woods.paused = true
  woods.cameraLook.stage()
  woods.state.t = 100
  woods.cameraLook.eyeshine.clear()
  woods.cameraLook.apply(look)
  woods.panel.sync()
  const cpu: number[] = []
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now()
    woods.step(1000 / 60)
    cpu.push(performance.now() - t0)
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0))
  }
  cpu.sort((a, b) => a - b)
  return cpu[Math.floor(cpu.length / 2)]!
}, { look, frames })

/** One run of consecutive 60 Hz frames, samples in order (NaN where a timing failed). */
const measure = () => page.evaluate(async (n) => (await woods.measure(n, 1 / 60))?.samples ?? [], samples)

if (stills) {
  await page.addStyleTag({ content: "body > :not(canvas) { visibility: hidden !important; }" })
  for (const look of LOOKS) {
    await stage(look, 240)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.screenshot({ path: `${out}/still-${look}${dpr === 1 ? "" : `@${dpr}x`}.png` })
  }
}

/** For the staged look: the full chain, no final pass, and the chain without each active pass. */
const variants = () => page.evaluate(async (n) => {
  const chain = woods.cameraLook.chain
  const Chain = chain.constructor as new (p: Pass[]) => unknown
  const active = chain.passes.map((p) => p.active)
  const time = async () => (await woods.measure(n, 1 / 60))?.samples ?? []
  const res: Record<string, number[]> = {}
  for (let i = 0; i < chain.passes.length; i++) {
    if (!active[i]) continue
    woods.renderer.setFinalPass(new Chain(chain.passes.filter((_, j) => j !== i)))
    res[`without:${i}`] = await time()
  }
  woods.renderer.setFinalPass(null)
  res.scene = await time()
  woods.renderer.setFinalPass(chain)
  return res
}, samples)

type Run = { cpuBase: number; cpu: number; v: Record<string, number[]> }
const runs: Record<string, Run[]> = {}
const quantile = (a: number[], q: number) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * q)]! : NaN }
const median = (a: number[]) => +quantile(a, 0.5).toFixed(3)
/**
 * Other jobs on the worker share its GPU and memory bandwidth and only ever add time (on a busy worker only ~5% of
 * frames run clean), so each estimate is the fastest sample pooled over rounds. Alternate frames are pooled apart (in
 * each run the half with the costlier fastest frame is the camera's frames, the other the held ones), and a frame's cost
 * is their mean.
 */
const halves = (runs: number[][]) => {
  const camera: number[] = [], held: number[] = []
  for (const xs of runs) {
    const even = xs.filter((_, i) => i % 2 === 0), odd = xs.filter((_, i) => i % 2 === 1)
    const [hi, lo] = quantile(even, 0) >= quantile(odd, 0) ? [even, odd] : [odd, even]
    camera.push(...hi); held.push(...lo)
  }
  const c = quantile(camera, 0), h = quantile(held, 0)
  return { frame: (c + h) / 2, camera: c, held: h }
}
const r3 = (x: number) => +x.toFixed(3)
const summary = () => Object.fromEntries(Object.entries(runs).map(([look, rs]) => {
  const est = (key: string) => halves(rs.map((x) => x.v[key]!))
  const eyes = est("eyes").frame, full = est("full"), scene = est("scene").frame
  const passes: Record<string, number> = {}
  for (const key of Object.keys(rs[0]!.v)) if (key.startsWith("without:")) passes[PASS_NAMES[Number(key.slice(8))]!] = r3(full.frame - est(key).frame)
  return [look, {
    eyes: r3(eyes),
    full: r3(full.frame),
    overEyes: r3(full.frame - eyes),
    cameraFrameOverEyes: r3(full.camera - eyes),
    heldFrameOverEyes: r3(full.held - eyes),
    scene: r3(scene - eyes),
    finalPasses: r3(full.frame - scene),
    passes,
    cpuStepMs: median(rs.map((x) => x.cpu)),
    cpuStepEyesMs: median(rs.map((x) => x.cpuBase)),
  }]
}))
const file = `${out}/camera-perf${dpr === 1 ? "" : `@${dpr}x`}.json`
let done = 0
for (let r = 0; r < rounds; r++) {
  const roundStart = Date.now()
  for (const look of LOOKS) {
    if (look === "eyes") continue
    const cpuBase = await stage("eyes")
    const eyes = await measure()
    const cpu = await stage(look)
    const full = await measure()
    const v = { eyes, full, ...(await variants()) }
    ;(runs[look] ??= []).push({ cpuBase, cpu, v })
    console.log("round", r, look, JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, median(x)]))))
  }
  done = r + 1
  writeFileSync(file, JSON.stringify({ size: [w, h], dpr, canvas, rounds: done, samples, looks: summary(), runs, errors }, null, 2))
  const took = Date.now() - roundStart
  console.log(`round ${r} took ${(took / 1000).toFixed(0)}s`)
  if (Date.now() - started + took > BUDGET_MS) break
}
console.log(JSON.stringify(summary(), null, 2))
if (errors.length) console.log("browser messages:", errors.slice(0, 10))
await budget.finish()
server.stop(true)
