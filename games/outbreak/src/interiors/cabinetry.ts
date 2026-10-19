import { MAT, type Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { lbox, type Frame } from "./frame"

/**
 * Fitted cabinetry (AR-69), built to the generated furniture's level of detail from boxes: a recessed toe-kick,
 * framed doors and drawer fronts (stiles and rails proud of a recessed field, a dark reveal between fronts), bar pulls
 * on standoffs, a countertop with an overhang, an edge band and a backsplash, a real sink well, and upper cabinets
 * with a light rail and a crown. All in a wall frame (`frame.ts`): the cabinets stand on the room side (negative d).
 * The house floor is at 0.13 m.
 */

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const shade = (c: Rgb, k: number): Rgb => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)]

export type CabinetStyle = {
  /** Door and drawer frames, end panels. */
  wood: Rgb
  /** Recessed field of each front (a little darker than the frame). */
  field: Rgb
  /** The gaps between fronts and the toe-kick. */
  dark: Rgb
  counter: Rgb
  counterTop: Rgb
  edge: Rgb
  pull: Rgb
}

/** 1970s stained walnut with harvest-tan laminate and brushed pulls (the start houses' kitchens). */
export const WALNUT_KITCHEN: CabinetStyle = {
  wood: hex(0x5e4228),
  field: hex(0x4e361f),
  dark: hex(0x1a120a),
  counter: hex(0x6e6250),
  counterTop: hex(0x847660),
  edge: hex(0x3a3328),
  pull: hex(0x8a8070),
}

const FLOOR = 0.13

/** A framed front facing the room at `F` (its face plane), `u0..u1` × `y0..y1`, stiles `st` wide. */
function front(m: Mesh, f: Frame, u0: number, u1: number, y0: number, y1: number, F: number, s: CabinetStyle, st: number): void {
  const g = 0.004
  lbox(m, f, u0 + g, u1 - g, y0 + g, y1 - g, F, F + 0.018, s.field, MAT.timber)
  const a0 = u0 + g, a1 = u1 - g, b0 = y0 + g, b1 = y1 - g
  const top = shade(s.wood, 1.12)
  lbox(m, f, a0, a0 + st, b0, b1, F - 0.012, F, s.wood, MAT.timber, 0, top)
  lbox(m, f, a1 - st, a1, b0, b1, F - 0.012, F, s.wood, MAT.timber, 0, top)
  lbox(m, f, a0 + st, a1 - st, b1 - st, b1, F - 0.012, F, s.wood, MAT.timber, 0, top)
  lbox(m, f, a0 + st, a1 - st, b0, b0 + st, F - 0.012, F, s.wood, MAT.timber, 0, top)
}

/** A bar pull on two standoffs: vertical beside a door's opening edge, horizontal across a drawer. */
function pull(m: Mesh, f: Frame, u: number, y: number, F: number, vertical: boolean, s: CabinetStyle): void {
  const half = vertical ? 0.06 : 0.07
  const d0 = F - 0.04, d1 = F - 0.028
  if (vertical) {
    lbox(m, f, u - 0.007, u + 0.007, y - half, y + half, d0, d1, s.pull, MAT.shiny)
    for (const k of [-1, 1]) lbox(m, f, u - 0.005, u + 0.005, y + k * (half - 0.012) - 0.005, y + k * (half - 0.012) + 0.005, d1, F - 0.012, s.pull, MAT.shiny)
  } else {
    lbox(m, f, u - half, u + half, y - 0.007, y + 0.007, d0, d1, s.pull, MAT.shiny)
    for (const k of [-1, 1]) lbox(m, f, u + k * (half - 0.012) - 0.005, u + k * (half - 0.012) + 0.005, y - 0.005, y + 0.005, d1, F - 0.012, s.pull, MAT.shiny)
  }
}

/** Splits `u0..u1` into bays near `target` wide. */
const bays = (u0: number, u1: number, target: number): [number, number][] => {
  const n = Math.max(1, Math.round((u1 - u0) / target))
  const w = (u1 - u0) / n
  return Array.from({ length: n }, (_, i) => [u0 + i * w, u0 + (i + 1) * w] as [number, number])
}

export type BaseRunOptions = {
  depth?: number
  /** Counter top height (m, world). */
  top?: number
  /** Sink well along the run, `[u0, u1]`. */
  sink?: readonly [number, number]
  /** Backsplash top (m); 0 for none. */
  splash?: number
}

