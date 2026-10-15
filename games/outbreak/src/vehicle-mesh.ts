import { MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import type { VehicleKind } from "../shared/vehicles"
import { hex } from "./level"

export type VehicleModels = {
  body: Mesh
  wreck: Mesh
  wheel: Mesh
  lens: Mesh
  tail: Mesh
  bar: Mesh | null
}

export type WheelSpot = { f: number; s: number; r: number; front: boolean }

export const WHEELS: Readonly<Record<VehicleKind, readonly WheelSpot[]>> = {
  sedan: [
    { f: 1.24, s: -0.78, r: 0.36, front: true },
    { f: 1.24, s: 0.78, r: 0.36, front: true },
    { f: -1.22, s: -0.78, r: 0.36, front: false },
    { f: -1.22, s: 0.78, r: 0.36, front: false },
  ],
  cruiser: [
    { f: 1.32, s: -0.82, r: 0.37, front: true },
    { f: 1.32, s: 0.82, r: 0.37, front: true },
    { f: -1.28, s: -0.82, r: 0.37, front: false },
    { f: -1.28, s: 0.82, r: 0.37, front: false },
  ],
  pickup: [
    { f: 1.28, s: -0.82, r: 0.4, front: true },
    { f: 1.28, s: 0.82, r: 0.4, front: true },
    { f: -1.24, s: -0.82, r: 0.4, front: false },
    { f: -1.24, s: 0.82, r: 0.4, front: false },
  ],
  van: [
    { f: 1.54, s: -0.86, r: 0.41, front: true },
    { f: 1.54, s: 0.86, r: 0.41, front: true },
    { f: -1.56, s: -0.86, r: 0.41, front: false },
    { f: -1.56, s: 0.86, r: 0.41, front: false },
  ],
}

export const LAMPS: Readonly<
  Record<
    VehicleKind,
    { head: readonly [number, number][]; tail: readonly [number, number][]; bar: readonly [number, number, number] | null; h: number }
  >
> = {
  sedan: {
    head: [
      [1.98, -0.58],
      [1.98, 0.58],
    ],
    tail: [
      [-1.98, -0.58],
      [-1.98, 0.58],
    ],
    bar: null,
    h: 0.62,
  },
  cruiser: {
    head: [
      [2.08, -0.62],
      [2.08, 0.62],
    ],
    tail: [
      [-2.08, -0.64],
      [-2.08, 0.64],
    ],
    bar: [0.05, 0, 1.48],
    h: 0.64,
  },
  pickup: {
    head: [
      [2.02, -0.64],
      [2.02, 0.64],
    ],
    tail: [
      [-2.02, -0.72],
      [-2.02, 0.72],
    ],
    bar: null,
    h: 0.78,
  },
  van: {
    head: [
      [2.34, -0.68],
      [2.34, 0.68],
    ],
    tail: [
      [-2.34, -0.8],
      [-2.34, 0.8],
    ],
    bar: null,
    h: 0.76,
  },
}

const DARK = hex(0x1b1d22)
const TIRE = hex(0x151619)
const HUB = hex(0x646870)
const GLASS = hex(0x141c24)
const SEAT = hex(0x282622)
const RAIL = hex(0x32363e)
const STEEL = hex(0x828890)
const LAMP: Rgb = [1, 1, 1]

type Tone = (c: Rgb) => Rgb
const clean: Tone = (c) => c
const charred: Tone = (c) => [0.06 + c[0] * 0.12, 0.052 + c[1] * 0.1, 0.048 + c[2] * 0.09]

class Kit {
  constructor(
    readonly m: Mesh,
    readonly t: Tone,
  ) {}
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.lit, top?: Rgb): void {
    this.m.box(x0, y0, z0, x1, y1, z1, this.t(col), mat, 0, top ? this.t(top) : undefined)
  }
  bevel(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, b: number, col: Rgb, top: Rgb, mat: Mat = MAT.lit): void {
    this.m.bevelBox(x0, y0, z0, x1, y1, z1, b, this.t(col), this.t(top), mat)
  }
  quad(a: number[], b: number[], c: number[], d: number[], col: Rgb, mat: Mat = MAT.lit): void {
    this.m.quadAuto(a, b, c, d, this.t(col), mat)
  }
  facet(a: number[], b: number[], c: number[], col: Rgb, mat: Mat = MAT.lit): void {
    this.m.facet(a, b, c, this.t(col), mat)
  }
  pair(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.lit, top?: Rgb): void {
    this.box(x0, y0, z0, x1, y1, z1, col, mat, top)
    this.box(x0, y0, -z1, x1, y1, -z0, col, mat, top)
  }
}

