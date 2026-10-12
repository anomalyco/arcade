import type { Rect } from "../geom"
import type { Rng } from "../rng"
import { type Plan, type Room, type RoomKind, type Side, EPS, OPP, contact, horizontal, q } from "./geo"
import { compose } from "./plans"
import { type Gen, connect, program } from "./zones"

export type * from "./geo"
export { contact, shuffle, weighted } from "./geo"

/** Rooms whose walls come down when part of a floor is being refitted. */
const STRIPPABLE = new Set<RoomKind>(["office", "manager", "meeting", "empty", "storage", "copy", "lounge", "boardroom", "hall", "cubicles", "lab", "foyer"])

/**
 * A floor halfway through a refit: the rooms at one end stripped back to concrete, most of their partitions knocked
 * through (stubs left standing), so the zone becomes one rough open space joined to the corridors.
 */
function renovate(g: Gen): void {
  const r = g.r
  const side: Side = r.pick(["w", "e", "n", "s"])
  const frac = r.range(0.28, 0.42)
  const inZone = (rc: Rect) => {
    const cx = (rc[0] + rc[2]) / 2
    const cy = (rc[1] + rc[3]) / 2
    return side === "w" ? cx < g.W * frac : side === "e" ? cx > g.W * (1 - frac) : side === "n" ? cy < g.H * frac : cy > g.H * (1 - frac)
  }
  const demo = g.rooms.filter((x) => STRIPPABLE.has(x.kind) && inZone(x.rect))
  if (demo.length < 3) return
  for (const x of demo) x.kind = "demo"
  const ids = new Set(demo.map((x) => x.id))
  const zones: { z: number; rc: Rect }[] = [...demo.map((x) => ({ z: x.id, rc: x.rect })), ...g.corridors.map((c, k) => ({ z: -1 - k, rc: c })).filter((c) => inZone(c.rc))]
  for (const a of demo)
    for (const b of zones) {
      if (b.z === a.id || (b.z >= 0 && b.z < a.id && ids.has(b.z))) continue
      const t = contact(a.rect, b.rc)
      if (!t || t.hi - t.lo < 1.5) continue
      // Knock it through, leaving a stub of wall at each end now and then and sometimes one in the middle.
      const l = horizontal(t.side) ? (t.side === "n" ? a.rect[1] : a.rect[3]) : t.side === "w" ? a.rect[0] : a.rect[2]
      g.openings = g.openings.filter((o) => !(o.a === a.id || o.b === a.id) || !(horizontal(t.side) ? Math.abs(o.y0 - o.y1) < EPS && Math.abs(o.y0 - l) < EPS && o.x0 < t.hi && o.x1 > t.lo : Math.abs(o.x0 - o.x1) < EPS && Math.abs(o.x0 - l) < EPS && o.y0 < t.hi && o.y1 > t.lo))
      let lo = t.lo + (r.next() < 0.6 ? r.range(0.5, 1.6) : 0.15)
      let hi = t.hi - (r.next() < 0.6 ? r.range(0.5, 1.6) : 0.15)
      if (hi - lo < 1.2) {
        lo = (t.lo + t.hi) / 2 - 0.6
        hi = lo + 1.2
      }
      if (hi - lo > 5 && r.next() < 0.5) {
        const m = r.range(lo + 1.5, hi - 2.5)
        g.open("open", a.id, b.z, t.side, lo, m)
        g.open("open", a.id, b.z, t.side, m + r.range(0.6, 1.4), hi)
      } else g.open("open", a.id, b.z, t.side, lo, hi)
    }
  g.tags.add("demo")
}

function mirror(p: Plan, mx: boolean, my: boolean): Plan {
  const { W, H } = p
  const rc = (a: Rect): Rect => [mx ? q(W - a[2]) : a[0], my ? q(H - a[3]) : a[1], mx ? q(W - a[0]) : a[2], my ? q(H - a[1]) : a[3]]
  const sd = (s: Side): Side => (mx && !horizontal(s) ? OPP[s] : my && horizontal(s) ? OPP[s] : s)
  return {
    ...p,
    rooms: p.rooms.map((x) => ({ ...x, rect: rc(x.rect), front: sd(x.front) })),
    corridors: p.corridors.map(rc),
    pillars: p.pillars.map(rc),
    voids: p.voids.map(rc),
    openings: p.openings.map((o) => {
      const [x0, y0, x1, y1] = rc([o.x0, o.y0, o.x1, o.y1])
      return { ...o, x0, y0, x1, y1 }
    }),
    ends: p.ends.map((e) => ({ ...e, x: mx ? q(W - e.x) : e.x, y: my ? q(H - e.y) : e.y, side: sd(e.side) })),
    solid: p.solid.map(sd),
  }
}

/** Lays out an office floor the way an architect would, then makes it flow: see Archetype and Template. */
export function layout(r: Rng): Plan {
  const { g, archetype } = compose(r)
  program(g)
  connect(g)
  if (r.next() < 0.18) renovate(g)
  const plan: Plan = { W: g.W, H: g.H, archetype, tags: [...g.tags].sort(), rooms: g.rooms, corridors: g.corridors, openings: g.openings, ends: g.ends, pillars: g.pillars, solid: [...g.solid], voids: g.voids }
  return mirror(plan, r.next() < 0.5, r.next() < 0.5)
}

/** Rooms that count for flow: everything enclosed, not the open plan, lift shafts or lobbies. */
export const counted = (room: Room) => room.kind !== "shaft" && room.kind !== "hall" && room.kind !== "core"

/** Ways into a room: doorways and open stretches to anywhere, not glass. */
export function entrances(p: Plan, id: number): number {
  return p.openings.filter((o) => (o.a === id || o.b === id) && o.kind !== "glass").length
}
