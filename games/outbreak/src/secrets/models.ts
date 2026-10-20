import { FLOATS_PER_VERT, hex, MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"

/**
 * Box-built models for the secrets (AR-85). Wall pieces are built with their back on the wall at z = 0 and their face
 * towards +z (the camera's side); floor and ground pieces lie flat with their front towards +z.
 */

/** Rotates every vertex added since `from` by `a` around the z axis (in the xy plane), then moves it. */
function rotZ(m: Mesh, from: number, a: number, tx = 0, ty = 0, tz = 0): void {
  const c = Math.cos(a)
  const s = Math.sin(a)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const x = m.v[i]!
    const y = m.v[i + 1]!
    m.v[i] = x * c - y * s + tx
    m.v[i + 1] = x * s + y * c + ty
    m.v[i + 2]! += tz
    const nx = m.v[i + 3]!
    const ny = m.v[i + 4]!
    m.v[i + 3] = nx * c - ny * s
    m.v[i + 4] = nx * s + ny * c
  }
}

/** Rotates every vertex added since `from` by `a` around the y axis (on the ground), then moves it. */
function rotY(m: Mesh, from: number, a: number, tx = 0, ty = 0, tz = 0): void {
  const c = Math.cos(a)
  const s = Math.sin(a)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const x = m.v[i]!
    const z = m.v[i + 2]!
    m.v[i] = x * c - z * s + tx
    m.v[i + 1]! += ty
    m.v[i + 2] = x * s + z * c + tz
    const nx = m.v[i + 3]!
    const nz = m.v[i + 5]!
    m.v[i + 3] = nx * c - nz * s
    m.v[i + 5] = nx * s + nz * c
  }
}

/** A stroke from (ax, ay) to (bx, by) on a face at depth z (normal +z), `w` wide and `d` proud. */
export function strokeV(m: Mesh, ax: number, ay: number, bx: number, by: number, z: number, w: number, col: Rgb, mat: Mat = MAT.lit, d = 0.003): void {
  const len = Math.hypot(bx - ax, by - ay)
  const from = m.v.length
  m.box(-len / 2 - w / 2, -w / 2, z, len / 2 + w / 2, w / 2, z + d, col, mat)
  rotZ(m, from, Math.atan2(by - ay, bx - ax), (ax + bx) / 2, (ay + by) / 2)
}

/** A stroke on the ground (plan x, z) at height y, `w` wide. */
export function strokeG(m: Mesh, ax: number, az: number, bx: number, bz: number, y: number, w: number, col: Rgb, mat: Mat = MAT.lit): void {
  const len = Math.hypot(bx - ax, bz - az)
  const from = m.v.length
  m.box(-len / 2 - w / 2, y, -w / 2, len / 2 + w / 2, y + 0.003, w / 2, col, mat)
  rotY(m, from, Math.atan2(bz - az, bx - ax), (ax + bx) / 2, 0, (az + bz) / 2)
}

/** A ring of strokes (a circle of `n` segments) on a face. */
function ringV(m: Mesh, cx: number, cy: number, r: number, z: number, w: number, col: Rgb, n = 12, mat: Mat = MAT.lit): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    strokeV(m, cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z, w, col, mat)
  }
}

function ringG(m: Mesh, cx: number, cz: number, r: number, y: number, w: number, col: Rgb, n = 12): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    strokeG(m, cx + Math.cos(a0) * r, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, cz + Math.sin(a1) * r, y, w, col)
  }
}

/** A flat disc facing +z at depth z, as a fan of facets. */
function discV(m: Mesh, cx: number, cy: number, r: number, z: number, col: Rgb, mat: Mat = MAT.lit, n = 18): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    m.facet([cx, cy, z], [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z], col, mat)
  }
}

/** A flat disc on the ground. */
function discG(m: Mesh, cx: number, cz: number, r: number, y: number, col: Rgb, n = 14): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    m.facet([cx, y, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], col, mat0)
  }
}
const mat0 = MAT.lit

