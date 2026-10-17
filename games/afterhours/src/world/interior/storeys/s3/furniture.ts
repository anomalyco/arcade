import * as THREE from "three/webgpu"
import { type Builder, type Mat, FLOOR_Y, M, T, paint } from "../../api"
import { F, OFFWHITE, PUTTY, BLACK, pt, sub } from "./equipment"

// Storey 3's procedural furniture (carrels, lateral files, steel work tables, counters, card catalogue) and the small
// props that tell its story (mugs, ashtrays, card decks, printout stacks). Same frame convention as equipment.ts.

const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0) => b.collideLocal(m, [ox - w / 2, 0, oz - d / 2], [ox + w / 2, h, oz + d / 2])
const PANEL = paint(0x6a6658, 0.92)
const PANEL_TRIM = paint(0x3a3832, 0.45, 0.4)
const STEEL_DESK = paint(0x7c8078, 0.5, 0.35)
const LATERAL = paint(0x8c8676, 0.5, 0.3)
const MUG = paint(0xc8c0a8, 0.3)
const COFFEE = paint(0x1a0e06, 0.15)
export const GREENBAR = paint(0xc8d4bc, 0.9)

/** Steel work table (length along local x): laminate top on a steel apron and square legs. Top at 0.74. */
export function workTable(b: Builder, x: number, z: number, yaw: number, length = 1.8, depth = 0.76, top: Mat = M.laminateTop) {
  const m = F(x, z, yaw)
  b.rbox(top, m, length, 0.03, depth, 0.008, 0, 0.725, 0)
  b.boxM(STEEL_DESK, m, length - 0.08, 0.08, depth - 0.08, 0, 0.67, 0)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(STEEL_DESK, m, 0.04, 0.63, 0.04, sx * (length / 2 - 0.06), 0.315, sz * (depth / 2 - 0.06))
  coll(b, m, length, 0.74, depth)
  return FLOOR_Y + 0.74
}

/** Terminal carrel: worksurface with 1.3 m fabric side and back screens (back at +Z), a cable grommet. Top 0.73. */
export function carrel(b: Builder, x: number, z: number, yaw: number, w = 1.0, d = 0.75) {
  const m = F(x, z, yaw)
  b.rbox(M.laminateTop, m, w - 0.06, 0.03, d - 0.02, 0.006, 0, 0.715, 0)
  b.rbox(PANEL, m, w, 1.3, 0.05, 0.008, 0, 0.65, d / 2 - 0.025)
  b.boxM(PANEL_TRIM, m, w + 0.01, 0.02, 0.06, 0, 1.31, d / 2 - 0.025)
  for (const s of [-1, 1]) {
    b.rbox(PANEL, m, 0.04, 1.3, d, 0.008, s * (w / 2 - 0.02), 0.65, 0)
    b.boxM(PANEL_TRIM, m, 0.05, 0.02, d + 0.01, s * (w / 2 - 0.02), 1.31, 0)
  }
  b.cyl(BLACK, sub(m, w / 2 - 0.15, 0.731, d / 2 - 0.1), 0.03, 0.03, 0.004, 12)
  b.collideLocal(m, [-w / 2, 0, d / 2 - 0.05], [w / 2, 1.32, d / 2])
  for (const s of [-1, 1]) b.collideLocal(m, [s * (w / 2) - 0.02, 0, -d / 2], [s * (w / 2) + 0.02, 1.32, d / 2])
  b.collideLocal(m, [-w / 2, 0.6, -d / 2], [w / 2, 0.74, d / 2])
  return FLOOR_Y + 0.73
}

/** Two-drawer lateral file (0.92 × 0.72 × 0.46), front −Z: the half-height cabinets that edge the bullpen. */
export function lateralFile(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(LATERAL, m, 0.92, 0.72, 0.46, 0.012, 0, 0.36, 0)
  b.boxM(M.rubber, m, 0.88, 0.05, 0.42, 0, 0.025, 0)
  for (const y of [0.24, 0.56]) {
    b.boxM(M.darkSteel, m, 0.88, 0.004, 0.004, 0, y + 0.14, -0.231, { cast: false })
    b.boxM(M.steel, m, 0.22, 0.02, 0.025, 0, y + 0.06, -0.24)
    b.boxM(M.paper, m, 0.08, 0.04, 0.003, 0, y + 0.1, -0.232, { cast: false })
  }
  coll(b, m, 0.92, 0.72, 0.46)
  return FLOOR_Y + 0.72
}

/** Service counter (length along local x, customer side −Z): laminate top over a solid modesty front, shelf behind. */
export function counter(b: Builder, x: number, z: number, yaw: number, length: number) {
  const m = F(x, z, yaw)
  b.rbox(M.laminate, m, length, 1.0, 0.1, 0.01, 0, 0.5, -0.25)
  b.rbox(M.laminateTop, m, length + 0.04, 0.035, 0.66, 0.008, 0, 1.03, -0.03)
  b.boxM(M.laminate, m, length - 0.1, 0.03, 0.45, 0, 0.72, 0.05)
  for (const s of [-1, 1]) b.boxM(M.laminate, m, 0.04, 1.0, 0.6, s * (length / 2 - 0.02), 0.5, 0)
  coll(b, m, length + 0.04, 1.05, 0.66, 0, -0.03)
  return FLOOR_Y + 1.05
}

