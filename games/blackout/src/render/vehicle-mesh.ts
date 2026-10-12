import type { VehicleKind } from "../../shared/sim/vehicle"
import { MAT, type Mat, Mesh, type Rgb } from "./mesh"
import { hex } from "./models"

/**
 * Low-poly vehicles in the office props' style: bevelled boxes with chamfered top edges that catch the rim light, flat
 * colours, dark glass. Forward is +x, right is +z, the origin is on the ground at the centre. Each kind comes as a body,
 * a charred wreck of the same shape, a wheel (spun and steered per instance; its origin is the hub), and three parts
 * tinted per instance that glow: the headlights, the tail lights and the roof light bar.
 */
export type VehicleModels = { body: Mesh; wreck: Mesh; wheel: Mesh; lens: Mesh; tail: Mesh; bar: Mesh | null }

/** Where the wheels sit: forward, right and the hub height (= the radius); front wheels steer. */
export type WheelSpot = { f: number; s: number; r: number; front: boolean }

export const WHEELS: Record<VehicleKind, WheelSpot[]> = {
  jeep: [
    { f: 1.25, s: -0.79, r: 0.4, front: true },
    { f: 1.25, s: 0.79, r: 0.4, front: true },
    { f: -1.2, s: -0.79, r: 0.4, front: false },
    { f: -1.2, s: 0.79, r: 0.4, front: false },
  ],
  van: [
    { f: 1.62, s: -0.86, r: 0.42, front: true },
    { f: 1.62, s: 0.86, r: 0.42, front: true },
    { f: -1.65, s: -0.86, r: 0.42, front: false },
    { f: -1.65, s: 0.86, r: 0.42, front: false },
  ],
  scooter: [
    { f: 0.62, s: 0, r: 0.25, front: true },
    { f: -0.6, s: 0, r: 0.25, front: false },
  ],
}

/** Plan offsets (forward, right) and height of the lamps, for the dynamic lights and glows. */
export const LAMPS: Record<VehicleKind, { head: [number, number][]; tail: [number, number][]; bar: [number, number, number] | null; h: number }> = {
  jeep: { head: [[1.98, -0.62], [1.98, 0.62]], tail: [[-1.92, -0.71], [-1.92, 0.71]], bar: [-0.55, 0, 1.75], h: 0.8 },
  van: { head: [[2.55, -0.72], [2.55, 0.72]], tail: [[-2.55, -0.85], [-2.55, 0.85]], bar: [1.37, 0, 1.94], h: 0.78 },
  scooter: { head: [[0.62, 0]], tail: [[-0.9, 0]], bar: null, h: 0.96 },
}

const DARK = hex(0x1b1d22)
const TIRE = hex(0x16171a)
const HUB = hex(0x5a5f68)
const GLASS = hex(0x141b26)
const SEAT = hex(0x26272c)
const RAIL = hex(0x2c3038)
const STEEL = hex(0x7a808c)
const LAMP: Rgb = [1, 1, 1]

/** A palette transform: identity for the clean body, burnt black for the wreck. */
type Tone = (c: Rgb) => Rgb
const clean: Tone = (c) => c
const charred: Tone = (c) => [0.055 + c[0] * 0.12, 0.05 + c[1] * 0.1, 0.048 + c[2] * 0.09]

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
  /** Both sides: a box mirrored across the centre line. */
  pair(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.lit, top?: Rgb): void {
    this.box(x0, y0, z0, x1, y1, z1, col, mat, top)
    this.box(x0, y0, -z1, x1, y1, -z0, col, mat, top)
  }
}