const PAPER = hex(0xe8dfc8)
const INK = hex(0x3a3833)
const RED = hex(0xb3241c)

/** Calendar cell geometry (shared with the presenter, which puts the red ring on the circled day). */
export const CAL = { w: 0.32, h: 0.42, gridTop: 0.1, cols: 7, rows: 5, cellW: 0.04, cellH: 0.05 }

/** A kitchen calendar: picture on top, month grid below, a red binding strip. Centre at (0, 0) on the wall. */
export function calendarMesh(): Mesh {
  const m = new Mesh()
  const { w, h } = CAL
  m.box(-w / 2, -h / 2, 0, w / 2, h / 2, 0.006, PAPER, MAT.lit)
  m.box(-w / 2, h / 2 - 0.02, 0, w / 2, h / 2, 0.01, hex(0x7a1d18), MAT.lit)
  // The month's picture: a muddy landscape block.
  m.box(-w / 2 + 0.02, 0.03, 0.006, w / 2 - 0.02, h / 2 - 0.035, 0.008, hex(0x5d6a52), MAT.lit)
  m.box(-w / 2 + 0.02, 0.03, 0.008, w / 2 - 0.02, 0.07, 0.009, hex(0x3f4a38), MAT.lit)
  // Grid lines.
  const gx0 = -CAL.cols * CAL.cellW / 2
  const gy0 = 0.0
  for (let c = 0; c <= CAL.cols; c++) m.box(gx0 + c * CAL.cellW - 0.001, gy0 - CAL.rows * CAL.cellH, 0.006, gx0 + c * CAL.cellW + 0.001, gy0, 0.0075, INK)
  for (let r = 0; r <= CAL.rows; r++) m.box(gx0, gy0 - r * CAL.cellH - 0.001, 0.006, gx0 + CAL.cols * CAL.cellW, gy0 - r * CAL.cellH + 0.001, 0.0075, INK)
  return m
}

/** Where day `day` sits on the calendar's face (centre of its cell), for a month starting on `firstWeekday`. */
export function calendarCell(day: number, firstWeekday: number): { x: number; y: number } {
  const i = firstWeekday + day - 1
  const col = i % CAL.cols
  const row = Math.floor(i / CAL.cols)
  return { x: -CAL.cols * CAL.cellW / 2 + (col + 0.5) * CAL.cellW, y: -(row + 0.5) * CAL.cellH }
}

/** The red ring round the circled day; a cross for each day crossed off. */
export function calendarRingMesh(): Mesh {
  const m = new Mesh()
  ringV(m, 0, 0, 0.026, 0.0085, 0.006, RED, 10)
  return m
}

export function calendarCrossMesh(): Mesh {
  const m = new Mesh()
  strokeV(m, -0.013, -0.016, 0.013, 0.016, 0.0078, 0.003, INK)
  strokeV(m, -0.013, 0.016, 0.013, -0.016, 0.0078, 0.003, INK)
  return m
}

/** A round wall clock without its hands: rim, face and the twelve marks. */
export function clockMesh(): Mesh {
  const m = new Mesh()
  const r = 0.17
  for (let i = 0; i < 20; i++) {
    const a0 = (i / 20) * Math.PI * 2
    const a1 = ((i + 1) / 20) * Math.PI * 2
    strokeV(m, Math.cos(a0) * r, Math.sin(a0) * r, Math.cos(a1) * r, Math.sin(a1) * r, 0, 0.03, hex(0x3b2a1c), MAT.timber, 0.04)
  }
  discV(m, 0, 0, r - 0.01, 0.025, hex(0xd9d2bd))
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const k = i % 3 === 0 ? 0.03 : 0.016
    strokeV(m, Math.sin(a) * (r - 0.03), Math.cos(a) * (r - 0.03), Math.sin(a) * (r - 0.03 - k), Math.cos(a) * (r - 0.03 - k), 0.026, 0.006, INK)
  }
  discV(m, 0, 0, 0.012, 0.031, INK)
  return m
}

