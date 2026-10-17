import { type Band, type Builder, type Mat, CEIL_Y, DOOR_H, FLOOR_Y, M, T, type Opening, wall } from "./kit"
import { type DoorwaySpec, doorway } from "./doorway"
import { WALL } from "./plan"
import type { Style } from "./styles"
import { materialFor } from "../../render/materials"

// Partitions: straight walls between rooms with two finishes (one per face) and typed openings that build their own
// frames, glazing, trims and door leaves. All heights are above the storey's finished floor.

/** A door in the wall; `side` is the face the door's sign/front is on ("b" = the +z / +x face, default). */
export type PDoor = { kind: "door"; at: number; side?: "a" | "b"; door: Omit<DoorwaySpec, "x" | "z" | "rot" | "wallT"> }
/** Fixed glazing (vision/borrowed-light window, glazed corridor wall). Mullions every `mullion` m. */
export type PGlazed = { kind: "glazed"; from: number; to: number; sill?: number; head?: number; mullion?: number; blinds?: boolean }
/** Cased opening (no leaf) with a timber or steel trim, `head` default door height. */
export type PCased = { kind: "cased"; from: number; to: number; head?: number }
/** High strip window from `sill` to `head` (default 2.1) above a solid lower wall. */
export type PClerestory = { kind: "clerestory"; from: number; to: number; sill: number; head?: number }
/** No wall at all over this span (open-plan edge). */
export type PGap = { kind: "gap"; from: number; to: number }
export type POpening = PDoor | PGlazed | PCased | PClerestory | PGap

export type Finish = Band[] | Style

export type PartitionSpec = {
  /** "x": wall runs along x at z = at; "z": along z at x = at. */
  axis: "x" | "z"
  at: number
  from: number
  to: number
  /** Default 0.12. */
  thickness?: number
  /** [face a (−z or −x side), face b (+z or +x side)]. */
  finish: [Finish, Finish]
  /** "full" (to the ceiling, default) or a height in metres (half-height / panel runs; capped). */
  height?: "full" | number
  openings?: POpening[]
  /** Default true. */
  collide?: boolean
}

const PLATE_GLASS = materialFor("flat", { color: 0xd4e4dc, roughness: 0.03, transparent: 0.08, name: "interior_glazing" })

const bandsOf = (f: Finish): Band[] => (Array.isArray(f) ? f : f.bands)
const seamOf = (f: Finish) => (Array.isArray(f) ? undefined : f.seam)

