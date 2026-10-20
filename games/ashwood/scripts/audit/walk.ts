// Scripted walk over the frozen audit build: drives the real player with physical keys (W, Shift, E) along planned
// paths and logs stuck points, falls (y drops > 1 m), wrong-level arrivals and doors that don't open.
//
//   bun scripts/audit/walk.ts [--legs spines,rooms,stair,lift,fire,roof,outside] [--storeys 0,1,2,3,4] [--run]
//
// Paths on a storey are planned with A* on a 0.25 m grid against ctx.colliders (body radius 0.33, the band
// Player.move tests), so a stall on a planned path is a real snag (a door leaf, a collider the plan can't see, a step
// the body won't take). Writes a JSON log to $AH_OUT/walk-<legs>.json.
import { writeFileSync, mkdirSync } from "node:fs"
import { launch, open, inPage, OUT } from "./lib"
import { CORE, FIRE_ESCAPE, ROOF_Y, storeyY, BOOTH } from "../../src/world/layout"

const args = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`)
  return i < 0 ? d : args[i + 1]
}
const legs = (flag("legs", "spines,stair,lift,fire,roof,outside,rooms") as string).split(",")
const storeys = (flag("storeys", "0,1,2,3,4") as string).split(",").map(Number)
const RUN = args.includes("--run")
const roomLimit = Number(flag("rooms-max", "999"))

type F = { min: number[]; max: number[]; y: number }
type B = { min: number[]; max: number[] }
type Ev = { leg: string; kind: string; at: [number, number, number]; note: string }
const events: Ev[] = []
const legLog: { leg: string; ok: boolean; secs: number; note?: string }[] = []
const ev = (leg: string, kind: string, at: { x: number; y: number; z: number }, note: string) => {
  events.push({ leg, kind, at: [+at.x.toFixed(2), +at.y.toFixed(2), +at.z.toFixed(2)], note })
  console.log(`  ${kind.toUpperCase()} [${leg}] at ${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}: ${note}`)
}

const browser = await launch()
const { page, log } = await open(browser, "view=corridor", [720, 450])
const snap = (await inPage(page, (g) => ({
  colliders: g.ctx.colliders.map((b: B) => ({ min: [...b.min], max: [...b.max] })),
  floors: g.ctx.floors.map((f: F) => ({ min: [...f.min], max: [...f.max], y: f.y })),
  ladders: g.ctx.ladders.map((b: B) => ({ min: [...b.min], max: [...b.max] })),
  rooms: g.reg.rooms.map((r: any) => ({ id: r.id, storey: r.storey, name: r.name, rect: r.rect, doors: [...r.doors] })),
  regDoors: g.reg.doors.map((d: any) => ({ id: d.id, storey: d.storey, state: d.state, room: d.room, x: d.x, z: d.z })),
  doors: g.doors.all().map((d: any) => {
    const m = (d.xa + d.xb) / 2
    return { id: d.id, hy: d.hy, mx: d.hx + m * Math.cos(d.yaw0), mz: d.hz - m * Math.sin(d.yaw0), nx: Math.sin(d.yaw0), nz: Math.cos(d.yaw0), locked: d.locked, height: d.height, partner: d.spec.double }
  }),
}), 0)) as { colliders: B[]; floors: F[]; ladders: B[]; rooms: { id: string; storey: number; name: string; rect: { x0: number; x1: number; z0: number; z1: number }; doors: string[] }[]; regDoors: { id: string; storey: number; state: string; room?: string; x: number; z: number }[]; doors: { id: string; hy: number; mx: number; mz: number; nx: number; nz: number; locked: boolean; height: number; partner?: string }[] }
console.log(`colliders ${snap.colliders.length}, rooms ${snap.rooms.length}, registered doors ${snap.doors.length}, ladders ${snap.ladders.length}`)
// Pair doors: the doorway mid is between both leaves.
for (const d of snap.doors) {
  const p = d.partner && snap.doors.find((o) => o.id === d.partner)
  if (p) {
    const mx = (d.mx + p.mx) / 2
    const mz = (d.mz + p.mz) / 2
    d.mx = p.mx = mx
    d.mz = p.mz = mz
  }
}

// ------------------------------------------------------------------ planner
const CELL = 2
const grid = new Map<string, B[]>()
for (const b of snap.colliders)
  for (let gx = Math.floor((b.min[0]! - 0.5) / CELL); gx <= Math.floor((b.max[0]! + 0.5) / CELL); gx++)
    for (let gz = Math.floor((b.min[2]! - 0.5) / CELL); gz <= Math.floor((b.max[2]! + 0.5) / CELL); gz++) {
      const k = `${gx},${gz}`
      let l = grid.get(k)
      if (!l) grid.set(k, (l = []))
      l.push(b)
    }
const blocked = (x: number, z: number, y: number, R = 0.36) => {
  for (const b of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
    if (b.max[1]! < y + 0.45 || b.min[1]! > y + 1.75) continue
    // Lift landing doors move; ignore the parked-away box.
    if (b.min[1]! < -50) continue
    const cx = Math.max(b.min[0]!, Math.min(x, b.max[0]!))
    const cz = Math.max(b.min[2]!, Math.min(z, b.max[2]!))
    if ((x - cx) ** 2 + (z - cz) ** 2 < R * R) return true
  }
  return false
}
const S = 0.25
const BOUNDS = { x0: -56.6, x1: 62, z0: -38, z1: 25 }
function plan(from: [number, number], to: [number, number], y: number): [number, number][] | null {
  const nx = Math.ceil((BOUNDS.x1 - BOUNDS.x0) / S)
  const nz = Math.ceil((BOUNDS.z1 - BOUNDS.z0) / S)
  const idx = (x: number, z: number) => Math.floor((x - BOUNDS.x0) / S) * nz + Math.floor((z - BOUNDS.z0) / S)
  const cx = (i: number) => BOUNDS.x0 + (Math.floor(i / nz) + 0.5) * S
  const cz = (i: number) => BOUNDS.z0 + ((i % nz) + 0.5) * S
  const free = new Map<number, boolean>()
  const isFree = (i: number) => {
    let f = free.get(i)
    if (f === undefined) free.set(i, (f = !blocked(cx(i), cz(i), y)))
    return f
  }
  // Snap endpoints to the nearest free cell.
  const snapTo = (p: [number, number]) => {
    const i0 = idx(p[0], p[1])
    if (isFree(i0)) return i0
    for (let r = 1; r < 6; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const i = i0 + di * nz + dj
      if (isFree(i)) return i
    }
    return -1
  }
  const a = snapTo(from)
  const b = snapTo(to)
  if (a < 0 || b < 0) return null
  const g = new Map<number, number>([[a, 0]])
  const came = new Map<number, number>()
  const h = (i: number) => Math.hypot(cx(i) - cx(b), cz(i) - cz(b))
  // Binary heap.
  const heap: [number, number][] = [[h(a), a]]
  const push = (e: [number, number]) => {
    heap.push(e)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p]![0] <= heap[i]![0]) break
      ;[heap[p], heap[i]] = [heap[i]!, heap[p]!]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i]!, heap[m]!]
        i = m
      }
    }
    return top
  }
  const closed = new Set<number>()
  let found = false
  let n = 0
  while (heap.length && n++ < 400_000) {
    const [, c] = pop()
    if (c === b) {
      found = true
      break
    }
    if (closed.has(c)) continue
    closed.add(c)
    for (const [di, dj, w] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]] as const) {
      const ii = Math.floor(c / nz) + di
      const jj = (c % nz) + dj
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue
      const k = ii * nz + jj
      if (!isFree(k)) continue
      if (di && dj && (!isFree(c + di * nz) || !isFree(c + dj))) continue
      const ng = g.get(c)! + w * S
      if (ng < (g.get(k) ?? Infinity)) {
        g.set(k, ng)
        came.set(k, c)
        push([ng + h(k), k])
      }
    }
  }
  if (!found) return null
  const cells: number[] = [b]
  while (cells[cells.length - 1] !== a) cells.push(came.get(cells[cells.length - 1]!)!)
  cells.reverse()
  const pts = cells.map((i) => [cx(i), cz(i)] as [number, number])
  // Line-of-sight pruning.
  const clear = (p: [number, number], q: [number, number]) => {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1])
    for (let t = 0; t <= L; t += 0.1) if (blocked(p[0] + ((q[0] - p[0]) * t) / L, p[1] + ((q[1] - p[1]) * t) / L, y, 0.34)) return false
    return true
  }
  const out: [number, number][] = [pts[0]!]
  let i = 0
  while (i < pts.length - 1) {
    let j = pts.length - 1
    while (j > i + 1 && !clear(pts[i]!, pts[j]!)) j--
    out.push(pts[j]!)
    i = j
  }
  out.push(to)
  return out
}

// ------------------------------------------------------------------ player control
type St = { x: number; y: number; z: number; grounded: boolean; ladder: boolean; focused: string | null; fLocked: boolean; fOpen: boolean }
const st = () =>
  inPage(page, (g) => {
    const f = g.doors.focused
    return { x: g.p.pos.x, y: g.p.pos.y, z: g.p.pos.z, grounded: g.p.state.grounded, ladder: g.p.state.onLadder, focused: f?.id ?? null, fLocked: !!f?.locked, fOpen: !!f?.isOpen }
  }, 0) as Promise<St>
const tp = (x: number, y: number, z: number, yaw = 0, pitch = -0.1) =>
  inPage(page, (g, a: number[]) => {
    g.p.fly = false
    g.p.pos.x = a[0]
    g.p.pos.y = a[1]
    g.p.pos.z = a[2]
    g.p.yaw = a[3]
    g.p.pitch = a[4]
    g.p.resetMotion()
  }, [x, y, z, yaw, pitch])
const look = (x: number, y: number, z: number) =>
  inPage(page, (g, a: number[]) => {
    const dx = a[0] - g.p.pos.x
    const dz = a[2] - g.p.pos.z
    g.p.yaw = Math.atan2(-dx, -dz)
    g.p.pitch = -Math.atan2(g.p.pos.y + 1.65 - a[1], Math.hypot(dx, dz))
  }, [x, y, z])
const sleep = (ms: number) => page.waitForTimeout(ms)
const keys = new Set<string>()
const down = async (k: string) => {
  if (!keys.has(k)) await page.keyboard.down(k)
  keys.add(k)
}
const up = async () => {
  for (const k of keys) await page.keyboard.up(k)
  keys.clear()
}
const pressE = async () => {
  await page.keyboard.press("KeyE")
  await sleep(100)
}

/** Follows waypoints [x, z, yExpected?]. Returns false if any stuck point needed a teleport. */
async function go(leg: string, pts: [number, number, number?][], opts: { run?: boolean; ladderKey?: string } = {}) {
  let ok = true
  let prev = await st()
  for (let w = 0; w < pts.length; w++) {
    const [tx, tz, ty] = pts[w]!
    let best = Infinity
    let lastProg = performance.now()
    let triedE = false
    const t0 = performance.now()
    for (;;) {
      const s = await st()
      if (s.y < prev.y - 1.0 && !s.ladder) ev(leg, "fall", s, `dropped ${(prev.y - s.y).toFixed(2)} m (from y ${prev.y.toFixed(2)}) heading for ${tx.toFixed(2)},${tz.toFixed(2)}`)
      prev = s
      const d = Math.hypot(tx - s.x, tz - s.z)
      if (d < 0.3) break
      await inPage(page, (g, a: number[]) => {
        g.p.yaw = Math.atan2(-(a[0] - g.p.pos.x), -(a[1] - g.p.pos.z))
        g.p.pitch = -0.12
      }, [tx, tz])
      await down("KeyW")
      if (opts.run ?? RUN) await down("ShiftLeft")
      if (d < best - 0.08) {
        best = d
        lastProg = performance.now()
      }
      const stall = performance.now() - lastProg
      if (stall > 700 && !triedE && s.focused && !s.fOpen) {
        triedE = true
        await up()
        if (s.fLocked) ev(leg, "locked", s, `door ${s.focused} is locked on the path`)
        await pressE()
        await sleep(2600)
        lastProg = performance.now()
        continue
      }
      if (stall > 2500 || performance.now() - t0 > 60_000) {
        await up()
        ok = false
        ev(leg, "stuck", s, `no progress towards ${tx.toFixed(2)},${tz.toFixed(2)} (${d.toFixed(2)} m left, focused door ${s.focused ?? "-"})`)
        await tp(tx, ty ?? s.y, tz)
        prev = await st()
        break
      }
      await sleep(40)
    }
    if (ty !== undefined) {
      const s = await st()
      if (Math.abs(s.y - ty) > 0.6) {
        ev(leg, "level", s, `arrived at y ${s.y.toFixed(2)}, expected ${ty.toFixed(2)}`)
        ok = false
      }
    }
  }
  await up()
  return ok
}

async function leg(name: string, fn: () => Promise<boolean | string>) {
  const t0 = performance.now()
  console.log(`-- ${name}`)
  let ok = false
  let note: string | undefined
  try {
    const r = await fn()
    ok = r === true
    if (typeof r === "string") note = r
  } catch (e) {
    note = `error: ${(e as Error).message.split("\n")[0]}`
    ev(name, "error", { x: 0, y: 0, z: 0 }, note)
  }
  await up()
  legLog.push({ leg: name, ok, secs: +((performance.now() - t0) / 1000).toFixed(1), note })
  console.log(`   ${ok ? "ok" : "FAIL"} (${((performance.now() - t0) / 1000).toFixed(1)} s)${note ? ` ${note}` : ""}`)
}

const Y = (i: number) => storeyY(i) + 0.01
const HALL: [number, number] = [-40.2, 10]

/** Plans and walks a route of storey points. */
async function route(name: string, i: number, pts: [number, number][]) {
  let ok = true
  for (let k = 1; k < pts.length; k++) {
    const p = plan(pts[k - 1]!, pts[k]!, Y(i))
    if (!p) {
      const s = await st()
      ev(name, "noroute", { x: pts[k]![0], y: Y(i), z: pts[k]![1] }, `no collider-free path from ${pts[k - 1]} to ${pts[k]} (blocked)`)
      await tp(pts[k]![0], Y(i), pts[k]![1])
      void s
      ok = false
      continue
    }
    ok = (await go(name, p.map(([x, z]) => [x, z, Y(i)]))) && ok
  }
  return ok
}

// ------------------------------------------------------------------ legs
if (legs.includes("spines"))
  for (const i of storeys)
    await leg(`spine s${i}`, async () => {
      await tp(HALL[0], Y(i), HALL[1], Math.PI)
      const east = i === 4 ? 22.0 : 33.8 // storey 4: the corridor ends at the Director's barricaded pair (x 22.4)
      return route(`spine s${i}`, i, [HALL, [-53.8, 0], [east, 0], [east, 0.5], HALL])
    })

if (legs.includes("stair"))
  await leg("stair ground → roof → ground", async () => {
    await tp(-41.5, Y(0), 17.4, Math.PI)
    let ok = true
    for (let i = 0; i < 5; i++) {
      const y = Y(i)
      ok = (await go("stair up", [[-42.3, 18.2, y], [-42.3, 21.6], [-42.3, 23.8], [-40.5, 23.8], [-40.5, 19.0], [-40.5, 17.6, Y(i + 1)], [-41.5, 17.4, Y(i + 1)]])) && ok
    }
    // Roof: out the door in the tower's north face onto the deck, round the dish, back in.
    ok = (await go("roof", [[-39.7, 17.0, ROOF_Y], [-39.7, 15.3, ROOF_Y], [-39.7, 14.6, ROOF_Y]])) && ok
    const roofPts: [number, number][] = [[-39.7, 14.6], [-20, 10], [-10, -15], [20, -15], [25, 15], [-20, 15], [-39.7, 14.6]]
    for (let k = 1; k < roofPts.length; k++) {
      const p = plan(roofPts[k - 1]!, roofPts[k]!, ROOF_Y)
      if (!p) {
        ev("roof", "noroute", { x: roofPts[k]![0], y: ROOF_Y, z: roofPts[k]![1] }, `no path on the roof deck from ${roofPts[k - 1]} to ${roofPts[k]}`)
        await tp(roofPts[k]![0], ROOF_Y, roofPts[k]![1])
        continue
      }
      ok = (await go("roof", p.map(([x, z]) => [x, z, ROOF_Y]))) && ok
    }
    ok = (await go("roof", [[-39.7, 15.3, ROOF_Y], [-39.7, 17.0, ROOF_Y], [-40.5, 17.6, ROOF_Y]])) && ok
    for (let i = 4; i >= 0; i--) {
      const y = Y(i + 1)
      ok = (await go("stair down", [[-40.5, 18.4, y], [-40.5, 21.0], [-40.5, 23.8], [-42.3, 23.8], [-42.3, 21.0], [-42.3, 18.0, Y(i)], [-41.5, 17.4, Y(i)]])) && ok
    }
    return ok
  })

if (legs.includes("roof"))
  await leg("roof stair head edges", async () => {
    // Walk from the roof landing towards the open well over the storey-4 west flight, and into the lift shaft line.
    let ok = true
    await tp(-41.5, ROOF_Y + 0.01, 17.4, Math.PI)
    ok = (await go("roof well", [[-42.3, 17.8, ROOF_Y], [-42.3, 20.0]])) && ok
    let s = await st()
    if (s.y < ROOF_Y - 1) ev("roof well", "fall", s, `walking south from the roof stair landing at x -42.3 drops into the stair well (y ${s.y.toFixed(2)})`)
    await tp(-37.9, ROOF_Y, 17.5, Math.PI)
    ok = (await go("roof lift shaft", [[-37.9, 18.5, ROOF_Y], [-37.9, 21.0]])) && ok
    s = await st()
    if (s.y < ROOF_Y - 1) ev("roof lift shaft", "fall", s, `walking south from the roof lift lobby enters the lift shaft (y ${s.y.toFixed(2)})`)
    await tp(-39.2, ROOF_Y + 0.01, 18.0, Math.PI)
    ok = (await go("roof gap", [[-39.15, 19.3, ROOF_Y]])) && ok
    s = await st()
    if (s.y < ROOF_Y - 1) ev("roof gap", "fall", s, `gap between the stair-head landing and the roof lift lobby floor (y ${s.y.toFixed(2)})`)
    return ok
  })

if (legs.includes("lift"))
  await leg("lift every storey", async () => {
    let ok = true
    const lift = () => inPage(page, (g) => g.interior.lift.state(), 0) as Promise<{ phase: string; cur: number; target: number; pos: number }>
    const waitIdle = async (ms = 40_000) => {
      const t0 = performance.now()
      await sleep(500)
      while (performance.now() - t0 < ms) {
        const l = await lift()
        if (l.phase === "idle") return l
        await sleep(250)
      }
      return lift()
    }
    // Call from storey 2 (car parked at 0).
    await tp(-37.4, Y(2), 18.6, Math.PI)
    await look(-36.82, Y(2) + 1.15, 19.45)
    await pressE()
    let l = await waitIdle()
    if (l.cur !== 2) {
      ev("lift", "lift", await st(), `call from storey 2 left the car at ${l.cur} (${l.phase})`)
      ok = false
    }
    ok = (await go("lift", [[-37.85, 19.0, Y(2)], [-37.85, 21.0, Y(2)]])) && ok
    for (let k = 0; k < 5; k++) {
      const from = l.cur
      await look(-37.85, Y(from) + 1.2, 19.5)
      await pressE()
      l = await waitIdle()
      const want = (from + 1) % 5
      const s = await st()
      if (l.cur !== want) ev("lift", "lift", s, `E in the car at ${from} went to ${l.cur}, expected ${want}`)
      if (Math.abs(s.y - Y(l.cur)) > 0.3) {
        ev("lift", "fall", s, `rider at y ${s.y.toFixed(2)} after the ride to ${l.cur} (car floor ${Y(l.cur).toFixed(2)})`)
        ok = false
        await tp(-37.85, Y(l.cur), 21.0)
      }
      // Step out to the lobby and back in.
      ok = (await go(`lift out s${l.cur}`, [[-37.85, 19.0, Y(l.cur)], [-37.85, 17.6, Y(l.cur)], [-37.85, 19.0, Y(l.cur)], [-37.85, 21.0, Y(l.cur)]])) && ok
    }
    return ok
  })

if (legs.includes("fire"))
  await leg("fire escape", async () => {
    let ok = true
    const W = FIRE_ESCAPE.x
    // Out through the storey-1 corridor door onto the landing, up every flight, down again, in at storey 4.
    await tp(-52.5, Y(1), 0, Math.PI / 2)
    ok = (await go("fire s1 door", [[-54.2, 0, Y(1)], [W - 0.4, 0, storeyY(1)]])) && ok
    for (let i = 1; i < 4; i++) {
      const y = storeyY(i)
      const up = i % 2 === 1
      const zs = up ? -5.6 : 5.6
      const zt = up ? -0.5 : 0.5
      ok = (await go(`fire up ${i}`, [[W - 0.4, zs, y], [W - 1.1, zs, y], [W - 1.1, up ? -4.9 : 4.9], [W - 1.1, zt, storeyY(i + 1)], [W - 0.4, zt, storeyY(i + 1)]])) && ok
    }
    // In at storey 4 and back out.
    ok = (await go("fire s4 door", [[W - 0.4, 0, storeyY(4)], [-53.6, 0, Y(4)], [W - 0.4, 0, storeyY(4)]])) && ok
    // Ladders (caged to the roof, drop ladder) are traced separately: $TMPDIR/ah-audit/ladder-trace.ts.
    // Down again: landing 4 → 1 by the flights, then the drop ladder.
    await tp(W - 0.4, storeyY(4), 0.5, 0)
    for (let i = 3; i >= 1; i--) {
      const up = i % 2 === 1
      const zs = up ? -5.6 : 5.6
      const zt = up ? -0.5 : 0.5
      ok = (await go(`fire down ${i + 1}`, [[W - 0.4, zt, storeyY(i + 1)], [W - 1.1, zt, storeyY(i + 1)], [W - 1.1, up ? -4.9 : 4.9], [W - 1.1, zs, storeyY(i)], [W - 0.4, zs, storeyY(i)]])) && ok
    }
    return ok
  })

if (legs.includes("outside"))
  await leg("entrance → lot → gate → forest", async () => {
    let ok = true
    await tp(0, Y(0), 12, 0)
    ok = (await go("entrance", [[0, 18], [0, 21], [0, 24], [0, 34], [-10, 60], [-2, 100], [6, 118]])) && ok
    // Booth: through its door, press the gate button, then through the gate.
    const booth = snap.doors.filter((d) => /booth/i.test(d.id))
    const gateBtn = snap.doors.find((d) => d.id === "ctl-gate")
    const gateIds = snap.doors.filter((d) => /gate/i.test(d.id) && !d.id.startsWith("ctl")).map((d) => d.id)
    console.log(`   booth doors ${booth.map((d) => d.id)}, gate doors ${gateIds}`)
    const gateState = () => inPage(page, (g, ids: string[]) => ids.map((i) => ({ id: i, amount: g.doors.get(i)?.amount ?? -1, locked: g.doors.get(i)?.locked })), gateIds)
    console.log("   gate before", JSON.stringify(await gateState()))
    // Inside the booth, in front of the control station on its west wall: press both buttons (gate, boom).
    for (const id of ["ctl-gate", "ctl-boom"]) {
      const btn = snap.doors.find((d) => d.id === id)
      if (!btn) {
        ev("gate", "missing", { x: BOOTH.x, y: 0, z: BOOTH.z }, `${id} not registered`)
        continue
      }
      // The control station is on the booth's west face (gate side): stand 0.7 m west of it, aim at the button.
      const c = (await inPage(page, (g, i: string) => g.doors.centreOf(i), id)) as { x: number; y: number; z: number }
      await tp(c.x - 0.7, 0, c.z, -Math.PI / 2)
      await tp(c.x - 0.7, (await st()).y, c.z, -Math.PI / 2)
      await look(c.x, c.y, c.z)
      await sleep(300)
      const s = await st()
      if (s.focused !== id) {
        ev("gate", "door", s, `crosshair on ${id}'s centre focuses ${s.focused} instead`)
        continue
      }
      await pressE()
    }
    await sleep(7000)
    console.log("   gate after buttons", JSON.stringify(await gateState()))
    if (!(await gateState()).some((g) => g.id === "vehicle-gate" && g.amount > 0.9)) {
      ev("gate", "door", await st(), "vehicle gate did not open from the booth button")
      ok = false
    }
    await tp(0, 0, 112, Math.PI)
    ok = (await go("gate", [[0, 112], [0, 122], [0, 135], [-20, 160], [-55, 172], [-70, 175]])) && ok
    return ok
  })

