import type { Rect } from "@arcade/kit/sim/geom"
import { MAT, VERT_BYTES } from "@arcade/kit/gpu/mesh"
import { buildingFootprint, type Building } from "../../shared/map"

/**
 * Yard plants stay out of houses (Kit: "Why are there trees inside the house?"). Stems keep clear of walls, porches and
 * outbuildings. A leaf or limb below the wall tops inside a footprint is trimmed off, like a tree pruned back from the
 * house. A crown that leans over a roof keeps its overhang, drawn in a chunk of its own that is skipped while the camera
 * is inside that house, as the roof is: the level's solid pass never runs the cutaway's discards, so a crown left in it
 * hung over the cut-away rooms.
 */

/** Height of the walls the roof cutaway leaves standing (`shaders.ts` discards above 2.801 m). */
export const CUTAWAY_TOP = 2.81
/** How far a tree trunk, then a shrub or hedge stem, keeps from walls, porches and outbuildings. */
export const TRUNK_CLEARANCE = 0.5
export const STEM_CLEARANCE = 0.2
/** Plants this tall are trees (`plant()`). */
const TREE_HEIGHT = 2.1

export const stemClearance = (h: number) => (h > TREE_HEIGHT ? TRUNK_CLEARANCE : STEM_CLEARANCE)

/** Whether (x, z) is at least `margin` outside every rect. */
export const clearOfRects = (rects: readonly Rect[], x: number, z: number, margin: number) =>
  rects.every((r) => x <= r[0] - margin || x >= r[2] + margin || z <= r[1] - margin || z >= r[3] + margin)

/** A leaf, or a swaying limb (`trees.ts`: timber with aux >= 7.5). */
export const isPlantMaterial = (mat: number, aux: number) => mat === MAT.foliage || (mat === MAT.timber && aux >= 7.5)

/** Footprint rects near a plant and the index (into the buildings given) of the building each belongs to. */
export type Rooms = { rects: Rect[]; owners: number[] }
export const emptyRooms = (): Rooms => ({ rects: [], owners: [] })

/** The footprint rects of `buildings` that reach into `box` (x0, z0, x1, z1), appended to `out`. */
export function roomsIn(buildings: readonly Building[], box: Rect, out: Rooms = emptyRooms()): Rooms {
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i]!
    if (b.rect[0] > box[2] || b.rect[2] < box[0] || b.rect[1] > box[3] || b.rect[3] < box[1]) continue
    for (const f of buildingFootprint(b)) {
      if (f[0] > box[2] || f[2] < box[0] || f[1] > box[3] || f[3] < box[1]) continue
      out.rects.push(f)
      out.owners.push(i)
    }
  }
  return out
}

/** The room (index into `rooms`) a point stands over, or -1. */
function roomAt(rooms: Rooms, x: number, z: number): number {
  const rects = rooms.rects
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!
    if (x > r[0] && x < r[2] && z > r[1] && z < r[3]) return i
  }
  return -1
}

/** A plant triangle is drawn as it is. */
export const OUTDOORS = -1
/** A plant triangle is dropped: part of it stands inside a room, below the wall tops. */
export const INDOORS = -2

/**
 * What becomes of one plant triangle: `INDOORS`, `OUTDOORS`, or the building (`rooms.owners`) whose roof it leans over.
 * `v` holds the three vertices' x, y, z at `a`, `b` and `c`.
 */
export function triangleFate(rooms: Rooms, v: ArrayLike<number>, a: number, b: number, c: number, ox = 0, oy = 0, oz = 0): number {
  if (!rooms.rects.length) return OUTDOORS
  let over = OUTDOORS
  for (const i of [a, b, c]) {
    const room = roomAt(rooms, v[i]! + ox, v[i + 2]! + oz)
    if (room < 0) continue
    if (v[i + 1]! + oy <= CUTAWAY_TOP) return INDOORS
    if (over === OUTDOORS) over = rooms.owners[room]!
  }
  return over
}

/** Packed vertex bytes gathered per building, for the crowns leaning over its roof. */
export class Overhangs {
  private readonly bytes = new Map<number, { buf: Uint8Array; len: number }>()

