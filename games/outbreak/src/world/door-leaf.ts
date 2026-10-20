import { MAT, Mesh, type Mat } from "@arcade/kit/gpu/mesh"
import type { Door } from "../../shared/map"
import { hex } from "../level"

/** Door leaf width (m): hinge at x 0, latch at `DOOR_WIDTH`. */
export const DOOR_WIDTH = 1.4

type LeafBox = readonly [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number, mat: Mat]

const PANEL_ROWS = [
  [0.38, 0.98],
  [1.08, 1.66],
  [1.76, 2.14],
] as const

/** Deep weathered walnut stiles & rails, 6 recessed craft panels, tarnished brass kickplate, and antique lockset. */
const LEAF_BOXES: readonly LeafBox[] = [
  [0, 0.13, -0.09, 1.4, 2.3, 0.09, 0x322216, MAT.timber],
  [0.07, 0.15, 0.09, 1.33, 0.32, 0.102, 0x6e5834, MAT.shiny],
  [0.08, 0.35, -0.1, 1.32, 2.12, -0.092, 0x3e2b1c, MAT.timber],
  // Escutcheon backplate, brass knob & deadbolt cylinder
  [1.13, 0.98, 0.09, 1.24, 1.28, 0.115, 0x4a3c24, MAT.shiny],
  [1.15, 1.05, 0.115, 1.22, 1.13, 0.165, 0xc29e58, MAT.shiny],
  [1.155, 1.19, 0.115, 1.215, 1.24, 0.14, 0xb89450, MAT.shiny],
  ...[0.14, 0.74].flatMap((x) =>
    PANEL_ROWS.flatMap(([y0, y1]): LeafBox[] => [
      [x, y0, 0.091, x + 0.5, y1, 0.112, 0x422e1e, MAT.timber],
      [x + 0.04, y0 + 0.04, 0.113, x + 0.46, y1 - 0.04, 0.122, 0x23170e, MAT.timber],
    ]),
  ),
]

/**
 * The door leaf, or the part of it between `x0` and `x1` (a door split down the middle). A part gets a pale,
 * ragged edge where it broke on the side that was cut.
 */
export function doorLeafMesh(x0 = 0, x1 = DOOR_WIDTH): Mesh {
  const m = new Mesh()
  for (const [bx0, y0, z0, bx1, y1, z1, colour, mat] of LEAF_BOXES) {
    const a = Math.max(bx0, x0)
    const b = Math.min(bx1, x1)
    if (b - a > 1e-4) m.box(a, y0, z0, b, y1, z1, hex(colour), mat)
  }
  const raw = hex(0xb08a5c)
  for (const edge of [x0 > 0 ? x0 : -1, x1 < DOOR_WIDTH ? x1 : -1]) {
    if (edge < 0) continue
    const into = edge === x0 ? 1 : -1
    // Splintered teeth of bare wood along the break, longer and shorter.
    for (let i = 0; i < 9; i++) {
      const y0 = 0.16 + i * 0.235
      const len = 0.03 + ((i * 37) % 7) * 0.012
      const a = into > 0 ? edge : edge - len
      m.box(a, y0, -0.085, a + len, y0 + 0.2, 0.085, raw, MAT.timber)
    }
  }
  return m
}

/** The plain closed/open door leaf the level draws. */
export function createDoorMesh(): Mesh {
  return doorLeafMesh()
}

let override: ((door: Door) => boolean) | null = null

/**
 * Lets a feature draw some doors itself (`src/breach/` draws damaged and torn-out doors): `fn` returns true for a
 * door the plain leaf should skip this frame. One hook; the last caller wins.
 */
export function setDoorLeafOverride(fn: ((door: Door) => boolean) | null): void {
  override = fn
}

export const doorLeafOverride = (): ((door: Door) => boolean) | null => override
