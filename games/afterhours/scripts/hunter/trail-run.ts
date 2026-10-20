// A scripted run of the post-reveal key trail against the hunter, headless, to measure how often it catches you.
//   Hide (out of 3-08, which it comes for: into 3-07 next door, door shut, crouched in the dark far corner) until
//   `lostPlayerFor()` passes 20 s, then the trail (game/objectives.ts): the vehicle sign-out by 3-08 → the locked key
//   cabinet in 0-30 (a metal rattle, 8 m) → the cabinet key from Security's key box in 0-38 (8 m) → back to 0-30 for the
//   Truck 2 keys (8 m) → out by the west staff door, across the dock court to the motor-pool shed: the engine (60 m)
//   and the roll-up (32 m, every 2 s), 10 s to get away. The hunter's trail is kept in step (`setTrail`). Caught at any
//   point: a failed run.
// Policies (what a player can know: the creature's sound, i.e. its distance with 6 m per storey between):
//   careful   walks, torch off; crouch-walks when it's within 18 m; within 10 m on the same storey (or hunting) it
//             stops, crouched, until it is 14 m off again (at most 30 s);
//   careless  sprints the whole way, torch on.
//
//   bun scripts/hunter/trail-run.ts careful 3 [seed0]   # policy, runs, first seed
import { appendFileSync, writeFileSync } from "node:fs"
import { OUT, inPage, launch, place, sleep } from "./lib"

const policy = (process.argv[2] ?? "careful") as "careful" | "careless"
const runs = Number(process.argv[3] ?? 3)
const seed0 = Number(process.argv[4] ?? 100)
const Y = (s: number) => 0.15 + s * 3.8 + 0.01
const LOG = `${OUT}/trail-run-${policy}.log`
writeFileSync(LOG, "")
const results: string[] = []