function buildWheel(r: number, w: number): Mesh {
  const m = new Mesh()
  const n = 10
  const z0 = -w / 2
  const z1 = w / 2
  const p = (a: number, rr: number, z: number) => [Math.cos(a) * rr, Math.sin(a) * rr, z]
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    m.quadAuto(p(a0, r, z1), p(a0, r, z0), p(a1, r, z0), p(a1, r, z1), TIRE)
    for (const [z, s] of [
      [z1, 1],
      [z0, -1],
    ] as const) {
      const ri = r * 0.6
      if (s > 0) {
        m.quadAuto(p(a0, r, z), p(a1, r, z), p(a1, ri, z), p(a0, ri, z), TIRE)
        m.facet([0, 0, z + s * 0.01], p(a0, ri, z + s * 0.01), p(a1, ri, z + s * 0.01), i % 2 ? HUB : STEEL, MAT.shiny)
      } else {
        m.quadAuto(p(a1, r, z), p(a0, r, z), p(a0, ri, z), p(a1, ri, z), TIRE)
        m.facet([0, 0, z + s * 0.01], p(a1, ri, z + s * 0.01), p(a0, ri, z + s * 0.01), i % 2 ? HUB : STEEL, MAT.shiny)
      }
    }
  }
  return m
}

/** 1970s 4-door suburban sedan (+X forward, +Z right). */
function sedan(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  const body = hex(0x886b42)
  const top = hex(0xa28252)
  const roof = hex(0xad8e5c)
  const trim = hex(0x282622)

  // Chassis & wrap-around chrome/rubber bumpers
  k.box(-1.88, 0.2, -0.78, 1.88, 0.36, 0.78, DARK)
  k.box(1.9, 0.24, -0.88, 2.04, 0.44, 0.88, trim, MAT.lit, STEEL)
  k.box(-2.04, 0.24, -0.88, -1.9, 0.44, 0.88, trim, MAT.lit, STEEL)

  // Main lower hull & hood/trunk creases
  k.bevel(-1.96, 0.26, -0.86, 1.96, 0.82, 0.86, 0.06, body, top)
  k.pair(0.75, 0.82, 0.48, 1.88, 0.845, 0.54, hex(0x745834))
  k.box(0.75, 0.82, -0.02, 1.9, 0.848, 0.02, roof)
  k.box(1.94, 0.44, -0.46, 1.98, 0.74, 0.46, DARK)

  // Tapered cabin greenhouse
  k.bevel(-0.98, 0.78, -0.76, 0.72, 1.32, 0.76, 0.1, body, roof)
  // Windshield (+X) & rear window (-X)
  k.quad([0.74, 0.82, -0.68], [0.74, 0.82, 0.68], [0.46, 1.26, 0.62], [0.46, 1.26, -0.62], GLASS, MAT.shiny)
  k.quad([-1.0, 0.82, 0.68], [-1.0, 0.82, -0.68], [-0.72, 1.26, -0.62], [-0.72, 1.26, 0.62], GLASS, MAT.shiny)
  // Side door windows & B-pillar
  k.pair(-0.78, 0.84, 0.75, -0.1, 1.22, 0.77, GLASS, MAT.shiny)
  k.pair(0.0, 0.84, 0.75, 0.56, 1.22, 0.77, GLASS, MAT.shiny)
  k.pair(-0.08, 0.3, 0.85, -0.02, 1.26, 0.87, trim)
  // Side mirrors
  k.pair(0.52, 0.8, 0.84, 0.64, 0.9, 0.98, trim)
  return k.m
}