/** A clock hand pointing up (12 o'clock); the presenter turns it with the instance's pitch. */
export function handMesh(length: number, width: number, z: number): Mesh {
  const m = new Mesh()
  m.box(-width / 2, -0.02, z, width / 2, length, z + 0.003, hex(0x151412), MAT.lit)
  return m
}

/** A framed family photo: `faces` people side by side, the `scratched` one (1-based, 0 none) scratched out in white. */
export function photoMesh(faces: number, scratched: number): Mesh {
  const m = new Mesh()
  const w = 0.4
  const h = 0.3
  m.box(-w / 2, -h / 2, 0, w / 2, h / 2, 0.025, hex(0x4a3020), MAT.timber)
  m.box(-w / 2 + 0.03, -h / 2 + 0.03, 0.025, w / 2 - 0.03, h / 2 - 0.03, 0.027, hex(0xb59c74), MAT.lit)
  const span = w - 0.1
  for (let i = 0; i < faces; i++) {
    const x = -span / 2 + (span * (i + 0.5)) / faces
    const tall = i < 2 ? 1 : 0.7
    const top = -0.06 + 0.12 * tall
    m.box(x - 0.026, -h / 2 + 0.04, 0.027, x + 0.026, top - 0.02, 0.029, hex(0x4e3a2a), MAT.lit)
    discV(m, x, top, 0.019, 0.029, hex(0xd8bf98), MAT.lit, 10)
    if (i + 1 === scratched) {
      // Frantic white strokes over the face, scored into the print.
      for (let k = 0; k < 7; k++) {
        const a = -0.9 + k * 0.29
        strokeV(m, x - 0.03, top - 0.025 + k * 0.007, x + 0.03, top + 0.02 - k * 0.004 + Math.sin(a) * 0.01, 0.0305, 0.0035, hex(0xf3efe6))
      }
    }
  }
  // Glass glint along the top.
  m.box(-w / 2 + 0.03, h / 2 - 0.05, 0.03, w / 2 - 0.03, h / 2 - 0.045, 0.031, hex(0x9aa2a6), MAT.shiny)
  return m
}

const CHALK = [hex(0xf2b6c6), hex(0xa9d4f0), hex(0xf4e39a), hex(0xbfe5b3), hex(0xf6f3ea)] as const

/**
 * A child's chalk drawing on the driveway, ~1.6 × 1.2 m: the house, the sun, the family (2–5 by `variant`). `late`
 * adds the thin man much taller than the house beside it and colours the sun in black.
 */
