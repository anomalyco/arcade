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
