// A scripted run of the post-reveal key trail against the hunter, headless, to measure how often it catches you.
//   Hide (out of 3-08, which it comes for: into 3-07 next door, door shut, crouched in the dark far corner) until
//   `lostPlayerFor()` passes 20 s, then the trail (game/objectives.ts): the vehicle sign-out by 3-08 → the locked key
//   cabinet in 0-30 (a metal rattle, 8 m) → the cabinet key from Security's key box in 0-38 (8 m) → back to 0-30 for the
//   Truck 2 keys (8 m) → out by the west staff door, across the dock court to the motor-pool shed: the engine (60 m)
//   and the roll-up (32 m, every 2 s), 10 s to get away. The hunter's trail is kept in step (`setTrail`). Caught at any
//   point: a failed run.
// Policies (what a player can know: the creature's sound, i.e. its distance with 6 m per storey between):
//   careful   leaves the hide once it is also 18 m off; walks, torch off; crouch-walks when it's within 18 m; within
//             15 m on the same storey (or hunting within
//             20 m) it backs off, crouched, into the nearest room away from it and waits there until it's 15 m off
//             (2 s) or 45 s have passed, then carries on; the same when it is near the place they're heading for;
//             in the stairwell they go by the real distance (12 m);
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
if (!process.env.APPEND) writeFileSync(LOG, "")
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
  // Debug only: no hunter (checks the route legs themselves).
  if (process.env.NOHUNTER) await inPage(page, ({ H }) => H.handle.sleep())
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
    const g = globalThis as unknown as { __drive: { target: { x: number; z: number; s: number } | null; go: boolean; pts: { x: number; z: number }[]; i: number; at: number; arrived: boolean; stall?: number; flip?: number } }
    g.__drive = { target: null, go: false, pts: [], i: 0, at: 0, arrived: false }
    const step = () => {
      const d = g.__drive
      const t = d.target
      if (t) {
        const s = Math.round((P.pos.y - 0.15) / 3.8)
        // Re-route now and then (doors, shoves), but never on the stair (mid-flight it would snap to a landing).
        const cur = d.pts[d.i] as { stair?: boolean } | undefined
        const prev = d.pts[d.i - 1] as { stair?: boolean } | undefined
        const onStair = !!(cur?.stair || prev?.stair)
        if (!d.pts.length || (!onStair && performance.now() - d.at > 4000)) {
          const r = H.nav.route({ x: P.pos.x, z: P.pos.z, s }, t)
          if (r) {
            d.pts = r.pts.slice(1)
            d.i = 0
          }
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
          // Stalled by a doorway's jamb (the route's straight line cuts the corner; the body is 0.3 m round): go
          // through the middle of the opening, square to it.
          d.stall = P.state.speed < 0.2 ? (d.stall ?? 0) + 1 : 0
          if (d.stall > 40) {
            d.stall = 0
            let best: { cx: number; cz: number; nx: number; nz: number; h: { amount: number } } | null = null
            let bd = 2.2
            for (const nd of H.nav.doors) {
              const dd = Math.hypot(nd.cx - P.pos.x, nd.cz - P.pos.z)
              if (dd < bd && Math.abs(nd.h.hy - P.pos.y) < 0.6) {
                bd = dd
                best = nd
              }
            }
            if (best) {
              const side = Math.sign((P.pos.x - best.cx) * best.nx + (P.pos.z - best.cz) * best.nz) || 1
              // A shut leaf can't swing open into a body pressed against it: step back clear of its swing first.
              const back = best.h.amount < 0.3 ? 1.4 : 0.7
              d.pts.splice(d.i, 0, { x: best.cx + best.nx * side * back, z: best.cz + best.nz * side * back }, { x: best.cx - best.nx * side * 0.8, z: best.cz - best.nz * side * 0.8 })
              d.at = performance.now()
            } else {
              // Snagged on something along a wall: a sidestep (sides alternate), then on.
              d.flip = -(d.flip ?? 1)
              const k = 0.8 * d.flip
              d.pts.splice(d.i, 0, { x: P.pos.x + Math.cos(P.yaw) * k, z: P.pos.z - Math.sin(P.yaw) * k })
              d.at = performance.now()
            }
          }
          // Doors ahead, shut or only ajar: opened on the way in, from up to 2.6 m (as a player presses E approaching,
          // before the leaf would swing into them).
          const fx = -Math.sin(P.yaw)
          const fz = -Math.cos(P.yaw)
          for (const nd of H.nav.doors) {
            if (nd.h.amount >= 0.95 || Math.abs(nd.h.hy - P.pos.y) > 0.6) continue
            const ddx = nd.cx - P.pos.x
            const ddz = nd.cz - P.pos.z
            const dd = Math.hypot(ddx, ddz)
            if (dd < 2.6 && (dd < 0.9 || (ddx * fx + ddz * fz) / dd > 0.3)) D.get(nd.id)?.open()
          }
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
  /** Where the careful player has ducked in to (a room away from it), and since when it has been 15 m off. */
  let refuge: { x: number; z: number; s: number; since: number; clear: number } | null = null
  let lastPosLog = 0
  let goal: { x: number; z: number; s: number } | null = null
  const danger = (st: Awaited<ReturnType<typeof state>>) => {
    const ps = Math.round((st.py - 0.15) / 3.8)
    const ed = Math.hypot(st.hx - st.px, st.hz - st.pz) + 6 * Math.abs(st.hs - ps)
    // In the stairwell (either of them in the core stair) the storeys run together: go by the real distance.
    const inCore = (x: number, z: number) => x > -43.2 && x < -39.6 && z > 15.5 && z < 25
    const stair = inCore(st.px, st.pz) || inCore(st.hx, st.hz)
    const d3 = Math.hypot(st.hx - st.px, (st.hs - ps) * 3.8, st.hz - st.pz)
    const near = (ed < 15 && st.hs === ps) || (stair && d3 < 12) || (st.mode === "hunt" && ed < 20)
    return { ed: stair ? Math.min(ed, d3) : ed, ps, near }
  }
  /** One tick of the policy while travelling; returns false when caught. */
  const tick = async () => {
    const st = await state()
    if (st.catches > 0) return false
    if (Date.now() - lastPosLog > 5000) {
      lastPosLog = Date.now()
      events.push(`${el()}s   . player ${st.px.toFixed(1)},${st.py.toFixed(1)},${st.pz.toFixed(1)}  creature ${st.mode} s${st.hs} ${st.hx.toFixed(1)},${st.hz.toFixed(1)}`)
    }
    if (policy === "careless") {
      await setKeys(["KeyW", "ShiftLeft"])
      return true
    }
    const { ed, ps, near: close } = danger(st)
    // It is at (or near) the place we're heading for: also a reason to get into a room and wait for it to move on.
    const atGoal = !!goal && st.hs === goal.s && Math.hypot(st.hx - goal.x, st.hz - goal.z) < 15 && Math.hypot(st.px - goal.x, st.pz - goal.z) < 25
    const near = close || atGoal
    if (near && !refuge) {
      // Back off into the nearest room on this storey that takes the player away from it.
      const r = await inPage(page, ({ H }, a: { px: number; pz: number; hx: number; hz: number; s: number }) => {
        let best: { x: number; z: number } | null = null
        let bs = -Infinity
        for (const rm of H.nav.rooms) {
          if (rm.s !== a.s) continue
          const dp = Math.hypot(rm.px - a.px, rm.pz - a.pz)
          if (dp > 14) continue
          const score = Math.hypot(rm.px - a.hx, rm.pz - a.hz) - dp * 0.8
          if (score > bs) {
            bs = score
            best = rm.spots.length ? { x: rm.spots[0][0], z: rm.spots[0][1] } : { x: rm.px, z: rm.pz }
          }
        }
        return best
      }, { px: st.px, pz: st.pz, hx: st.hx, hz: st.hz, s: ps })
      if (r) {
        refuge = { ...r, s: ps, since: Date.now(), clear: 0 }
        events.push(`${el()}s backs off into a room (it is ${ed.toFixed(0)} m off, ${st.mode})`)
        await drive(r.x, r.z, ps)
      }
    }
    if (refuge) {
      refuge.clear = ed > 15 && !atGoal ? refuge.clear + 1 : 0
      const there = Math.hypot(st.px - refuge.x, st.pz - refuge.z) < 1.2
      if (refuge.clear > 20 || Date.now() - refuge.since > 45000) {
        refuge = null
        if (goal) await drive(goal.x, goal.z, goal.s)
      } else {
        await setKeys(there ? ["KeyC"] : ["KeyW", "KeyC"])
        return true
      }
    }
    await setKeys(ed < 18 ? ["KeyW", "KeyC"] : ["KeyW"])
    return true
  }
  let traceN = 0
  const travel = async (x: number, z: number, s: number, limit: number) => {
    goal = { x, z, s }
    refuge = null
    await drive(x, z, s)
    const end = Date.now() + limit * 1000
    let arrived = false
    while (Date.now() < end) {
      if (!(await tick())) return false
      if (process.env.TRACE && (traceN++ % 10 === 0)) console.log("   ", JSON.stringify(await inPage(page, ({ P }) => { const d = (globalThis as unknown as { __drive: { pts: unknown[]; i: number } }).__drive; return { p: [+P.pos.x.toFixed(1), +P.pos.y.toFixed(1), +P.pos.z.toFixed(1)], v: +P.state.speed.toFixed(2), wp: `${d.i}/${d.pts.length}`, next: d.pts[d.i] } })), [...keys].join("+"))
      const st = await state()
      if (!refuge && Math.hypot(st.px - x, st.pz - z) < 1.6 && Math.abs(Math.round((st.py - 0.15) / 3.8) - s) === 0) {
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
    if (process.env.START !== "signout") {
    if (process.env.START === "signout") await place(page, 3.95, Y(3), -2.4, 0)
    events.push(`${el()}s to 3-07 to hide`)
    await travel(room.dx, room.dz - 1.3, 3, 40)
    await inPage(page, ({ D }, id: string) => D.get(id)?.close(), room.door)
    await travel(room.x0 + 0.9, room.z0 + 0.9, 3, 40)
    events.push(`${el()}s hiding in 3-07, door shut`)
    }
    await setKeys(["KeyC"])
    for (let i = 0; i < 960; i++) {
      const st = await state()
      if (st.catches > 0) throw new Error("caught while hiding")
      // The hide is over for the story at 20 s lost; a careful player also waits until they can hear it is well off.
      const ps = Math.round((st.py - 0.15) / 3.8)
      const ed = Math.hypot(st.hx - st.px, st.hz - st.pz) + 6 * Math.abs(st.hs - ps)
      if ((st.lost > 20 && (policy === "careless" || ed > 18)) || process.env.NOHIDE) break
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
    if (!(await travel(T.cabinet[0], T.cabinet[1], T.cabinet[2], 220))) throw new Error("caught on the way to 0-30")
    if (!(await wait(2, true, () => noise(8, "knock")))) throw new Error("caught at the locked cabinet")
    await remaining(["security", "office", "shed"])
    events.push(`${el()}s cabinet locked: tag says Security 0-38`)
    // The cabinet key from Security's key box, 0-38.
    if (!(await travel(T.security[0], T.security[1], T.security[2], 200))) throw new Error("caught on the way to 0-38")
    if (!(await wait(3, true, () => noise(8, "knock")))) throw new Error("caught at the key box")
    await remaining(["office", "shed"])
    events.push(`${el()}s cabinet key from the key box`)
    // Back to 0-30: the Truck 2 keys.
    if (!(await travel(T.cabinet[0], T.cabinet[1], T.cabinet[2], 200))) throw new Error("caught on the way back to 0-30")
    if (!(await wait(3, true, () => noise(8, "knock")))) throw new Error("caught at the key cabinet")
    await remaining(["shed"])
    events.push(`${el()}s Truck 2 keys`)
    // Out by the west staff door (0-10), across the court to the shed; the engine (60) and the roll-up (32, every 2 s
    // for 6 s). Something solid stands in front of that door inside 0-10 (x −53.66..−53.34, z −10.06..−9.74, 0.63 m
    // tall: too narrow either side for the player's body, though not for the creature's nav): reported as a level bug;
    // here the player steps past it.
    if (!(await travel(-52.8, -10.4, 0, 180))) throw new Error("caught on the way to the staff exit")
    await place(page, -55.8, 0.06, -10.0, Math.PI / 2)
    events.push(`${el()}s stepped past the object blocking the staff exit`)
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
