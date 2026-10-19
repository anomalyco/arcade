import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { DETAIL_MODELS, LETTER_ADVANCE, MARK_X_SIZE, WORDS, type DetailModel } from "./placement"

/**
 * Low-poly meshes for the world details, one per `DETAIL_MODELS` entry. Every piece is built at the instance origin on
 * the ground (wall marks: bottom centre on the wall face, facing +Z). Matte materials only (lit, timber, brick and a
 * little shiny metal), muted pigments: the look keeps colour for what light falls on, so nothing here glows or glints.
 */

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

/** A wooden dining chair standing, back to -Z; 0.22 m from centre to the back and to each side (see `CHAIR_DOWN_LIFT`). */
function chair(m: Mesh): void {
  const wood = hex(0x3a2616), seat = hex(0x4a3020), dark = hex(0x24160c)
  for (const x of [-0.18, 0.18]) for (const z of [-0.18, 0.18]) m.box(x - 0.025, 0, z - 0.025, x + 0.025, 0.43, z + 0.025, dark, MAT.timber)
  m.box(-0.21, 0.43, -0.21, 0.21, 0.475, 0.21, wood, MAT.timber, 0, seat)
  for (const x of [-0.18, 0.18]) m.box(x - 0.025, 0.475, -0.22, x + 0.025, 0.95, -0.17, dark, MAT.timber)
  m.box(-0.2, 0.78, -0.22, 0.2, 0.93, -0.18, wood, MAT.timber)
  m.box(-0.2, 0.6, -0.215, 0.2, 0.65, -0.185, wood, MAT.timber)
  // Stretchers between the legs.
  m.box(-0.17, 0.12, -0.19, 0.17, 0.15, -0.17, dark, MAT.timber)
  m.box(-0.17, 0.12, 0.17, 0.17, 0.15, 0.19, dark, MAT.timber)
}

function crockery(m: Mesh): void {
  const china = hex(0x9a958a), rim = hex(0x5a6a7a), dark = hex(0x2a2622)
  // A plate in shards, a saucer whole, a cup on its side and a fork.
  const shards: [number, number, number, number, number][] = [
    [0, 0, 0.12, 0.09, 0.2], [0.11, 0.05, 0.08, 0.07, -0.7], [-0.08, 0.09, 0.07, 0.05, 1.1], [0.05, -0.1, 0.06, 0.05, 0.5], [-0.12, -0.06, 0.05, 0.04, -1.3], [0.2, -0.04, 0.04, 0.03, 0.9],
  ]
  for (const [x, z, w, d, a] of shards) m.yawBox(x, z, w, d, 0, 0.012, a, china, MAT.lit, 0, china)
  m.yawBox(0.02, 0.01, 0.1, 0.012, 0.012, 0.016, 0.2, rim, MAT.lit)
  m.prism(-0.22, 0.14, 0.08, 0.08, 0, 0.012, 10, china, MAT.lit)
  m.prism(-0.22, 0.14, 0.05, 0.05, 0.012, 0.015, 10, rim, MAT.lit)
  m.yawBox(0.18, 0.16, 0.09, 0.07, 0, 0.07, 0.6, china, MAT.lit, 0, hex(0xa8a296))
  m.yawBox(0.22, 0.19, 0.06, 0.04, 0.005, 0.065, 0.6, dark, MAT.lit)
  m.yawBox(-0.02, -0.2, 0.17, 0.018, 0, 0.008, -0.3, hex(0x6e6e6a), MAT.shiny)
}

function mail(m: Mesh): void {
  const env = [hex(0x9a9282), hex(0x8c8474), hex(0x7e6e58), hex(0xa09886)]
  const pieces: [number, number, number][] = [[0, 0, 0.3], [0.06, 0.05, -0.4], [-0.08, 0.07, 0.9], [0.12, -0.07, 1.4], [-0.1, -0.06, -0.9], [0.02, 0.12, 0.1]]
  pieces.forEach(([x, z, a], i) => m.yawBox(x, z, 0.22, 0.11, i * 0.003, i * 0.003 + 0.004, a, env[i % env.length]!, MAT.lit))
  // A folded newspaper in its rubber band.
  m.yawBox(-0.2, 0.02, 0.3, 0.2, 0, 0.022, -0.2, hex(0x7a766c), MAT.lit, 0, hex(0x86827a))
  m.yawBox(-0.22, -0.02, 0.16, 0.05, 0.022, 0.024, -0.2, hex(0x34322e), MAT.lit)
  m.yawBox(-0.2, 0.02, 0.025, 0.205, 0.022, 0.026, -0.2, hex(0x5a2a1e), MAT.lit)
}

