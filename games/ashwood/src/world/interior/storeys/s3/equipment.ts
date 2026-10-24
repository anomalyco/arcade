import * as THREE from "three/webgpu"
import { type Builder, type Mat, FLOOR_Y, CEIL_Y, M, T, glow, paint, doorRelief } from "../../api"
import { BLINK, CHART, PLOT, REEL, SCOPE, STATIC, TEXT } from "./mats"

// Storey 3's machines, built procedurally (no library model exists for any of them). FRAME CONVENTION as the kit's
// fixtures: (x, z) is the footprint centre on the floor, the FRONT faces local −Z, `yaw = yawToward(dx, dz)` turns it.
// Everything adds its own colliders. Bevelled boxes (rbox) for anything seen up close.

export const CAB_GREY = paint(0x858c8e, 0.5, 0.2)
export const CAB_BLUE = paint(0x2f4566, 0.42, 0.25)
export const PUTTY = paint(0xa59e88, 0.55, 0.05)
export const OFFWHITE = paint(0xb9b4a4, 0.5, 0)
export const SMOKED = paint(0x0b0e0f, 0.08, 0.1)
export const BLACK = paint(0x111212, 0.5, 0.2)
export const HALON_RED = paint(0x8a1c14, 0.35, 0.3)
export const WOOD_TV = paint(0x3a2614, 0.55, 0)
export const BRUSHED = paint(0xa8aaa6, 0.3, 0.85)
export const BATTERY = paint(0x161818, 0.35, 0.05)
export const CARD = paint(0xcbb98e, 0.85, 0)
const METER = glow(0x1a1406, 0xffc060, 1.2, "s3_meter")
const READOUT = glow(0x020a04, 0x40ff70, 1.4, "s3_readout")
const LIGHTBOX = glow(0x2a2c2a, 0xdfeeff, 2.2, "s3_lightbox")
const RED_LED = glow(0x200404, 0xff2010, 2.2, "s3_red_led")

export const F = (x: number, z: number, yaw: number, y = FLOOR_Y) => T(x, y, z, yaw)
export const sub = (m: THREE.Matrix4, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) => m.clone().multiply(T(x, y, z, ry, rx, rz))
export const pt = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0) => b.collideLocal(m, [ox - w / 2, 0, oz - d / 2], [ox + w / 2, h, oz + d / 2])
/** Quad facing the front (local −Z) at local (x, y, z). */
const front = (b: Builder, mat: Mat, m: THREE.Matrix4, x: number, y: number, z: number, w: number, h: number, tilt = 0) =>
  b.quad(mat, sub(m, x, y, z, Math.PI, tilt), w, h, { cast: false })

// ------------------------------------------------------------------------------------------------ machine room

/** Vacuum-column tape drive (IBM 3420 class): reels side by side behind a glass door, tape loops in the columns,
 *  control strip, lower service door. Reels shuttle (REEL shader). */
export function tapeUnit(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(CAB_GREY, m, 0.76, 1.84, 0.72, 0.025, 0, 0.92, 0)
  b.rbox(CAB_BLUE, m, 0.78, 0.12, 0.74, 0.02, 0, 1.86, 0)
  b.boxM(M.rubber, m, 0.7, 0.08, 0.6, 0, 0.04, 0.02)
  // Recessed dark well behind the door glass.
  b.boxM(BLACK, m, 0.64, 1.0, 0.012, 0, 1.3, -0.366)
  for (const dx of [-0.165, 0.165]) {
    front(b, REEL, m, dx, 1.58, -0.376, 0.27, 0.27)
    // Vacuum columns: dark slots with the tape loop hanging in them.
    b.boxM(SMOKED, m, 0.1, 0.5, 0.006, dx, 1.06, -0.375, { cast: false })
    b.boxM(paint(0x2a1c10, 0.4), m, 0.09, 0.012, 0.004, dx, 0.92 + (dx > 0 ? 0.12 : 0), -0.38, { cast: false })
  }
  b.boxM(BRUSHED, m, 0.12, 0.08, 0.02, 0, 1.2, -0.38)
  // Glass door frame and pane.
  for (const [w, h, ox, oy] of [[0.68, 0.025, 0, 1.81], [0.68, 0.025, 0, 0.79], [0.025, 1.02, -0.33, 1.3], [0.025, 1.02, 0.33, 1.3]] as const) b.boxM(M.darkSteel, m, w, h, 0.02, ox, oy, -0.385)
  front(b, M.glass, m, 0, 1.3, -0.393, 0.64, 1.0)
  // Control strip under the door: indicator lamps and buttons.
  b.boxM(M.darkSteel, m, 0.66, 0.07, 0.012, 0, 0.72, -0.366)
  b.boxM(BLINK, m, 0.5, 0.022, 0.004, -0.05, 0.735, -0.374, { cast: false })
  for (let k = 0; k < 4; k++) b.rbox(k === 3 ? M.red : M.beige, m, 0.04, 0.03, 0.02, 0.005, -0.24 + k * 0.1, 0.7, -0.375)
  doorRelief(b, m, 0.66, 0.5, 0.36, -0.361)
  coll(b, m, 0.78, 1.92, 0.74)
}