export function chalkMesh(variant: number, late: boolean): Mesh {
  const m = new Mesh()
  const y = 0.004
  const w = 0.04
  const [pink, blue, yellow, green, white] = CHALK
  // The house: a box and a roof, a door and a window. Drawn "up" towards −z (away from the camera, as a child stands).
  const hx = -0.15
  strokeG(m, hx - 0.35, 0.3, hx + 0.35, 0.3, y, w, white)
  strokeG(m, hx - 0.35, 0.3, hx - 0.35, -0.25, y, w, white)
  strokeG(m, hx + 0.35, 0.3, hx + 0.35, -0.25, y, w, white)
  strokeG(m, hx - 0.35, -0.25, hx + 0.35, -0.25, y, w, white)
  strokeG(m, hx - 0.42, -0.25, hx, -0.62, y, w, pink)
  strokeG(m, hx, -0.62, hx + 0.42, -0.25, y, w, pink)
  strokeG(m, hx - 0.06, 0.3, hx - 0.06, 0.05, y, w, yellow)
  strokeG(m, hx + 0.06, 0.3, hx + 0.06, 0.05, y, w, yellow)
  strokeG(m, hx - 0.06, 0.05, hx + 0.06, 0.05, y, w, yellow)
  // The sun in the corner.
  const sx = 0.62
  const sz = -0.52
  if (late) discG(m, sx, sz, 0.15, y + 0.001, hex(0x111111))
  ringG(m, sx, sz, 0.15, y + 0.002, w, late ? hex(0x111111) : yellow)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    strokeG(m, sx + Math.cos(a) * 0.2, sz + Math.sin(a) * 0.2, sx + Math.cos(a) * 0.3, sz + Math.sin(a) * 0.3, y, w * 0.8, late ? hex(0x111111) : yellow)
  }
  // The family, holding hands in front of the house.
  const n = 2 + (variant % 4)
  const cols = [blue, pink, green, yellow, blue]
  for (let i = 0; i < n; i++) {
    const x = -0.6 + i * 0.28
    const tall = i < 2 ? 1 : 0.7
    const c = cols[i]!
    const foot = 0.62
    const hip = foot - 0.16 * tall
    const neck = hip - 0.2 * tall
    ringG(m, x, neck - 0.07 * tall, 0.06 * tall, y, w * 0.8, c, 8)
    strokeG(m, x, neck, x, hip, y, w * 0.8, c)
    strokeG(m, x, hip, x - 0.07, foot, y, w * 0.8, c)
    strokeG(m, x, hip, x + 0.07, foot, y, w * 0.8, c)
    strokeG(m, x - 0.13, neck + 0.06, x + 0.13, neck + 0.06, y, w * 0.8, c)
  }
  if (late) {
    // Him: beside the house, taller than its roof, no face, arms down to his knees.
    const x = hx + 0.62
    const foot = 0.62
    const dark = hex(0x1b1b1d)
    ringG(m, x, -0.78, 0.05, y + 0.001, w * 0.7, dark, 8)
    strokeG(m, x, -0.72, x, 0.0, y + 0.001, w * 0.7, dark)
    strokeG(m, x, 0.0, x - 0.04, foot, y + 0.001, w * 0.7, dark)
    strokeG(m, x, 0.0, x + 0.04, foot, y + 0.001, w * 0.7, dark)
    strokeG(m, x - 0.02, -0.62, x - 0.12, 0.2, y + 0.001, w * 0.6, dark)
    strokeG(m, x + 0.02, -0.62, x + 0.12, 0.2, y + 0.001, w * 0.6, dark)
  }
  return m
}

/** Lowercase stroke letters for the stencil, on a 0..1 × 0..1 box (x right, y up). */
const LETTERS: Readonly<Record<string, readonly (readonly [number, number, number, number])[]>> = {
  a: [[0.85, 0, 0.85, 0.7], [0.85, 0.7, 0.15, 0.7], [0.15, 0.7, 0.15, 0.35], [0.15, 0.35, 0.85, 0.35], [0.15, 0, 0.85, 0]],
  n: [[0.15, 0, 0.15, 0.7], [0.15, 0.7, 0.85, 0.7], [0.85, 0.7, 0.85, 0]],
  o: [[0.15, 0, 0.15, 0.7], [0.15, 0.7, 0.85, 0.7], [0.85, 0.7, 0.85, 0], [0.85, 0, 0.15, 0]],
  m: [[0.08, 0, 0.08, 0.7], [0.08, 0.7, 0.92, 0.7], [0.5, 0.7, 0.5, 0.15], [0.92, 0.7, 0.92, 0]],
  l: [[0.5, 0, 0.5, 1]],
  y: [[0.15, 0.7, 0.15, 0.25], [0.15, 0.25, 0.85, 0.25], [0.85, 0.7, 0.85, -0.3], [0.85, -0.3, 0.2, -0.3]],
}