const CARD = hex(0x5e4a32), CARD_TOP = hex(0x6c563a), TAPE = hex(0x8a7c5c)

function carton(m: Mesh, x: number, z: number, w: number, d: number, y0: number, h: number, yaw: number): void {
  m.yawBox(x, z, w, d, y0, y0 + h, yaw, CARD, MAT.lit, 0, CARD_TOP)
  m.yawBox(x, z, 0.06, d + 0.004, y0 + h, y0 + h + 0.003, yaw, TAPE, MAT.lit)
}

function boxes(m: Mesh, three: boolean): void {
  if (three) {
    carton(m, -0.17, 0, 0.34, 0.38, 0, 0.36, 0.04)
    carton(m, 0.19, 0.02, 0.36, 0.36, 0, 0.32, -0.06)
    carton(m, 0.0, -0.01, 0.4, 0.34, 0.36, 0.3, 0.18)
  } else {
    carton(m, 0, 0, 0.5, 0.4, 0, 0.38, 0)
    carton(m, 0.02, -0.01, 0.42, 0.34, 0.38, 0.3, -0.22)
  }
}

function books(m: Mesh): void {
  const covers = [0x4a1e18, 0x1e3426, 0x3a2a18, 0x22283a, 0x5a4626, 0x2e1a20]
  const lay: [number, number, number, number][] = [[0, 0, 0.3, 0], [0.18, 0.08, -0.6, 0], [-0.16, 0.1, 1.2, 0], [0.06, -0.15, 2.0, 0], [-0.04, 0.02, 0.9, 0.035], [0.22, -0.12, 0.2, 0]]
  lay.forEach(([x, z, a, y], i) => m.yawBox(x, z, 0.2, 0.15, y, y + 0.032, a, hex(covers[i % covers.length]!), MAT.lit))
  // One open, face down on its pages, and loose sheets.
  m.yawBox(-0.22, -0.12, 0.28, 0.2, 0, 0.012, -0.4, hex(0x8c8678), MAT.lit)
  m.yawBox(-0.22, -0.12, 0.3, 0.21, 0.012, 0.02, -0.4, hex(0x3a1c14), MAT.lit)
  m.yawBox(0.3, 0.15, 0.21, 0.15, 0, 0.004, 0.7, hex(0x8e897c), MAT.lit)
}

function drawer(m: Mesh): void {
  const wood = hex(0x3a2818), inside = hex(0x24180e)
  // Pulled out and dumped upside down: the bottom up, the front panel to +Z, its contents spilled round it.
  m.box(-0.26, 0, -0.2, 0.26, 0.13, 0.2, wood, MAT.timber, 0, inside)
  m.box(-0.29, 0, 0.2, 0.29, 0.16, 0.235, hex(0x4a3220), MAT.timber)
  m.box(-0.03, 0.06, 0.235, 0.03, 0.09, 0.26, hex(0x7a6a46), MAT.shiny)
  const spill: [number, number, number, number, number, number][] = [
    [0.36, 0.05, 0.22, 0.16, 0.6, 0x5a3a36], [-0.38, 0.1, 0.2, 0.18, -0.4, 0x3e4a5a], [0.1, 0.36, 0.24, 0.14, 1.2, 0x6a6458], [-0.2, 0.34, 0.12, 0.09, 0.3, 0x8c867a],
  ]
  for (const [x, z, w, d, a, c] of spill) m.yawBox(x, z, w, d, 0, 0.03, a, hex(c), MAT.lit)
}

/** A wheelie bin facing +Z (wheels and handle at the back), `lid` lifts and tilts its lid. */
function wheelieBin(m: Mesh, x: number, body: Rgb, lidCol: Rgb, open: boolean): void {
  m.box(x - 0.28, 0.04, -0.34, x + 0.28, 0.98, 0.34, body, MAT.lit, 0, hex(0x141618))
  m.box(x - 0.29, 0.2, 0.33, x + 0.29, 0.26, 0.36, body, MAT.lit)
  for (const s of [-0.22, 0.22]) m.box(x + s - 0.04, 0, -0.42, x + s + 0.04, 0.16, -0.3, hex(0x101214), MAT.lit)
  m.box(x - 0.24, 0.92, -0.42, x + 0.24, 0.97, -0.36, lidCol, MAT.lit)
  if (open) {
    // Lid propped on a full bag.
    m.box(x - 0.3, 1.12, -0.36, x + 0.3, 1.16, 0.38, lidCol, MAT.lit)
    m.prism(x, 0.02, 0.24, 0.16, 0.95, 1.13, 7, hex(0x15181c), MAT.lit, 0, true, 0.3)
  } else m.box(x - 0.3, 0.98, -0.36, x + 0.3, 1.02, 0.38, lidCol, MAT.lit)
}