/** Builds the wall and its openings; returns the door ids created, in opening order. */
export function partition(b: Builder, p: PartitionSpec): string[] {
  const t = p.thickness ?? WALL.partition
  const a0 = Math.min(p.from, p.to)
  const a1 = Math.max(p.from, p.to)
  const half = p.height !== undefined && p.height !== "full"
  const top = half ? FLOOR_Y + (p.height as number) : CEIL_Y + 0.02
  const ops = p.openings ?? []
  const holes: Opening[] = []
  for (const o of ops) {
    if (o.kind === "door") {
      const w = (o.door.width ?? (o.door.double ? 1.7 : 0.92)) / 2 + 0.05
      holes.push({ a0: o.at - w, a1: o.at + w, top: DOOR_H + 0.05 })
    } else if (o.kind === "glazed") holes.push({ a0: o.from, a1: o.to, bottom: o.sill ?? 0.9, top: o.head ?? 2.3 })
    else if (o.kind === "clerestory") holes.push({ a0: o.from, a1: o.to, bottom: o.sill, top: o.head ?? 2.1 })
    else if (o.kind === "cased") holes.push({ a0: o.from, a1: o.to, top: o.head ?? DOOR_H + 0.05 })
    else holes.push({ a0: o.from, a1: o.to, top: 99 })
  }
  // Overlapping openings would emit overlapping head/sill segments (coplanar faces): clip each to the previous one.
  holes.sort((p, q) => p.a0 - q.a0)
  for (let k = 1; k < holes.length; k++) if (holes[k]!.a0 < holes[k - 1]!.a1) holes[k] = { ...holes[k]!, a0: holes[k - 1]!.a1 }
  const ext = { y0: FLOOR_Y - 0.01, y1: top, collide: p.collide ?? true }
  const [fa, fb] = p.finish
  const c = p.at
  if (bandsOf(fa) === bandsOf(fb)) wall(b, p.axis, a0, a1, c - t / 2, c + t / 2, bandsOf(fa), holes, ext)
  else {
    wall(b, p.axis, a0, a1, c - t / 2, c, bandsOf(fa), holes, ext)
    wall(b, p.axis, a0, a1, c, c + t / 2, bandsOf(fb), holes, { ...ext, collide: false })
  }
  if (half) {
    // Cap: a timber/steel rail along the top.
    box(b, p.axis, a0, a1, c - t / 2 - 0.01, c + t / 2 + 0.01, top, top + 0.03, M.laminateTop, holes.filter((h) => h.top >= 50))
  }
  // Seams on solid spans of each face.
  const spans = solidSpans(a0, a1, holes)
  for (const [f, s] of [[fa, -1], [fb, 1]] as const) {
    const seam = seamOf(f)
    if (!seam) continue
    const cz = c + (s * t) / 2
    for (const [s0, s1] of spans)
      for (let u = Math.ceil((s0 + 0.08) / seam.every) * seam.every; u < s1 - 0.08; u += seam.every)
        box(b, p.axis, u - 0.002, u + 0.002, Math.min(cz, cz + s * 0.003), Math.max(cz, cz + s * 0.003), FLOOR_Y + seam.y0, Math.min(top, CEIL_Y), seam.mat, [], false)
  }
  const ids: string[] = []
  const frame = (o: { from: number; to: number }, y0: number, y1: number, mat: Mat) => {
    const w = 0.04
    box(b, p.axis, o.from, o.from + w, c - t / 2 - 0.012, c + t / 2 + 0.012, FLOOR_Y + y0, FLOOR_Y + y1, mat, [], true)
    box(b, p.axis, o.to - w, o.to, c - t / 2 - 0.012, c + t / 2 + 0.012, FLOOR_Y + y0, FLOOR_Y + y1, mat, [], true)
    box(b, p.axis, o.from + w, o.to - w, c - t / 2 - 0.012, c + t / 2 + 0.012, FLOOR_Y + y1 - w, FLOOR_Y + y1, mat, [], true)
    if (y0 > 0.05) box(b, p.axis, o.from + w, o.to - w, c - t / 2 - 0.02, c + t / 2 + 0.02, FLOOR_Y + y0, FLOOR_Y + y0 + 0.03, mat, [], true)
  }
  for (const o of ops) {
    if (o.kind === "door") {
      const front = o.side ?? "b"
      const rot = p.axis === "x" ? (front === "b" ? 0 : Math.PI) : front === "b" ? Math.PI / 2 : -Math.PI / 2
      const x = p.axis === "x" ? o.at : c
      const z = p.axis === "x" ? c : o.at
      ids.push(...doorway(b, { ...o.door, x, z, rot, wallT: t }))
    } else if (o.kind === "glazed" || o.kind === "clerestory") {
      const sill = o.kind === "glazed" ? (o.sill ?? 0.9) : o.sill
      const head = o.head ?? (o.kind === "glazed" ? 2.3 : 2.1)
      frame(o, sill, head, M.frame)
      const step = o.kind === "glazed" ? (o.mullion ?? 1.2) : 1.5
      const n = Math.max(1, Math.round((o.to - o.from) / step))
      for (let k = 1; k < n; k++) {
        const u = o.from + ((o.to - o.from) * k) / n
        box(b, p.axis, u - 0.02, u + 0.02, c - 0.03, c + 0.03, FLOOR_Y + sill, FLOOR_Y + head, M.frame, [], true)
      }
      const mid = (o.from + o.to) / 2
      const m = p.axis === "x" ? T(mid, FLOOR_Y + (sill + head) / 2, c) : T(c, FLOOR_Y + (sill + head) / 2, mid, Math.PI / 2)
      b.quad(PLATE_GLASS, m, o.to - o.from - 0.08, head - sill - 0.04, { cast: false })
      if (p.collide ?? true) {
        if (p.axis === "x") b.collide(o.from, FLOOR_Y + sill, c - 0.03, o.to, FLOOR_Y + head, c + 0.03)
        else b.collide(c - 0.03, FLOOR_Y + sill, o.from, c + 0.03, FLOOR_Y + head, o.to)
      }
    } else if (o.kind === "cased") frame(o, 0, o.head ?? DOOR_H + 0.05, M.veneer)
  }
  return ids
}

