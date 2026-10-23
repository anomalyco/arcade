// How smoothly friends are drawn, headless and muted:
//   bun scripts/jitter.ts [--url https://studio.taila8e7c7.ts.net:5298/arcade/barbara/] [--out dir]
//   bun scripts/jitter.ts --serve 8799     (after `bun run build`: runs its own `wrangler dev`, e.g. in HiveMind)
// Solo: bots follow you round a loop on a synthetic 120 Hz clock (the sim ticks at 60 Hz). Room: two browsers join,
// one walks a loop while sweeping its look, the other records how it draws that friend each frame in real time.
// Each runs with friends drawn raw (`?smooth=0`) and smoothed (the default). Reports per-frame position and
// beam-direction jitter (lower is smoother) as JSON in the out dir ($LEASE_OUT).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const serve = arg("--serve", "")
const wrangler = serve ? Bun.spawn(["bunx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", serve], { stdout: "ignore", stderr: "ignore" }) : null
const base = new URL(serve ? `http://127.0.0.1:${serve}/arcade/barbara/` : arg("--url", "https://studio.taila8e7c7.ts.net:5298/arcade/barbara/"))
for (let i = 0; wrangler && i < 90; i++) {
  if (await fetch(new URL("api/health", base)).then((r) => r.ok, () => false)) break
  await new Promise((r) => setTimeout(r, 1000))
}
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/jitter"))
mkdirSync(out, { recursive: true })

type Sample = { now: number; id: number; x: number; z: number; yaw: number; axis: [number, number, number] | null; level: number }
type Woods = {
  frames: number; autoplay: boolean; net: { me: number; self: { x: number; z: number } }
  walkTo(x: number, z: number): void; face(x: number, z: number, pitch?: number): void; step(ms: number): void
  trace(): void; traced(): Sample[]; camera: { yaw: number; pitch: number; flashlight: boolean }
}
declare const woods: Woods
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Per friend: speed jitter (RMS change in speed between frames, m/s), frames standing still while moving, beam angular-velocity jitter (deg/s) and the largest beam step (deg), brightness jumps. */
function metrics(samples: Sample[]) {
  const byId = new Map<number, Sample[]>()
  for (const s of samples) (byId.get(s.id) ?? byId.set(s.id, []).get(s.id)!).push(s)
  const rows: Record<string, unknown>[] = []
  for (const [id, list] of byId) {
    if (list.length < 30) continue
    const speeds: number[] = [], omegas: number[] = []
    let still = 0, moving = 0, maxStep = 0, jumps = 0, dist = 0, time = 0
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!, dt = (b.now - a.now) / 1000
      if (dt <= 0) continue
      const d = Math.hypot(b.x - a.x, b.z - a.z)
      speeds.push(d / dt); dist += d; time += dt
      if (a.axis && b.axis) {
        const dot = Math.max(-1, Math.min(1, a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2]))
        const ang = (Math.acos(dot) * 180) / Math.PI
        omegas.push(ang / dt); maxStep = Math.max(maxStep, ang)
      }
      if (Math.abs(b.level - a.level) > 0.2) jumps++
    }
    const mean = dist / Math.max(time, 1e-6)
    for (let i = 1; i < list.length; i++) {
      const d = Math.hypot(list[i]!.x - list[i - 1]!.x, list[i]!.z - list[i - 1]!.z)
      if (mean > 0.3) { moving++; if (d < 1e-5) still++ }
    }
    const rmsDiff = (v: number[]) => v.length < 2 ? 0 : Math.sqrt(v.slice(1).reduce((s, x, i) => s + (x - v[i]!) ** 2, 0) / (v.length - 1))
    const p99 = omegas.length ? [...omegas].sort((a, b) => a - b)[Math.floor(omegas.length * 0.99)]! : 0
    rows.push({ id, frames: list.length, meanSpeed: +mean.toFixed(2), speedJitter: +rmsDiff(speeds).toFixed(3), stillFrames: moving ? +(still / moving).toFixed(3) : 0, beamJitter: +rmsDiff(omegas).toFixed(1), beamP99DegPerS: +p99.toFixed(0), beamMaxStepDeg: +maxStep.toFixed(2), levelJumps: jumps })
  }
  return rows
}

