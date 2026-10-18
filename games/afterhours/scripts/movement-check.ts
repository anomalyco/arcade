// Headless movement check: walks and runs up and down the core stair (ground floor → storey 1 → back) with physical
// key presses, logging the eye height every frame, then crouches under a beam and jumps. The beam exists only in this
// page. Expects the dev server on :5196. Exits 1 on any failure.
//
//   bun scripts/movement-check.ts            # prints per-leg eye smoothness, crouch and jump results
//   bun scripts/movement-check.ts --log f    # also writes the per-frame trace (JSON) to f
import { chromium } from "playwright-core"
import { existsSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const logIdx = args.indexOf("--log")
const logFile = logIdx >= 0 ? args[logIdx + 1] : undefined

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const page = await browser.newPage({ viewport: { width: 800, height: 520 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
// Swallow Vite's HMR socket so other agents' saves don't reload the page mid-run.
await page.routeWebSocket(/.*/, () => {})
await page.goto("http://localhost:5196/?view=corridor&only=terrain,interior")
await page.waitForFunction(() => {
  const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
  return !!s?.complete && s.ready
}, null, { timeout: 240_000 })

let failed = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failed++
}

type Sample = { t: number; dt: number; y: number; eye: number; crouch: number; grounded: boolean }
type P = {
  pos: { x: number; y: number; z: number }
  yaw: number
  pitch: number
  trace: Sample[] | null
  resetMotion(): void
  state: { crouch: number; grounded: boolean; speed: number; stepPhase: number; eyeHeight: number }
  ctx: { colliders: { min: number[]; max: number[] }[] }
  onStep(l: (e: { kind: string; surface: string }) => void): () => void
}
const player = <T>(fn: (p: P, arg: T) => unknown, arg: T) =>
  page.evaluate(({ src, arg }) => new Function("p", "arg", `return (${src})(p, arg)`)((globalThis as unknown as { __afterhoursPlayer: P }).__afterhoursPlayer, arg), { src: fn.toString(), arg })
const pos = () => player((p) => ({ ...p.pos }), 0) as Promise<{ x: number; y: number; z: number }>

async function place(x: number, y: number, z: number, yaw: number) {
  await player(
    (p, a: number[]) => {
      p.pos.x = a[0]!
      p.pos.y = a[1]!
      p.pos.z = a[2]!
      p.yaw = a[3]!
      p.pitch = 0
      p.resetMotion()
    },
    [x, y, z, yaw],
  )
  await page.waitForTimeout(300)
}

/** Holds W (and Shift), turning to each leg's heading until its goal is passed. */
async function route(legs: { yaw: number; until: (p: { x: number; y: number; z: number }) => boolean }[], run: boolean) {
  await player((p) => (p.trace = []), 0)
  if (run) await page.keyboard.down("ShiftLeft")
  await page.keyboard.down("KeyW")
  const t0 = performance.now()
  for (const leg of legs) {
    await player((p, y: number) => (p.yaw = y), leg.yaw)
    while (!leg.until(await pos()) && performance.now() - t0 < 25_000) await page.waitForTimeout(25)
  }
  await page.keyboard.up("KeyW")
  if (run) await page.keyboard.up("ShiftLeft")
  await page.waitForTimeout(400)
  return (await player((p) => {
    const t = p.trace
    p.trace = null
    return t
  }, 0)) as Sample[]
}

/**
 * Eye smoothness on a uniform 60 Hz clock (the trace is resampled by time, so headless frame-time jitter doesn't read
 * as motion): the largest per-frame change, and jerk (the largest change of that per-frame change).
 */
function smoothness(raw: Sample[]) {
  const trace: Sample[] = []
  let t = raw[0]!.t
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1]!
    const b = raw[i]!
    while (t <= b.t && b.t > a.t) {
      const u = (t - a.t) / (b.t - a.t)
      trace.push({ ...b, t, dt: 1 / 60, y: u < 1 ? a.y : b.y, eye: a.eye + (b.eye - a.eye) * u })
      t += 1 / 60
    }
  }
  let eye60 = 0
  let body = 0
  let eyeRaw = 0
  // Jerk: how much the per-frame eye change itself changes (a tread kink or a snap shows up here even at a run).
  let jerk = 0
  let prev: number | null = null
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1]!
    const b = trace[i]!
    if (b.dt <= 0) continue
    const v60 = ((b.eye - a.eye) * (1 / 60)) / Math.max(b.dt, 1 / 240)
    eye60 = Math.max(eye60, Math.abs(v60))
    if (prev !== null) jerk = Math.max(jerk, Math.abs(v60 - prev))
    prev = v60
    body = Math.max(body, Math.abs(b.y - a.y))
  }
  const fps = raw.length / raw.slice(1).reduce((s, x) => s + x.dt, 0)
  for (let i = 1; i < raw.length; i++) eyeRaw = Math.max(eyeRaw, Math.abs(raw[i]!.eye - raw[i - 1]!.eye))
  return { eye60, eyeRaw, body, jerk, fps, rise: raw.at(-1)!.y - raw[0]!.y, frames: raw.length }
}