/** County Police Cruiser with push bar and roof lightbar (+X forward). */
function cruiser(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  const navy = hex(0x283648)
  const navyTop = hex(0x36485e)
  const white = hex(0xc8c4b8)
  const whiteTop = hex(0xdad6ca)

  k.box(-1.98, 0.2, -0.8, 1.98, 0.36, 0.8, DARK)
  // Front & rear quarters in precinct navy, center doors & roof in cream-white
  k.bevel(-2.06, 0.26, -0.9, -0.68, 0.84, 0.9, 0.06, navy, navyTop)
  k.bevel(-0.68, 0.26, -0.9, 0.78, 0.84, 0.9, 0.06, white, whiteTop)
  k.bevel(0.78, 0.26, -0.9, 2.06, 0.84, 0.9, 0.06, navy, navyTop)

  // Push bumper / bull bar at +X
  k.box(2.04, 0.24, -0.92, 2.16, 0.44, 0.92, DARK, MAT.lit, RAIL)
  k.pair(2.06, 0.3, 0.36, 2.18, 0.82, 0.44, DARK)
  k.box(2.08, 0.52, -0.44, 2.18, 0.6, 0.44, RAIL)

  // Cabin greenhouse
  k.bevel(-1.02, 0.8, -0.78, 0.76, 1.36, 0.78, 0.1, white, whiteTop)
  k.quad([0.78, 0.84, -0.7], [0.78, 0.84, 0.7], [0.48, 1.3, 0.64], [0.48, 1.3, -0.64], GLASS, MAT.shiny)
  k.quad([-1.04, 0.84, 0.7], [-1.04, 0.84, -0.7], [-0.74, 1.3, -0.64], [-0.74, 1.3, 0.64], GLASS, MAT.shiny)
  k.pair(-0.82, 0.86, 0.77, -0.1, 1.26, 0.79, GLASS, MAT.shiny)
  k.pair(0.0, 0.86, 0.77, 0.58, 1.26, 0.79, GLASS, MAT.shiny)
  k.pair(0.54, 0.82, 0.88, 0.66, 0.92, 1.02, DARK)
  // Roof lightbar mount base
  k.box(-0.08, 1.36, -0.58, 0.18, 1.42, 0.58, DARK)
  return k.m
}

/** Rugged 4x4 utility pickup truck with open bed, roll cage, spare wheel & jerrycan (+X forward). */
function pickup(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  const olive = hex(0x42523c)
  const oliveD = hex(0x2e3a2a)
  const oliveL = hex(0x56684e)

  k.box(-1.92, 0.26, -0.78, 1.92, 0.44, 0.78, DARK)
  k.box(1.94, 0.3, -0.94, 2.08, 0.52, 0.94, DARK, MAT.lit, RAIL)
  k.box(-2.08, 0.32, -0.92, -1.94, 0.52, 0.92, DARK, MAT.lit, RAIL)

  // Rear cargo bed & side rails
  k.box(-1.94, 0.42, -0.84, 0.45, 0.54, 0.84, oliveD)
  k.bevel(-1.98, 0.42, -0.94, 0.48, 1.02, -0.78, 0.04, olive, oliveL)
  k.bevel(-1.98, 0.42, 0.78, 0.48, 1.02, 0.94, 0.04, olive, oliveL)
  k.bevel(-1.98, 0.42, -0.82, -1.84, 1.02, 0.82, 0.04, olive, oliveL)

  // Hood & front grille
  k.bevel(0.45, 0.42, -0.88, 2.0, 1.02, 0.88, 0.07, olive, oliveL)
  k.box(1.98, 0.54, -0.52, 2.03, 0.92, 0.52, DARK)
  for (let i = 0; i < 6; i++) {
    const z = -0.4 + i * 0.16
    k.box(2.01, 0.56, z - 0.025, 2.04, 0.9, z + 0.025, oliveD)
  }

  // Cab roof & windshield
  k.bevel(-0.35, 0.98, -0.82, 0.62, 1.56, 0.82, 0.08, olive, oliveL)
  k.quad([0.64, 1.0, -0.74], [0.64, 1.0, 0.74], [0.48, 1.5, 0.72], [0.48, 1.5, -0.72], GLASS, MAT.shiny)
  k.pair(-0.24, 1.02, 0.81, 0.46, 1.46, 0.83, GLASS, MAT.shiny)

  // Bed seats & roll bar
  for (const s of [-0.42, 0.42]) {
    k.box(-1.25, 0.54, s - 0.24, -0.72, 0.7, s + 0.24, SEAT)
  }
  k.pair(-0.48, 1.02, 0.8, -0.38, 1.66, 0.88, RAIL)
  k.box(-0.48, 1.58, -0.88, -0.38, 1.66, 0.88, RAIL)
  // Spare tyre & jerrycan in bed
  k.box(-1.78, 0.54, 0.46, -1.38, 0.9, 0.74, hex(0x8a3226), MAT.lit, hex(0xa43e30))
  return k.m
}