/** Disk storage unit (IBM 3350 class): waist-high cabinet, putty lid with a smoked viewing window, lamp panel. */
export function diskUnit(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(CAB_BLUE, m, 0.8, 0.9, 0.78, 0.02, 0, 0.45, 0)
  b.rbox(PUTTY, m, 0.82, 0.16, 0.8, 0.04, 0, 0.98, 0)
  b.boxM(SMOKED, m, 0.46, 0.006, 0.36, 0, 1.061, 0.05, { cast: false })
  b.boxM(M.darkSteel, m, 0.6, 0.06, 0.01, 0, 0.83, -0.393)
  b.boxM(BLINK, m, 0.4, 0.022, 0.004, 0, 0.835, -0.4, { cast: false })
  b.boxM(M.darkSteel, m, 0.004, 0.66, 0.004, 0, 0.4, -0.391, { cast: false })
  doorRelief(b, m, 0.72, 0.62, 0.38, -0.391)
  coll(b, m, 0.82, 1.06, 0.8)
}

/** Processor frame: tall grey cabinet with a big lamp panel (the blinking wall seen through the glass). */
export function cpuFrame(b: Builder, x: number, z: number, yaw: number, wide = false) {
  const m = F(x, z, yaw)
  const w = wide ? 1.2 : 0.8
  b.rbox(CAB_GREY, m, w, 1.78, 0.78, 0.025, 0, 0.89, 0)
  b.rbox(CAB_BLUE, m, w + 0.02, 0.1, 0.8, 0.02, 0, 1.83, 0)
  b.boxM(M.rubber, m, w - 0.06, 0.08, 0.66, 0, 0.04, 0.02)
  b.boxM(M.darkSteel, m, w - 0.14, 0.42, 0.01, 0, 1.38, -0.392)
  b.boxM(BLINK, m, w - 0.2, 0.36, 0.004, 0, 1.38, -0.399, { cast: false })
  if (wide) for (let k = 0; k < 6; k++) b.rbox(k % 3 === 2 ? M.red : M.beige, m, 0.05, 0.035, 0.02, 0.005, -0.4 + k * 0.16, 1.1, -0.4)
  b.boxM(M.darkSteel, m, 0.004, 0.86, 0.004, 0, 0.6, -0.391, { cast: false })
  doorRelief(b, m, w - 0.1, 0.86, 0.56, -0.391)
  coll(b, m, w + 0.02, 1.88, 0.8)
}

/** Computer-room air conditioner (CRAC): tall putty unit, three doors, return grille on top, small green readout. */
export function crac(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(PUTTY, m, 1.9, 1.86, 0.86, 0.03, 0, 0.98, 0)
  b.boxM(M.rubber, m, 1.84, 0.06, 0.8, 0, 0.03, 0)
  for (let k = 0; k < 2; k++) b.boxM(M.darkSteel, m, 0.004, 1.7, 0.004, -0.32 + k * 0.64, 0.95, -0.431, { cast: false })
  for (let k = 0; k < 14; k++) b.boxM(M.darkSteel, m, 1.7, 0.012, 0.6, 0, 1.92 + 0.0001 * k, -0.34 + k * 0.045, { cast: false })
  for (let k = 0; k < 12; k++) b.boxM(M.darkSteel, m, 0.5, 0.012, 0.01, 0.64, 0.25 + k * 0.05, -0.435, { cast: false })
  b.boxM(M.darkSteel, m, 0.28, 0.16, 0.012, -0.64, 1.45, -0.433)
  b.boxM(READOUT, m, 0.12, 0.04, 0.004, -0.68, 1.48, -0.44, { cast: false })
  b.boxM(BLINK, m, 0.08, 0.022, 0.004, -0.6, 1.4, -0.44, { cast: false })
  for (const dx of [-0.38, 0.2, 0.9]) b.boxM(M.steel, m, 0.02, 0.14, 0.03, dx, 1.0, -0.445)
  coll(b, m, 1.9, 1.95, 0.86)
}

/** Halon bottles strapped to a wall frame (back at +Z), manifold piped up into the ceiling. */
export function halonBank(b: Builder, x: number, z: number, yaw: number, n = 3) {
  const m = F(x, z, yaw)
  const pitch = 0.42
  for (let k = 0; k < n; k++) {
    const u = (k - (n - 1) / 2) * pitch
    b.cyl(HALON_RED, sub(m, u, 0.66, 0), 0.17, 0.17, 1.1, 20)
    const dome = new THREE.SphereGeometry(0.17, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2)
    dome.applyMatrix4(sub(m, u, 1.21, 0))
    b.add(HALON_RED, dome)
    b.cyl(HALON_RED, sub(m, u, 0.08, 0), 0.17, 0.15, 0.06, 20)
    b.cyl(BRUSHED, sub(m, u, 1.42, 0), 0.04, 0.05, 0.08, 10)
    b.rod(BRUSHED, pt(m, u, 1.46, 0), pt(m, u, 1.62, 0), 0.016, 8)
    for (const y of [0.45, 1.0]) b.cyl(M.darkSteel, sub(m, u, y, 0), 0.176, 0.176, 0.04, 20, { open: true })
    b.boxM(M.paper, m, 0.12, 0.16, 0.004, u, 0.8, -0.172, { cast: false })
  }
  const span = (n - 1) * pitch
  b.rod(BRUSHED, pt(m, -span / 2 - 0.05, 1.62, 0), pt(m, span / 2 + 0.05, 1.62, 0), 0.024, 8)
  b.rod(BRUSHED, pt(m, span / 2 + 0.05, 1.62, 0), pt(m, span / 2 + 0.05, CEIL_Y - FLOOR_Y, 0), 0.03, 8)
  b.boxM(M.darkSteel, m, span + 0.5, 0.06, 0.04, 0, 1.0, 0.19)
  b.boxM(M.darkSteel, m, span + 0.5, 0.06, 0.04, 0, 0.45, 0.19)
  coll(b, m, span + 0.4, 1.7, 0.42)
}

