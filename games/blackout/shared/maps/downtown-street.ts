import type { Rect } from "../geom"
import { parkedCar, wreckAt } from "./downtown-lots"
import { FACE, OUT, type Junction, type Street, type Town, type Walk, drive, free, overlap, take } from "./downtown-town"
import type { Side } from "./geo"
import type { Prop } from "./types"

type Rot = Prop["rot"]
const SODIUM = [1, 0.6, 0.28] as const
const RED = [1, 0.1, 0.06] as const
const GREEN = [0.15, 1, 0.5] as const

/** Paint, signals, parked cars, the burning wreck, then lamps and furniture along every sidewalk. */
export function streets(t: Town): void {
  paint(t)
  for (const j of t.junctions) signals(t, j)
  wreck(t)
  vehicles(t)
  for (const s of t.streets) parking(t, s)
  shelters(t)
  for (const w of t.walks) lamps(t, w)
  for (const w of t.walks) furniture(t, w)
  neons(t)
}

const horizontal = (s: Side) => s === "n" || s === "s"

/** A point on the sidewalks (not on a road or a lot). */
function onWalk(t: Town, x: number, y: number): boolean {
  return t.walks.some((w) => x > w.rect[0] && x < w.rect[2] && y > w.rect[1] && y < w.rect[3])
}

// Paint ---------------------------------------------------------------------------------------------------------------

/** Zebra crossings on every arm of every junction, stop lines, centre and lane lines between junctions. */
function paint(t: Town): void {
  const P = t.b.paint
  const white = (rc: Rect) => P.push({ rect: rc, color: "white" })
  const yellow = (rc: Rect) => P.push({ rect: rc, color: "yellow" })
  const armOf = (j: Junction, side: Side): Street | undefined =>
    t.streets.find((s) => {
      const E = 1e-6
      if (side === "n") return s.axis === "y" && Math.abs(s.rect[3] - j.rect[1]) < E && Math.abs(s.rect[0] - j.rect[0]) < E
      if (side === "s") return s.axis === "y" && Math.abs(s.rect[1] - j.rect[3]) < E && Math.abs(s.rect[0] - j.rect[0]) < E
      return s.axis === "x" && Math.abs(s.rect[1] - j.rect[1]) < E && (side === "w" ? s.rect[0] < j.rect[0] - E : s.rect[2] > j.rect[2] + E)
    })
  for (const j of t.junctions) {
    const [x0, y0, x1, y1] = j.rect
    if (j.n || j.s) {
      for (const side of ["n", "s"] as const) {
        if (!j[side]) continue
        const a = side === "n" ? y0 - 3.6 : y1 + 0.6
        for (let x = x0 + 0.4; x + 0.5 <= x1 - 0.3; x += 1.1) white([x, a, x + 0.5, a + 3])
        const st = armOf(j, side)
        if (st && countArms(j) >= 3) {
          const d = drive(st)
          const mid = (d[0] + d[2]) / 2
          // Right-hand traffic: northbound stops in the east half below the junction, southbound in the west half above.
          if (side === "s") white([mid + 0.1, y1 + 4, d[2] - 0.1, y1 + 4.35])
          else white([d[0] + 0.1, y0 - 4.35, mid - 0.1, y0 - 4])
        }
      }
    }
    for (const side of ["w", "e"] as const) {
      if (!j[side]) continue
      const a = side === "w" ? x0 - 3.6 : x1 + 0.6
      for (let y = y0 + 0.4; y + 0.5 <= y1 - 0.3; y += 1.1) white([a, y, a + 3, y + 0.5])
      const st = armOf(j, side)
      if (st && countArms(j) >= 3) {
        const d = drive(st)
        const mid = (d[1] + d[3]) / 2
        if (side === "w") white([x0 - 4.35, mid + 0.1, x0 - 4, d[3] - 0.1])
        else white([x1 + 4, d[1] + 0.1, x1 + 4.35, mid - 0.1])
      }
    }
  }
  for (const s of t.streets) {
    const d = drive(s)
    const ax = s.axis === "x"
    const lo = ax ? d[0] : d[1]
    const hi = ax ? d[2] : d[3]
    // Stretches clear of junctions and their crossings.
    const skip: [number, number][] = t.junctions.filter((j) => overlap(j.rect, s.rect, 0.01)).map((j) => (ax ? [j.rect[0] - 4.6, j.rect[2] + 4.6] : [j.rect[1] - 4.6, j.rect[3] + 4.6]))
    if (s.end) skip.push(s.end === "n" || s.end === "w" ? [lo - 1, lo + 1.5] : [hi - 1.5, hi + 1])
    const runs = spans(lo, hi, skip)
    const mid = ax ? (d[1] + d[3]) / 2 : (d[0] + d[2]) / 2
    const line = (a: number, z: number, c: number, w: number, col: "white" | "yellow") => P.push({ rect: ax ? [a, c - w / 2, z, c + w / 2] : [c - w / 2, a, c + w / 2, z], color: col })
    for (const [a, z] of runs) {
      if (s.lanes >= 4) {
        line(a, z, mid - 0.13, 0.11, "yellow")
        line(a, z, mid + 0.13, 0.11, "yellow")
        for (const off of [-3.5, 3.5]) for (let u = a + 0.5; u + 2.4 <= z; u += 5.4) line(u, u + 2.4, mid + off, 0.11, "white")
      } else for (let u = a + 0.6; u + 2.4 <= z; u += 5) line(u, u + 2.4, mid, 0.12, "yellow")
      // The edge of the travel lanes where there's a parking lane beside them.
      if (s.park[0] > 0) line(a, z, (ax ? d[1] : d[0]) + 0.06, 0.1, "white")
      if (s.park[1] > 0) line(a, z, (ax ? d[3] : d[2]) - 0.06, 0.1, "white")
    }
  }
  void yellow
}

