// A scripted run of the post-reveal key trail against the hunter, headless, to measure how often it catches you.
//   Hide in 3-08 (crouched in its dark far corner) until `lostPlayerFor()` passes 20 s (the Hide → keys switch), then
//   the trail: Hargrove's locker (DEFAULT_TRAIL "locker", the 0-12 change room; a 4 s metal-locker search: noises of
//   8 m) → the key cabinet in 0-30 ("keys": a 3 s search, 4 m noises) → the dock ("dock": the engine and the dock door,
//   a 90 m "engine" noise) → 12 s for the truck to get out. Caught at any point: a failed run.
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
  await place(page, 2.1, Y(3), -20.6, 0)
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
        if (!w) d.arrived = true
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
      if ((await state()).arrived) {
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
    // Hide: crouched in 3-08's far corner until it has lost the trail for 20 s (or 4 min).
    events.push(`${el()}s hide in 3-08`)
    await setKeys(["KeyC"])
    for (let i = 0; i < 960; i++) {
      const st = await state()
      if (st.catches > 0) throw new Error("caught while hiding")
      if (st.lost > 20 || process.env.NOHIDE) break
      await sleep(250)
    }
    events.push(`${el()}s it lost the trail >20 s: go (it is on storey ${(await state()).hs}, ${(await state()).mode})`)
    if (policy === "careless") await setKeys([])
    if (!(await travel(-45.1, -8.5, 0, 150))) throw new Error("caught on the way to the locker")
    events.push(`${el()}s at the locker`)
    if (!(await wait(4, true, () => noise(8, "search")))) throw new Error("caught searching the locker")
    await inPage(page, ({ H }) => H.handle.completeTrail("locker"))
    if (!(await travel(-51.2, 6.2, 0, 90))) throw new Error("caught on the way to 0-30")
    events.push(`${el()}s at the key cabinet`)
    if (!(await wait(3, true, () => noise(4, "search")))) throw new Error("caught at the key cabinet")
    await inPage(page, ({ H }) => H.handle.completeTrail("keys"))
    if (!(await travel(-31, -15, 0, 90))) throw new Error("caught on the way to the dock")
    events.push(`${el()}s at the dock: engine and dock door`)
    await noise(90, "engine")
    if (!(await wait(12, false))) throw new Error("caught at the truck")
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