// ------------------------------------------------------------------------------------------------ terminals

/** Desk-top video terminal (IBM 3278 / VT class) at (x, y, z), front −Z; `on` shows scrolling green text. Returns the
 *  screen centre (for a screen lamp). */
export function terminal(b: Builder, x: number, y: number, z: number, yaw: number, on = true, kbDrop = 0) {
  const id = x === -9.5 && z < 0 ? "terminal:3-04" : x === -12.5 && z > 17.5 ? "terminal:3-24" : null
  if (id && b.ctx.interactions && !b.ctx.interactions.terminals.some(t => t.terminal.id === id)) {
    const view = b.ctx.interactions.terminal(b, id, x, y, z, yaw)
    const at = view.glass.getWorldPosition(new THREE.Vector3())
    return [at.x, at.y - b.oy, at.z] as [number, number, number]
  }
  const m = T(x, y, z, yaw)
  b.rbox(OFFWHITE, m, 0.42, 0.34, 0.38, 0.035, 0, 0.21, 0.04)
  b.rbox(OFFWHITE, m, 0.36, 0.28, 0.12, 0.03, 0, 0.21, 0.27)
  b.rbox(OFFWHITE, m, 0.2, 0.04, 0.24, 0.01, 0, 0.02, 0.06)
  // Recessed bezel and the screen.
  b.boxM(BLACK, m, 0.34, 0.25, 0.01, 0, 0.215, -0.152)
  front(b, on ? TEXT : SMOKED, m, 0, 0.215, -0.158, 0.29, 0.21)
  // Keyboard on the desk in front.
  const ky = -kbDrop
  const kz = kbDrop ? -0.42 : -0.3
  b.rbox(OFFWHITE, m, 0.46, 0.035, 0.18, 0.012, 0, ky + 0.018, kz)
  b.boxM(BLACK, m, 0.4, 0.008, 0.13, 0, ky + 0.038, kz, { cast: false })
  for (let r = 0; r < 4; r++) b.boxM(M.beige, m, 0.38 - r * 0.02, 0.006, 0.022, 0, ky + 0.045, kz - 0.05 + r * 0.032, { cast: false })
  return pt(m, 0, 0.215, -0.3)
}

/** Teleprinter console (operator's keyboard printer, IBM 3215 / DECwriter class) on its own pedestal. */
export function teleprinter(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(PUTTY, m, 0.74, 0.7, 0.56, 0.03, 0, 0.35, 0.05)
  b.rbox(OFFWHITE, m, 0.78, 0.2, 0.62, 0.05, 0, 0.8, 0)
  b.boxM(BLACK, m, 0.5, 0.01, 0.16, 0, 0.905, -0.18, { cast: false })
  b.rbox(SMOKED, m, 0.5, 0.12, 0.16, 0.02, 0, 0.94, 0.08)
  // Paper rising from the platen and folding over the back.
  b.boxM(M.paper, m, 0.36, 0.34, 0.004, 0, 1.08, 0.16, { cast: false })
  b.boxM(M.paper, m, 0.36, 0.004, 0.24, 0, 1.25, 0.28, { cast: false })
  coll(b, m, 0.78, 1.0, 0.66)
}

// ------------------------------------------------------------------------------------------------ data entry

/** Card keypunch (IBM 029): desk body, top unit with the card hopper (right) and stacker (left), keyboard shelf. */
export function keypunch(b: Builder, x: number, z: number, yaw: number, rnd: () => number) {
  const m = F(x, z, yaw)
  b.rbox(paint(0x4c5a68, 0.45, 0.2), m, 1.2, 0.72, 0.72, 0.025, 0, 0.36, 0.02)
  b.rbox(OFFWHITE, m, 1.24, 0.035, 0.76, 0.01, 0, 0.74, 0)
  b.rbox(paint(0x4c5a68, 0.45, 0.2), m, 0.9, 0.3, 0.32, 0.03, 0.08, 0.91, 0.2)
  b.rbox(OFFWHITE, m, 0.2, 0.2, 0.14, 0.02, 0.4, 1.12, 0.18)
  b.boxM(CARD, m, 0.18, 0.1, 0.08, 0.4, 1.25, 0.18)
  b.rbox(OFFWHITE, m, 0.2, 0.08, 0.14, 0.02, -0.28, 1.1, 0.2)
  b.boxM(CARD, m, 0.18, 0.02 + rnd() * 0.05, 0.08, -0.28, 1.15, 0.2)
  b.boxM(BLACK, m, 0.6, 0.02, 0.05, 0.08, 0.92, 0.035, { cast: false })
  b.rbox(OFFWHITE, m, 0.5, 0.06, 0.22, 0.015, 0, 0.78, -0.3)
  b.boxM(BLACK, m, 0.42, 0.01, 0.16, 0, 0.815, -0.3, { cast: false })
  b.boxM(paint(0x2a3038, 0.6), m, 0.04, 0.64, 0.5, 0.56, 0.32, 0.02)
  coll(b, m, 1.24, 1.26, 0.78)
}