function bins(m: Mesh, bags: boolean): void {
  wheelieBin(m, -0.32, hex(0x1e2c22), hex(0x243426), bags)
  wheelieBin(m, 0.32, hex(0x26292c), hex(0x2c3034), false)
  if (bags) {
    m.prism(-0.25, 0.68, 0.24, 0.16, 0, 0.36, 7, hex(0x16191c), MAT.lit, 0, true, 0.2)
    m.prism(0.22, 0.62, 0.2, 0.13, 0, 0.3, 6, hex(0x1c2226), MAT.lit, 0, true, 1.1)
    m.yawBox(0.5, 0.78, 0.12, 0.08, 0, 0.05, 0.6, hex(0x6a2a22), MAT.lit)
    m.yawBox(-0.02, 0.9, 0.24, 0.16, 0, 0.006, -0.4, hex(0x7a7468), MAT.lit)
  }
}

function dumpster(m: Mesh): void {
  const body = hex(0x24342a), rust = hex(0x4a2e1e), lid = hex(0x1a1e20)
  m.box(-0.95, 0.12, -0.55, 0.95, 1.15, 0.55, body, MAT.lit, 0, hex(0x0e1012))
  m.box(-0.97, 0.12, 0.53, 0.97, 0.3, 0.58, rust, MAT.lit)
  m.box(-0.97, 0.95, 0.53, 0.97, 1.05, 0.58, hex(0x2e4234), MAT.lit)
  for (const x of [-0.8, 0.8]) for (const z of [-0.42, 0.42]) m.box(x - 0.06, 0, z - 0.06, x + 0.06, 0.12, z + 0.06, hex(0x101214), MAT.lit)
  // One lid closed, the other thrown back against the wall, the bin overflowing.
  m.box(-0.96, 1.15, -0.56, 0, 1.2, 0.56, lid, MAT.lit)
  m.box(0, 1.15, -0.66, 0.96, 1.95, -0.6, lid, MAT.lit)
  for (const [x, z, r, h, a] of [[0.35, 0.1, 0.3, 0.32, 0.4], [0.7, -0.2, 0.24, 0.26, 1.3], [0.3, -0.3, 0.22, 0.24, 2.1]] as const) m.prism(x, z, r, r * 0.7, 1.1, 1.1 + h, 7, hex(0x16191c), MAT.lit, 0, true, a)
  m.prism(1.25, 0.25, 0.26, 0.17, 0, 0.36, 7, hex(0x1a1e22), MAT.lit, 0, true, 0.7)
  m.yawBox(0.6, 0.0, 0.5, 0.36, 1.2, 1.26, 0.3, hex(0x5a4630), MAT.lit)
}

function mailbox(m: Mesh): void {
  m.box(-0.045, 0, -0.045, 0.045, 1.0, 0.045, hex(0x3a3026), MAT.timber)
  m.box(-0.12, 0.98, -0.2, 0.12, 1.02, 0.2, hex(0x3a3026), MAT.timber)
  m.bevelBox(-0.11, 1.02, -0.24, 0.11, 1.22, 0.24, 0.05, hex(0x2c3034), hex(0x3a3e42), MAT.lit)
  m.box(-0.1, 1.03, 0.24, 0.1, 1.2, 0.255, hex(0x23272a), MAT.lit)
  // The flag, up: there is still mail inside.
  m.box(0.11, 1.12, -0.1, 0.13, 1.36, -0.07, hex(0x6a1c14), MAT.lit)
  m.box(0.11, 1.28, -0.07, 0.13, 1.36, 0.06, hex(0x6a1c14), MAT.lit)
}