/** A moving box with a removals firm's name stencilled on its front: "anomaly". */
export function nodBoxMesh(): Mesh {
  const m = new Mesh()
  const card = hex(0x9c7a4e)
  m.box(-0.28, 0, -0.22, 0.28, 0.44, 0.22, card, MAT.lit, 0, hex(0xa98757))
  // Tape across the top and down the front.
  m.box(-0.04, 0.44, -0.22, 0.04, 0.443, 0.22, hex(0xc9b78f), MAT.lit)
  m.box(-0.04, 0.34, 0.22, 0.04, 0.44, 0.223, hex(0xc9b78f), MAT.lit)
  const word = "anomaly"
  const size = 0.055
  const step = size * 0.92
  const x0 = -(word.length * step) / 2
  const ink = hex(0x24201a)
  word.split("").forEach((ch, i) => {
    for (const [ax, ay, bx, by] of LETTERS[ch] ?? []) {
      const ox = x0 + i * step
      strokeV(m, ox + ax * size * 0.8, 0.16 + ay * size, ox + bx * size * 0.8, 0.16 + by * size, 0.221, 0.007, ink)
    }
  })
  // A small "this way up" pair of arrows, the way every box has.
  strokeV(m, 0.17, 0.08, 0.17, 0.13, 0.221, 0.006, ink)
  strokeV(m, 0.2, 0.08, 0.2, 0.13, 0.221, 0.006, ink)
  return m
}

/** The tall man: very tall and thin, arms down to his knees, a small head. Near black. */
export function tallManMesh(): Mesh {
  const m = new Mesh()
  const c = hex(0x0e0e10)
  const mat = MAT.actor
  m.box(-0.11, 0, -0.05, -0.03, 1.3, 0.05, c, mat)
  m.box(0.03, 0, -0.05, 0.11, 1.3, 0.05, c, mat)
  m.box(-0.15, 1.28, -0.08, 0.15, 2.02, 0.08, c, mat)
  m.box(-0.2, 1.98, -0.07, 0.2, 2.05, 0.07, c, mat)
  // Arms hang past the knees, a little out from the body.
  const from = m.v.length
  m.box(-0.025, -1.05, -0.03, 0.025, 0, 0.03, c, mat)
  rotZ(m, from, -0.06, -0.2, 2.02, 0)
  const from2 = m.v.length
  m.box(-0.025, -1.05, -0.03, 0.025, 0, 0.03, c, mat)
  rotZ(m, from2, 0.06, 0.2, 2.02, 0)
  m.box(-0.035, 2.04, -0.035, 0.035, 2.14, 0.035, c, mat)
  m.box(-0.075, 2.13, -0.08, 0.075, 2.34, 0.08, c, mat)
  return m
}

/** A plain dining chair, the sitter facing +z. */
export function chairMesh(): Mesh {
  const m = new Mesh()
  const wood = hex(0x5b3e28)
  for (const [x, z] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const) m.box(x - 0.022, 0, z - 0.022, x + 0.022, 0.44, z + 0.022, wood, MAT.timber)
  m.box(-0.21, 0.44, -0.21, 0.21, 0.48, 0.21, hex(0x6b4a30), MAT.timber)
  m.box(-0.2, 0.48, -0.21, -0.16, 0.95, -0.17, wood, MAT.timber)
  m.box(0.16, 0.48, -0.21, 0.2, 0.95, -0.17, wood, MAT.timber)
  m.box(-0.2, 0.74, -0.215, 0.2, 0.92, -0.18, hex(0x6b4a30), MAT.timber)
  return m
}