/** Card sorter (IBM 083): long low body with 13 pockets along the front, a hopper at one end. */
export function cardSorter(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(paint(0x4c5a68, 0.45, 0.2), m, 1.6, 0.66, 0.48, 0.025, 0, 0.33, 0)
  b.rbox(OFFWHITE, m, 1.64, 0.2, 0.52, 0.03, 0, 0.76, 0)
  for (let k = 0; k < 13; k++) {
    b.boxM(BLACK, m, 0.08, 0.12, 0.01, -0.68 + k * 0.105, 0.78, -0.262, { cast: false })
    if (k % 3 === 0) b.boxM(CARD, m, 0.07, 0.05, 0.06, -0.68 + k * 0.105, 0.76, -0.24)
  }
  b.rbox(OFFWHITE, m, 0.22, 0.14, 0.2, 0.02, 0.7, 0.93, 0.05)
  coll(b, m, 1.64, 0.9, 0.52)
}

/** Decollator / burster on its stand: paper feed rolls and a stack of separated sheets. */
export function decollator(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  for (const dx of [-0.4, 0.4]) for (const dz of [-0.22, 0.22]) b.boxM(M.darkSteel, m, 0.035, 0.7, 0.035, dx, 0.35, dz)
  b.rbox(PUTTY, m, 0.95, 0.22, 0.55, 0.02, 0, 0.8, 0)
  for (const dz of [-0.12, 0.12]) b.cyl(BRUSHED, sub(m, 0, 0.95, dz, 0, 0, Math.PI / 2), 0.04, 0.04, 0.82, 14)
  b.boxM(M.paper, m, 0.38, 0.12, 0.28, 0, 1.0, -0.05)
  b.boxM(M.darkSteel, m, 0.8, 0.02, 0.5, 0, 0.18, 0)
  b.boxM(M.paper, m, 0.38, 0.1, 0.28, -0.1, 0.24, 0)
  coll(b, m, 0.95, 1.05, 0.55)
}

/** Wall of printout pigeonholes (back at +Z), `cols` × `rows` cubbies of 0.3 × 0.24 m; `stuffed` cubby index jammed
 *  with months of folded printouts. Returns the stuffed cubby's centre (local frame) for a label. */
export function pigeonholes(b: Builder, x: number, z: number, yaw: number, cols: number, rows: number, rnd: () => number, stuffed = -1, y0 = 0.8) {
  const m = F(x, z, yaw)
  const cw = 0.3
  const ch = 0.24
  const w = cols * cw
  const h = rows * ch
  const d = 0.36
  b.boxM(M.wood, m, w + 0.04, h + 0.04, 0.015, 0, y0 + h / 2, d / 2 - 0.008)
  for (let i = 0; i <= cols; i++) b.boxM(M.wood, m, 0.016, h, d, -w / 2 + i * cw, y0 + h / 2, 0)
  for (let j = 0; j <= rows; j++) b.boxM(M.wood, m, w + 0.016, 0.016, d, 0, y0 + j * ch, 0)
  let out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const k = i * rows + j
      const cx = -w / 2 + (i + 0.5) * cw
      const cy = y0 + j * ch + 0.008
      if (k === stuffed) {
        for (let s = 0; s < 14; s++) b.boxM(s % 3 ? M.paper : paint(0xb8c8a8, 0.9), m, 0.27, 0.014, 0.33 + (rnd() - 0.5) * 0.04, cx + (rnd() - 0.5) * 0.01, cy + 0.007 + s * 0.015, -0.03 - rnd() * 0.04, { cast: false })
        out = pt(m, cx, y0 + j * ch - 0.01, -d / 2)
      } else if (rnd() < 0.45) {
        const n = 1 + Math.floor(rnd() * 4)
        for (let s = 0; s < n; s++) b.boxM(M.paper, m, 0.26, 0.012, 0.3, cx + (rnd() - 0.5) * 0.02, cy + 0.006 + s * 0.013, (rnd() - 0.5) * 0.04, { cast: false })
      }
    }
  b.collideLocal(m, [-w / 2, y0 - 0.8, -d / 2], [w / 2, y0 + h, d / 2])
  if (y0 > 0.3) b.boxM(M.cabinet, m, w, y0 - 0.02, d - 0.02, 0, (y0 - 0.02) / 2, 0)
  return out
}

// ------------------------------------------------------------------------------------------------ tape library

const REEL_RINGS = [paint(0x3a6ea8, 0.5), paint(0xb8b6aa, 0.5), paint(0x7a1c18, 0.5), paint(0x2a2a2a, 0.5), paint(0xa08a2a, 0.5)]
const REEL_GREY = paint(0x5a5e60, 0.45, 0.3)

/** Two-sided tape-reel rack along local x, `length` m: steel frame, five sloped shelves each side holding reels on
 *  edge in their seal belts (coloured rings), a few gaps where reels are out. */