const launch = () => chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const browser = await launch()
// The walker gets its own browser: a second page in one browser can be throttled, which starves its inputs.
const walker = await launch()
const errors: string[] = []
async function open(query: string, name: string, from = browser): Promise<Page> {
  const ctx = await from.newContext({ viewport: { width: 640, height: 360 } })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`))
  await page.goto(`${base.href}${query}`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 90000 })
  return page
}
const report: Record<string, unknown> = { url: base.href }

for (const [name, q] of [["raw", "&smooth=0"], ["smoothed", ""]] as const) {
  const result: Record<string, unknown> = {}
  report[name] = result
  // Solo: walk a square on a synthetic clock (8.33 ms frames) while bots follow; record how they're drawn.
  {
    const page = await open(`?quality=low${q}`, "solo")
    // A 120 Hz screen, and a 60 Hz one whose frames wobble ±1.5 ms as rAF does.
    for (const [clock, wobble, frameMs] of [["120hz", 0, 1000 / 120], ["60hz", 1.5, 1000 / 60]] as const) {
      result[`solo${clock}`] = await page.evaluate(([wobble, frameMs]) => {
        woods.autoplay = true
        const s = woods.net.self, pts = [[s.x + 14, s.z], [s.x + 14, s.z + 14], [s.x, s.z + 14], [s.x, s.z]]
        let i = 0
        const step = () => woods.step(frameMs + wobble * Math.sin(i++ * 2.3))
        for (let k = 0; k < 120; k++) step()
        woods.trace()
        for (let lap = 0; lap < 2; lap++) for (const [x, z] of pts) {
          woods.walkTo(x!, z!)
          for (let k = 0; k < 3000 / frameMs; k++) { step(); woods.camera.yaw += 0.01 }
        }
        return woods.traced()
      }, [wobble, frameMs] as const).then(metrics)
    }
    await page.context().close()
  }

  // Room: B walks a loop and sweeps its look; A records B (and the bots) as drawn, in real time.
  if (!process.argv.includes("--solo")) {
    const room = ((await (await fetch(new URL("api/create", base), { method: "POST" })).json()) as { room: string }).room
    const a = await open(`?room=${room}&name=A&quality=low${q}`, "A")
    const b = await open(`?room=${room}&name=B&quality=low`, "B", walker)
    for (const p of [a, b]) await p.evaluate(() => { woods.autoplay = true })
    await a.waitForFunction(() => woods.net.me > 0, null, { timeout: 30000 })
    await b.waitForFunction(() => woods.net.me > 0, null, { timeout: 30000 })
    await sleep(2000)
    const bId = await b.evaluate(() => woods.net.me)
    const loop = await b.evaluate(() => { const s = woods.net.self; return [[s.x + 10, s.z], [s.x + 10, s.z + 10], [s.x, s.z + 10], [s.x, s.z]] })
    await a.evaluate(() => woods.trace())
    const sweep = b.evaluate(async () => { for (let i = 0; i < 480; i++) { woods.camera.yaw += Math.sin(i / 40) * 0.05; await new Promise((r) => setTimeout(r, 1000 / 60)) } })
    for (const [x, z] of loop) { await b.evaluate(([x, z]) => woods.walkTo(x!, z!), [x, z]); await sleep(2000) }
    await sweep
    const samples = await a.evaluate(() => woods.traced())
    result.room = { friend: bId, rows: metrics(samples) }
    for (const p of [a, b]) await p.context().close()
  }
}
report.errors = errors
writeFileSync(`${out}/jitter.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 1))
await browser.close()
await walker.close()
wrangler?.kill()
