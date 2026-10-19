// Headless ladder check: climbs the fire escape's drop ladder from the ground onto landing 1 with W, steps off onto
// the landing, walks back onto the hatch and descends with S to the ground, logging the eye every frame. Expects the
// dev server on :5196. Exits 1 on any failure.
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 800, height: 520 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.routeWebSocket(/.*/, () => {})
await page.goto("http://localhost:5196/?view=dock&only=terrain,facility")
await page.waitForFunction(() => {
  const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
  return !!s?.complete && s.ready
}, null, { timeout: 240_000 })

let failed = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failed++
}
type Sample = { t: number; dt: number; x: number; z: number; y: number; eye: number; grounded: boolean }
const P = "(globalThis.__afterhoursPlayer)"
const evalP = <T>(body: string): Promise<T> => page.evaluate(`(() => { const p = ${P}; ${body} })()`) as Promise<T>
const pos = () => evalP<{ x: number; y: number; z: number; grounded: boolean }>("return { ...p.pos, grounded: p.state.grounded }")

const ladder = await page.evaluate(() => {
  const ls = (globalThis as unknown as { __afterhoursPlayer: { ctx: { ladders: { min: number[]; max: number[] }[] } } }).__afterhoursPlayer.ctx.ladders
  return ls.find((l) => l.min[1] < 0.5 && l.max[0] < -55) ?? null
})
check(!!ladder, `drop ladder volume ${ladder ? `[${ladder.min.map((v) => v.toFixed(2))}]–[${ladder.max.map((v) => v.toFixed(2))}]` : "missing"}`)
if (!ladder) process.exit(1)
const top = ladder.max[1]
const lz = (ladder.min[2] + ladder.max[2]) / 2

/** Holds `key` until `until` holds (or `ms` passes), returning the per-frame trace. */
async function hold(key: string, until: (p: { x: number; y: number; z: number; grounded: boolean }) => boolean, ms: number) {
  await evalP("p.trace = []")
  await page.keyboard.down(key)
  const t0 = performance.now()
  while (!until(await pos()) && performance.now() - t0 < ms) await page.waitForTimeout(25)
  await page.keyboard.up(key)
  await page.waitForTimeout(250)
  return evalP<Sample[]>("const t = p.trace; p.trace = null; return t")
}
const maxStep = (tr: Sample[]) => Math.max(0, ...tr.slice(1).map((s, i) => (Math.abs(s.eye - tr[i]!.eye) / Math.max(s.dt, 1 / 240)) / 60))

// Up from the ground, facing the ladder (+x).
await evalP(`p.pos.x = -57.2; p.pos.z = ${lz}; p.pos.y = 0.3; p.yaw = -Math.PI / 2; p.pitch = 0; p.resetMotion()`)
await page.waitForTimeout(300)
const g0 = (await pos()).y
const up = await hold("KeyW", (p) => p.grounded && p.y > top - 0.5, 15_000)
let p = await pos()
const minY = Math.min(...up.filter((s) => s.y > g0 + 0.3).map((s) => s.y))
check(p.grounded && p.y > top - 0.3 && p.x > ladder.max[0], `W climbs and steps off onto the landing (at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`)
// (The one step down allowed is off the top of the ladder, 0.12 m, onto the landing grating.)
check(!up.some((s, i) => i > 0 && !s.grounded && s.y < up[i - 1]!.y - 0.05), `never slipped back on the way up (lowest after leaving the ground ${minY.toFixed(2)})`)
check(maxStep(up) < 0.035, `eye smooth climbing and stepping off (max ${(maxStep(up) * 100).toFixed(2)} cm per 60 Hz frame)`)

// Back onto the hatch from the landing (facing -x), then down with S.
await evalP("p.yaw = Math.PI / 2; p.pitch = -0.3")
await hold("KeyW", (p) => p.x < ladder.max[0] - 0.15, 2000)
p = await pos()
check(p.y > top - 0.3, `walked onto the hatch without falling (y ${p.y.toFixed(2)})`)
const down = await hold("KeyS", (p) => p.y < g0 + 0.02 && p.grounded, 15_000)
p = await pos()
check(Math.abs(p.y - g0) < 0.05 && !down.some((s, i) => i > 0 && s.y < down[i - 1]!.y - 0.1), `S descends to the ground without dropping (at ${p.y.toFixed(2)})`)
check(maxStep(down) < 0.035, `eye smooth descending (max ${(maxStep(down) * 100).toFixed(2)} cm per 60 Hz frame)`)
const outside = (p: { x: number; z: number }) => p.x < ladder.min[0] - 0.05 || p.x > ladder.max[0] + 0.05 || p.z < ladder.min[2] - 0.05 || p.z > ladder.max[2] + 0.05
await hold("KeyS", outside, 2000)
p = await pos()
check(outside(p) && Math.abs(p.y - g0) < 0.05, `S at the bottom steps back off the ladder (at ${p.x.toFixed(2)}, ${p.z.toFixed(2)})`)