function suitcase(m: Mesh, open: boolean): void {
  const shell = hex(0x3e2c20), edge = hex(0x2a1e16), lining = hex(0x5a3e3a)
  if (!open) {
    m.bevelBox(-0.35, 0, -0.24, 0.35, 0.22, 0.24, 0.03, shell, hex(0x4a3628), MAT.lit)
    m.box(-0.36, 0.1, -0.25, 0.36, 0.12, 0.25, edge, MAT.lit)
    m.box(-0.08, 0.06, 0.24, 0.08, 0.16, 0.29, hex(0x1a1410), MAT.lit)
    for (const x of [-0.2, 0.2]) m.box(x - 0.02, 0.22, -0.245, x + 0.02, 0.225, 0.245, hex(0x2a221a), MAT.lit)
    // A holdall dropped beside it.
    m.prism(0.15, -0.5, 0.17, 0.15, 0, 0.2, 8, hex(0x262c30), MAT.lit, 0, true, 0.3)
    return
  }
  m.box(-0.35, 0, -0.24, 0.35, 0.11, 0.24, shell, MAT.lit, 0, lining)
  m.box(-0.35, 0, 0.26, 0.35, 0.05, 0.74, shell, MAT.lit, 0, lining)
  const clothes: [number, number, number, number, number, number][] = [
    [0, 0, 0.5, 0.32, 0.2, 0x6a5e4e], [-0.15, 0.05, 0.3, 0.22, -0.3, 0x3e4656], [0.42, -0.2, 0.34, 0.2, 0.9, 0x5a2e2a], [-0.5, 0.3, 0.28, 0.18, -0.8, 0x7a7466], [0.1, 0.5, 0.26, 0.2, 0.4, 0x2e3e34],
  ]
  for (const [x, z, w, d, a, c] of clothes) m.yawBox(x, z, w, d, x === 0 && z === 0 ? 0.11 : 0.05, (x === 0 && z === 0 ? 0.11 : 0.05) + 0.03, a, hex(c), MAT.lit)
}

function bike(m: Mesh): void {
  // Lying on its left side: wheels flat on the ground along X, the frame and bars just above them.
  const tyre = hex(0x121416), rim = hex(0x4a4c50), frame = hex(0x5a241c)
  for (const x of [-0.52, 0.52]) {
    m.prism(x, 0, 0.34, 0.34, 0, 0.035, 14, tyre, MAT.lit)
    m.prism(x, 0, 0.29, 0.29, 0.035, 0.04, 14, rim, MAT.lit)
    m.prism(x, 0, 0.05, 0.05, 0.04, 0.06, 6, rim, MAT.shiny)
  }
  const tube = (x0: number, z0: number, x1: number, z1: number, y = 0.07) => {
    const len = Math.hypot(x1 - x0, z1 - z0)
    m.yawBox((x0 + x1) / 2, (z0 + z1) / 2, len, 0.04, y - 0.02, y + 0.02, Math.atan2(z1 - z0, x1 - x0), frame, MAT.lit)
  }
  tube(-0.52, 0, -0.08, 0.02)
  tube(-0.08, 0.02, 0.3, -0.42)
  tube(-0.08, 0.02, -0.18, -0.46)
  tube(-0.18, -0.46, 0.3, -0.42)
  tube(0.3, -0.42, 0.52, 0)
  tube(-0.52, 0, -0.18, -0.46)
  // Saddle, bars and a pedal.
  m.yawBox(-0.22, -0.55, 0.24, 0.1, 0.06, 0.11, 0.1, hex(0x18140f), MAT.lit)
  m.yawBox(0.38, -0.52, 0.06, 0.46, 0.08, 0.12, 0.2, hex(0x5a5c60), MAT.shiny)
  m.prism(-0.08, 0.02, 0.09, 0.09, 0.05, 0.09, 8, hex(0x2a2c30), MAT.lit)
}

function pram(m: Mesh): void {
  // Tipped on its side: the bassinet's open top faces +Z, the hood folded over one end, wheels sticking out.
  const body = hex(0x1e2430), trim = hex(0x6a6458), wheel = hex(0x14161a)
  m.bevelBox(-0.38, 0, -0.24, 0.32, 0.34, 0.22, 0.05, body, hex(0x262e3c), MAT.lit)
  m.box(-0.36, 0.02, 0.21, 0.3, 0.32, 0.24, hex(0x0e1014), MAT.lit)
  m.bevelBox(0.18, 0, -0.26, 0.5, 0.4, 0.24, 0.08, hex(0x252c3a), hex(0x2c3444), MAT.lit)
  m.box(-0.4, 0.15, -0.25, 0.34, 0.18, -0.22, trim, MAT.lit)
  for (const x of [-0.3, 0.3]) for (const z of [-0.42, 0.06]) m.box(x - 0.11, 0.0, z - 0.03, x + 0.11, 0.22, z + 0.03, wheel, MAT.lit)
  m.box(-0.75, 0.05, -0.32, -0.38, 0.08, -0.28, hex(0x4a4c50), MAT.shiny)
  m.box(-0.78, 0.04, -0.34, -0.74, 0.09, 0.02, hex(0x1a1a1a), MAT.lit)
  // A blanket spilled out of it.
  m.yawBox(0.05, 0.42, 0.38, 0.26, 0, 0.02, 0.4, hex(0x6a5a5a), MAT.lit)
}