/** Base cabinets along a wall: toe-kick, framed drawers over doors, a countertop with edge band and an optional sink. */
export function baseRun(m: Mesh, f: Frame, u0: number, u1: number, s: CabinetStyle, o: BaseRunOptions = {}): void {
  const depth = o.depth ?? 0.62
  const top = o.top ?? 0.96
  const F = -depth
  const slab = top - 0.04
  lbox(m, f, u0, u1, FLOOR, FLOOR + 0.1, F + 0.065, 0, s.dark, MAT.lit)
  if (o.sink) {
    // The carcass steps down under the well so the well is as deep as it looks.
    const [s0, s1] = o.sink
    lbox(m, f, u0, s0, FLOOR + 0.1, slab, F + 0.018, 0, s.wood, MAT.timber)
    lbox(m, f, s1, u1, FLOOR + 0.1, slab, F + 0.018, 0, s.wood, MAT.timber)
    lbox(m, f, s0, s1, FLOOR + 0.1, slab, F + 0.018, F + 0.07, s.wood, MAT.timber)
    lbox(m, f, s0, s1, FLOOR + 0.1, slab, -0.1, 0, s.wood, MAT.timber)
    lbox(m, f, s0, s1, FLOOR + 0.1, top - 0.19, F + 0.07, -0.1, s.wood, MAT.timber)
  } else {
    lbox(m, f, u0, u1, FLOOR + 0.1, slab, F + 0.018, 0, s.wood, MAT.timber)
  }
  const drawerY = slab - 0.15
  bays(u0, u1, 0.56).forEach(([b0, b1], i, all) => {
    front(m, f, b0, b1, drawerY, slab - 0.008, F, s, 0.032)
    pull(m, f, (b0 + b1) / 2, (drawerY + slab) / 2, F, false, s)
    front(m, f, b0, b1, FLOOR + 0.105, drawerY - 0.008, F, s, 0.05)
    // Doors open from the run's middle outwards, so pulls pair up across it.
    const left = i < all.length / 2
    pull(m, f, left ? b1 - 0.05 : b0 + 0.05, drawerY - 0.12, F, true, s)
  })
  // Countertop: slab with 30 mm overhang, a darker edge band, then the backsplash.
  const fo = F - 0.03
  const slabPiece = (a0: number, a1: number, d0: number, d1: number) => lbox(m, f, a0, a1, slab, top, d0, d1, s.counter, MAT.lit, 0, s.counterTop)
  if (o.sink) {
    const [s0, s1] = o.sink
    const w0 = fo + 0.1, w1 = -0.1
    slabPiece(u0 - 0.02, s0, fo, 0)
    slabPiece(s1, u1 + 0.02, fo, 0)
    slabPiece(s0, s1, fo, w0)
    slabPiece(s0, s1, w1, 0)
    // The well: steel walls and floor below the counter, a rim just proud of it, a drain and a mixer tap.
    const steel = hex(0x6a706e), deep = hex(0x262a2a)
    const floorY = top - 0.17
    lbox(m, f, s0, s1, floorY - 0.01, floorY, w0, w1, deep, MAT.shiny)
    lbox(m, f, s0, s0 + 0.01, floorY, top, w0, w1, steel, MAT.shiny)
    lbox(m, f, s1 - 0.01, s1, floorY, top, w0, w1, steel, MAT.shiny)
    lbox(m, f, s0, s1, floorY, top, w0, w0 + 0.01, steel, MAT.shiny)
    lbox(m, f, s0, s1, floorY, top, w1 - 0.01, w1, steel, MAT.shiny)
    const sm = (s0 + s1) / 2
    lbox(m, f, sm - 0.006, sm + 0.006, floorY, floorY + 0.004, w0, w1, steel, MAT.shiny)
    for (const [a0, a1, d0, d1] of [[s0 - 0.015, s1 + 0.015, w0 - 0.015, w0], [s0 - 0.015, s1 + 0.015, w1, w1 + 0.015], [s0 - 0.015, s0, w0, w1], [s1, s1 + 0.015, w0, w1]] as const) {
      lbox(m, f, a0, a1, top, top + 0.004, d0, d1, steel, MAT.shiny)
    }
    lbox(m, f, sm - 0.025, sm + 0.025, top, top + 0.03, -0.075, -0.035, steel, MAT.shiny)
    lbox(m, f, sm - 0.011, sm + 0.011, top + 0.03, top + 0.25, -0.066, -0.044, steel, MAT.shiny)
    lbox(m, f, sm - 0.011, sm + 0.011, top + 0.23, top + 0.25, -0.2, -0.044, steel, MAT.shiny)
    for (const k of [-1, 1]) lbox(m, f, sm + k * 0.07 - 0.015, sm + k * 0.07 + 0.015, top, top + 0.045, -0.07, -0.04, steel, MAT.shiny)
  } else {
    slabPiece(u0 - 0.02, u1 + 0.02, fo, 0)
  }
  lbox(m, f, u0 - 0.02, u1 + 0.02, slab - 0.005, top, fo - 0.006, fo, s.edge, MAT.lit)
  if ((o.splash ?? top + 0.08) > top) lbox(m, f, u0 - 0.02, u1 + 0.02, top, o.splash ?? top + 0.08, -0.016, 0, s.counter, MAT.lit, 0, s.counterTop)
}