  push(owner: number, src: Uint8Array, from: number, ox: number, oy: number, oz: number): void {
    let o = this.bytes.get(owner)
    if (!o) this.bytes.set(owner, (o = { buf: new Uint8Array(VERT_BYTES * 3 * 256), len: 0 }))
    const n = VERT_BYTES * 3
    if (o.len + n > o.buf.length) {
      const grown = new Uint8Array(o.buf.length * 2)
      grown.set(o.buf.subarray(0, o.len))
      o.buf = grown
    }
    o.buf.set(src.subarray(from, from + n), o.len)
    const f32 = new Float32Array(o.buf.buffer, o.len, n / 4)
    for (let k = 0; k < 3; k++) {
      f32[k * 6] = f32[k * 6]! + ox
      f32[k * 6 + 1] = f32[k * 6 + 1]! + oy
      f32[k * 6 + 2] = f32[k * 6 + 2]! + oz
    }
    o.len += n
  }

  owners(): number[] {
    return [...this.bytes.keys()]
  }

  /** The bytes gathered for `owner`, copied out. */
  take(owner: number): Uint8Array {
    const o = this.bytes.get(owner)!
    return o.buf.slice(0, o.len)
  }

  clear(): void {
    this.bytes.clear()
  }
}

/** Appends `src`'s plant triangles (`Mesh.v`, 11 floats a vertex) to `dst`, minus those standing indoors. */
export function appendOutdoorTriangles(src: readonly number[], dst: number[], rooms: Rooms): void {
  for (let i = 0; i < src.length; i += 33) {
    if (triangleFate(rooms, src, i, i + 11, i + 22) === INDOORS) continue
    for (let k = i; k < i + 33; k++) dst.push(src[k]!)
  }
}

/**
 * Copies a packed plant template (`VERT_BYTES` a vertex, positions relative to its stem) into `dst` at vertex `at`,
 * moved to (ox, oy, oz): triangles standing indoors are dropped and those leaning over a roof go to `overhangs`.
 * Returns the vertices written to `dst`.
 */
export function placeOutdoorTemplate(tpl: Uint8Array, vertCount: number, dst: Uint8Array, dstF32: Float32Array, at: number, ox: number, oy: number, oz: number, rooms: Rooms, overhangs: Overhangs): number {
  const stride = VERT_BYTES / 4
  if (!rooms.rects.length) {
    dst.set(tpl.subarray(0, vertCount * VERT_BYTES), at * VERT_BYTES)
    for (let v = at; v < at + vertCount; v++) {
      const f = v * stride
      dstF32[f] = dstF32[f]! + ox
      dstF32[f + 1] = dstF32[f + 1]! + oy
      dstF32[f + 2] = dstF32[f + 2]! + oz
    }
    return vertCount
  }
  const src = new Float32Array(tpl.buffer, tpl.byteOffset, (vertCount * VERT_BYTES) / 4)
  let out = at
  for (let t = 0; t + 2 < vertCount; t += 3) {
    const fate = triangleFate(rooms, src, t * stride, (t + 1) * stride, (t + 2) * stride, ox, oy, oz)
    if (fate === INDOORS) continue
    if (fate !== OUTDOORS) {
      overhangs.push(fate, tpl, t * VERT_BYTES, ox, oy, oz)
      continue
    }
    dst.set(tpl.subarray(t * VERT_BYTES, (t + 3) * VERT_BYTES), out * VERT_BYTES)
    for (let k = 0; k < 3; k++) {
      const f = (out + k) * stride
      dstF32[f] = dstF32[f]! + ox
      dstF32[f + 1] = dstF32[f + 1]! + oy
      dstF32[f + 2] = dstF32[f + 2]! + oz
    }
    out += 3
  }
  return out - at
}

/** The box the camera must be inside for a house's overhang chunk to be skipped: its walls, as its roof chunk's. */
export const overhangCutBox = (b: Building, top: number): readonly number[] => [b.rect[0] - 0.1, 0, b.rect[1] - 0.1, b.rect[2] + 0.1, top, b.rect[3] + 0.1]