// Mid-ladder: no input holds on, W with the view pitched well down descends.
await evalP(`p.pos.x = ${(ladder.min[0] + ladder.max[0]) / 2}; p.pos.z = ${lz}; p.pos.y = 2.0; p.yaw = -Math.PI / 2; p.pitch = 0; p.resetMotion()`)
await page.waitForTimeout(600)
p = await pos()
check(Math.abs(p.y - 2.0) < 0.05, `hangs on mid-ladder with no input (y ${p.y.toFixed(2)})`)
await evalP("p.pitch = -1")
await hold("KeyW", (p) => p.y < 1.2, 2000)
p = await pos()
check(p.y < 1.3, `W looking down descends (y ${p.y.toFixed(2)})`)

// The caged ladder from the top landing over the parapet to the roof (facing the building, +x).
const cage = await page.evaluate(() => {
  const ls = (globalThis as unknown as { __afterhoursPlayer: { ctx: { ladders: { min: number[]; max: number[] }[] } } }).__afterhoursPlayer.ctx.ladders
  return ls.find((l) => l.max[1] > 15) ?? null
})
if (cage) {
  const cx = (cage.min[0] + cage.max[0]) / 2
  const cz = (cage.min[2] + cage.max[2]) / 2
  await evalP(`p.pos.x = ${cx}; p.pos.z = ${cz}; p.pos.y = ${cage.min[1] + 1.65}; p.yaw = -Math.PI / 2; p.pitch = 0; p.resetMotion()`)
  await page.waitForTimeout(300)
  const tr = await hold("KeyW", (p) => p.grounded && p.y > cage.max[1] - 1, 20_000)
  p = await pos()
  check(p.grounded && p.y > cage.max[1] - 1 && maxStep(tr) < 0.035, `caged ladder: climbs onto the roof (at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}; eye max ${(maxStep(tr) * 100).toFixed(2)} cm per frame)`)
}

// Fire-escape doors (panic bar + closer, opening out across the 0.75 m landing walkway): with a leaf standing open,
// walking along the walkway into it from the side it opens towards swings it back, so the way north is never shut.
for (const id of ["fire-escape-1", "fire-escape-2", "fire-escape-3", "fire-escape-4"]) {
  const info = await page.evaluate((id) => {
    const d = (globalThis as unknown as { __afterhoursDoors: { get(id: string): { hy: number; open(): void } | undefined } }).__afterhoursDoors.get(id)
    if (!d) return null
    d.open()
    return { y: d.hy }
  }, id)
  if (!info) {
    check(false, `${id} registered`)
    continue
  }
  await page.waitForTimeout(2800)
  await evalP(`p.pos.x = -55.39; p.pos.z = 0.3; p.pos.y = ${info.y + 0.02}; p.yaw = 0; p.pitch = 0; p.resetMotion()`)
  await page.waitForTimeout(200)
  await hold("KeyW", (p) => p.z < -1.4, 4000)
  p = await pos()
  check(p.z < -1.2, `${id}: open leaf across the landing doesn't trap the walkway (reached z ${p.z.toFixed(2)})`)
}

// Mantle: the loading dock's edge (1.25 m platform), Space from the yard facing it.
const dock = await page.evaluate(() => {
  const cs = (globalThis as unknown as { __afterhoursPlayer: { ctx: { colliders: { min: number[]; max: number[] }[] } } }).__afterhoursPlayer.ctx.colliders
  const b = cs.find((c) => Math.abs(c.max[1] - 1.25) < 0.06 && c.min[0] < -30 && c.max[0] > -30 && c.max[2] <= -21.5 && c.max[0] - c.min[0] > 5)
  return b ? { min: b.min, max: b.max } : null
})
if (dock) {
  const zStart = dock.min[2] - 0.75
  await evalP(`p.pos.x = -30; p.pos.y = 0.6; p.pos.z = ${zStart}; p.yaw = Math.PI; p.pitch = 0; p.resetMotion()`)
  await page.waitForTimeout(500)
  const g = (await pos()).y
  await page.keyboard.press("Space")
  await page.waitForTimeout(1800)
  p = await pos()
  check(Math.abs(p.y - 1.25) < 0.05 && p.z > dock.min[2], `mantle onto the dock edge from the yard (${(1.25 - g).toFixed(2)} m: now at y ${p.y.toFixed(2)}, z ${p.z.toFixed(2)})`)
} else check(false, "dock edge collider found")

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`)
await browser.close()
process.exit(failed ? 1 : 0)