function solidSpans(a0: number, a1: number, holes: Opening[]) {
  const sorted = [...holes].sort((p, q) => p.a0 - q.a0)
  const out: [number, number][] = []
  let cur = a0
  for (const h of sorted) {
    if (h.a0 > cur) out.push([cur, h.a0])
    cur = Math.max(cur, h.a1)
  }
  if (a1 > cur) out.push([cur, a1])
  return out
}

/** Axis-mapped box (a along the wall, c across it), skipping spans `minus`. */
function box(b: Builder, axis: "x" | "z", a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, mat: Mat, minus: Opening[] = [], cast = true) {
  for (const [s0, s1] of solidSpans(a0, a1, minus)) {
    if (axis === "x") b.box(mat, s0, y0, c0, s1, y1, c1, { cast })
    else b.box(mat, c0, y0, s0, c1, y1, s1, { cast })
  }
}

/** Steel stud wall without board (storey 4 strip-out): tracks, studs at 406 mm, gaps for openings (no leaves). */
export function studWall(b: Builder, p: { axis: "x" | "z"; at: number; from: number; to: number; openings?: { from: number; to: number; head?: number }[] }) {
  const a0 = Math.min(p.from, p.to)
  const a1 = Math.max(p.from, p.to)
  const c = p.at
  const holes: Opening[] = (p.openings ?? []).map((o) => ({ a0: o.from, a1: o.to, top: o.head ?? DOOR_H + 0.05 }))
  const stud = M.steel
  box(b, p.axis, a0, a1, c - 0.046, c + 0.046, FLOOR_Y, FLOOR_Y + 0.03, stud, holes)
  box(b, p.axis, a0, a1, c - 0.046, c + 0.046, CEIL_Y - 0.03, CEIL_Y, stud)
  for (const h of holes) box(b, p.axis, h.a0, h.a1, c - 0.046, c + 0.046, FLOOR_Y + h.top - 0.03, FLOOR_Y + h.top, stud)
  const posts: number[] = []
  for (let u = a0 + 0.02; u <= a1 - 0.02 + 1e-6; u += 0.406) posts.push(u)
  for (const h of holes) posts.push(h.a0 + 0.02, h.a1 - 0.02)
  for (const u of posts) {
    if (holes.some((h) => u > h.a0 + 0.03 && u < h.a1 - 0.03)) continue
    // C-channel: web and two flanges.
    box(b, p.axis, u - 0.02, u + 0.02, c - 0.046, c - 0.04, FLOOR_Y + 0.03, CEIL_Y - 0.03, stud)
    box(b, p.axis, u - 0.02, u - 0.016, c - 0.046, c + 0.046, FLOOR_Y + 0.03, CEIL_Y - 0.03, stud)
    box(b, p.axis, u + 0.016, u + 0.02, c - 0.046, c + 0.046, FLOOR_Y + 0.03, CEIL_Y - 0.03, stud)
  }
  for (const [s0, s1] of solidSpans(a0, a1, holes)) {
    if (p.axis === "x") b.collide(s0, FLOOR_Y, c - 0.05, s1, CEIL_Y, c + 0.05)
    else b.collide(c - 0.05, FLOOR_Y, s0, c + 0.05, CEIL_Y, s1)
  }
}

/** Structural column: 0.45 m square plastered concrete with a rubber base, floor to ceiling, collider. */
export function column(b: Builder, x: number, z: number, size = 0.45) {
  const h = size / 2
  b.box(M.plaster, x - h, FLOOR_Y, z - h, x + h, CEIL_Y + 0.02, z + h, { skip: "y" })
  b.box(M.rubber, x - h - 0.006, FLOOR_Y, z - h - 0.006, x + h + 0.006, FLOOR_Y + 0.1, z + h + 0.006, { skip: "yY" })
  b.collide(x - h, FLOOR_Y, z - h, x + h, CEIL_Y, z + h)
}
