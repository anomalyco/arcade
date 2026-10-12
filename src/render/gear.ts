import { MAT, Mesh, type Rgb } from "./mesh"
import { hex } from "./models"

const OLIVE = hex(0x56613a)
const OLIVE_D = hex(0x3c4428)
const OLIVE_L = hex(0x6e7a4a)
const STEEL = hex(0x8a909c)
const DARK = hex(0x1a1c21)
const CLAY = hex(0x34382c)
const CLAY_L = hex(0x3d4134)
const ACC: Rgb = [1, 1, 1]

/** Frag: a faceted ovoid with a fuse cap and the spoon down one side, centred on its middle so it tumbles. */
function frag(): Mesh {
  const m = new Mesh()
  m.prism(0, 0, 0.03, 0.062, -0.075, -0.035, 7, OLIVE_D, MAT.lit, 0, false)
  m.prism(0, 0, 0.062, 0.066, -0.035, 0.0, 7, OLIVE, MAT.lit, 0, false, 0.2)
  m.prism(0, 0, 0.066, 0.058, 0.0, 0.035, 7, OLIVE_L, MAT.lit, 0, false)
  m.prism(0, 0, 0.058, 0.03, 0.035, 0.07, 7, OLIVE, MAT.lit, 0, true, 0.2)
  m.prism(0, 0, 0.032, 0.026, -0.08, -0.07, 7, OLIVE_D)
  m.box(-0.022, 0.07, -0.022, 0.022, 0.1, 0.022, STEEL)
  m.box(0.022, 0.05, -0.012, 0.072, 0.095, 0.012, STEEL)
  m.box(0.062, -0.04, -0.01, 0.075, 0.06, 0.01, STEEL)
  m.box(-0.035, 0.085, -0.004, -0.022, 0.11, 0.004, DARK)
  return m
}

/**
 * Claymore: a low, dull curved slab bowed toward +x on four short scissor legs, coloured to sink into the floor, with a
 * thin strip along the top that takes the instance tint (a dim accent for its owner, case-dark for everyone else).
 * Pivot on the floor at its centre.
 */
function claymore(): Mesh {
  const m = new Mesh()
  const y0 = 0.035
  const y1 = 0.14
  m.yawBox(0.02, 0, 0.05, 0.14, y0, y1, 0, CLAY, MAT.lit, 0, CLAY_L)
  for (const s of [-1, 1]) m.yawBox(-0.002, s * 0.122, 0.05, 0.12, y0, y1, s * 0.5, CLAY, MAT.lit, 0, CLAY_L)
  // Front face: a barely lighter plate; back: the darker case and the detonator wells.
  m.yawBox(0.047, 0, 0.006, 0.12, y0 + 0.015, y1 - 0.015, 0, CLAY_L)
  for (const s of [-1, 1]) m.yawBox(0.023, s * 0.135, 0.006, 0.1, y0 + 0.015, y1 - 0.015, s * 0.5, CLAY_L)
  for (const s of [-1, 1]) m.yawBox(-0.012, s * 0.05, 0.026, 0.026, y1, y1 + 0.02, 0, DARK)
  m.yawBox(0.02, 0, 0.012, 0.12, y1, y1 + 0.006, 0, ACC, MAT.accent)
  for (const s of [-1, 1]) m.yawBox(-0.002, s * 0.122, 0.012, 0.1, y1, y1 + 0.006, s * 0.5, ACC, MAT.accent)
  // Scissor legs.
  for (const s of [-1, 1]) {
    m.yawBox(0.03, s * 0.1, 0.012, 0.012, 0, y0 + 0.01, s * 0.3, DARK)
    m.yawBox(-0.03, s * 0.1, 0.012, 0.012, 0, y0 + 0.01, -s * 0.3, DARK)
  }
  return m
}

/** The claymore's status light, a pinprick tinted by the instance: off, armed or tripped. */
function led(): Mesh {
  const m = new Mesh()
  m.box(-0.008, 0, -0.008, 0.008, 0.01, 0.008, ACC, MAT.accent)
  return m
}

export type GearModels = { frag: Mesh; claymore: Mesh; led: Mesh }

export function gearModels(): GearModels {
  return { frag: frag(), claymore: claymore(), led: led() }
}