export function reelRack(b: Builder, x: number, z: number, yaw: number, length: number, rnd: () => number) {
  const m = F(x, z, yaw)
  const d = 0.62
  const H = 2.1
  for (const u of [-length / 2, 0, length / 2]) for (const s of [-1, 1]) b.boxM(M.darkSteel, m, 0.035, H, 0.035, u, H / 2, s * (d / 2 - 0.02))
  b.boxM(M.darkSteel, m, length, 0.03, d, 0, H - 0.015, 0)
  b.boxM(M.darkSteel, m, length, 0.6 * H, 0.006, 0, 0.3 * H + 0.1, 0)
  for (let shelf = 0; shelf < 5; shelf++) {
    const y = 0.12 + shelf * 0.38
    for (const s of [-1, 1]) {
      b.boxM(M.darkSteel, m, length, 0.012, d / 2 - 0.02, 0, y, s * (d / 4))
      b.boxM(M.darkSteel, m, length, 0.04, 0.01, 0, y + 0.02, s * (d / 2 - 0.01))
      const n = Math.floor(length / 0.034) - 4
      for (let k = 0; k < n; k++) {
        if (rnd() < 0.07) continue
        const u = -length / 2 + 0.07 + k * 0.034
        const ring = REEL_RINGS[Math.floor(rnd() * REEL_RINGS.length)]!
        const r = 0.135
        const c = sub(m, u, y + 0.006 + r, s * (d / 4 + 0.005), 0, 0, Math.PI / 2)
        b.cyl(REEL_GREY, c, r, r, 0.026, 12, { cast: false })
        b.cyl(ring, c, r + 0.004, r + 0.004, 0.012, 12, { cast: false, open: true })
      }
    }
  }
  coll(b, m, length + 0.04, H, d)
}

/** Tape cleaner / certifier on a cabinet: reel deck with two reels (REEL), smoked lid. */
export function tapeCleaner(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(CAB_GREY, m, 0.9, 0.9, 0.6, 0.025, 0, 0.45, 0)
  b.rbox(PUTTY, m, 0.92, 0.42, 0.62, 0.03, 0, 1.11, 0)
  b.boxM(BLACK, m, 0.8, 0.34, 0.01, 0, 1.12, -0.311)
  for (const dx of [-0.2, 0.2]) front(b, REEL, m, dx, 1.13, -0.32, 0.27, 0.27)
  b.boxM(BLINK, m, 0.3, 0.022, 0.004, 0, 0.82, -0.304, { cast: false })
  doorRelief(b, m, 0.8, 0.6, 0.38, -0.301)
  coll(b, m, 0.92, 1.32, 0.62)
}

// ------------------------------------------------------------------------------------------------ listening room

/** Reel-to-reel recorder console (Ampex class) in a cabinet: reels upright on the top deck (REEL), head block, two
 *  VU meters lit, electronics drawers below. */
export function recorderConsole(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(CAB_GREY, m, 0.66, 1.0, 0.62, 0.025, 0, 0.5, 0)
  b.rbox(BRUSHED, m, 0.64, 0.7, 0.06, 0.015, 0, 1.4, 0.1)
  const deck = sub(m, 0, 1.4, 0.07, 0, -0.12)
  for (const dx of [-0.16, 0.16]) {
    b.quad(REEL, sub(deck, dx, 0.12, 0.0, Math.PI), 0.27, 0.27, { cast: false })
    b.cyl(M.darkSteel, sub(deck, dx, 0.12, -0.012, 0, Math.PI / 2), 0.02, 0.02, 0.03, 10)
  }
  b.boxM(M.darkSteel, deck, 0.16, 0.08, 0.04, 0, -0.18, -0.02)
  b.boxM(paint(0x2a1c10, 0.4), deck, 0.5, 0.006, 0.006, 0, -0.14, -0.04, { cast: false })
  b.rbox(CAB_GREY, m, 0.66, 0.06, 0.66, 0.02, 0, 1.03, 0)
  for (const dx of [-0.13, 0.13]) {
    b.boxM(M.darkSteel, m, 0.16, 0.1, 0.01, dx, 0.88, -0.311)
    b.boxM(METER, m, 0.13, 0.075, 0.004, dx, 0.88, -0.318, { cast: false })
  }
  for (let k = 0; k < 6; k++) b.cyl(BLACK, sub(m, -0.25 + k * 0.1, 0.74, -0.32, 0, Math.PI / 2), 0.018, 0.018, 0.025, 10)
  for (const y of [0.22, 0.5]) b.boxM(M.darkSteel, m, 0.6, 0.004, 0.004, 0, y, -0.311, { cast: false })
  coll(b, m, 0.66, 1.78, 0.66)
}