function cone(m: Mesh): void {
  m.box(-0.18, 0, -0.18, 0.18, 0.035, 0.18, hex(0x1a1a1a), MAT.lit)
  m.prism(0, 0, 0.15, 0.05, 0.035, 0.66, 10, hex(0x8a3a14), MAT.lit)
  m.prism(0, 0, 0.115, 0.09, 0.3, 0.4, 10, hex(0x9a968a), MAT.lit, 0, false)
  m.prism(0, 0, 0.054, 0.045, 0.62, 0.7, 8, hex(0x8a3a14), MAT.lit)
}

const TAPE_YELLOW = hex(0x9c8414), TAPE_STRIPE = hex(0x1a1814)

/** One metre of police tape along +X from the origin, sagging in the middle (the instance scale stretches it). */
function tape(m: Mesh): void {
  const n = 6
  for (let k = 0; k < n; k++) {
    const x0 = k / n
    const x1 = (k + 1) / n
    const y = -0.07 * Math.sin((Math.PI * (k + 0.5)) / n)
    m.box(x0, y - 0.014, -0.028, x1 + 0.005, y + 0.006, 0.028, TAPE_YELLOW, MAT.lit)
    if (k % 2 === 0) m.box(x0 + 0.05, y + 0.006, -0.012, x0 + 0.1, y + 0.008, 0.012, TAPE_STRIPE, MAT.lit)
  }
}

/** A snapped end of tape: down from a cone top (0.66 m) to the ground along +X, then trailing on the road. */
function tapeTail(m: Mesh): void {
  const steps = 5
  for (let k = 0; k < steps; k++) {
    const y = 0.62 - (k + 0.5) * (0.62 / steps)
    m.box(0.02 + k * 0.05, y - 0.07, -0.026, 0.07 + k * 0.05, y + 0.07, 0.026, TAPE_YELLOW, MAT.lit)
  }
  m.yawBox(0.5, 0.03, 0.5, 0.055, 0.004, 0.012, 0.25, TAPE_YELLOW, MAT.lit)
  m.yawBox(0.92, 0.16, 0.4, 0.055, 0.004, 0.012, 0.6, TAPE_YELLOW, MAT.lit)
}

/** A paint stroke from (x0, y0) to (x1, y1) on the wall plane, a hair off the face. */
function stroke(m: Mesh, x0: number, y0: number, x1: number, y1: number, half: number, col: Rgb): void {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1
  const dx = (x1 - x0) / len
  const dy = (y1 - y0) / len
  const ax = x0 - dx * half * 0.6, ay = y0 - dy * half * 0.6
  const bx = x1 + dx * half * 0.6, by = y1 + dy * half * 0.6
  const nx = -dy * half, ny = dx * half
  m.quad([ax - nx, ay - ny, 0.004], [bx - nx, by - ny, 0.004], [bx + nx, by + ny, 0.004], [ax + nx, ay + ny, 0.004], [0, 0, 1], col, MAT.lit)
}

/** Stroke font on a 2 × 4 grid (x right, y up). */
const FONT: Record<string, readonly (readonly [number, number, number, number])[]> = {
  A: [[0, 0, 1, 4], [1, 4, 2, 0], [0.5, 1.8, 1.5, 1.8]],
  D: [[0, 0, 0, 4], [0, 4, 1.3, 4], [1.3, 4, 2, 3], [2, 3, 2, 1], [2, 1, 1.3, 0], [1.3, 0, 0, 0]],
  E: [[0, 0, 0, 4], [0, 4, 2, 4], [0, 2, 1.5, 2], [0, 0, 2, 0]],
  G: [[2, 4, 0, 4], [0, 4, 0, 0], [0, 0, 2, 0], [2, 0, 2, 2], [2, 2, 1, 2]],
  H: [[0, 0, 0, 4], [2, 0, 2, 4], [0, 2, 2, 2]],
  I: [[1, 0, 1, 4]],
  K: [[0, 0, 0, 4], [0, 2, 2, 4], [0.6, 2.5, 2, 0]],
  L: [[0, 4, 0, 0], [0, 0, 2, 0]],
  N: [[0, 0, 0, 4], [0, 4, 2, 0], [2, 0, 2, 4]],
  O: [[0, 0, 0, 4], [0, 4, 2, 4], [2, 4, 2, 0], [2, 0, 0, 0]],
  P: [[0, 0, 0, 4], [0, 4, 2, 4], [2, 4, 2, 2], [2, 2, 0, 2]],
  S: [[2, 4, 0, 4], [0, 4, 0, 2], [0, 2, 2, 2], [2, 2, 2, 0], [2, 0, 0, 0]],
  T: [[0, 4, 2, 4], [1, 4, 1, 0]],
  U: [[0, 4, 0, 0], [0, 0, 2, 0], [2, 0, 2, 4]],
}