const countArms = (j: Junction) => Number(j.n) + Number(j.s) + Number(j.w) + Number(j.e)

/** [lo, hi] minus the skip spans. */
function spans(lo: number, hi: number, skip: [number, number][]): [number, number][] {
  let out: [number, number][] = [[lo, hi]]
  for (const [a, z] of skip) {
    const next: [number, number][] = []
    for (const [p, q] of out) {
      if (z <= p || a >= q) next.push([p, q])
      else {
        if (a > p) next.push([p, a])
        if (z < q) next.push([z, q])
      }
    }
    out = next
  }
  return out.filter(([p, q]) => q - p > 1)
}

// Signals and lamps ---------------------------------------------------------------------------------------------------

/**
 * Traffic lights on two opposite corners of a three- or four-way junction, one red, one green, and a street lamp on
 * one of the other corners with its arm out over the crossing.
 */
function signals(t: Town, j: Junction): void {
  if (countArms(j) < 3) return
  const [x0, y0, x1, y1] = j.rect
  const corners: { x: number; y: number; rot: Rot }[] = [
    { x: x1 + 0.45, y: y0 - 0.45, rot: 1 },
    { x: x0 - 0.45, y: y1 + 0.45, rot: 3 },
    { x: x0 - 0.45, y: y0 - 0.45, rot: 0 },
    { x: x1 + 0.45, y: y1 + 0.45, rot: 2 },
  ]
  const ok = (c: { x: number; y: number }, pad: number) => onWalk(t, c.x, c.y) && free(t, [c.x - 0.15, c.y - 0.15, c.x + 0.15, c.y + 0.15], pad)
  const diag = t.r.next() < 0.5
  const ns = t.r.next() < 0.5
  const used = new Set<number>()
  for (const k of diag ? [0, 1, 2, 3] : [2, 3, 0, 1]) {
    if (used.size >= 2) break
    const c = corners[k]!
    if (!ok(c, 0.2)) continue
    const rc: Rect = [c.x - 0.14, c.y - 0.14, c.x + 0.14, c.y + 0.14]
    const red = (k % 2 === 0) === ns
    const id = t.b.light({ kind: "signal", x: c.x, y: c.y, h: 3.3, r: 3.4, power: 0.55, color: red ? RED : GREEN })
    t.b.prop("signal", ...rc, c.rot, true, id)
    take(t, [rc[0] - 0.4, rc[1] - 0.4, rc[2] + 0.4, rc[3] + 0.4])
    used.add(k)
  }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  for (const k of t.r.next() < 0.5 ? [0, 1, 2, 3] : [3, 2, 1, 0]) {
    if (used.has(k)) continue
    const c = corners[k]!
    // The arm reaches across the wider gap, toward the middle of the junction.
    const horiz = x1 - x0 < y1 - y0
    const ox = horiz ? Math.sign(cx - c.x) : 0
    const oy = horiz ? 0 : Math.sign(cy - c.y)
    const lx = c.x + ox * 1.25
    const ly = c.y + oy * 1.25
    if (!ok(c, 0.2) || t.lit.some((q) => Math.hypot(q.x - lx, q.y - ly) < 5)) continue
    const lrc: Rect = [c.x - 0.15, c.y - 0.15, c.x + 0.15, c.y + 0.15]
    const id = t.b.light({ kind: "street", x: lx, y: ly, h: 5.2, r: 11, power: 1.15, color: SODIUM, cone: [ox, oy, -0.6] })
    t.b.prop("lamppost", ...lrc, ox > 0 ? 3 : ox < 0 ? 1 : oy > 0 ? 0 : 2, true, id)
    take(t, [lrc[0] - 0.3, lrc[1] - 0.3, lrc[2] + 0.3, lrc[3] + 0.3])
    t.lit.push({ x: lx, y: ly })
    break
  }
}

