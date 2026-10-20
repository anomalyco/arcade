// First-person chase-and-escape video (1280×720, muted) plus the top-down debug trace and the hunter's CPU cost.
// The Wendigo comes up the ground-floor spine, upright, investigating; at ~19.5 m the player's torch finds it and they
// run: it spots them, screams and charges on all fours; the player rounds the corner into the link, crosses the lobby into the
// security office (0-38) and crouches in the dark far corner, watching the door; it searches and gives up.
//
//   bun scripts/hunter/video.ts [--seed 11]
// Output: captures/hunter/chase-escape.mp4, captures/hunter/chase-escape-trace.png
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { OUT, hunterState, inPage, launch, place, sleep } from "./lib"

const seedArg = process.argv.indexOf("--seed")
const seed = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 11
const VID = `${OUT}/video-tmp`
rmSync(VID, { recursive: true, force: true })
mkdirSync(VID, { recursive: true })
process.env.HUNTER_VIDEO = VID
const { browser, context, page, errors, readyS } = await launch(`hunter=-50,0,4&hunterSeed=${seed}&view=corridor`)
await page.mouse.click(640, 360)
const Y0 = 0.16

await inPage(page, ({ H }) => {
  const h = H.handle.hunter
  h.hold(9999)
  h.ctx.settings["hunter.searchTime"] = 22
  // Cost: time spent in the hunter's frame.
  const g = globalThis as unknown as { __hcost: number[] }
  g.__hcost = []
  const inner = H.handle.update
  H.handle.update = (dt: number) => {
    const t0 = performance.now()
    inner(dt)
    g.__hcost.push(performance.now() - t0)
  }
  // Hide the debug hint strip for the video.
  const hud = document.querySelector<HTMLElement>("#hud")
  if (hud) hud.style.display = "none"
})
await place(page, -9, Y0, 0, Math.PI / 2, -0.02)
await sleep(1200)

const keys = (codes: string[], down: boolean) =>
  inPage(page, (_a, a: { codes: string[]; down: boolean }) => {
    for (const code of a.codes) dispatchEvent(new KeyboardEvent(a.down ? "keydown" : "keyup", { code }))
  }, { codes, down })
const tap = (code: string) => keys([code], true).then(() => keys([code], false))

/** Smooth autopilot along a nav route (the view turns at most 9 rad/s; it faces the way before setting off). */
async function pilot(x: number, z: number, gait: "run" | "walk" | "crouch", timeoutS = 30) {
  const codes = ["KeyW", ...(gait === "run" ? ["ShiftLeft"] : gait === "crouch" ? ["KeyC"] : [])]
  await inPage(page, ({ H, P }, a: { x: number; z: number }) => {
    const s = Math.round((P.pos.y - 0.15) / 3.8)
    const r = H.nav.route({ x: P.pos.x, z: P.pos.z, s }, { x: a.x, z: a.z, s })
    const pts = r ? r.pts.slice(1) : [{ x: a.x, z: a.z }]
    const g = globalThis as unknown as { __pilot: { pts: { x: number; z: number }[]; i: number; done: boolean; t: number } }
    g.__pilot = { pts, i: 0, done: false, t: performance.now() }
    const step = () => {
      const pl = g.__pilot
      if (pl.done) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - pl.t) / 1000)
      pl.t = now
      const w = pl.pts[pl.i]
      if (!w) {
        pl.done = true
        return
      }
      const dx = w.x - P.pos.x
      const dz = w.z - P.pos.z
      if (Math.hypot(dx, dz) < 0.6) pl.i++
      const want = Math.atan2(-dx, -dz)
      const d = Math.atan2(Math.sin(want - P.yaw), Math.cos(want - P.yaw))
      P.yaw += Math.sign(d) * Math.min(Math.abs(d), 9 * dt)
      P.pitch += (-0.05 - P.pitch) * Math.min(1, dt * 4)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, { x, z })
  // Face the way first (a player turns before running), then go.
  await inPage(page, ({ P }) => new Promise<void>((res) => {
    const pl = (globalThis as unknown as { __pilot: { pts: { x: number; z: number }[] } }).__pilot
    const w = pl.pts[0]
    if (!w) return res()
    const f = () => {
      const want = Math.atan2(-(w.x - P.pos.x), -(w.z - P.pos.z))
      if (Math.abs(Math.atan2(Math.sin(want - P.yaw), Math.cos(want - P.yaw))) < 0.6) return res()
      requestAnimationFrame(f)
    }
    f()
  }))
  await keys(codes, true)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutS * 1000) {
    if (await inPage(page, () => (globalThis as unknown as { __pilot: { done: boolean } }).__pilot.done)) break
    await sleep(80)
  }
  await keys(codes, false)
  await inPage(page, () => ((globalThis as unknown as { __pilot: { done: boolean } }).__pilot.done = true))
}
/** Turns the view smoothly to face (x, z) over `s` seconds. */
const face = (x: number, z: number, s = 0.8, pitch = -0.04) =>
  inPage(page, ({ P }, a: number[]) => new Promise<void>((res) => {
    const y0 = P.yaw
    const want = Math.atan2(-(a[0] - P.pos.x), -(a[1] - P.pos.z))
    const d = Math.atan2(Math.sin(want - y0), Math.cos(want - y0))
    const p0 = P.pitch
    const t0 = performance.now()
    const f = () => {
      const u = Math.min(1, (performance.now() - t0) / (a[2] * 1000))
      const e = u * u * (3 - 2 * u)
      P.yaw = y0 + d * e
      P.pitch = p0 + (a[3] - p0) * e
      if (u < 1) requestAnimationFrame(f)
      else res()
    }
    f()
  }), [x, z, s, pitch])