if (legs.includes("rooms"))
  for (const i of storeys) {
    const rooms = snap.rooms.filter((r) => r.storey === i).slice(0, roomLimit)
    await leg(`rooms s${i} (${rooms.length})`, async () => {
      let ok = true
      for (const r of rooms) {
        const name = `room ${r.id}`
        const { x0, x1, z0, z1 } = r.rect
        const inRoom = (x: number, z: number) => x > x0 && x < x1 && z > z0 && z < z1
        const centre: [number, number] = [(x0 + x1) / 2, (z0 + z1) / 2]
        const doorIds = snap.regDoors.filter((d) => d.room === r.id && d.storey === i && !/locked|keycard/.test(d.state)).map((d) => d.id)
        const door = doorIds.map((id) => snap.doors.find((d) => d.id === id)).find((d) => d && !d.locked)
        if (!door) {
          // Open-plan room (or every door locked): walk in from the hall.
          if (r.doors.length) continue
          await tp(HALL[0], Y(i), HALL[1])
          const p = plan(HALL, centre, Y(i))
          if (!p) {
            ev(name, "noroute", { x: centre[0], y: Y(i), z: centre[1] }, `${r.name}: no door registered and no open path from the hall`)
            ok = false
            continue
          }
          ok = (await go(name, p.map(([x, z]) => [x, z, Y(i)]), { run: true })) && ok
          continue
        }
        const sideOut = inRoom(door.mx + door.nx * 1.2, door.mz + door.nz * 1.2) ? -1 : 1
        const ox = door.mx + door.nx * sideOut * 1.2
        const oz = door.mz + door.nz * sideOut * 1.2
        await tp(ox, Y(i), oz)
        await look(door.mx, door.hy + 1.0, door.mz)
        await sleep(150)
        let s = await st()
        const mine = s.focused === door.id || (!!door.partner && s.focused === door.partner)
        if (!s.fOpen || !mine) {
          if (!mine) ev(name, "door", s, `${r.name}: door ${door.id} not focused from the corridor (focused ${s.focused})`)
          await pressE()
          await sleep(2600)
        }
        const open = await inPage(page, (g, id: string) => g.doors.get(id)?.isOpen, door.id)
        if (!open) {
          ev(name, "door", await st(), `${r.name}: door ${door.id} did not open with E`)
          ok = false
          continue
        }
        const inside: [number, number] = [door.mx - door.nx * sideOut * 0.9, door.mz - door.nz * sideOut * 0.9]
        const p = plan(inside, centre, Y(i))
        const pts: [number, number, number?][] = [[door.mx, door.mz], inside, ...(p ?? []).slice(1).map(([x, z]) => [x, z] as [number, number])]
        if (!p) ev(name, "noroute", { x: inside[0], y: Y(i), z: inside[1] }, `${r.name}: room centre not reachable past furniture (planner)`)
        const before = events.length
        ok = (await go(name, pts.map(([x, z]) => [x, z, Y(i)]), { run: true })) && ok
        s = await st()
        if (events.length === before && !inRoom(s.x, s.z)) ev(name, "stuck", s, `${r.name}: ended outside the room rect`)
      }
      return ok
    })
  }

const errorsAll = { page: log.page, console: log.console }
mkdirSync(OUT, { recursive: true })
const file = `${OUT}/walk-${legs.join("+")}.json`
writeFileSync(file, JSON.stringify({ legs: legLog, events, errors: errorsAll }, null, 1))
console.log(`\n${events.length} events; page errors ${log.page.length}, console errors ${log.console.length} → ${file}`)
for (const e of log.page.slice(0, 5)) console.log(`  pageerror: ${e}`)
for (const e of log.console.slice(0, 8)) console.log(`  console: ${e}`)
await browser.close()
process.exit(0)
