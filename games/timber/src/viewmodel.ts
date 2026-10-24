// The lumberjack's first-person saw: the chainsaw in his gloved hands, plaid cuffs behind them, drawn in the
// world in front of the eye (the forest's lights and beams light it like anything else). Modelled in eye space:
// x forward, y up, z right, the eye at the origin; one part per frame placed at the eye with its yaw and pitch.
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, type Mat, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"

const ORANGE: Rgb = [0.62, 0.2, 0.03]
const DARK: Rgb = [0.05, 0.05, 0.055]
const GREY: Rgb = [0.22, 0.22, 0.24]
const STEEL: Rgb = [0.55, 0.57, 0.6]
const CHAIN: Rgb = [0.3, 0.3, 0.32]
const GLOVE: Rgb = [0.26, 0.17, 0.09]
const PLAID_B: Rgb = [0.05, 0.03, 0.03]

/** A box from p0 to p1 (eye space). */
type Box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: Rgb, m?: Mat) => void

/** A gloved fist round a handle at (x, y, z), the cuff of a plaid sleeve behind it. */
function glove(box: Box, x: number, y: number, z: number, back: number): void {
  box(x - 0.04, y - 0.03, z - 0.04, x + 0.035, y + 0.035, z + 0.04, GLOVE)
  box(x - 0.005, y + 0.015, z - 0.035, x + 0.045, y + 0.042, z + 0.025, GLOVE)
  box(x - 0.04 - back, y - 0.06, z - 0.045, x - 0.04, y + 0.02, z + 0.045, PLAID_B)
}

/** Where the saw sits in eye space: low and right, so the housing peeks in at the corner and the bar runs inwards. */
const OX = 0.06
const OY = -0.09
const OZ = 0.08

/**
 * Low and to the right, the bar running in towards the middle of the frame below the centre: the top of the engine
 * housing in the bottom right corner, the right hand on the rear handle out of frame, the left over the wrap handle.
 */
export function sawViewMesh(): Mesh {
  const m = new Mesh({ chamfer: "auto" })
  const box: Box = (x0, y0, z0, x1, y1, z1, c, mat = MAT.lit) => m.box(x0 + OX, y0 + OY, z0 + OZ, x1 + OX, y1 + OY, z1 + OZ, c, mat)
  // Engine housing: orange cover over a dark crankcase, the starter on the left, a fuel cap.
  box(0.4, -0.37, 0.17, 0.7, -0.28, 0.32, DARK)
  box(0.42, -0.28, 0.18, 0.68, -0.22, 0.31, ORANGE)
  box(0.47, -0.22, 0.2, 0.64, -0.205, 0.29, ORANGE)
  box(0.44, -0.35, 0.15, 0.6, -0.25, 0.17, GREY)
  box(0.42, -0.37, 0.3, 0.46, -0.34, 0.34, DARK)
  // The muffler's guard on the right.
  box(0.56, -0.35, 0.32, 0.68, -0.28, 0.345, STEEL, MAT.shiny)
  // The wrap handle over the top and down the left, the rear handle behind with its trigger.
  box(0.62, -0.19, 0.14, 0.645, -0.165, 0.3, DARK)
  box(0.62, -0.34, 0.14, 0.645, -0.165, 0.165, DARK)
  box(0.26, -0.33, 0.235, 0.42, -0.3, 0.265, DARK)
  box(0.26, -0.37, 0.235, 0.29, -0.3, 0.265, DARK)
  box(0.32, -0.355, 0.24, 0.36, -0.33, 0.26, ORANGE)
  // The bar and chain: steel plate, chain running round its edge, a nose sprocket.
  box(0.7, -0.315, 0.232, 1.6, -0.265, 0.248, STEEL, MAT.shiny)
  box(0.7, -0.266, 0.229, 1.6, -0.257, 0.251, CHAIN, MAT.shiny)
  box(0.7, -0.323, 0.229, 1.6, -0.314, 0.251, CHAIN, MAT.shiny)
  for (let i = 0; i < 20; i++) {
    const x = 0.72 + i * 0.044
    box(x, -0.258, 0.228, x + 0.014, -0.25, 0.252, DARK)
    box(x + 0.02, -0.331, 0.228, x + 0.034, -0.323, 0.252, DARK)
  }
  box(1.6, -0.31, 0.229, 1.625, -0.27, 0.251, CHAIN, MAT.shiny)
  // Hands: the right on the rear handle, the left over the wrap handle.
  glove(box, 0.33, -0.31, 0.25, 0.12)
  glove(box, 0.632, -0.17, 0.215, 0.1)
  return m
}

export type SawPose = {
  /** Eye position (world). */
  eye: readonly number[]
  /** Camera yaw (the game's `camYaw`) and pitch down (rad). */
  yaw: number
  pitch: number
  /** 0 idle .. 1 revving; 0..1 in wood; seconds; the engine running. */
  rev: number
  cut: number
  t: number
  on: boolean
  /** Head bob (m) and the sprint (0..1). */
  bob: number
  sprint: number
  buzz: number
  /** Tint (0..1), against the helmet lamp's glare up close. */
  lit: number
}

/** Draws the first-person saw for this frame; returns the bar's nose (world), where chips leave. */
export function drawSawView(fp: FrameParts, model: number, p: SawPose): [number, number, number] {
  const fx = -Math.sin(p.yaw)
  const fz = -Math.cos(p.yaw)
  // The engine shakes the saw: a fine buzz idling, a harder one revved, a coarse judder in wood.
  const b = p.on ? p.buzz * (0.0025 + p.rev * 0.004 + p.cut * 0.006) : 0
  const jx = Math.sin(p.t * 97) * b + Math.sin(p.t * 61) * b * 0.6
  const jy = Math.sin(p.t * 83 + 1) * b + Math.sin(p.t * 41) * b * 0.5
  // Lowered at a sprint, pushed forward and down into the cut.
  const lower = p.sprint * 0.12 + p.bob * 0.4
  const push = p.cut * 0.08
  const pitch = -p.pitch - lower * 0.6 - p.cut * 0.1 + jy * 4
  const yaw = Math.atan2(fz, fx) + jx * 3
  const roll = jx * 6 + p.sprint * 0.12 * Math.sin(p.t * 7)
  const ex = p.eye[0]! + fx * push
  const ey = p.eye[1]! - lower * 0.3 + jy
  const ez = p.eye[2]! + fz * push
  // A dimmer tint: it sits half a metre under the helmet lamp, which would otherwise blow it out.
  fp.part(model, ex, ey, ez, yaw, [p.lit, p.lit, p.lit], pitch, roll, 0, 1, 1)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  // The nose in eye space.
  const nx = 1.6 + OX
  const ny = -0.29 + OY
  const lx = nx * cp - ny * sp
  const ly = nx * sp + ny * cp
  const rx = Math.cos(p.yaw)
  const rz = -Math.sin(p.yaw)
  return [ex + fx * lx + rx * (0.24 + OZ), ey + ly, ez + fz * lx + rz * (0.24 + OZ)]
}