/** A rocking chair on curved runners, the sitter facing +z. */
export function rockerMesh(): Mesh {
  const m = new Mesh()
  const wood = hex(0x4c3523)
  // Runners: a few segments on an arc.
  for (const x of [-0.22, 0.2]) {
    for (let i = 0; i < 6; i++) {
      const a0 = -0.55 + (i / 6) * 1.1
      const a1 = -0.55 + ((i + 1) / 6) * 1.1
      const r = 0.9
      const z0 = Math.sin(a0) * r
      const z1 = Math.sin(a1) * r
      const y0 = r - Math.cos(a0) * r + 0.02
      const y1 = r - Math.cos(a1) * r + 0.02
      const from = m.v.length
      const len = Math.hypot(z1 - z0, y1 - y0)
      m.box(-0.02, -0.02, -len / 2, 0.02, 0.02, len / 2, wood, MAT.timber)
      // Tilt the segment in the yz plane to follow the arc.
      const t = Math.atan2(y1 - y0, z1 - z0)
      const c = Math.cos(t)
      const s = Math.sin(t)
      for (let k = from; k < m.v.length; k += FLOATS_PER_VERT) {
        const yy = m.v[k + 1]!
        const zz = m.v[k + 2]!
        m.v[k] = m.v[k]! + x
        m.v[k + 1] = zz * s + yy * c + (y0 + y1) / 2
        m.v[k + 2] = zz * c - yy * s + (z0 + z1) / 2
      }
    }
  }
  for (const [x, z] of [[-0.2, -0.22], [0.2, -0.22], [-0.2, 0.2], [0.2, 0.2]] as const) m.box(x - 0.02, 0.03, z - 0.02, x + 0.02, 0.45, z + 0.02, wood, MAT.timber)
  m.box(-0.23, 0.42, -0.24, 0.23, 0.46, 0.22, hex(0x5d4330), MAT.timber)
  // Tall back of spindles.
  m.box(-0.22, 0.46, -0.27, -0.18, 1.12, -0.23, wood, MAT.timber)
  m.box(0.18, 0.46, -0.27, 0.22, 1.12, -0.23, wood, MAT.timber)
  for (let i = 0; i < 5; i++) {
    const x = -0.12 + i * 0.06
    m.box(x - 0.008, 0.5, -0.26, x + 0.008, 1.05, -0.245, wood, MAT.timber)
  }
  m.box(-0.23, 1.05, -0.28, 0.23, 1.14, -0.22, hex(0x5d4330), MAT.timber)
  // Arm rests.
  m.box(-0.25, 0.68, -0.24, -0.2, 0.71, 0.18, wood, MAT.timber)
  m.box(0.2, 0.68, -0.24, 0.25, 0.71, 0.18, wood, MAT.timber)
  return m
}

/** A lit pane over a front window, `w` wide: glows in the instance's colour (accent). */
export function paneMesh(w: number): Mesh {
  const m = new Mesh()
  m.box(-w / 2 + 0.12, 0.98, 0.0, w / 2 - 0.12, 2.02, 0.012, hex(0xffc070), MAT.accent)
  return m
}

/** A bare, muddy footprint (left; `right` mirrors it), heel towards −z, toes towards +z. */
export function footprintMesh(right: boolean): Mesh {
  const m = new Mesh()
  const mud = hex(0x2b2118)
  const k = right ? -1 : 1
  discG(m, 0, -0.07, 0.042, 0.003, mud, 10)
  discG(m, 0.006 * k, 0.03, 0.05, 0.003, mud, 10)
  m.box(-0.03, 0.003, -0.07, 0.04, 0.006, 0.03, mud)
  const toes: readonly (readonly [number, number, number])[] = [[-0.032, 0.105, 0.016], [-0.01, 0.112, 0.012], [0.01, 0.11, 0.011], [0.027, 0.103, 0.01], [0.041, 0.092, 0.009]]
  for (const [x, z, r] of toes) discG(m, x * k, z, r, 0.0035, mud, 7)
  return m
}

/** A wall telephone, its handset hung on its left side, the cord cut short (the handset is a model of its own). */
export function phoneMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.08, -0.13, 0, 0.08, 0.13, 0.07, hex(0x6f6a5d), MAT.lit, 0, hex(0x7c7768))
  discV(m, 0.015, -0.01, 0.045, 0.071, hex(0xd8d2c0), MAT.lit, 14)
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 1.6 + 0.9
    discV(m, 0.015 + Math.cos(a) * 0.032, -0.01 + Math.sin(a) * 0.032, 0.006, 0.073, hex(0x2a2826), MAT.lit, 6)
  }
  // The cord: a few coils down from the handset's cradle, ending in nothing.
  for (let i = 0; i < 6; i++) m.box(-0.115, -0.15 - i * 0.04, 0.03, -0.095, -0.135 - i * 0.04, 0.05, hex(0x1f1d1b))
  m.box(-0.108, -0.4, 0.035, -0.102, -0.37, 0.045, hex(0x8a6a40))
  return m
}

