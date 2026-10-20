import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { hex } from "../level"

/** Rough length of each throwable lying on the ground, for laying several side by side. */
export const THROWABLE_FOOTPRINT: Readonly<Record<string, number>> = { baseball: 0.09, brick: 0.22, rock: 0.14, "tin-can": 0.1 }

/**
 * Throwables as small props (origin at the base centre, long axis along +x), read by shape and colour: a scuffed white
 * baseball with red stitching, a red house brick, a grey fist-sized rock, a dented label-wrapped tin can on its side.
 */
export function buildThrowableMeshes(): Record<string, Mesh> {
  const out: Record<string, Mesh> = {}

  const ball = new Mesh()
  ball.prism(0, 0, 0.026, 0.036, 0, 0.012, 10, hex(0xd8d2c0), MAT.cloth)
  ball.prism(0, 0, 0.037, 0.037, 0.012, 0.062, 10, hex(0xe4ded0), MAT.cloth)
  ball.prism(0, 0, 0.036, 0.026, 0.062, 0.074, 10, hex(0xd8d2c0), MAT.cloth)
  for (const s of [-1, 1]) ball.yawBox(s * 0.02, 0, 0.006, 0.05, 0.02, 0.06, s * 0.5, hex(0xb02a24), MAT.lit)
  out.baseball = ball

  const brick = new Mesh()
  brick.bevelBox(-0.11, 0, -0.052, 0.11, 0.065, 0.052, 0.006, hex(0x8e3a26), hex(0x9e4630), MAT.brick)
  brick.box(-0.06, 0.065, -0.02, -0.02, 0.0655, 0.02, hex(0x5a2418))
  brick.box(0.02, 0.065, -0.02, 0.06, 0.0655, 0.02, hex(0x5a2418))
  out.brick = brick

  const rock = new Mesh()
  rock.prism(0, 0, 0.06, 0.07, 0, 0.03, 7, hex(0x6a6862), MAT.lit, 0, true, 0.3)
  rock.prism(0.01, -0.005, 0.07, 0.035, 0.03, 0.075, 7, hex(0x7a7870), MAT.lit, 0, true, 0.9)
  out.rock = rock

  const can = new Mesh()
  can.yawBox(0, 0, 0.11, 0.07, 0.0, 0.07, 0, hex(0x9a9c98), MAT.shiny)
  can.yawBox(0, 0, 0.08, 0.072, 0.0, 0.072, 0, hex(0xb8402a), MAT.lit)
  can.yawBox(0.056, 0, 0.004, 0.06, 0.006, 0.064, 0, hex(0x6a6c68), MAT.shiny)
  out["tin-can"] = can
  return out
}

/** The arc preview's dot and landing marker: a small bright bead and a flat ring segment, both accent-lit. */
export function buildAimMeshes(): { dot: Mesh; ring: Mesh } {
  const dot = new Mesh()
  dot.prism(0, 0, 0.035, 0.035, -0.035, 0.035, 6, hex(0xffffff), MAT.accent)
  const ring = new Mesh()
  const n = 18
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    ring.yawBox(Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0.1, 0.025, 0.01, 0.02, -a + Math.PI / 2, hex(0xffffff), MAT.accent)
  }
  return { dot, ring }
}

/**
 * Loose furniture (origin at the base centre, width along x, depth along z), read by shape: a kitchen chair, a plain
 * table, a chest of drawers with brass pulls, a striped mattress on its edge. Each has a lying-down twin for when the
 * dead have shoved it over.
 */
export function buildFurnitureMeshes(): Record<string, Mesh> {
  const out: Record<string, Mesh> = {}
  const wood = hex(0x6a4a30)
  const dark = hex(0x4a3220)
  const brass = hex(0xb08a48)

  const chair = new Mesh()
  for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]] as const) chair.box(x - 0.02, 0, z - 0.02, x + 0.02, 0.45, z + 0.02, dark, MAT.timber)
  chair.box(-0.24, 0.45, -0.24, 0.24, 0.49, 0.24, wood, MAT.timber)
  chair.box(-0.24, 0.49, 0.2, 0.24, 0.9, 0.24, wood, MAT.timber)
  for (const x of [-0.12, 0, 0.12]) chair.box(x - 0.015, 0.52, 0.21, x + 0.015, 0.84, 0.23, dark, MAT.timber)
  out.chair = chair

  const table = new Mesh()
  for (const [x, z] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]] as const) table.box(x - 0.03, 0, z - 0.03, x + 0.03, 0.72, z + 0.03, dark, MAT.timber)
  table.bevelBox(-0.55, 0.72, -0.35, 0.55, 0.76, 0.35, 0.01, wood, hex(0x7a5838), MAT.timber)
  out.table = table

  const dresser = new Mesh()
  dresser.bevelBox(-0.475, 0.04, -0.24, 0.475, 1.15, 0.24, 0.012, hex(0x5a3c26), hex(0x6a4a30), MAT.timber)
  dresser.box(-0.45, 0, -0.22, 0.45, 0.04, 0.22, dark, MAT.timber)
  for (let i = 0; i < 4; i++) {
    const y0 = 0.1 + i * 0.26
    dresser.box(-0.43, y0, -0.25, 0.43, y0 + 0.22, -0.24, hex(0x6e4c32), MAT.timber)
    for (const x of [-0.2, 0.2]) dresser.box(x - 0.04, y0 + 0.09, -0.265, x + 0.04, y0 + 0.12, -0.25, brass, MAT.shiny)
  }
  out.dresser = dresser

  const mattress = new Mesh()
  mattress.bevelBox(-0.675, 0, -0.12, 0.675, 1.85, 0.12, 0.05, hex(0xc8c0ac), hex(0xd8d0bc), MAT.cloth)
  for (let i = 0; i < 6; i++) mattress.box(-0.676, 0.15 + i * 0.3, -0.121, 0.676, 0.2 + i * 0.3, 0.121, hex(0x7a8aa0), MAT.cloth)
  out.mattress = mattress

  // Shoved over: each lies on its back, its height along z.
  const chairDown = new Mesh()
  chairDown.box(-0.24, 0, -0.45, 0.24, 0.04, 0.45, wood, MAT.timber)
  chairDown.box(-0.24, 0.04, -0.45, 0.24, 0.48, -0.41, dark, MAT.timber)
  out["chair:down"] = chairDown
  const tableDown = new Mesh()
  tableDown.box(-0.55, 0, -0.38, 0.55, 0.7, -0.34, wood, MAT.timber)
  for (const x of [-0.5, 0.5]) for (const y of [0.08, 0.62]) tableDown.box(x - 0.03, y - 0.03, -0.34, x + 0.03, y + 0.03, 0.38, dark, MAT.timber)
  out["table:down"] = tableDown
  const dresserDown = new Mesh()
  dresserDown.bevelBox(-0.475, 0, -0.575, 0.475, 0.48, 0.575, 0.012, hex(0x5a3c26), hex(0x6e4c32), MAT.timber)
  for (let i = 0; i < 4; i++) for (const x of [-0.2, 0.2]) dresserDown.box(x - 0.04, 0.48, -0.47 + i * 0.26, x + 0.04, 0.495, -0.44 + i * 0.26, brass, MAT.shiny)
  out["dresser:down"] = dresserDown
  const mattressDown = new Mesh()
  mattressDown.bevelBox(-0.675, 0, -0.925, 0.675, 0.24, 0.925, 0.05, hex(0xc8c0ac), hex(0xd8d0bc), MAT.cloth)
  out["mattress:down"] = mattressDown
  return out
}