/** A wheel with its axle along z: a faceted tyre, sidewalls and a lighter hub on both faces. Origin at the hub. */
function wheel(r: number, w: number): Mesh {
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
      const ri = r * 0.62
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

const OLIVE = hex(0x3a4632)
const OLIVE_D = hex(0x283024)
const OLIVE_L = hex(0x4c5a40)

/** Open-top military jeep: a tub with four seats, a long hood with a slatted grille, a roll cage with the light bar on it. */
function jeep(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  // Chassis, bumpers, the tub floor and walls.
  k.box(-1.8, 0.26, -0.72, 1.8, 0.42, 0.72, DARK)
  k.box(1.88, 0.3, -0.92, 2.02, 0.5, 0.92, DARK, MAT.lit, RAIL)
  k.box(-2.0, 0.32, -0.9, -1.86, 0.5, 0.9, DARK, MAT.lit, RAIL)
  k.box(-1.82, 0.4, -0.8, 0.55, 0.52, 0.8, OLIVE_D)
  k.bevel(-1.88, 0.4, -0.92, 0.6, 0.98, -0.78, 0.04, OLIVE, OLIVE_L)
  k.bevel(-1.88, 0.4, 0.78, 0.6, 0.98, 0.92, 0.04, OLIVE, OLIVE_L)
  k.bevel(-1.88, 0.4, -0.8, -1.76, 0.98, 0.8, 0.04, OLIVE, OLIVE_L)
  // Dashboard and hood, with the grille slats and the vent on top.
  k.bevel(0.5, 0.4, -0.84, 1.95, 0.98, 0.84, 0.07, OLIVE, OLIVE_L)
  k.box(0.42, 0.85, -0.8, 0.6, 1.02, 0.8, DARK, MAT.lit, OLIVE_D)
  k.box(1.95, 0.52, -0.48, 1.99, 0.9, 0.48, DARK)
  for (let i = 0; i < 7; i++) {
    const z = -0.42 + i * 0.14
    k.box(1.97, 0.54, z - 0.025, 2.0, 0.88, z + 0.025, OLIVE_D)
  }
  k.box(1.1, 0.98, -0.3, 1.6, 1.0, 0.3, OLIVE_D)
  // Flat fenders over the wheels.
  for (const f of [1.25, -1.2]) {
    k.pair(f - 0.48, 0.78, 0.82, f + 0.48, 0.86, 1.0, OLIVE, MAT.lit, OLIVE_L)
    k.pair(f - 0.52, 0.5, 0.9, f - 0.44, 0.86, 1.0, OLIVE_D)
    k.pair(f + 0.44, 0.5, 0.9, f + 0.52, 0.86, 1.0, OLIVE_D)
  }
  // Windshield frame and glass, mirrors.
  k.pair(0.5, 0.98, 0.76, 0.58, 1.5, 0.84, RAIL)
  k.box(0.5, 1.44, -0.84, 0.58, 1.52, 0.84, RAIL)
  k.box(0.52, 1.0, -0.76, 0.56, 1.44, 0.76, GLASS, MAT.shiny)
  k.pair(0.5, 1.0, 0.86, 0.6, 1.1, 1.04, DARK)
  // Seats: two buckets up front, a bench at the back; the wheel and the stick.
  for (const s of [-0.42, 0.42]) {
    k.box(-0.24, 0.52, s - 0.23, 0.22, 0.68, s + 0.23, SEAT, MAT.lit, hex(0x34353b))
    k.box(-0.34, 0.6, s - 0.22, -0.22, 1.12, s + 0.22, SEAT, MAT.lit, hex(0x34353b))
  }
  k.box(-1.36, 0.52, -0.72, -0.82, 0.66, 0.72, SEAT, MAT.lit, hex(0x34353b))
  k.box(-1.5, 0.6, -0.72, -1.36, 1.08, 0.72, SEAT, MAT.lit, hex(0x34353b))
  k.box(0.3, 0.96, -0.6, 0.36, 1.12, -0.24, DARK)
  k.box(0.0, 0.52, -0.05, 0.12, 0.8, 0.05, DARK)
  // Roll cage.
  k.pair(-0.6, 0.98, 0.78, -0.52, 1.68, 0.86, RAIL)
  k.pair(-1.84, 0.98, 0.78, -1.76, 1.58, 0.86, RAIL)
  k.pair(-1.84, 1.54, 0.78, -0.52, 1.62, 0.86, RAIL)
  k.box(-0.62, 1.62, -0.86, -0.5, 1.7, 0.86, RAIL)
  k.box(-0.64, 1.68, -0.6, -0.46, 1.71, 0.6, DARK)
  // Spare wheel and jerrycans on the back.
  k.box(-2.08, 0.52, -0.32, -1.9, 1.08, 0.32, TIRE)
  k.box(-2.1, 0.68, -0.14, -2.06, 0.92, 0.14, HUB, MAT.shiny)
  k.box(-1.72, 0.52, 0.5, -1.4, 0.86, 0.74, OLIVE_D, MAT.lit, OLIVE)
  // Lamp housings.
  k.pair(1.94, 0.7, 0.5, 1.98, 0.88, 0.74, DARK)
  k.pair(-1.92, 0.72, 0.6, -1.88, 0.9, 0.82, DARK)
  return k.m
}

const GREY = hex(0x3c4048)
const GREY_D = hex(0x2a2d33)
const GREY_L = hex(0x50555e)

/** Armoured van: a tall box with a sloped windshield, slit windows, a bull bar and three roof hatches for gunners. */
function van(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  const roof = 1.85
  k.box(-2.42, 0.28, -0.9, 2.42, 0.45, 0.9, DARK)
  k.bevel(-2.52, 0.42, -1.04, 1.55, roof, 1.04, 0.1, GREY, GREY_L)
  k.bevel(1.5, 0.42, -1.0, 2.52, 1.02, 1.0, 0.08, GREY, GREY_L)
  // Windshield sloping from the roof down to the hood, with its side panes.
  const wz = 0.94
  k.quad([1.55, roof - 0.06, -wz], [1.55, roof - 0.06, wz], [2.1, 1.02, wz], [2.1, 1.02, -wz], GLASS, MAT.shiny)
  for (const s of [-1, 1]) {
    const z = s * 1.0
    const a = [1.55, roof - 0.08, z]
    const b = [1.55, 1.02, z]
    const c = [2.1, 1.02, z]
    if (s > 0) k.facet(a, b, c, GREY_D)
    else k.facet(a, c, b, GREY_D)
  }
  k.box(1.5, 1.02, -1.0, 1.58, roof - 0.04, 1.0, GREY_D)
  // Slit windows down the sides, and the cab doors.
  for (const [x0, x1] of [
    [0.85, 1.48],
    [-0.85, -0.15],
    [-2.15, -1.45],
  ] as const)
    k.pair(x0, 1.18, 1.04, x1, 1.48, 1.06, GLASS, MAT.shiny)
  k.pair(0.78, 0.5, 1.04, 0.82, 1.6, 1.07, GREY_D)
  k.pair(-0.05, 0.6, 1.04, 0.0, 1.6, 1.07, GREY_D)
  k.pair(-2.4, 0.95, 1.03, 0.75, 1.0, 1.07, GREY_D)
  // Bull bar, grille, rear doors and step.
  k.box(2.52, 0.38, -0.98, 2.62, 0.95, -0.86, DARK)
  k.box(2.52, 0.38, 0.86, 2.62, 0.95, 0.98, DARK)
  k.box(2.55, 0.5, -0.98, 2.64, 0.6, 0.98, RAIL)
  k.box(2.55, 0.78, -0.98, 2.64, 0.86, 0.98, RAIL)
  k.box(2.52, 0.62, -0.5, 2.55, 0.94, 0.5, DARK)
  k.box(-2.56, 0.5, -0.02, -2.52, 1.72, 0.02, GREY_D)
  k.box(-2.62, 0.3, -0.9, -2.5, 0.42, 0.9, DARK, MAT.lit, RAIL)
  // Roof: rails, a vent, the hatches (open, lids tipped back) and the light bar housing.
  k.pair(-2.3, roof, 0.86, 1.2, roof + 0.06, 0.92, RAIL)
  k.box(-0.3, roof, -0.25, 0.05, roof + 0.12, 0.25, GREY_D, MAT.lit, GREY)
  for (const [f, s] of [
    [0.2, 0.48],
    [-1.1, -0.48],
    [-1.1, 0.48],
  ] as const) {
    k.box(f - 0.33, roof, s - 0.31, f + 0.33, roof + 0.03, s + 0.31, DARK)
    k.box(f - 0.4, roof + 0.03, s - 0.3, f - 0.34, roof + 0.4, s + 0.3, GREY_D, MAT.lit, GREY)
  }
  k.box(1.28, roof, -0.65, 1.46, roof + 0.05, 0.65, DARK)
  // Mirrors and lamp housings.
  k.pair(1.45, 1.25, 1.04, 1.55, 1.45, 1.2, DARK)
  k.pair(2.5, 0.66, 0.55, 2.54, 0.88, 0.92, DARK)
  k.pair(-2.56, 0.58, 0.72, -2.52, 1.02, 0.98, DARK)
  return k.m
}

const RED = hex(0xb02a2a)
const RED_D = hex(0x761c1f)
const RED_L = hex(0xd04444)

/** Scooter: floorboard, a rounded rear body under the seat, the leg shield and the bars. */
function scooter(t: Tone): Mesh {
  const k = new Kit(new Mesh(), t)
  k.box(-0.38, 0.18, -0.17, 0.4, 0.28, 0.17, DARK, MAT.lit, RAIL)
  k.bevel(-0.88, 0.22, -0.2, -0.22, 0.6, 0.2, 0.08, RED, RED_L)
  k.bevel(-0.8, 0.58, -0.16, -0.08, 0.7, 0.16, 0.04, SEAT, hex(0x303036))
  k.box(-0.94, 0.42, -0.06, -0.86, 0.6, 0.06, RED_D)
  k.bevel(0.34, 0.22, -0.21, 0.52, 0.98, 0.21, 0.05, RED, RED_L)
  k.box(0.5, 0.48, -0.035, 0.58, 1.04, 0.035, DARK)
  k.box(0.48, 1.0, -0.34, 0.6, 1.06, 0.34, DARK)
  k.box(0.5, 0.98, -0.12, 0.62, 1.08, 0.12, RED, MAT.lit, RED_L)
  k.box(0.48, 0.42, -0.09, 0.86, 0.5, 0.09, RED, MAT.lit, RED_L)
  k.box(-0.82, 0.28, -0.09, -0.4, 0.42, 0.09, DARK)
  k.box(0.6, 0.9, -0.08, 0.63, 1.02, 0.08, DARK)
  return k.m
}

/** Lamp lenses as tinted boxes: the instance's tint is their glow. */
function lamps(boxes: [number, number, number, number, number, number][]): Mesh {
  const m = new Mesh()
  for (const b of boxes) m.box(b[0], b[1], b[2], b[3], b[4], b[5], LAMP, MAT.accent)
  return m
}

/** The light bar: a row of lamps, glowing in the instance's tint (the team holding the vehicle, else amber). */
function bar(x: number, y: number, half: number): Mesh {
  const m = new Mesh()
  m.box(x - 0.06, y - 0.01, -half, x + 0.06, y + 0.04, half, DARK)
  const n = 4
  for (let i = 0; i < n; i++) {
    const z0 = -half + (i * 2 * half) / n + 0.04
    const z1 = z0 + (2 * half) / n - 0.08
    m.box(x - 0.045, y + 0.04, z0, x + 0.045, y + 0.1, z1, LAMP, MAT.accent)
  }
  return m
}

/** Every vehicle's models. */
export function vehicleModels(): Record<VehicleKind, VehicleModels> {
  return {
    jeep: {
      body: jeep(clean),
      wreck: jeep(charred),
      wheel: wheel(0.4, 0.3),
      lens: lamps([
        [1.96, 0.72, -0.72, 2.0, 0.86, -0.52],
        [1.96, 0.72, 0.52, 2.0, 0.86, 0.72],
      ]),
      tail: lamps([
        [-1.95, 0.74, -0.8, -1.91, 0.88, -0.62],
        [-1.95, 0.74, 0.62, -1.91, 0.88, 0.8],
      ]),
      bar: bar(-0.55, 1.71, 0.58),
    },
    van: {
      body: van(clean),
      wreck: van(charred),
      wheel: wheel(0.42, 0.32),
      lens: lamps([
        [2.53, 0.68, -0.9, 2.57, 0.86, -0.57],
        [2.53, 0.68, 0.57, 2.57, 0.86, 0.9],
      ]),
      tail: lamps([
        [-2.58, 0.6, -0.96, -2.54, 1.0, -0.74],
        [-2.58, 0.6, 0.74, -2.54, 1.0, 0.96],
      ]),
      bar: bar(1.37, 1.9, 0.62),
    },
    scooter: {
      body: scooter(clean),
      wreck: scooter(charred),
      wheel: wheel(0.25, 0.13),
      lens: lamps([[0.61, 0.92, -0.07, 0.65, 1.02, 0.07]]),
      tail: lamps([[-0.97, 0.48, -0.08, -0.93, 0.56, 0.08]]),
      bar: null,
    },
  }
}


/** Height of the floor riders stand on (the van's is its roof, for the hatch gunners), for their rings. */
export const FLOOR: Record<VehicleKind, number> = { jeep: 0.54, van: 1.9, scooter: 0.3 }