export function handsetMesh(): Mesh {
  const m = new Mesh()
  const c = hex(0x5e594d)
  m.box(-0.02, -0.11, 0, 0.02, 0.11, 0.05, c, MAT.lit)
  m.box(-0.03, 0.08, 0, 0.03, 0.14, 0.06, c, MAT.lit)
  m.box(-0.03, -0.14, 0, 0.03, -0.08, 0.06, c, MAT.lit)
  return m
}

/** The cellar hatch's frame in the floor and the dark below it (drawn when open). */
export function hatchFrameMesh(): Mesh {
  const m = new Mesh()
  const wood = hex(0x3d2b1d)
  m.box(-0.55, 0, -0.55, 0.55, 0.03, -0.47, wood, MAT.timber)
  m.box(-0.55, 0, 0.47, 0.55, 0.03, 0.55, wood, MAT.timber)
  m.box(-0.55, 0, -0.47, -0.47, 0.03, 0.47, wood, MAT.timber)
  m.box(0.47, 0, -0.47, 0.55, 0.03, 0.47, wood, MAT.timber)
  return m
}

export function hatchHoleMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.47, 0.004, -0.47, 0.47, 0.012, 0.47, hex(0x050505), MAT.lit)
  // The top of a ladder going down.
  for (const x of [-0.2, 0.2]) m.box(x - 0.025, 0.012, -0.44, x + 0.025, 0.03, -0.3, hex(0x6b4f33), MAT.timber)
  m.box(-0.2, 0.013, -0.39, 0.2, 0.026, -0.36, hex(0x6b4f33), MAT.timber)
  return m
}

/** The lid, hinged along its north edge (z = −0.47): planks, battens, an iron ring. */
export function hatchLidMesh(): Mesh {
  const m = new Mesh()
  for (let i = 0; i < 5; i++) {
    const x0 = -0.47 + i * 0.188
    m.box(x0 + 0.004, 0, 0, x0 + 0.184, 0.035, 0.94, i % 2 ? hex(0x5a4129) : hex(0x634830), MAT.timber)
  }
  m.box(-0.47, 0.035, 0.15, 0.47, 0.05, 0.22, hex(0x3d2b1d), MAT.timber)
  m.box(-0.47, 0.035, 0.72, 0.47, 0.05, 0.79, hex(0x3d2b1d), MAT.timber)
  m.box(-0.04, 0.035, 0.86, 0.04, 0.06, 0.93, hex(0x2c2c2e), MAT.shiny)
  return m
}

/** A three-dial brass padlock on a hasp. */
export function padlockMesh(): Mesh {
  const m = new Mesh()
  const brass = hex(0xb08d3a)
  m.box(-0.06, 0, -0.025, 0.06, 0.05, 0.025, brass, MAT.shiny)
  m.box(-0.045, 0.05, -0.008, -0.03, 0.09, 0.008, hex(0x9a9ea2), MAT.shiny)
  m.box(0.03, 0.05, -0.008, 0.045, 0.09, 0.008, hex(0x9a9ea2), MAT.shiny)
  m.box(-0.045, 0.085, -0.008, 0.045, 0.095, 0.008, hex(0x9a9ea2), MAT.shiny)
  for (const x of [-0.035, 0, 0.035]) m.box(x - 0.013, 0.008, 0.024, x + 0.013, 0.042, 0.032, hex(0x2a2a2a), MAT.lit)
  return m
}