/** Equipment rack (19-inch, open sides) with a spectrum analyser and two oscilloscope drawers (SCOPE screens). */
export function analyserRack(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  const H = 1.9
  b.rbox(paint(0x3a3e3c, 0.5, 0.4), m, 0.6, H, 0.62, 0.02, 0, H / 2, 0)
  b.boxM(BLACK, m, 0.5, H - 0.2, 0.01, 0, H / 2, -0.311)
  const units: [number, number, number][] = [[1.45, 0.36, 1], [1.02, 0.3, 1], [0.64, 0.26, 0]]
  for (const [y, h, scope] of units) {
    b.rbox(paint(0x9a9a92, 0.5, 0.2), m, 0.48, h, 0.04, 0.008, 0, y, -0.33)
    if (scope) {
      b.boxM(BLACK, m, 0.2, h * 0.72, 0.008, -0.11, y, -0.354)
      front(b, SCOPE, m, -0.11, y, -0.359, 0.17, h * 0.6)
      for (let k = 0; k < 6; k++) b.cyl(BLACK, sub(m, 0.07 + (k % 3) * 0.06, y - 0.06 + Math.floor(k / 3) * 0.1, -0.36, 0, Math.PI / 2), 0.014, 0.014, 0.02, 10)
    } else {
      b.boxM(BLINK, m, 0.3, 0.022, 0.004, 0, y + 0.06, -0.353, { cast: false })
      b.boxM(READOUT, m, 0.14, 0.04, 0.004, -0.1, y - 0.04, -0.353, { cast: false })
    }
  }
  coll(b, m, 0.6, H, 0.62)
}

/** Bench oscilloscope (Tektronix class) on a surface at (x, y, z), front −Z. */
export function scope(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(paint(0x6e7a80, 0.45, 0.3), m, 0.32, 0.2, 0.46, 0.015, 0, 0.11, 0)
  b.boxM(BLACK, m, 0.13, 0.11, 0.01, -0.07, 0.12, -0.232)
  front(b, SCOPE, m, -0.07, 0.12, -0.238, 0.11, 0.088)
  for (let k = 0; k < 6; k++) b.cyl(BLACK, sub(m, 0.05 + (k % 2) * 0.06, 0.06 + Math.floor(k / 2) * 0.05, -0.24, 0, Math.PI / 2), 0.012, 0.012, 0.02, 10)
  b.boxM(M.darkSteel, m, 0.3, 0.02, 0.02, 0, 0.005, -0.21)
}

/** Strip-chart recorder on a surface, its paper spilling over the front edge and heaping on the floor: the last metre
 *  shows the heartbeat-like trace (CHART). `spill` m forward of the bench edge, heap at floor level. */
export function stripChart(b: Builder, x: number, y: number, z: number, yaw: number, spill: number, rnd: () => number) {
  const m = T(x, y, z, yaw)
  b.rbox(paint(0x8a8e84, 0.5, 0.2), m, 0.44, 0.22, 0.34, 0.015, 0, 0.11, 0)
  b.boxM(BLACK, m, 0.32, 0.12, 0.01, 0, 0.13, -0.172)
  front(b, CHART, m, 0, 0.13, -0.178, 0.28, 0.1)
  b.boxM(M.glass, m, 0.32, 0.12, 0.004, 0, 0.13, -0.183, { cast: false })
  // Paper ribbon: out of the slot, over the edge, down to the floor, a few folds in a heap.
  const pts: [number, number][] = [[-0.17, 0.03], [-0.25, 0.0], [-0.32, -0.08], [-0.34, -0.3], [-0.36, -y + 0.25 + FLOOR_Y], [-0.4 - spill * 0.3, -y + 0.04 + FLOOR_Y], [-0.4 - spill, -y + 0.006 + FLOOR_Y]]
  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  let acc = 0
  for (let i = 0; i < pts.length; i++) {
    if (i) acc += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
    for (const [s, u] of [[-0.13, 0], [0.13, 1]] as const) {
      pos.push(s, pts[i]![1], pts[i]![0])
      uvs.push(u, acc * 3)
    }
  }
  for (let i = 0; i < pts.length - 1; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3)
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.applyMatrix4(m)
  b.add(CHART2S, g, { worldUV: false, cast: false })
  // Heap: crumpled folds on the floor beyond the end.
  const hm = sub(m, 0, -y + FLOOR_Y, -0.45 - spill)
  for (let k = 0; k < 9; k++) b.boxM(M.paper, sub(hm, (rnd() - 0.5) * 0.3, 0.01 + k * 0.012, (rnd() - 0.5) * 0.3, rnd() * 3, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4), 0.26, 0.008, 0.2, 0, 0, 0, { cast: false })
}
const CHART2S = (() => {
  const c = CHART.clone() as THREE.MeshStandardNodeMaterial
  c.side = THREE.DoubleSide
  c.name = "s3_chart_2s"
  return c
})()

/** Teletype (ASR-33) on its stand: body, keyboard, paper roll, paper tape punch. */
export function teletype(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  for (const dx of [-0.32, 0.32]) for (const dz of [-0.18, 0.18]) b.boxM(M.darkSteel, m, 0.03, 0.66, 0.03, dx, 0.33, dz)
  b.boxM(M.darkSteel, m, 0.7, 0.03, 0.42, 0, 0.66, 0)
  b.rbox(paint(0xa49a7c, 0.5, 0.05), m, 0.6, 0.36, 0.48, 0.05, 0, 0.86, 0.02)
  b.rbox(paint(0xa49a7c, 0.5, 0.05), m, 0.5, 0.06, 0.2, 0.02, 0, 0.72, -0.28)
  b.boxM(BLACK, m, 0.4, 0.01, 0.14, 0, 0.755, -0.28, { cast: false })
  b.cyl(M.paper, sub(m, 0.02, 1.08, 0.1, 0, 0, Math.PI / 2), 0.08, 0.08, 0.24, 16)
  b.boxM(M.paper, m, 0.24, 0.3, 0.004, 0.02, 1.15, -0.04, { cast: false })
  b.rbox(paint(0xa49a7c, 0.5, 0.05), m, 0.14, 0.12, 0.14, 0.02, -0.33, 0.9, -0.05)
  b.boxM(paint(0xc8b878, 0.8), m, 0.02, 0.004, 0.5, -0.33, 0.67, -0.25, { cast: false })
  coll(b, m, 0.7, 1.1, 0.5)
}

