import type { Rect } from "@arcade/kit/sim/geom"
import type { HouseRoom } from "./style"

/**
 * Plan geometry shared by the generator (walls, openings) and the client (cladding, roofs, upper storeys): the outside
 * edges of a set of rooms and the edges two rooms share.
 */

/** An edge along x (`axis: "x"`, at z = `at`) or along z (at x = `at`), from a0 to a1; `side` points outside (+z/+x). */
export type PlanEdge = { axis: "x" | "z"; at: number; a0: number; a1: number; side: 1 | -1 }

/** An edge between two rooms: `a` is the room on the low side (north or west), `b` on the high side. */
export type SharedEdge = { axis: "x" | "z"; at: number; a0: number; a1: number; a: number; b: number }

const EPS = 1e-4
const same = (p: number, q: number) => Math.abs(p - q) < EPS

/** The four edges of a rect, outward sides set. */
function edgesOf(r: Rect): PlanEdge[] {
  return [
    { axis: "x", at: r[1], a0: r[0], a1: r[2], side: -1 },
    { axis: "x", at: r[3], a0: r[0], a1: r[2], side: 1 },
    { axis: "z", at: r[0], a0: r[1], a1: r[3], side: -1 },
    { axis: "z", at: r[2], a0: r[1], a1: r[3], side: 1 },
  ]
}

function subtract(spans: [number, number][], c0: number, c1: number): [number, number][] {
  const out: [number, number][] = []
  for (const [s0, s1] of spans) {
    if (c1 <= s0 + EPS || c0 >= s1 - EPS) {
      out.push([s0, s1])
      continue
    }
    if (c0 > s0 + EPS) out.push([s0, c0])
    if (c1 < s1 - EPS) out.push([c1, s1])
  }
  return out
}

/** Outside edges of the union of `rects` (rooms tile it without overlap), collinear pieces merged. */
export function boundaryEdges(rects: readonly Rect[]): PlanEdge[] {
  const raw: PlanEdge[] = []
  rects.forEach((r, i) => {
    for (const e of edgesOf(r)) {
      let spans: [number, number][] = [[e.a0, e.a1]]
      rects.forEach((o, j) => {
        if (i === j) return
        // A neighbour across this edge covers part of it.
        if (e.axis === "x") {
          const touches = e.side < 0 ? same(o[3], e.at) : same(o[1], e.at)
          if (touches) spans = subtract(spans, o[0], o[2])
        } else {
          const touches = e.side < 0 ? same(o[2], e.at) : same(o[0], e.at)
          if (touches) spans = subtract(spans, o[1], o[3])
        }
      })
      for (const [a0, a1] of spans) if (a1 - a0 > 0.05) raw.push({ ...e, a0, a1 })
    }
  })
  // Merge collinear touching edges on the same side.
  raw.sort((p, q) => (p.axis < q.axis ? -1 : p.axis > q.axis ? 1 : p.side - q.side || p.at - q.at || p.a0 - q.a0))
  const out: PlanEdge[] = []
  for (const e of raw) {
    const last = out[out.length - 1]
    if (last && last.axis === e.axis && last.side === e.side && same(last.at, e.at) && same(last.a1, e.a0)) last.a1 = e.a1
    else out.push({ ...e })
  }
  return out
}

/** Every edge two rooms share (longer than 5 cm). */
export function sharedEdges(rooms: readonly HouseRoom[]): SharedEdge[] {
  const out: SharedEdge[] = []
  for (let i = 0; i < rooms.length; i++) {
    for (let j = 0; j < rooms.length; j++) {
      if (i === j) continue
      const p = rooms[i]!.rect, q = rooms[j]!.rect
      if (same(p[3], q[1])) {
        const a0 = Math.max(p[0], q[0]), a1 = Math.min(p[2], q[2])
        if (a1 - a0 > 0.05) out.push({ axis: "x", at: p[3], a0, a1, a: i, b: j })
      }
      if (same(p[2], q[0])) {
        const a0 = Math.max(p[1], q[1]), a1 = Math.min(p[3], q[3])
        if (a1 - a0 > 0.05) out.push({ axis: "z", at: p[2], a0, a1, a: i, b: j })
      }
    }
  }
  return out
}

/** Wall thickness of outside walls (inside the room cell) and of partitions (centred on the shared line). */
export const OUTER_WALL = 0.22
export const PARTITION = 0.2

/** A room's floor inside its walls. */
export function roomInner(room: Rect, rooms: readonly Rect[]): Rect {
  const outside = (axis: "x" | "z", at: number, side: 1 | -1, a0: number, a1: number) =>
    boundaryEdges(rooms).some((e) => e.axis === axis && e.side === side && same(e.at, at) && e.a0 < a1 - EPS && e.a1 > a0 + EPS)
  const n = outside("x", room[1], -1, room[0], room[2]) ? OUTER_WALL : PARTITION / 2
  const s = outside("x", room[3], 1, room[0], room[2]) ? OUTER_WALL : PARTITION / 2
  const w = outside("z", room[0], -1, room[1], room[3]) ? OUTER_WALL : PARTITION / 2
  const e = outside("z", room[2], 1, room[1], room[3]) ? OUTER_WALL : PARTITION / 2
  return [room[0] + w, room[1] + n, room[2] - e, room[3] - s]
}