export type UpperRunOptions = {
  depth?: number
  y0?: number
  y1?: number
  /** Warm under-cabinet strip on this map light (MAT.lamp); -1 for none. */
  lamp?: number
}

/** Wall cabinets: carcass, framed doors meeting in pairs, a light rail under and a crown on top. */
export function upperRun(m: Mesh, f: Frame, u0: number, u1: number, s: CabinetStyle, o: UpperRunOptions = {}): void {
  const depth = o.depth ?? 0.34
  const y0 = o.y0 ?? 1.72, y1 = o.y1 ?? 2.38
  const F = -depth
  lbox(m, f, u0, u1, y0, y1, F + 0.018, 0, s.wood, MAT.timber, 0, shade(s.wood, 0.8))
  bays(u0, u1, 0.42).forEach(([b0, b1], i, all) => {
    front(m, f, b0, b1, y0 + 0.01, y1 - 0.01, F, s, 0.045)
    const left = i % 2 === 0 && i < all.length - 1
    pull(m, f, left ? b1 - 0.04 : b0 + 0.04, y0 + 0.12, F, true, s)
  })
  lbox(m, f, u0, u1, y0 - 0.03, y0, F - 0.014, 0, shade(s.wood, 0.9), MAT.timber)
  lbox(m, f, u0 - 0.02, u1 + 0.02, y1, y1 + 0.045, F - 0.03, 0, shade(s.wood, 0.85), MAT.timber, 0, shade(s.wood, 1.2))
  lbox(m, f, u0 - 0.035, u1 + 0.035, y1 + 0.045, y1 + 0.065, F - 0.045, 0, shade(s.wood, 0.75), MAT.timber, 0, shade(s.wood, 1.1))
  if (o.lamp !== undefined && o.lamp >= 0) lbox(m, f, u0 + 0.04, u1 - 0.04, y0 - 0.034, y0 - 0.03, F + 0.04, F + 0.1, hex(0x985c1c), MAT.lamp, o.lamp)
}

/** A full-height pantry: toe-kick, a tall lower door and a short upper door, crown to match the wall cabinets. */
export function tallCabinet(m: Mesh, f: Frame, u0: number, u1: number, s: CabinetStyle, depth = 0.62, y1 = 2.38): void {
  const F = -depth
  lbox(m, f, u0, u1, FLOOR, FLOOR + 0.1, F + 0.065, 0, s.dark, MAT.lit)
  lbox(m, f, u0, u1, FLOOR + 0.1, y1, F + 0.018, 0, s.wood, MAT.timber, 0, shade(s.wood, 0.8))
  const split = 1.72
  front(m, f, u0, u1, FLOOR + 0.105, split - 0.006, F, s, 0.055)
  front(m, f, u0, u1, split + 0.006, y1 - 0.01, F, s, 0.05)
  pull(m, f, u1 - 0.05, 1.12, F, true, s)
  pull(m, f, u1 - 0.05, split + 0.13, F, true, s)
  lbox(m, f, u0 - 0.02, u1 + 0.02, y1, y1 + 0.045, F - 0.03, 0, shade(s.wood, 0.85), MAT.timber, 0, shade(s.wood, 1.2))
  lbox(m, f, u0 - 0.035, u1 + 0.035, y1 + 0.045, y1 + 0.065, F - 0.045, 0, shade(s.wood, 0.75), MAT.timber, 0, shade(s.wood, 1.1))
}