/** Headphones (headband + two cups). `hang` lets them dangle by the cord from a desk edge at (x, y, z). */
export function headphones(b: Builder, x: number, y: number, z: number, yaw: number, hang = 0) {
  const m = T(x, y - hang, z, yaw, hang ? 0 : -Math.PI / 2)
  const band = new THREE.TorusGeometry(0.085, 0.008, 6, 18, Math.PI)
  band.applyMatrix4(sub(m, 0, 0.0, 0))
  b.add(BLACK, band, { cast: false })
  for (const s of [-1, 1]) b.cyl(BLACK, sub(m, s * 0.085, -0.01, 0, 0, 0, Math.PI / 2), 0.04, 0.042, 0.035, 14)
  if (hang) b.rod(BLACK, [x, y, z], pt(m, 0.085, -0.04, 0), 0.003, 4)
}

// ------------------------------------------------------------------------------------------------ maps, plots

/** Drum pen plotter (CalComp class) mid-plot on its cabinet: paper over the drum (PLOT), pen carriage, supply roll. */
export function drumPlotter(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  b.rbox(PUTTY, m, 1.7, 0.8, 0.6, 0.025, 0, 0.4, 0)
  b.cyl(BRUSHED, sub(m, 0, 0.98, 0, 0, 0, Math.PI / 2), 0.17, 0.17, 1.5, 28)
  for (const s of [-1, 1]) b.rbox(PUTTY, m, 0.1, 0.42, 0.5, 0.02, s * 0.8, 0.98, 0)
  // Plotted sheet wrapped over the front of the drum (a curved quad strip).
  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  const n = 10
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 0.95
    for (const [u, s] of [[0, -0.7], [1, 0.7]] as const) {
      pos.push(s, 0.98 + Math.sin(a) * 0.173, -Math.cos(a) * 0.173)
      uvs.push(u, i / n)
    }
  }
  for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.applyMatrix4(m)
  b.add(PLOT, g, { worldUV: false, cast: false })
  b.rod(M.darkSteel, pt(m, -0.75, 1.2, -0.08), pt(m, 0.75, 1.2, -0.08), 0.012, 8)
  b.rbox(M.darkSteel, m, 0.08, 0.06, 0.08, 0.01, 0.12, 1.17, -0.12)
  b.boxM(M.red, m, 0.008, 0.06, 0.008, 0.12, 1.13, -0.16)
  b.boxM(BLINK, m, 0.2, 0.022, 0.004, -0.55, 0.65, -0.302, { cast: false })
  coll(b, m, 1.7, 1.2, 0.6)
}

/** Flat-file map cabinet: five wide shallow drawers on a plinth, a rolled map on top. */
export function flatFile(b: Builder, x: number, z: number, yaw: number, rnd: () => number) {
  const m = F(x, z, yaw)
  b.rbox(paint(0x6a7468, 0.5, 0.3), m, 1.3, 0.86, 0.95, 0.015, 0, 0.47, 0)
  b.boxM(M.rubber, m, 1.26, 0.06, 0.9, 0, 0.03, 0)
  for (let k = 0; k < 5; k++) {
    b.boxM(M.darkSteel, m, 1.26, 0.004, 0.004, 0, 0.22 + k * 0.15, -0.476, { cast: false })
    b.boxM(M.steel, m, 0.2, 0.02, 0.02, 0, 0.29 + k * 0.15, -0.49)
  }
  if (rnd() < 0.7) b.cyl(M.paper, sub(m, (rnd() - 0.5) * 0.4, 0.94, 0, rnd() * 0.3, 0, Math.PI / 2), 0.04, 0.04, 0.9, 12)
  coll(b, m, 1.3, 0.9, 0.95)
}

/** Light table: steel stand, tilted opal glass top lit from below (glow + a cool fluorescent lamp). */
export function lightTable(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  for (const dx of [-0.65, 0.65]) for (const dz of [-0.35, 0.35]) b.boxM(M.darkSteel, m, 0.04, 0.8, 0.04, dx, 0.4, dz)
  const top = sub(m, 0, 0.92, 0, 0, 0.25)
  b.rbox(paint(0x3a3e3a, 0.5, 0.4), top, 1.44, 0.12, 0.84, 0.02)
  b.quad(LIGHTBOX, sub(top, 0, 0.062, 0, 0, -Math.PI / 2), 1.32, 0.72, { cast: false })
  b.quad(PLOT, sub(top, 0.1, 0.067, 0.05, 0.08, -Math.PI / 2), 0.6, 0.45, { cast: false })
  const p = pt(top, 0, 0.5, 0)
  b.lamp({ kind: "fluorescent", position: [p[0], p[1] - 0.35, p[2]], color: [0.82, 0.92, 1.0], intensity: 4, range: 3.5, size: 0.6 })
  coll(b, m, 1.44, 1.05, 0.9)
}