/** Hand-sprayed words: each letter drifts and leans a little (fixed per letter, so every client sees the same). */
export function sprayWord(m: Mesh, text: string, height: number, col: Rgb): void {
  const u = height / 4
  const width = (text.length * LETTER_ADVANCE - 0.22) * height
  const half = u * 0.26
  let x = -width / 2
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const strokes = FONT[ch]
    const lean = Math.sin(i * 2.3 + text.length) * 0.08
    const lift = Math.sin(i * 1.7) * u * 0.25
    if (strokes) {
      for (const [a, b, c, d] of strokes) stroke(m, x + (a + b * lean) * u, b * u + lift, x + (c + d * lean) * u, d * u + lift, half, col)
      // A drip under the lowest stroke of some letters.
      if (i % 3 === 1) stroke(m, x + u, lift, x + u * 1.05, lift - u * (0.7 + (i % 2) * 0.5), half * 0.45, col)
    }
    x += LETTER_ADVANCE * height
  }
}

/** The search mark: a big X with a tally and a zero in its quadrants. */
function markX(m: Mesh): void {
  const s = MARK_X_SIZE
  const col = hex(0x8a3412)
  stroke(m, -s / 2, 0, s / 2, s, 0.035, col)
  stroke(m, -s / 2, s, s / 2, 0, 0.035, col)
  stroke(m, -0.07, s * 0.82, 0.07, s * 0.82, 0.018, col)
  for (const x of [-s * 0.38, -s * 0.31]) stroke(m, x, s * 0.42, x, s * 0.58, 0.016, col)
  const o = s * 0.08
  stroke(m, -o, s * 0.08, o, s * 0.08, 0.016, col)
  stroke(m, o, s * 0.08, o, s * 0.24, 0.016, col)
  stroke(m, o, s * 0.24, -o, s * 0.24, 0.016, col)
  stroke(m, -o, s * 0.24, -o, s * 0.08, 0.016, col)
  stroke(m, s * 0.1, -0.02, s * 0.12, -0.16, 0.012, col)
}

const WORD_COLOURS = [0x7a1a12, 0x6e6a5c, 0x7a1a12, 0x8a3412, 0x7a1a12, 0x6e6a5c]

/** Builds every detail mesh, in `DETAIL_MODELS` order. */
export function buildDetailMeshes(): Mesh[] {
  const out: Mesh[] = []
  for (const id of DETAIL_MODELS) {
    const m = new Mesh()
    buildModel(m, id)
    out.push(m)
  }
  return out
}

function buildModel(m: Mesh, id: DetailModel): void {
  switch (id) {
    case "chair": return chair(m)
    case "crockery": return crockery(m)
    case "mail": return mail(m)
    case "boxes2": return boxes(m, false)
    case "boxes3": return boxes(m, true)
    case "books": return books(m)
    case "drawer": return drawer(m)
    case "bins": return bins(m, false)
    case "binsBags": return bins(m, true)
    case "dumpster": return dumpster(m)
    case "mailbox": return mailbox(m)
    case "suitcase": return suitcase(m, false)
    case "suitcaseOpen": return suitcase(m, true)
    case "bike": return bike(m)
    case "pram": return pram(m)
    case "cone": return cone(m)
    case "tape": return tape(m)
    case "tapeTail": return tapeTail(m)
    case "markX": return markX(m)
    default: {
      const i = WORDS.findIndex((w) => w.model === id)
      const w = WORDS[i]!
      return sprayWord(m, w.text, w.height, hex(WORD_COLOURS[i % WORD_COLOURS.length]!))
    }
  }
}