const maxStep60 = (tr: Sample[]) => Math.max(0, ...tr.slice(1).map((s, i) => (Math.abs(s.eye - tr[i]!.eye) / Math.max(s.dt, 1 / 240)) / 60))
const WEST = -42.28
const EAST = -40.5
const up = [
  { yaw: Math.PI, until: (p: { z: number }) => p.z >= 23.2 },
  { yaw: -Math.PI / 2, until: (p: { x: number }) => p.x >= EAST },
  { yaw: 0, until: (p: { z: number }) => p.z <= 17.6 },
]
const down = [
  { yaw: Math.PI, until: (p: { z: number }) => p.z >= 23.2 },
  { yaw: Math.PI / 2, until: (p: { x: number }) => p.x <= WEST },
  { yaw: 0, until: (p: { z: number }) => p.z <= 17.6 },
]

const steps: string[] = []
await player((p) => p.onStep((e) => ((globalThis as unknown as { __steps: string[] }).__steps ??= []).push(`${e.kind}:${e.surface}`)), 0)

const traces: Record<string, Sample[]> = {}
for (const run of [false, true]) {
  const tag = run ? "run" : "walk"
  await place(WEST, 0.3, 17.4, Math.PI)
  const y0 = (await pos()).y
  const tu = await route(up, run)
  const su = smoothness(tu)
  check(su.rise > 3.5, `${tag} up: climbed a storey (${su.rise.toFixed(2)} m)`)
  // At a run the climb itself is ~5 cm of height per 60 Hz frame (a steady ramp), so there the check is on jerk: the
  // frame-to-frame change of that rate. A tread snap would show as ~9 cm; the eased climb onset at the foot of a flight
  // (0 → 2.8 m/s vertical in ~0.2 s) is ~1.2 cm.
  const ok = (s: ReturnType<typeof smoothness>) => (run ? s.jerk <= 0.015 : s.eye60 <= 0.02 && s.jerk <= 0.005)
  const fmt = (s: ReturnType<typeof smoothness>) =>
    `max ${(s.eye60 * 100).toFixed(2)} cm per 60 Hz frame, jerk ${(s.jerk * 100).toFixed(2)} cm, ${(s.eyeRaw * 100).toFixed(2)} cm raw at ${s.fps.toFixed(0)} fps; body snaps ${(s.body * 100).toFixed(1)} cm`
  check(ok(su), `${tag} up: eye smooth (${fmt(su)})`)
  const td = await route(down, run)
  const sd = smoothness(td)
  check(Math.abs((await pos()).y - y0) < 0.05, `${tag} down: back on the ground floor (${(sd.rise).toFixed(2)} m)`)
  check(ok(sd), `${tag} down: eye smooth (${fmt(sd)})`)
  check(td.every((s) => s.grounded), `${tag} down: followed the treads (never airborne)`)
  traces[`${tag}-up`] = tu
  traces[`${tag}-down`] = td
}
steps.push(...((await page.evaluate(() => (globalThis as unknown as { __steps?: string[] }).__steps ?? [])) as string[]))
check(steps.filter((s) => s.startsWith("step")).length > 40, `footstep events fired (${steps.length}, e.g. ${steps.slice(0, 3).join(", ")})`)