/** Heavy utility cargo van (+X forward). */
function van(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  const col = hex(0x4c545c)
  const colD = hex(0x363c42)
  const colL = hex(0x646e78)
  const roof = 1.78

  k.box(-2.26, 0.26, -0.88, 2.26, 0.44, 0.88, DARK)
  k.bevel(-2.34, 0.4, -0.98, 1.42, roof, 0.98, 0.1, col, colL)
  k.bevel(1.38, 0.4, -0.94, 2.34, 1.0, 0.94, 0.08, col, colL)
  // Sloped windshield
  const wz = 0.88
  k.quad([1.42, roof - 0.06, -wz], [1.42, roof - 0.06, wz], [1.98, 1.0, wz], [1.98, 1.0, -wz], GLASS, MAT.shiny)
  k.pair(0.72, 1.12, 0.97, 1.36, 1.48, 0.99, GLASS, MAT.shiny)
  k.pair(-0.78, 1.14, 0.97, -0.1, 1.46, 0.99, GLASS, MAT.shiny)
  // Side panel ribs & bumpers
  k.pair(-2.24, 0.88, 0.97, 0.68, 0.94, 1.0, colD)
  k.box(2.32, 0.34, -0.94, 2.44, 0.54, 0.94, DARK, MAT.lit, RAIL)
  k.box(-2.44, 0.32, -0.92, -2.3, 0.48, 0.92, DARK, MAT.lit, RAIL)
  k.pair(-2.15, roof, 0.8, 1.1, roof + 0.06, 0.86, RAIL)
  return k.m
}

function buildLamps(boxes: readonly [number, number, number, number, number, number][]): Mesh {
  const m = new Mesh()
  for (const b of boxes) m.box(b[0], b[1], b[2], b[3], b[4], b[5], LAMP, MAT.accent)
  return m
}

function buildBar(x: number, y: number, half: number): Mesh {
  const m = new Mesh()
  m.box(x - 0.08, y - 0.01, -half, x + 0.08, y + 0.04, half, DARK)
  const n = 4
  for (let i = 0; i < n; i++) {
    const z0 = -half + (i * 2 * half) / n + 0.04
    const z1 = z0 + (2 * half) / n - 0.08
    m.box(x - 0.06, y + 0.04, z0, x + 0.06, y + 0.11, z1, LAMP, MAT.accent)
  }
  return m
}

export function createVehicleModels(): Record<VehicleKind, VehicleModels> {
  return {
    sedan: {
      body: sedan(clean),
      wreck: sedan(charred),
      wheel: buildWheel(0.36, 0.26),
      lens: buildLamps([
        [1.95, 0.52, -0.72, 2.0, 0.68, -0.46],
        [1.95, 0.52, 0.46, 2.0, 0.68, 0.72],
      ]),
      tail: buildLamps([
        [-2.0, 0.52, -0.74, -1.95, 0.68, -0.44],
        [-2.0, 0.52, 0.44, -1.95, 0.68, 0.74],
      ]),
      bar: null,
    },
    cruiser: {
      body: cruiser(clean),
      wreck: cruiser(charred),
      wheel: buildWheel(0.37, 0.28),
      lens: buildLamps([
        [2.05, 0.54, -0.76, 2.1, 0.7, -0.48],
        [2.05, 0.54, 0.48, 2.1, 0.7, 0.76],
      ]),
      tail: buildLamps([
        [-2.1, 0.54, -0.78, -2.05, 0.7, -0.48],
        [-2.1, 0.54, 0.48, -2.05, 0.7, 0.78],
      ]),
      bar: buildBar(0.05, 1.42, 0.54),
    },
    pickup: {
      body: pickup(clean),
      wreck: pickup(charred),
      wheel: buildWheel(0.4, 0.3),
      lens: buildLamps([
        [1.99, 0.68, -0.76, 2.04, 0.86, -0.52],
        [1.99, 0.68, 0.52, 2.04, 0.86, 0.76],
      ]),
      tail: buildLamps([
        [-2.01, 0.68, -0.84, -1.96, 0.86, -0.62],
        [-2.01, 0.68, 0.62, -1.96, 0.86, 0.84],
      ]),
      bar: null,
    },
    van: {
      body: van(clean),
      wreck: van(charred),
      wheel: buildWheel(0.41, 0.3),
      lens: buildLamps([
        [2.32, 0.64, -0.82, 2.37, 0.82, -0.54],
        [2.32, 0.64, 0.54, 2.37, 0.82, 0.82],
      ]),
      tail: buildLamps([
        [-2.37, 0.58, -0.9, -2.32, 0.94, -0.68],
        [-2.37, 0.58, 0.68, -2.32, 0.94, 0.9],
      ]),
      bar: null,
    },
  }
}