/**
 * Street lamps along the curb, far enough apart that it's dark between the pools: the arm reaches out over the road
 * and the light hangs there.
 */
function lamps(t: Town, w: Walk): void {
  const { r } = t
  const hz = horizontal(w.curb)
  const L = hz ? w.rect[2] - w.rect[0] : w.rect[3] - w.rect[1]
  if (L < 6) return
  const [ox, oy] = OUT[w.curb]
  const curbLine = w.curb === "n" ? w.rect[1] : w.curb === "s" ? w.rect[3] : w.curb === "w" ? w.rect[0] : w.rect[2]
  for (let u = 3 + r.next() * 6; u < L - 2; u += 15 + r.next() * 5) {
    const along = (hz ? w.rect[0] : w.rect[1]) + u
    const px = hz ? along : curbLine - ox * 0.35
    const py = hz ? curbLine - oy * 0.35 : along
    const lx = px + ox * 1.25
    const ly = py + oy * 1.25
    if (t.lit.some((q) => Math.hypot(q.x - lx, q.y - ly) < 8)) continue
    if (t.junctions.some((j) => overlap(j.rect, [lx - 1, ly - 1, lx + 1, ly + 1]))) continue
    const rc: Rect = [px - 0.15, py - 0.15, px + 0.15, py + 0.15]
    if (!free(t, rc, 0.25)) continue
    const id = t.b.light({ kind: "street", x: lx, y: ly, h: 5.2, r: 11, power: 1.15, color: SODIUM, cone: [ox, oy, -0.6], flicker: r.next() < 0.08 ? r.range(0.3, 0.8) : undefined })
    t.b.prop("lamppost", ...rc, FACE[w.curb], true, id)
    take(t, [rc[0] - 0.3, rc[1] - 0.3, rc[2] + 0.3, rc[3] + 0.3])
    t.lit.push({ x: lx, y: ly })
  }
}