// Crouch under a beam (1.3–1.5 m) across the ground-floor stair landing; can't stand up beneath it; then jump.
const floorY = (await pos()).y
await player(
  (p, y: number) => p.ctx.colliders.push({ min: [-43.1, y + 1.3, 17.5], max: [-39.7, y + 1.5, 17.7] }),
  floorY,
)
await place(WEST, floorY + 0.02, 18.5, 0)
await page.keyboard.down("KeyW")
await page.waitForTimeout(1500)
await page.keyboard.up("KeyW")
let p = await pos()
check(p.z > 17.7 + 0.25, `standing: the beam blocks (z ${p.z.toFixed(2)})`)
await page.keyboard.down("KeyC")
await page.waitForTimeout(300)
await page.keyboard.down("KeyW")
for (let i = 0; i < 80 && (await pos()).z > 17.6; i++) await page.waitForTimeout(25)
await page.keyboard.up("KeyW")
await page.keyboard.up("KeyC")
await page.waitForTimeout(500)
let st = (await player((p) => ({ crouch: p.state.crouch, pos: { ...p.pos } }), 0)) as { crouch: number; pos: { z: number } }
check(st.pos.z < 17.85 && st.crouch > 0.95, `crouched under the beam; still crouched after releasing C beneath it (crouch ${st.crouch.toFixed(2)}, z ${st.pos.z.toFixed(2)})`)
await player((p) => (p.trace = []), 0)
await page.keyboard.press("Space")
await page.waitForTimeout(400)
let tr = (await player((p) => p.trace, 0)) as Sample[]
check(Math.max(...tr.map((s) => s.y)) - floorY < 0.01, "no jump while crouched under the beam")
await page.keyboard.down("KeyW")
await page.waitForTimeout(900)
await page.keyboard.up("KeyW")
await page.waitForTimeout(600)
st = (await player((p) => ({ crouch: p.state.crouch, pos: { ...p.pos } }), 0)) as { crouch: number; pos: { z: number } }
check(st.pos.z < 17.2 && st.crouch < 0.02, `stood up once clear (crouch ${st.crouch.toFixed(2)}, z ${st.pos.z.toFixed(2)})`)
await player((p) => (p.trace = []), 0)
await page.keyboard.press("Space")
await page.waitForTimeout(1200)
tr = (await player((p) => {
  const t = p.trace
  p.trace = null
  return t
}, 0)) as Sample[]
const apex = Math.max(...tr.map((s) => s.y)) - floorY
const air = tr.filter((s) => !s.grounded).length
const landed = tr.at(-1)!.grounded && Math.abs(tr.at(-1)!.y - floorY) < 0.01
const restEye = tr.at(-1)!.eye - floorY
const dip = restEye - Math.min(...tr.slice(tr.findIndex((s, i) => i > 0 && !tr[i - 1]!.grounded && s.grounded)).map((s) => s.eye - floorY))
check(apex > 0.42 && apex < 0.52 && landed, `jump: apex ${apex.toFixed(2)} m, ${air} airborne frames, landed`)
check(dip > 0.015, `landing dip on the camera (${(dip * 100).toFixed(1)} cm)`)
const landSteps = (await page.evaluate(() => (globalThis as unknown as { __steps?: string[] }).__steps ?? [])) as string[]
check(landSteps.some((s) => s.startsWith("jump")), "jump event fired")

// A crawl space (underside 1.17 m, the lowest the world models): crouched, the body passes and the eye ducks under it.
await player(
  (p, y: number) => p.ctx.colliders.push({ min: [-43.1, y + 1.17, 16.6], max: [-39.7, y + 1.5, 16.8] }),
  floorY,
)
await place(WEST, floorY + 0.02, 17.4, 0)
await page.keyboard.down("KeyC")
await page.waitForTimeout(300)
await player((p) => (p.trace = []), 0)
await page.keyboard.down("KeyW")
for (let i = 0; i < 100 && (await pos()).z > 16.7; i++) await page.waitForTimeout(25)
await page.waitForTimeout(150)
const under = (await player((p) => ({ eye: p.state.eyeHeight, z: p.pos.z }), 0)) as { eye: number; z: number }
for (let i = 0; i < 60 && (await pos()).z > 16.3; i++) await page.waitForTimeout(25)
await page.keyboard.up("KeyW")
await page.keyboard.up("KeyC")
const crawlTrace = (await player((p) => {
  const t = p.trace
  p.trace = null
  return t
}, 0)) as Sample[]
p = await pos()
check(p.z < 16.45, `crouched through a 1.17 m crawl space (z ${p.z.toFixed(2)})`)
check(under.eye <= 1.1, `eye ducked under it (${under.eye.toFixed(3)} m)`)
check(maxStep60(crawlTrace) < 0.03, `ducking is smooth (max ${(maxStep60(crawlTrace) * 100).toFixed(2)} cm per 60 Hz frame)`)

// Speeds (they set the body's animation cadence): walk, jog, crouch, and backwards/sideways at 0.68×.
async function speedOf(keys: string[]) {
  // The lobby (open floor), facing north.
  await place(0, 0.2, 19, 0)
  for (const k of keys) await page.keyboard.down(k)
  await page.waitForTimeout(700)
  const a = await player((p) => ({ x: p.pos.x, z: p.pos.z, t: performance.now() }), 0)
  await page.waitForTimeout(600)
  const b = await player((p) => ({ x: p.pos.x, z: p.pos.z, t: performance.now() }), 0)
  for (const k of keys) await page.keyboard.up(k)
  return Math.hypot(b.x - a.x, b.z - a.z) / ((b.t - a.t) / 1000)
}
const speeds = { walk: await speedOf(["KeyW"]), jog: await speedOf(["KeyW", "ShiftLeft"]), crouch: await speedOf(["KeyW", "KeyC"]), back: await speedOf(["KeyS"]), side: await speedOf(["KeyD"]) }
const near = (v: number, want: number) => Math.abs(v - want) < 0.12
check(
  near(speeds.walk, 1.6) && near(speeds.jog, 2.4) && near(speeds.crouch, 1.3) && near(speeds.back, 1.6 * 0.68) && near(speeds.side, 1.6 * 0.68),
  `speeds: walk ${speeds.walk.toFixed(2)}, jog ${speeds.jog.toFixed(2)}, crouch ${speeds.crouch.toFixed(2)}, back ${speeds.back.toFixed(2)}, side ${speeds.side.toFixed(2)} m/s`,
)

if (logFile) writeFileSync(logFile, JSON.stringify(traces))
check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`)
await browser.close()
process.exit(failed ? 1 : 0)