/** Card catalogue: a wooden cabinet of 6 × 5 small drawers on legs. */
export function cardCatalogue(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(M.wood, m, 0.9, 0.8, 0.5, 0.01, 0, 0.75, 0)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(M.wood, m, 0.04, 0.35, 0.04, sx * 0.4, 0.175, sz * 0.2)
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 5; j++) {
      const u = -0.375 + i * 0.15
      const v = 0.42 + j * 0.15
      b.boxM(M.veneerDark, m, 0.004, 0.004, 0.004, u + 0.075, v + 0.075, -0.251, { cast: false })
      b.boxM(M.steel, m, 0.03, 0.012, 0.012, u, v + 0.04, -0.256)
      b.boxM(M.paper, m, 0.04, 0.018, 0.002, u, v + 0.08, -0.251, { cast: false })
    }
  coll(b, m, 0.9, 1.15, 0.5)
}

/** Coffee mug (a little coffee left in it) at a surface point. */
export function mug(b: Builder, x: number, y: number, z: number) {
  b.cyl(MUG, T(x, y + 0.048, z), 0.04, 0.038, 0.095, 14, { open: true })
  b.cyl(MUG, T(x, y + 0.003, z), 0.038, 0.038, 0.006, 14)
  b.cyl(COFFEE, T(x, y + 0.05, z), 0.037, 0.037, 0.004, 14, { cast: false })
  const h = new THREE.TorusGeometry(0.025, 0.006, 6, 10, Math.PI)
  h.applyMatrix4(T(x + 0.04, y + 0.05, z, 0, 0, -Math.PI / 2))
  b.add(MUG, h, { cast: false })
}

/** Glass ashtray with a few butts. */
export function ashtray(b: Builder, x: number, y: number, z: number, rnd: () => number) {
  b.cyl(M.glass as unknown as Mat, T(x, y + 0.015, z), 0.06, 0.055, 0.03, 16)
  for (let k = 0; k < 3; k++) b.rod(M.paper, [x + (rnd() - 0.5) * 0.06, y + 0.032, z + (rnd() - 0.5) * 0.06], [x + (rnd() - 0.5) * 0.1, y + 0.035, z + (rnd() - 0.5) * 0.1], 0.004, 5)
}

/** A deck of punched cards (rubber-banded) or a tray of them. */
export function cardDeck(b: Builder, x: number, y: number, z: number, yaw: number, h = 0.04) {
  const m = T(x, y, z, yaw)
  b.boxM(paint(0xcbb98e, 0.85), m, 0.19, h, 0.083, 0, h / 2, 0, { cast: false })
  b.boxM(paint(0x8a2a1a, 0.6), m, 0.006, h + 0.002, 0.085, 0.05, h / 2, 0, { cast: false })
}

/** Stack of fan-fold green-bar printout on a surface. */
export function printoutStack(b: Builder, x: number, y: number, z: number, yaw: number, h = 0.06) {
  const m = T(x, y, z, yaw)
  b.boxM(GREENBAR, m, 0.38, h, 0.28, 0, h / 2, 0, { cast: false })
  b.boxM(M.paper, m, 0.381, 0.004, 0.281, 0, h + 0.002, 0, { cast: false })
}

/** Acoustic wall panel (perforated, on a timber frame), back on the wall at +Z. */
export function acousticPanel(b: Builder, x: number, z: number, yaw: number, w: number, h: number, y0 = 0.3) {
  const m = F(x, z, yaw)
  b.rbox(M.wood, m, w, h, 0.05, 0.006, 0, y0 + h / 2, 0)
  b.boxM(M.perf, m, w - 0.06, h - 0.06, 0.006, 0, y0 + h / 2, -0.026, { cast: false })
}

/** Operator's console desk (length along local x, operator at −Z): steel pedestal desk with a raised shelf at the back
 *  for terminals. Returns [deskTop y, shelf y]. */
export function consoleDesk(b: Builder, x: number, z: number, yaw: number, length: number) {
  const m = F(x, z, yaw)
  b.rbox(M.laminateTop, m, length, 0.035, 0.85, 0.008, 0, 0.74, 0)
  for (const s of [-1, 1]) b.rbox(PUTTY, m, 0.45, 0.72, 0.8, 0.01, s * (length / 2 - 0.24), 0.36, 0)
  b.boxM(PUTTY, m, length - 0.9, 0.6, 0.03, 0, 0.4, 0.38)
  b.rbox(PUTTY, m, length, 0.16, 0.36, 0.01, 0, 0.84, 0.25)
  b.rbox(M.laminateTop, m, length, 0.025, 0.38, 0.006, 0, 0.93, 0.25)
  coll(b, m, length, 0.94, 0.85)
  return [FLOOR_Y + 0.758, FLOOR_Y + 0.943] as const
}

export { OFFWHITE, pt }