// ------------------------------------------------------------------------------------------------ power

/** UPS / power distribution cabinet: tall grey enclosure, analogue meters (lit), selector switches, red lamps. */
export function upsCabinet(b: Builder, x: number, z: number, yaw: number, meters = true) {
  const m = F(x, z, yaw)
  b.rbox(paint(0x7a8278, 0.5, 0.35), m, 1.2, 2.0, 0.8, 0.02, 0, 1.0, 0)
  b.boxM(M.rubber, m, 1.16, 0.08, 0.76, 0, 0.04, 0)
  b.boxM(M.darkSteel, m, 0.004, 1.84, 0.004, 0, 1.0, -0.401, { cast: false })
  if (meters)
    for (let k = 0; k < 3; k++) {
      b.cyl(BLACK, sub(m, -0.35 + k * 0.17, 1.6, -0.405, 0, Math.PI / 2), 0.065, 0.065, 0.015, 18)
      b.cyl(METER, sub(m, -0.35 + k * 0.17, 1.6, -0.413, 0, Math.PI / 2), 0.055, 0.055, 0.002, 18, { cast: false })
    }
  for (let k = 0; k < 3; k++) b.boxM(RED_LED, m, 0.02, 0.02, 0.004, 0.25 + k * 0.08, 1.62, -0.404, { cast: false })
  for (let k = 0; k < 3; k++) b.cyl(BLACK, sub(m, 0.25 + k * 0.08, 1.4, -0.41, 0, Math.PI / 2), 0.022, 0.022, 0.025, 10)
  for (const dx of [-0.08, 0.08]) b.boxM(M.steel, m, 0.025, 0.2, 0.03, dx, 1.0, -0.415)
  for (let k = 0; k < 10; k++) b.boxM(M.darkSteel, m, 0.5, 0.012, 0.01, -0.28, 0.25 + k * 0.04, -0.405, { cast: false })
  coll(b, m, 1.2, 2.0, 0.8)
}

/** Two-tier steel battery rack along local x, rows of black lead-acid jars with terminals and links. */
export function batteryRack(b: Builder, x: number, z: number, yaw: number, length: number) {
  const m = F(x, z, yaw)
  for (const y of [0.1, 0.62]) {
    b.boxM(M.safety, m, length, 0.06, 0.06, 0, y, -0.25)
    b.boxM(M.safety, m, length, 0.06, 0.06, 0, y, 0.25)
    const n = Math.floor(length / 0.24)
    for (let k = 0; k < n; k++) {
      const u = -length / 2 + 0.12 + k * 0.24
      b.rbox(BATTERY, m, 0.2, 0.36, 0.42, 0.01, u, y + 0.21, 0)
      for (const dz of [-0.1, 0.1]) b.cyl(M.darkSteel, sub(m, u, y + 0.405, dz), 0.015, 0.015, 0.03, 8)
      if (k < n - 1) b.boxM(BRUSHED, m, 0.24, 0.006, 0.03, u + 0.12, y + 0.42, 0.1, { cast: false })
    }
  }
  for (const u of [-length / 2, length / 2]) for (const s of [-1, 1]) b.boxM(M.safety, m, 0.05, 1.05, 0.05, u, 0.52, s * 0.25)
  coll(b, m, length + 0.05, 1.05, 0.56)
}

// ------------------------------------------------------------------------------------------------ rest room

/** Portable television on a wheeled cart: woodgrain cabinet, a screen of static (STATIC), knobs, rabbit ears.
 *  Returns the screen centre. */
export function staticTV(b: Builder, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  for (const y of [0.12, 0.62]) b.boxM(M.darkSteel, m, 0.62, 0.025, 0.46, 0, y, 0)
  for (const dx of [-0.29, 0.29]) for (const dz of [-0.2, 0.2]) {
    b.boxM(M.darkSteel, m, 0.025, 0.62, 0.025, dx, 0.37, dz)
    b.cyl(M.rubber, sub(m, dx, 0.035, dz, 0, 0, Math.PI / 2), 0.035, 0.035, 0.03, 10)
  }
  const t = sub(m, 0, 0.635, 0)
  b.rbox(WOOD_TV, t, 0.56, 0.42, 0.44, 0.03, 0, 0.21, 0)
  b.rbox(paint(0x6a6a64, 0.4, 0.5), t, 0.44, 0.34, 0.02, 0.02, -0.04, 0.21, -0.215)
  front(b, STATIC, t, -0.04, 0.21, -0.227, 0.36, 0.27)
  for (let k = 0; k < 3; k++) b.cyl(BLACK, sub(t, 0.23, 0.32 - k * 0.08, -0.225, 0, Math.PI / 2), 0.018, 0.018, 0.02, 10)
  for (const s of [-1, 1]) b.rod(BRUSHED, pt(t, 0.05, 0.42, 0.1), pt(t, 0.05 + s * 0.25, 0.85, 0.15), 0.003, 4)
  coll(b, m, 0.62, 1.05, 0.46)
  return pt(t, -0.04, 0.21, -0.4)
}