const until = async (pred: string, timeoutS: number) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutS * 1000) {
    if (await inPage(page, ({ H }, src: string) => !!new Function("h", `return (${src})`)(H.hunter), pred)) return (Date.now() - t0) / 1000
    await sleep(80)
  }
  return -1
}

const since = await inPage(page, ({ H }) => H.hunter.time as number)
// Torch off: it comes up the lit corridor, upright, investigating a sound near the player.
await inPage(page, ({ H }) => {
  const h = H.hunter
  h.spawn(-36, 0, 0, { toward: { x: -14, z: 0, s: 0 } })
  h.grace = 0
})
// At ~19.5 m the player's torch goes on and finds it; they run at once; it spots them as they go.
await until(`h.pos.x > -28.5`, 30)
await tap("KeyF")
await sleep(250)
await page.screenshot({ path: `${OUT}/chase-escape-spot.png` })
const fleeing = pilot(0, 0.2, "run", 8)
const spotted = await until(`h.mode === "hunt"`, 3)
console.log(`spotted after ${spotted.toFixed(1)} s`, JSON.stringify(await hunterState(page)))
await fleeing
await pilot(0, 11, "run", 6)
await pilot(10.5, 14, "run", 6)
await tap("KeyF")
await pilot(16.2, 20.6, "crouch", 14)
await keys(["KeyC"], true)
await face(9.1, 12.4, 1.2, -0.06)
const lost = await until(`h.mode === "search" || h.mode === "roam" || h.catches > 0`, 20)
console.log(`lost after ${lost.toFixed(1)} s`, JSON.stringify(await hunterState(page)))
const gaveUp = await until(`(h.mode === "roam" || h.mode === "ambush") || h.catches > 0`, 45)
await sleep(3000)
await keys(["KeyC"], false)
const st = await hunterState(page)
console.log(`gave up after ${gaveUp.toFixed(1)} s`, JSON.stringify(st))
const cost = await inPage(page, () => {
  const c = (globalThis as unknown as { __hcost: number[] }).__hcost.slice().sort((a, b) => a - b)
  const fm = (globalThis as unknown as { __ashwood: { frameMs: number[] } }).__ashwood.frameMs.slice().sort((a, b) => a - b)
  return { n: c.length, median: +c[c.length >> 1]!.toFixed(3), p95: +c[Math.floor(c.length * 0.95)]!.toFixed(3), max: +c[c.length - 1]!.toFixed(2), frameMedian: +fm[fm.length >> 1]!.toFixed(1) }
})
console.log("hunter cost ms/frame:", JSON.stringify(cost))
const log = await inPage(page, ({ H }) => H.hunter.log.map((l: { t: number; event: string }) => `${l.t} ${l.event}`))
console.log(log.slice(-30).join("\n"))
const url = await inPage(page, ({ H }, a: number) => H.trace(0, 10, a), since)
writeFileSync(`${OUT}/chase-escape-trace.png`, Buffer.from(url.split(",")[1]!, "base64"))
await context.close()
await browser.close()
const webm = readdirSync(VID).find((f) => f.endsWith(".webm"))
if (webm) {
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", String(Math.max(0, readyS + 1.2)), "-i", `${VID}/${webm}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", `${OUT}/chase-escape.mp4`])
  if (p.exitCode !== 0) renameSync(`${VID}/${webm}`, `${OUT}/chase-escape.webm`)
}
rmSync(VID, { recursive: true, force: true })
console.log(`caught: ${st.catches}; errors: ${errors.slice(0, 3).join(" | ") || "none"}`)