/** The radio man's set: a grey-green cabinet with a meter, a big dial window (glows green, accent) and knobs. */
export function setMesh(): Mesh {
  const m = new Mesh()
  const body = hex(0x4c5446)
  m.box(-0.26, 0, -0.15, 0.26, 0.3, 0.15, body, MAT.lit, 0, hex(0x56604f))
  m.box(-0.25, 0.02, 0.15, 0.25, 0.28, 0.16, hex(0x30352c), MAT.lit)
  m.box(-0.2, 0.15, 0.16, 0.04, 0.25, 0.17, hex(0x7cff9a), MAT.accent)
  m.box(-0.08, 0.3, -0.02, 0.12, 0.302, 0.12, hex(0x7cff9a), MAT.accent)
  m.box(0.08, 0.15, 0.16, 0.2, 0.25, 0.168, hex(0xd8d2b0), MAT.lit)
  for (const x of [-0.17, -0.07, 0.03, 0.15]) m.prism(x, 0.17, 0.022, 0.022, 0.05, 0.1, 10, hex(0x1d1d1d), MAT.shiny)
  // A key and a headset beside it.
  m.box(0.3, 0, 0.02, 0.4, 0.03, 0.09, hex(0x2a2a2a), MAT.lit)
  m.box(0.33, 0.03, 0.04, 0.37, 0.05, 0.07, hex(0x8a8a8a), MAT.shiny)
  return m
}

/** His notebook page, lying on the table: pencil drawing of the lock and the three things over its dials. */
export function pageMesh(): Mesh {
  const m = new Mesh()
  m.box(-0.11, 0, -0.14, 0.11, 0.003, 0.14, hex(0xe9e3cf), MAT.lit)
  const pencil = hex(0x55534d)
  // Three little boxes in a row (the dials) with marks above, as top-down strokes.
  for (const x of [-0.06, 0, 0.06]) {
    m.box(x - 0.022, 0.003, 0.02, x + 0.022, 0.0045, 0.024, pencil)
    m.box(x - 0.022, 0.003, 0.06, x + 0.022, 0.0045, 0.064, pencil)
    m.box(x - 0.022, 0.003, 0.02, x - 0.018, 0.0045, 0.064, pencil)
    m.box(x + 0.018, 0.003, 0.02, x + 0.022, 0.0045, 0.064, pencil)
    m.box(x - 0.015, 0.003, -0.05, x + 0.015, 0.0045, -0.02, pencil)
  }
  for (let i = 0; i < 4; i++) m.box(-0.09, 0.003, 0.09 + i * 0.012, 0.06 - i * 0.02, 0.0042, 0.093 + i * 0.012, hex(0x8a877e))
  return m
}

/** His mast: a three-legged lattice tower with an antenna at the top. */
export function mastMesh(): Mesh {
  const m = new Mesh()
  const steel = hex(0x8c8f8a)
  const h = 7.5
  const legs: readonly (readonly [number, number])[] = [[-0.18, -0.12], [0.18, -0.12], [0, 0.2]]
  for (const [x, z] of legs) m.box(x - 0.015, 0, z - 0.015, x + 0.015, h, z + 0.015, steel, MAT.shiny)
  for (let y = 0.4; y < h; y += 0.6) {
    for (let i = 0; i < 3; i++) {
      const [ax, az] = legs[i]!
      const [bx, bz] = legs[(i + 1) % 3]!
      const from = m.v.length
      const len = Math.hypot(bx - ax, bz - az)
      m.box(-len / 2, -0.008, -0.008, len / 2, 0.008, 0.008, steel, MAT.shiny)
      rotY(m, from, Math.atan2(bz - az, bx - ax), (ax + bx) / 2, y, (az + bz) / 2)
    }
  }
  m.box(-0.01, h, -0.01, 0.01, h + 1.4, 0.01, steel, MAT.shiny)
  m.box(-0.7, h + 0.9, -0.01, 0.7, h + 0.92, 0.01, steel, MAT.shiny)
  m.box(-0.5, h + 1.2, -0.01, 0.5, h + 1.22, 0.01, steel, MAT.shiny)
  // Guy wires to stakes are too thin to read; a concrete pad grounds it.
  m.box(-0.35, 0, -0.3, 0.35, 0.06, 0.35, hex(0x6e6c66), MAT.lit)
  return m
}