for (let run = 0; run < runs; run++) {
  const seed = seed0 + run
  const { browser, page, errors } = await launch(`hunter=-50,0,4&hunterSeed=${seed}&view=corridor`)
  await page.mouse.click(640, 360)
  // The hunter as after the reveal: in through the lobby, coming for 3-08.
  await inPage(page, ({ H }) => {
    const h = H.hunter
    h.hold(1)
    H.handle.start()
    h.catches = 0
  })
  // The player is by the desk in 3-08 at the reveal (the chapter's spot).
  await place(page, 8.45, Y(3), -12.45, 0)
  const keys = new Set<string>()
  const setKeys = async (want: string[]) => {
    const add = want.filter((k) => !keys.has(k))
    const del = [...keys].filter((k) => !want.includes(k))
    if (!add.length && !del.length) return
    await inPage(page, (_a, a: { add: string[]; del: string[] }) => {
      for (const code of a.del) dispatchEvent(new KeyboardEvent("keyup", { code }))
      for (const code of a.add) dispatchEvent(new KeyboardEvent("keydown", { code }))
    }, { add, del })
    for (const k of del) keys.delete(k)
    for (const k of add) keys.add(k)
  }
  if (policy === "careless") await inPage(page, () => (dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF" })), dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF" }))))
  // Page-side autopilot: follows a nav route to __drive.target while __drive.go; opens doors in its way (as E would).
  await inPage(page, ({ H, P, D }) => {
    const g = globalThis as unknown as { __drive: { target: { x: number; z: number; s: number } | null; go: boolean; pts: { x: number; z: number }[]; i: number; at: number; arrived: boolean } }
    g.__drive = { target: null, go: false, pts: [], i: 0, at: 0, arrived: false }
    const step = () => {
      const d = g.__drive
      const t = d.target
      if (t) {
        const s = Math.round((P.pos.y - 0.15) / 3.8)
        if (!d.pts.length || performance.now() - d.at > 4000) {
          const r = H.nav.route({ x: P.pos.x, z: P.pos.z, s }, t)
          d.pts = r ? r.pts.slice(1) : []
          d.i = 0
          d.at = performance.now()
        }
        const w = d.pts[d.i]
        // Out of waypoints short of the target (a bad snap, a shove): route again.
        if (!w) d.pts = []
        else {
          const dx = w.x - P.pos.x
          const dz = w.z - P.pos.z
          if (Math.hypot(dx, dz) < 0.5) d.i++
          else P.yaw = Math.atan2(-dx, -dz)
          for (const nd of H.nav.doors) if (nd.h.amount < 0.5 && Math.abs(nd.h.hy - P.pos.y) < 0.6 && Math.hypot(nd.cx - P.pos.x, nd.cz - P.pos.z) < 1.3) D.get(nd.id)?.open()
        }
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  const state = () =>
    inPage(page, ({ H, P }) => {
      const h = H.hunter
      return { px: P.pos.x, py: P.pos.y, pz: P.pos.z, hx: h.pos.x, hz: h.pos.z, hs: h.s, mode: h.mode, lost: H.handle.lostPlayerFor(), catches: h.catches, arrived: (globalThis as unknown as { __drive: { arrived: boolean } }).__drive.arrived, t: h.time }
    })
  const drive = (x: number, z: number, s: number) =>
    inPage(page, (_a, t: { x: number; z: number; s: number }) => {
      const d = (globalThis as unknown as { __drive: { target: unknown; pts: unknown[]; arrived: boolean } }).__drive
      d.target = t
      d.pts = []
      d.arrived = false
    }, { x, z, s })
  /** A noise where the player is (searching, the truck beside them). */
  const noise = (r: number, kind: string) => inPage(page, ({ H, P }, a: { r: number; kind: string }) => H.noise({ x: P.pos.x, y: P.pos.y, z: P.pos.z }, a.r, a.kind), { r, kind })
  const events: string[] = []
  const t0 = Date.now()
  const el = () => ((Date.now() - t0) / 1000).toFixed(0)
  let caught = false
  let frozen = 0
  /** One tick of the policy while travelling; returns false when caught. */
  const tick = async () => {
    const st = await state()
    if (st.catches > 0) return false
    const ps = Math.round((st.py - 0.15) / 3.8)
    const ed = Math.hypot(st.hx - st.px, st.hz - st.pz) + 6 * Math.abs(st.hs - ps)
    let want: string[]
    if (policy === "careless") want = ["KeyW", "ShiftLeft"]
    else if ((ed < 10 && st.hs === ps) || (st.mode === "hunt" && ed < 20)) {
      if (frozen === 0) events.push(`${el()}s freeze (it is ${ed.toFixed(0)} m off, ${st.mode})`)
      frozen++
      want = frozen > 200 ? ["KeyW", "KeyC"] : ["KeyC"]
    } else if (frozen && ed < 14) want = frozen > 200 ? ["KeyW", "KeyC"] : ["KeyC"]
    else {
      frozen = 0
      want = ed < 18 ? ["KeyW", "KeyC"] : ["KeyW"]
    }
    await setKeys(want)
    return true
  }
  const travel = async (x: number, z: number, s: number, limit: number) => {
    await drive(x, z, s)
    const end = Date.now() + limit * 1000
    let arrived = false
    while (Date.now() < end) {
      if (!(await tick())) return false
      if (process.env.TRACE && Math.random() < 0.03) console.log("   ", JSON.stringify(await inPage(page, ({ P }) => { const d = (globalThis as unknown as { __drive: { pts: unknown[]; i: number } }).__drive; return { p: [+P.pos.x.toFixed(1), +P.pos.y.toFixed(1), +P.pos.z.toFixed(1)], v: +P.state.speed.toFixed(2), wp: `${d.i}/${d.pts.length}`, next: d.pts[d.i] } })), [...keys].join("+"))
      const st = await state()
      if (Math.hypot(st.px - x, st.pz - z) < 1.6 && Math.abs(Math.round((st.py - 0.15) / 3.8) - s) === 0) {
        arrived = true
        break
      }
      await sleep(100)
    }
    await setKeys([])
    if (!arrived) events.push(`${el()}s (leg timed out before arriving)`)
    return true
  }
  const wait = async (secs: number, crouch: boolean, f?: () => Promise<void>) => {
    await setKeys(crouch ? ["KeyC"] : [])
    const end = Date.now() + secs * 1000
    while (Date.now() < end) {
      if ((await state()).catches > 0) return false
      if (f) await f()
      await sleep(250)
    }
    return true
  }
  try {
    // Hide: out of 3-08 (it is coming for the transmission) into 3-07 next door, its door shut behind, crouched in
    // its dark far corner, until it has lost the trail for 20 s (or 4 min).
    const room = await inPage(page, ({ H }) => {
      const r = H.nav.rooms.find((x: { id: string; s: number }) => x.id === "3-07" && x.s === 3)
      const d = r && H.nav.doors[r.doors[0]]
      return r && d ? { door: d.id, dx: d.cx, dz: d.cz, x0: r.rect.x0, z0: r.rect.z0 } : null
    })
    if (!room) throw new Error("no room 3-07")
    events.push(`${el()}s to 3-07 to hide`)
    await travel(room.dx, room.dz - 1.3, 3, 40)
    await inPage(page, ({ D }, id: string) => D.get(id)?.close(), room.door)
    await travel(room.x0 + 0.9, room.z0 + 0.9, 3, 40)
    events.push(`${el()}s hiding in 3-07, door shut`)
    await setKeys(["KeyC"])
    for (let i = 0; i < 960; i++) {
      const st = await state()
      if (st.catches > 0) throw new Error("caught while hiding")
      if (st.lost > 20 || process.env.NOHIDE) break
      await sleep(250)
    }
    events.push(`${el()}s it lost the trail >20 s: go (it is on storey ${(await state()).hs}, ${(await state()).mode})`)
    if (policy === "careless") await setKeys([])
    const T = { signout: [3.95, -2.4, 3], cabinet: [-47.3, 3.3, 0], security: [16.2, 14.5, 0], shed: [-48.4, -33.6, 0] } as const
    const remaining = async (ids: string[]) =>
      inPage(page, ({ H }, ids: string[]) => {
        const all: Record<string, { id: string; x: number; z: number; s: number }> = {
          signout: { id: "signout", x: 3.95, z: -2.4, s: 3 },
          cabinet: { id: "cabinet", x: -47.3, z: 3.3, s: 0 },
          security: { id: "security", x: 16.2, z: 14.5, s: 0 },
          office: { id: "office", x: -47.3, z: 3.3, s: 0 },
          shed: { id: "shed", x: -49.75, z: -33.5, s: 0 },
        }
        H.handle.setTrail(ids.map((i) => all[i]!))
      }, ids)
    await remaining(["signout", "cabinet", "security", "office", "shed"])
    // The vehicle sign-out by 3-08 (read: no noise).
    if (!(await travel(T.signout[0], T.signout[1], T.signout[2], 60))) throw new Error("caught on the way to the sign-out")
    if (!(await wait(2, false))) throw new Error("caught reading the sign-out")
    await remaining(["cabinet", "security", "office", "shed"])
    events.push(`${el()}s read the sign-out`)
    // The locked cabinet in 0-30 (tried: a metal rattle), its tag.
    if (!(await travel(T.cabinet[0], T.cabinet[1], T.cabinet[2], 150))) throw new Error("caught on the way to 0-30")
    if (!(await wait(2, true, () => noise(8, "knock")))) throw new Error("caught at the locked cabinet")
    await remaining(["security", "office", "shed"])
    events.push(`${el()}s cabinet locked: tag says Security 0-38`)
    // The cabinet key from Security's key box, 0-38.
    if (!(await travel(T.security[0], T.security[1], T.security[2], 120))) throw new Error("caught on the way to 0-38")
    if (!(await wait(3, true, () => noise(8, "knock")))) throw new Error("caught at the key box")
    await remaining(["office", "shed"])
    events.push(`${el()}s cabinet key from the key box`)
    // Back to 0-30: the Truck 2 keys.
    if (!(await travel(T.cabinet[0], T.cabinet[1], T.cabinet[2], 120))) throw new Error("caught on the way back to 0-30")
    if (!(await wait(3, true, () => noise(8, "knock")))) throw new Error("caught at the key cabinet")
    await remaining(["shed"])
    events.push(`${el()}s Truck 2 keys`)
    // Out by the west door, across the court to the shed; the engine (60) and the roll-up (32, every 2 s for 6 s).
    if (!(await travel(T.shed[0], T.shed[1], T.shed[2], 120))) throw new Error("caught on the way to the shed")
    events.push(`${el()}s in Truck 2: engine and roll-up`)
    await noise(60, "other")
    let roll = 0
    if (!(await wait(10, false, async () => {
      roll += 0.25
      if (roll % 2 < 0.25 && roll <= 6.5) await noise(32, "door")
    }))) throw new Error("caught at the truck")
    events.push(`${el()}s away in Truck 2`)
  } catch (e) {
    caught = true
    events.push(`${el()}s ${(e as Error).message}`)
  }
  await setKeys([])
  const log = await inPage(page, ({ H }) => H.hunter.log.map((l: { t: number; event: string }) => `${l.t} ${l.event}`))
  appendFileSync(LOG, `\n== ${policy} seed ${seed}: ${caught ? "CAUGHT" : "ESCAPED"}\n${events.join("\n")}\n-- hunter log\n${log.join("\n")}\n`)
  results.push(`${policy} seed ${seed}: ${caught ? "CAUGHT" : "escaped"} (${events[events.length - 1]})`)
  console.log(results[results.length - 1], errors.length ? `errors: ${errors[0]}` : "")
  await browser.close()
}
console.log(`\n${results.filter((r) => r.includes("escaped")).length}/${results.length} escaped (${policy})`)
