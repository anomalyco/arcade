// Scripted hunter scenarios, headless (debug page, `?hunter`): each places the creature and the player, drives the
// player with real key presses along nav routes (an autopilot turns the view), and checks what the hunter does.
//
//   bun scripts/hunter/scenarios.ts                 # all
//   bun scripts/hunter/scenarios.ts noise stairs    # some: noise sight escape door stairs sprint lift below
//
// Writes captures/hunter/scenario-<name>.png (top-down trace) and prints a PASS/FAIL line per check.
import { mkdirSync, writeFileSync } from "node:fs"
import type { Page } from "playwright-core"
import { OUT, frames, hunterState, inPage, launch, place, sleep } from "./lib"

const want = process.argv.slice(2)
const run = (name: string) => !want.length || want.includes(name)
mkdirSync(OUT, { recursive: true })

const { browser, page, errors } = await launch("hunter=-50,0,4&hunterSeed=11&hunterDebug&view=corridor")
// Unlock audio (a click on the canvas) so the creature's sounds are really played and logged.
await page.mouse.click(640, 360)
await inPage(page, ({ H }) => H.handle.hunter.hold(9999))
await sleep(1500)

let failed = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`)
  if (!ok) failed++
}
const Y = (s: number) => 0.15 + s * 3.8 + 0.01

/** Holds keys (physical codes) via window events, as the player's controller reads them. */
const keys = (codes: string[], down: boolean) =>
  inPage(page, (_a, a: { codes: string[]; down: boolean }) => {
    for (const code of a.codes) dispatchEvent(new KeyboardEvent(a.down ? "keydown" : "keyup", { code }))
  }, { codes, down })

/** Walks the player along the nav route to (x, z) on their storey: "run" | "walk" | "crouch". Resolves on arrival. */
async function pilot(x: number, z: number, gait: "run" | "walk" | "crouch", timeoutS = 40) {
  const codes = ["KeyW", ...(gait === "run" ? ["ShiftLeft"] : gait === "crouch" ? ["KeyC"] : [])]
  await inPage(page, ({ H, P }, a: { x: number; z: number }) => {
    const s = Math.round((P.pos.y - 0.15) / 3.8)
    const r = H.nav.route({ x: P.pos.x, z: P.pos.z, s }, { x: a.x, z: a.z, s })
    const pts = r ? r.pts.slice(1) : [{ x: a.x, z: a.z }]
    const g = globalThis as unknown as { __pilot: { pts: { x: number; z: number }[]; i: number; done: boolean } }
    g.__pilot = { pts, i: 0, done: false }
    const step = () => {
      const pl = g.__pilot
      if (pl.done) return
      const w = pl.pts[pl.i]
      if (!w) {
        pl.done = true
        return
      }
      const dx = w.x - P.pos.x
      const dz = w.z - P.pos.z
      if (Math.hypot(dx, dz) < 0.45) pl.i++
      else P.yaw = Math.atan2(-dx, -dz)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, { x, z })
  await keys(codes, true)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutS * 1000) {
    const done = await inPage(page, () => (globalThis as unknown as { __pilot: { done: boolean } }).__pilot.done)
    if (done) break
    await sleep(100)
  }
  await keys(codes, false)
  await inPage(page, () => ((globalThis as unknown as { __pilot: { done: boolean } }).__pilot.done = true))
}

async function trace(name: string, s: number, since: number) {
  const url = await inPage(page, ({ H }, a: number[]) => H.trace(a[0], 10, a[1]), [s, since])
  writeFileSync(`${OUT}/scenario-${name}.png`, Buffer.from(url.split(",")[1]!, "base64"))
}
const hTime = () => inPage(page, ({ H }) => H.hunter.time as number)
const setH = (fn: string) => inPage(page, ({ H }, src: string) => new Function("h", "H", src)(H.hunter, H), fn)
/** Waits until `pred` (page-side source over h = hunter) holds, or the timeout. */
async function until(pred: string, timeoutS: number) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutS * 1000) {
    if (await inPage(page, ({ H }, src: string) => !!new Function("h", "H", `return (${src})`)(H.hunter, H), pred)) return (Date.now() - t0) / 1000
    await sleep(100)
  }
  return -1
}
async function reset(cx: number, cz: number, cs: number, heading: number, hold = 9999) {
  await setH(`h.release(); h.spawn(${cx}, ${cz}, ${cs}); h.grace = 0; h.heading = ${heading}; h.hold(${hold}); h.heard.length = 0; h.heat.length = 0; h.memory = null; h.awareness = 0; h.catches = 0`)
}
async function lights(page: Page, on: boolean) {
  await inPage(page, ({ P }, on: boolean) => {
    if (P.flashlight !== on) dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF" }))
    dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF" }))
  }, on)
}

// ------------------------------------------------------------------------------------------------ noise
if (run("noise")) {
  console.log("\n# noise attracts it (storey 2 linoleum corridor: crouch-walking 8–10 m off unheard, walking closer heard → investigate)")
  await place(page, -10, Y(2), 0, -Math.PI / 2)
  await reset(-20, 0, 2, Math.PI)
  const since = await hTime()
  await pilot(-11.5, 0, "crouch", 6)
  const quiet = await hunterState(page)
  check(quiet.mode === "roam", `crouch-walk unheard: mode ${quiet.mode}`)
  await pilot(-15, 0, "walk", 6)
  const heard = await until(`h.heard.some((e) => e.heard && e.e.kind === "step") && h.mode !== "roam"`, 3)
  const st = await hunterState(page)
  const goal = await inPage(page, ({ H }) => H.hunter.goal)
  check(heard >= 0, `walking within ~6 m heard → reacts (${st.mode}), goal ${goal ? `${goal.x.toFixed(1)},${goal.z.toFixed(1)}` : "-"}, player at ${st.player.x},${st.player.z}`)
  const arrived = await until(`Math.hypot(h.pos.x - (${st.player.x}), h.pos.z - (${st.player.z})) < 6`, 25)
  check(arrived >= 0, `went to the noise (${arrived.toFixed(1)} s)`)
  await setH(`h.release(); h.hold(9999)`)
  await trace("noise", 2, since)
}

// ------------------------------------------------------------------------------------------------ sight
if (run("sight")) {
  console.log("\n# running in its sight triggers a chase (storey 1 corridor, 12 m, flashlight on)")
  await place(page, -14, Y(1), 0, -Math.PI / 2)
  await reset(-26, 0, 1, Math.PI / 2)
  const since = await hTime()
  await lights(page, true)
  const p = pilot(14, 0, "run", 4)
  const t = await until(`h.mode === "hunt"`, 4)
  await p
  check(t >= 0, `hunt within ${t.toFixed(2)} s`)
  await sleep(1500)
  const st = await hunterState(page)
  check(st.mode === "hunt" && st.x > -24, `chasing: mode ${st.mode}, creature x ${st.x}`)
  await lights(page, false)
  await trace("sight", 1, since)
  await setH(`h.hold(9999)`)
}

// ------------------------------------------------------------------------------------------------ escape
if (run("escape")) {
  console.log("\n# breaking line of sight and going quiet escapes (storey 1: seen in the spine, sprint, duck into the cubicles, crouch)")
  await inPage(page, ({ H }) => (H.handle.hunter.ctx.settings["hunter.searchTime"] = 25))
  await place(page, -6, Y(1), 0, Math.PI / 2)
  await reset(-24, 0, 1, Math.PI / 2)
  const since = await hTime()
  await lights(page, true)
  const t = await until(`h.mode === "hunt"`, 4)
  check(t >= 0, `hunt began (${t.toFixed(2)} s)`)
  // Away east down the spine, then off it among the cubicle pods; torch off, crouched and still behind a panel.
  await pilot(5, 0.3, "run", 6)
  await lights(page, false)
  await pilot(7.6, 9.4, "crouch", 12)
  await keys(["KeyC"], true)
  const lost = await until(`h.mode === "search" || h.catches > 0`, 20)
  check(lost >= 0 && (await hunterState(page)).catches === 0, `lost: search after ${lost.toFixed(1)} s`)
  const gaveUp = await until(`h.mode === "roam" || h.mode === "ambush" || h.catches > 0`, 45)
  await keys(["KeyC"], false)
  const st = await hunterState(page)
  check(gaveUp >= 0 && st.catches === 0, `escaped: ${st.catches} catches, mode ${st.mode}`)
  await trace("escape", 1, since)
  await inPage(page, ({ H }) => (H.handle.hunter.ctx.settings["hunter.searchTime"] = 35))
}

// ------------------------------------------------------------------------------------------------ door
if (run("door")) {
  console.log("\n# hiding behind a closed door loses it (storey 3: heard, then out of sight into a room, door shut, crouched)")
  await inPage(page, ({ H }) => (H.handle.hunter.ctx.settings["hunter.searchTime"] = 25))
  // The room: the storey-3 room with a door on the spine nearest x = -18.
  const room = await inPage(page, ({ H }) => {
    const nav = H.nav
    const cands = nav.rooms
      .filter((r: { s: number; doors: number[]; rect: { z0: number } }) => r.s === 3 && r.doors.length === 1 && r.rect.z0 < -1)
      .map((r: { doors: number[]; px: number; pz: number; id: string; rect: object; spots: number[][] }) => ({ r, d: nav.doors[r.doors[0]!] }))
      .filter((e: { d: { cz: number } }) => Math.abs(e.d.cz + 1.7) < 0.3)
      .sort((a: { d: { cx: number } }, b: { d: { cx: number } }) => Math.abs(a.d.cx + 18) - Math.abs(b.d.cx + 18))[0]
    return cands ? { id: cands.r.id, door: cands.d.id, dx: cands.d.cx, dz: cands.d.cz, rect: cands.r.rect } : null
  })
  if (!room) check(false, "no storey-3 room with a spine door found")
  else {
    console.log(`  room ${room.id}, door ${room.door} at ${room.dx.toFixed(1)},${room.dz.toFixed(1)}`)
    await inPage(page, ({ D }, id: string) => D.get(id).open(), room.door)
    await place(page, room.dx + 3, Y(3), 0, Math.PI / 2)
    await sleep(2500)
    // It is far down the corridor; the player walks in, shuts the door and crouches in the far corner (dark).
    await reset(room.dx - 24, 0, 3, -Math.PI / 2)
    const since = await hTime()
    await pilot(room.dx, room.dz - 1.4, "walk", 4)
    await inPage(page, ({ D }, id: string) => D.get(id).close(), room.door)
    const corner = { x: room.rect.x0 + 0.9, z: room.rect.z0 + 0.9 }
    await pilot(corner.x, corner.z, "crouch", 25)
    await keys(["KeyC"], true)
    // Something clatters at the door (the player's own noise, say): it comes to look.
    await inPage(page, ({ H }, d: number[]) => H.noise({ x: d[0], y: 0.15 + 3 * 3.8, z: d[1] + 0.8 }, 30, "knock"), [room.dx, room.dz])
    const t = await until(`h.heard.some((e) => e.heard && e.e.kind === "knock")`, 4)
    check(t >= 0, `heard the noise at the door (${t.toFixed(2)} s)`)
    const st0 = await hunterState(page)
    console.log(`  hidden at ${st0.player.x},${st0.player.z}; hunter ${st0.mode} at ${st0.x},${st0.z}`)
    // It comes to the noise, checks round it, and moves on.
    const came = await until(`Math.hypot(h.pos.x - (${room.dx}), h.pos.z) < 6`, 40)
    check(came >= 0, `came to where it heard you (${came.toFixed(1)} s)`)
    const gaveUp = await until(`(h.mode === "roam" && Math.hypot(h.pos.x - (${room.dx}), h.pos.z - (${room.dz})) > 12) || h.catches > 0`, 60)
    await keys(["KeyC"], false)
    const st = await hunterState(page)
    const opened = await inPage(page, ({ H }) => H.hunter.log.filter((l: { event: string }) => /opens|bashes/.test(l.event)).map((l: { event: string }) => l.event).slice(-4))
    check(gaveUp >= 0 && st.catches === 0, `lost behind the door: ${st.catches} catches, mode ${st.mode} (doors it opened: ${opened.join(", ") || "none"})`)
    await trace("door", 3, since)
  }
  await inPage(page, ({ H }) => (H.handle.hunter.ctx.settings["hunter.searchTime"] = 35))
}

// ------------------------------------------------------------------------------------------------ stairs
if (run("stairs")) {
  console.log("\n# stairs between storeys (a loud noise on storey 2 draws it up from the ground floor, then back down)")
  await place(page, 25, Y(4), 0, 0)
  await reset(-20, 0, 0, Math.PI / 2, 1)
  const since = await hTime()
  await inPage(page, ({ H }) => H.noise({ x: -30, y: 0.15 + 2 * 3.8, z: 0 }, 70, "knock"))
  const up = await until(`h.s === 2 && Math.abs(h.pos.y - 7.75) < 0.2`, 90)
  check(up >= 0, `reached storey 2 (${up.toFixed(1)} s)`)
  const ys = await inPage(page, ({ H }) => H.hunter.trail.filter((p: { x: number; z: number }) => p.x < -39 && p.z > 16).length)
  check(ys > 4, `went by the stair core (${ys} trail samples in it)`)
  await setH(`h.hold(0.5)`)
  await sleep(800)
  await inPage(page, ({ H }) => H.noise({ x: -20, y: 0.15 + 3.8, z: 0 }, 70, "knock"))
  const down = await until(`h.s === 1 && Math.abs(h.pos.y - 3.95) < 0.2`, 60)
  check(down >= 0, `back down to storey 1 (${down.toFixed(1)} s)`)
  await trace("stairs", 2, since)
}

// ------------------------------------------------------------------------------------------------ sprint
if (run("sprint")) {
  console.log("\n# sprinting is heard across floors (creature on storey 0; the player walks, then sprints back and forth, on storey 3)")
  await place(page, -32, Y(3), 0, -Math.PI / 2)
  await reset(-25, 0, 0, Math.PI / 2)
  const since = await hTime()
  // Walking the storey-3 spine: unheard three floors down.
  await pilot(-20, 0, "walk", 10)
  const walked = await hunterState(page)
  check(walked.mode === "roam", `walking on storey 3 unheard from storey 0 (mode ${walked.mode})`)
  // Sprinting the storey-3 spine, back and forth, as a player tearing through the halls would.
  const t0 = Date.now()
  let running = true
  const sprint = (async () => {
    for (let leg = 0; running && leg < 12; leg++) await pilot(leg % 2 ? -30 : 12, 0, "run", 12)
  })()
  const heard = await until(`h.mode === "hunt"`, 6)
  check(heard >= 0, `sprint heard from three floors down → hunt (${heard.toFixed(2)} s)`)
  // Speed on the stair (on all fours, at rush speed).
  await inPage(page, ({ H }) => {
    const g = globalThis as unknown as { __stair: { v: number; quad: number; n: number } }
    g.__stair = { v: 0, quad: 0, n: 0 }
    const f = () => {
      const h = H.hunter
      if (h.pos.x < -39.5 && h.pos.z > 18.7 && h.mode === "hunt") {
        g.__stair.v = Math.max(g.__stair.v, Math.hypot(h.vel.x, h.vel.z))
        g.__stair.n++
        if (h.stance === "quad") g.__stair.quad++
      }
      if (h.s < 3 || h.pos.z > 16) requestAnimationFrame(f)
    }
    requestAnimationFrame(f)
  })
  const up = await until(`h.s === 3 && Math.abs(h.pos.y - ${Y(3)}) < 0.2`, 40)
  const tUp = (Date.now() - t0) / 1000
  check(up >= 0 && tUp < 30, `reached storey 3 ${tUp.toFixed(1)} s after the sprint began (target well under 30 s)`)
  const stair = await inPage(page, () => (globalThis as unknown as { __stair: { v: number; quad: number; n: number } }).__stair)
  check(stair.n > 0 && stair.quad === stair.n && stair.v > 4, `stairs on all fours at speed (max ${stair.v.toFixed(1)} m/s, quad ${stair.quad}/${stair.n} samples)`)
  const caught = await until(`h.catches > 0`, 40)
  const tCaught = (Date.now() - t0) / 1000
  running = false
  await inPage(page, () => ((globalThis as unknown as { __pilot: { done: boolean } }).__pilot.done = true))
  await sprint
  check(caught >= 0, `sprinting is not safe: caught ${tCaught.toFixed(1)} s after the sprint began`)
  await trace("sprint", 3, since)
  await setH(`h.release(); h.hold(9999)`)
}

// ------------------------------------------------------------------------------------------------ lift
if (run("lift")) {
  console.log("\n# the lift is a noise (a clunk at the car, parked at the ground floor, draws it up the storey-1 hall)")
  await place(page, 25, Y(4), 0, 0)
  await reset(-40.2, 4, 1, Math.PI)
  await inPage(page, ({ H }) => H.lift()?.clunk(1))
  const t = await until(`h.mode === "investigate"`, 2)
  const goal = await inPage(page, ({ H }) => H.hunter.goal)
  check(t >= 0 && goal && goal.x < -35 && goal.z > 12, `lift clunk heard → investigate toward the lift lobby (goal ${goal ? `${goal.x.toFixed(1)},${goal.z.toFixed(1)}` : "-"})`)
}

// ------------------------------------------------------------------------------------------------ below
if (run("below")) {
  console.log("\n# sounds from the floor below match its position (player still on storey 1; creature walks storey 0 under them)")
  await place(page, -20, Y(1), 0, 0)
  await reset(-34, 0, 0, Math.PI / 2, 1)
  await inPage(page, ({ H }) => {
    H.hunter.voice.log.length = 0
    H.hunter.ctx.settings["hunter.speedInvestigate"] = 1.2
  })
  await sleep(300)
  await inPage(page, ({ H }) => H.noise({ x: -4, y: 0.16, z: 0 }, 40, "knock"))
  await until(`Math.hypot(h.pos.x + 4, h.pos.z) < 3`, 45)
  const res = await inPage(page, ({ H }) => {
    const h = H.hunter
    const steps = h.voice.log.filter((l: { id: string }) => l.id.startsWith("foot-"))
    const out = steps.map((l: { t: number; x: number; y: number; z: number; walls: number; heard: number }) => {
      // Nearest trail sample in time (trail is on the hunter clock: map by position instead).
      let best = Infinity
      for (const p of h.trail) best = Math.min(best, Math.hypot(p.x - l.x, p.z - l.z))
      return { x: l.x, y: l.y, z: l.z, walls: l.walls, heard: l.heard, off: +best.toFixed(2) }
    })
    return { n: steps.length, played: h.voice.log.length, sfx: (globalThis as unknown as { __afterhoursAudio?: { sfx: { stats: { played: Record<string, number> } } } }).__afterhoursAudio?.sfx.stats.played, out }
  })
  await inPage(page, ({ H }) => (H.hunter.ctx.settings["hunter.speedInvestigate"] = 1.8))
  const n = res.out.length
  const onFloor = res.out.filter((s: { y: number }) => s.y < 1).length
  const placed = res.out.filter((s: { off: number }) => s.off < 1.2).length
  const muffled = res.out.filter((s: { walls: number }) => s.walls >= 1.5).length
  console.log(`  ${n} footsteps logged; sample: ${JSON.stringify(res.out.filter((_: unknown, i: number) => i % Math.max(1, Math.floor(n / 6)) === 0))}`)
  console.log(`  engine played: ${JSON.stringify(res.sfx)}`)
  check(n > 5, `footsteps logged while it walked (${n})`)
  check(onFloor === n, `every step at storey-0 height (${onFloor}/${n})`)
  check(placed === n, `every step within 1.2 m of the creature's path (${placed}/${n})`)
  check(muffled === n, `every step occluded by the slab (walls ≥ 1.5: ${muffled}/${n})`)
  const nearest = res.out.reduce((a: { heard: number }, b: { heard: number }) => (b.heard > a.heard ? b : a), res.out[0] ?? { heard: 0 })
  check(Math.abs((nearest as { x: number }).x + 20) < 6, `loudest step right under the player (x ${(nearest as { x: number }).x}, player x -20)`)
}

await frames(page, 2)
console.log(`\n${failed ? `${failed} FAILED` : "all passed"}; page errors: ${errors.length ? errors.slice(0, 4).join(" | ") : "none"}`)
await browser.close()
process.exit(failed ? 1 : 0)