/** Trees in pits along some curbs, and hydrants, bins, newspaper boxes and benches dotted about. */
function furniture(t: Town, w: Walk): void {
  const { r, b } = t
  const hz = horizontal(w.curb)
  const L = hz ? w.rect[2] - w.rect[0] : w.rect[3] - w.rect[1]
  const D = hz ? w.rect[3] - w.rect[1] : w.rect[2] - w.rect[0]
  if (L < 5 || D < 2.4) return
  // u along the walk, v in from the curb.
  const R = (u0: number, v0: number, u1: number, v1: number): Rect => {
    const a = hz ? w.rect[0] : w.rect[1]
    if (w.curb === "n") return [a + u0, w.rect[1] + v0, a + u1, w.rect[1] + v1]
    if (w.curb === "s") return [a + u0, w.rect[3] - v1, a + u1, w.rect[3] - v0]
    if (w.curb === "w") return [w.rect[0] + v0, a + u0, w.rect[0] + v1, a + u1]
    return [w.rect[2] - v1, a + u0, w.rect[2] - v0, a + u1]
  }
  if (r.next() < 0.45)
    for (let u = 3 + r.next() * 4; u < L - 3; u += 8 + r.next() * 5) {
      const rc = R(u - 0.2, 0.55, u + 0.2, 0.95)
      if (!free(t, rc, 0.9)) continue
      b.prop("tree", ...rc, r.int(4) as Rot, true)
      take(t, [rc[0] - 0.5, rc[1] - 0.5, rc[2] + 0.5, rc[3] + 0.5])
    }
  const n = r.int(3) + (L > 20 ? 1 : 0)
  for (let k = 0; k < n; k++) {
    const u = r.range(1.5, L - 1.5)
    const kind = r.pick(["hydrant", "bin", "bin", "newsbox", "newsbox", "bench"] as const)
    if (kind === "bench") {
      // Against the building side, facing the road.
      const rc = R(u - 0.9, D - 0.65, u + 0.9, D - 0.1)
      if (free(t, rc, 0.3) && freeOfWalls(t, rc)) {
        b.prop("bench", ...rc, FACE[w.curb], true)
        take(t, rc)
      }
      continue
    }
    const s = kind === "hydrant" ? 0.16 : kind === "bin" ? 0.24 : 0.24
    const rc = R(u - s, 0.35, u + s, 0.35 + s * 2)
    if (!free(t, rc, 0.4)) continue
    b.prop(kind, ...rc, FACE[w.curb], true)
    take(t, rc)
    if (kind === "newsbox" && r.next() < 0.6) {
      const rc2 = R(u + s + 0.08, 0.35, u + 3 * s + 0.08, 0.35 + s * 2)
      if (free(t, rc2, 0.05)) {
        b.prop("newsbox", ...rc2, FACE[w.curb], true)
        take(t, rc2)
      }
    }
  }
}

function freeOfWalls(t: Town, rc: Rect): boolean {
  return !t.b.walls.some((w) => overlap(w.rect, rc, 0.05)) && !t.b.windows.some((w) => overlap(w, rc, 0.05))
}

// Cars, wreck, shelters, signs ----------------------------------------------------------------------------------------

/**
 * Heading of traffic in a parking lane (right-hand traffic): along +x on a road's south side, -x on its north side,
 * +y on its west side, -y on its east side.
 */
const laneHeading = (s: Street, side: 0 | 1) => (s.axis === "x" ? (side === 1 ? 0 : Math.PI) : side === 0 ? Math.PI / 2 : -Math.PI / 2)

/** Drivable vehicles, parked in the parking lanes spread round the map: a van, jeeps and scooters. */
function vehicles(t: Town): void {
  const { r } = t
  const want = (["van", "jeep", "jeep", "scooter", "scooter"] as const).slice(t.vehicles.length)
  const spots: { s: Street; side: 0 | 1; u: number }[] = []
  for (const s of t.streets) {
    const ax = s.axis === "x"
    const skip: [number, number][] = t.junctions.filter((j) => overlap(j.rect, s.rect, 0.01)).map((j) => (ax ? [j.rect[0] - 5, j.rect[2] + 5] : [j.rect[1] - 5, j.rect[3] + 5]))
    for (const side of [0, 1] as const) {
      if (!s.park[side]) continue
      for (const [a, z] of spans(ax ? s.rect[0] : s.rect[1], ax ? s.rect[2] : s.rect[3], skip)) if (z - a >= 6) spots.push({ s, side, u: a + 3 + r.next() * (z - a - 6) })
    }
  }
  const placed: { x: number; y: number }[] = []
  for (const kind of want) {
    let best: { x: number; y: number; h: number; rc: Rect } | null = null
    let bd = -1
    for (const sp of spots) {
      const { s, side } = sp
      const ax = s.axis === "x"
      const pw = s.park[side]
      const v = side === 0 ? (ax ? s.rect[1] : s.rect[0]) + pw / 2 : (ax ? s.rect[3] : s.rect[2]) - pw / 2
      const x = ax ? sp.u : v
      const y = ax ? v : sp.u
      const hl = kind === "van" ? 2.7 : kind === "jeep" ? 2.2 : 1.1
      const hw = kind === "scooter" ? 0.6 : 1.15
      const rc: Rect = ax ? [x - hl, y - hw, x + hl, y + hw] : [x - hw, y - hl, x + hw, y + hl]
      if (!free(t, rc, 0.3)) continue
      // Spread out: as far as possible from the others.
      const d = placed.length ? Math.min(...placed.map((q) => Math.hypot(q.x - x, q.y - y))) : r.next()
      if (d > bd) {
        bd = d
        best = { x, y, h: laneHeading(s, side), rc }
      }
    }
    if (!best && kind === "scooter") {
      // No room in the parking lanes: a scooter up on the sidewalk by the curb.
      for (const w of t.walks) {
        const hz = w.curb === "n" || w.curb === "s"
        const L = hz ? w.rect[2] - w.rect[0] : w.rect[3] - w.rect[1]
        if (L < 8 || (hz ? w.rect[3] - w.rect[1] : w.rect[2] - w.rect[0]) < 2.4) continue
        const u = (hz ? w.rect[0] : w.rect[1]) + L * (0.3 + r.next() * 0.4)
        const v = w.curb === "n" ? w.rect[1] + 0.75 : w.curb === "s" ? w.rect[3] - 0.75 : w.curb === "w" ? w.rect[0] + 0.75 : w.rect[2] - 0.75
        const x = hz ? u : v
        const y = hz ? v : u
        const rc: Rect = hz ? [x - 1.1, y - 0.5, x + 1.1, y + 0.5] : [x - 0.5, y - 1.1, x + 0.5, y + 1.1]
        if (!free(t, rc, 0.3) || placed.some((q) => Math.hypot(q.x - x, q.y - y) < 10)) continue
        best = { x, y, h: hz ? (w.curb === "n" ? Math.PI : 0) : w.curb === "w" ? Math.PI / 2 : -Math.PI / 2, rc }
        break
      }
    }
    if (!best) continue
    t.vehicles.push({ kind, x: best.x, y: best.y, heading: best.h })
    take(t, best.rc)
    placed.push(best)
  }
}

/** Cars along a street's parking lanes, with gaps, never near a junction. */
function parking(t: Town, s: Street): void {
  if (!s.park[0] && !s.park[1]) return
  const ax = s.axis === "x"
  const lo = ax ? s.rect[0] : s.rect[1]
  const hi = ax ? s.rect[2] : s.rect[3]
  const skip: [number, number][] = t.junctions.filter((j) => overlap(j.rect, s.rect, 0.01)).map((j) => (ax ? [j.rect[0] - 5.5, j.rect[2] + 5.5] : [j.rect[1] - 5.5, j.rect[3] + 5.5]))
  for (const side of [0, 1] as const) {
    const pw = s.park[side]
    if (!pw) continue
    const v0 = side === 0 ? (ax ? s.rect[1] : s.rect[0]) : (ax ? s.rect[3] : s.rect[2]) - pw
    for (const [a, z] of spans(lo, hi, skip)) {
      for (let u = a + t.r.next() * 1.5; u + 4.8 <= z; u += 5.4 + t.r.next() * 2) {
        if (t.r.next() < 0.25) continue
        const rc: Rect = ax ? [u, v0 + 0.15, u + 4.8, v0 + pw - 0.15] : [v0 + 0.15, u, v0 + pw - 0.15, u + 4.8]
        // Right-hand traffic: cars face the way their side of the road runs.
        parkedCar(t, rc, s.axis, laneHeading(s, side) > Math.PI / 4 * 3 || laneHeading(s, side) < 0)
      }
    }
  }
}

/** Sometimes a car burns at a dead end behind a line of barriers, or in a parking lane. */
function wreck(t: Town): void {
  const { r, b } = t
  if (b.lights.some((l) => l.kind === "fire") || r.next() < 0.3) return
  const stub = t.streets.find((s) => s.stub && s.end)
  if (stub) {
    const [x0, y0, x1, y1] = stub.rect
    const ax = stub.axis === "x"
    const width = ax ? y1 - y0 : x1 - x0
    // Barriers across the stub a little in from the junction, the wreck beyond them.
    const atEnd = stub.end === "n" || stub.end === "w"
    const len = ax ? x1 - x0 : y1 - y0
    const bu = atEnd ? len - 4.6 : 4.6
    const wu = atEnd ? 2.6 + r.next() : len - 3.6 - r.next()
    const off = r.next() < 0.5 ? 0.5 : width - 2.4
    const R = (u0: number, v0: number, u1: number, v1: number): Rect => (ax ? [x0 + u0, y0 + v0, x0 + u1, y0 + v1] : [x0 + v0, y0 + u0, x0 + v1, y0 + u1])
    for (let v = 0.3; v + 1.9 <= width - 0.3; v += 2.6) if (r.next() < 0.75) b.wall(...R(bu - 0.3, v, bu + 0.3, v + 1.9), 0.85, "barrier")
    wreckAt(t, R(wu - 2.2, off, wu + 2.2, off + 1.9), ax ? "x" : "y")
    return
  }
  for (const s of t.streets) {
    if (!s.park[0] && !s.park[1]) continue
    const side = s.park[0] ? 0 : 1
    const ax = s.axis === "x"
    const skip: [number, number][] = t.junctions.filter((j) => overlap(j.rect, s.rect, 0.01)).map((j) => (ax ? [j.rect[0] - 7, j.rect[2] + 7] : [j.rect[1] - 7, j.rect[3] + 7]))
    const run = spans(ax ? s.rect[0] : s.rect[1], ax ? s.rect[2] : s.rect[3], skip).find(([a, z]) => z - a > 6)
    if (!run) continue
    const u = (run[0] + run[1]) / 2
    const v0 = side === 0 ? (ax ? s.rect[1] : s.rect[0]) : (ax ? s.rect[3] : s.rect[2]) - s.park[1]
    const rc: Rect = ax ? [u - 2.4, v0 + 0.1, u + 2.4, v0 + 2.4] : [v0 + 0.1, u - 2.4, v0 + 2.4, u + 2.4]
    t.taken = t.taken.filter((q) => !overlap(q, rc))
    b.walls = b.walls.filter((w) => !(w.style === "car" && overlap(w.rect, rc)))
    wreckAt(t, rc, s.axis)
    return
  }
}

/** One or two bus shelters on wide sidewalks: glass back and end, a roof, a bench, a lit advert. */
function shelters(t: Town): void {
  const { r, b } = t
  let n = 1 + (r.next() < 0.5 ? 1 : 0)
  const walks = t.walks.filter((w) => (horizontal(w.curb) ? w.rect[2] - w.rect[0] : w.rect[3] - w.rect[1]) >= 14 && (horizontal(w.curb) ? w.rect[3] - w.rect[1] : w.rect[2] - w.rect[0]) >= 2.9)
  for (let k = 0; k < walks.length * 2 && n > 0; k++) {
    const w = r.pick(walks)
    const hz = horizontal(w.curb)
    const L = hz ? w.rect[2] - w.rect[0] : w.rect[3] - w.rect[1]
    const u = r.range(3, L - 6.6)
    const a = (hz ? w.rect[0] : w.rect[1]) + u
    const v0 = 0.45
    const v1 = 1.75
    const R = (u0: number, va: number, u1: number, vb: number): Rect => {
      if (w.curb === "n") return [a + u0, w.rect[1] + va, a + u1, w.rect[1] + vb]
      if (w.curb === "s") return [a + u0, w.rect[3] - vb, a + u1, w.rect[3] - va]
      if (w.curb === "w") return [w.rect[0] + va, a + u0, w.rect[0] + vb, a + u1]
      return [w.rect[2] - vb, a + u0, w.rect[2] - va, a + u1]
    }
    const foot = R(0, v0, 3.6, v1)
    if (!free(t, foot, 0.4)) continue
    b.props.push({ kind: "shelter", rect: foot, rot: FACE[w.curb], solid: false })
    b.pane(...R(0.05, v1 - 0.08, 3.55, v1))
    b.pane(...R(3.5, v0 + 0.3, 3.58, v1 - 0.08))
    const ad = R(3.3, (v0 + v1) / 2, 3.3, (v0 + v1) / 2)
    b.light({ kind: "glow", x: ad[0], y: ad[1], h: 1.2, r: 3.8, power: 0.8, color: r.next() < 0.5 ? [1, 0.25, 0.65] : [0.3, 0.75, 1] })
    take(t, [foot[0] - 0.3, foot[1] - 0.3, foot[2] + 0.3, foot[3] + 0.3])
    n--
  }
}

const WORDS = ["HOTEL", "ECHO", "LIVE", "NOODLE", "MOTEL", "KARAOKE", "SUSHI", "CLUB", "PAWN", "TATTOO", "VIDEO", "ARCADE"]
const NEONS: readonly (readonly [number, number, number])[] = [
  [1, 0.2, 0.75],
  [0.2, 0.9, 1],
  [1, 0.3, 0.4],
  [0.6, 0.35, 1],
  [1, 0.6, 0.2],
]

/** Neon signs on a few building fronts that face a sidewalk (not north faces: the camera can't see them). */
function neons(t: Town): void {
  const { r, b } = t
  let n = 2 + r.int(3)
  const cands = b.walls.filter((w) => w.style === "building")
  for (let k = 0; k < cands.length * 2 && n > 0; k++) {
    const w = r.pick(cands)
    const s = r.pick(["s", "s", "w", "e"] as const)
    const [x0, y0, x1, y1] = w.rect
    const L = horizontal(s) ? x1 - x0 : y1 - y0
    if (L < 4) continue
    const [ox, oy] = OUT[s]
    const line = s === "s" ? y1 : s === "w" ? x0 : x1
    const probe = horizontal(s) ? { x: (x0 + x1) / 2, y: line + oy * 0.6 } : { x: line + ox * 0.6, y: (y0 + y1) / 2 }
    if (!onWalk(t, probe.x, probe.y)) continue
    const text = r.pick(WORDS)
    const sl = Math.min(L - 1, 0.5 * text.length + 0.4)
    const u = (horizontal(s) ? x0 : y0) + r.range(0.5, L - sl - 0.5)
    const rect: Rect = horizontal(s) ? [u, line, u + sl, line + 0.16] : s === "w" ? [line - 0.16, u, line, u + sl] : [line, u, line + 0.16, u + sl]
    const mx = (rect[0] + rect[2]) / 2 + ox * 0.8
    const my = (rect[1] + rect[3]) / 2 + oy * 0.8
    if (t.lit.some((q) => Math.hypot(q.x - mx, q.y - my) < 6)) continue
    const id = b.light({ kind: "neon", x: mx, y: my, h: 3.6, r: 7.5, power: 1.05, color: r.pick(NEONS), cone: [ox, oy, -0.35], flicker: r.next() < 0.25 ? r.range(0.2, 0.6) : undefined })
    b.props.push({ kind: "neon", rect, rot: FACE[s], solid: false, light: id >= 0 ? id : undefined, text })
    t.lit.push({ x: mx, y: my })
    n--
  }
}
