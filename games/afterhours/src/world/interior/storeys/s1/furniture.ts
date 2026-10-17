import * as THREE from "three/webgpu"
import { materialFor } from "../../../../render/materials"
import { type Builder, type Mat, CEIL_Y, FLOOR_Y, M, T, glow, paint, placeModels, screen } from "../../api"

// Storey 1's own procedural furniture (office equipment of 1984 that the model library doesn't have). Frame convention
// as the kit's fixtures: a piece stands at (x, z) on the floor (or at height y on a surface), FRONT towards local −Z
// (the side you use it from), back at local +Z; `yaw` turns the frame. Every piece adds its own colliders.

export type Rnd = () => number
export const rng = (seed: number): Rnd => {
  let s = (seed * 9973 + 7) % 2147483647 || 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

export const pt = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const at = (x: number, z: number, yaw: number, y = FLOOR_Y) => T(x, y, z, yaw)
const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0, oy = 0) =>
  b.collideLocal(m, [ox - w / 2, oy, oz - d / 2], [ox + w / 2, oy + h, oz + d / 2])

export const P = {
  oak: paint(0x6b4a2a, 0.5),
  oakDark: paint(0x3e2a17, 0.55),
  selectric: paint(0x2c3a4e, 0.32, 0.05),
  selectricTan: paint(0x9a8a6a, 0.35),
  keys: paint(0x1a1a1a, 0.4),
  putty: paint(0xa49c86, 0.45),
  puttyDark: paint(0x5e594c, 0.5),
  smoke: materialFor("flat", { color: 0x2a2620, roughness: 0.08, transparent: 0.55, name: "s1_smoked_acrylic" }),
  blotter: paint(0x1f3524, 0.85),
  leather: paint(0x2a1a10, 0.55),
  wool: paint(0x2e2c2a, 0.98),
  woolDark: paint(0x1c1b1a, 0.98),
  bakelite: paint(0x0e0e0e, 0.3),
  cord: paint(0x151515, 0.6),
  fabric: paint(0x5a5448, 0.95),
  fabricTrim: paint(0x3a3630, 0.5, 0.3),
  potWhite: paint(0x8e8a7c, 0.5),
  leafDark: paint(0x16261a, 0.6),
  magnetRed: paint(0x8a1a12, 0.4),
  magnetGreen: paint(0x1d5a2a, 0.4),
  board: paint(0xb8b8b0, 0.35, 0.1),
  amberGlass: materialFor("flat", { color: 0x5a3010, roughness: 0.1, transparent: 0.35, name: "s1_amber_glass" }),
  ash: paint(0x4a4844, 0.95),
  butt: paint(0xc8b890, 0.8),
  vault: materialFor("flat", { color: 0x7d807c, roughness: 0.35, metalness: 0.85, name: "s1_vault_steel" }),
  vaultDark: materialFor("flat", { color: 0x2a2c2b, roughness: 0.4, metalness: 0.8, name: "s1_vault_dark" }),
}
const BOOK_COLOURS = [0x5a1a14, 0x1e2a44, 0x2a3a22, 0x6a5a3a, 0x3a2a1a, 0x7a6a50, 0x222222, 0x4a1e2e, 0x8a7a5a, 0x2a4448].map((c) => paint(c, 0.75))
const READY = glow(0x041004, 0x30ff40, 1.8, "s1_ready_led")

// ------------------------------------------------------------------------------------------------ desk-top

/** IBM Selectric on a surface at height y, front (keyboard) towards local −Z. `paper` returns the sheet frame. */
export function typewriter(b: Builder, x: number, y: number, z: number, yaw: number, opts: { tan?: boolean } = {}) {
  const m = T(x, y, z, yaw)
  const body = opts.tan ? P.selectricTan : P.selectric
  b.rbox(body, m, 0.47, 0.12, 0.38, 0.035, 0, 0.06, 0.02)
  b.rbox(body, m, 0.43, 0.06, 0.2, 0.03, 0, 0.14, 0.08)
  // Keyboard well, sloped towards the typist, with key rows.
  const kb = m.clone().multiply(T(0, 0.095, -0.1, 0, -0.22))
  b.boxM(P.keys, kb, 0.36, 0.012, 0.16, 0, 0, 0)
  for (let r = 0; r < 4; r++) for (let k = 0; k < 11; k++) b.boxM(P.putty, kb, 0.022, 0.012, 0.022, -0.15 + k * 0.03 + (r % 2) * 0.01, 0.01, -0.06 + r * 0.035, { cast: false })
  b.boxM(P.putty, kb, 0.16, 0.012, 0.024, 0, 0.01, -0.095, { cast: false })
  // Platen and knobs.
  b.cyl(P.keys, m.clone().multiply(T(0, 0.19, 0.13, 0, 0, Math.PI / 2)), 0.026, 0.026, 0.42, 16)
  for (const s of [-1, 1]) b.cyl(P.keys, m.clone().multiply(T(s * 0.225, 0.19, 0.13, 0, 0, Math.PI / 2)), 0.02, 0.02, 0.03, 12)
  b.boxM(M.steel, m, 0.4, 0.006, 0.02, 0, 0.2, 0.1, { cast: false })
  // The sheet in the machine: centre and normal (towards the typist, leaning back).
  const c = pt(m, 0, 0.19 + 0.11, 0.15)
  const n = new THREE.Vector3(0, 0.26, -1).normalize().applyMatrix4(new THREE.Matrix4().makeRotationY(yaw))
  return { position: c, normal: [n.x, n.y, n.z] as [number, number, number] }
}

/** Rotary card file (Rolodex) on a surface. */
export function cardFile(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(M.darkSteel, m, 0.2, 0.02, 0.14, 0.006, 0, 0.01, 0)
  for (const s of [-1, 1]) b.boxM(M.darkSteel, m, 0.008, 0.12, 0.03, s * 0.09, 0.08, 0)
  b.cyl(P.keys, m.clone().multiply(T(0, 0.11, 0, 0, 0, Math.PI / 2)), 0.012, 0.012, 0.18, 8)
  for (let k = 0; k < 11; k++) b.boxM(M.paper, m.clone().multiply(T(0, 0.11, 0, 0, -1.2 + k * 0.24)), 0.16, 0.002, 0.07, 0, 0, 0.035, { cast: false })
}

/** Leather-cornered desk blotter. */
export function blotter(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.boxM(P.blotter, m, 0.62, 0.004, 0.44, 0, 0.002, 0, { cast: false })
  for (const s of [-1, 1]) b.boxM(P.leather, m, 0.06, 0.006, 0.45, s * 0.3, 0.003, 0, { cast: false })
}

/** Desk phone knocked off the hook: base on the desk, handset lying beside it, coiled cord between. */
export function phoneOffHook(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.bakelite, m, 0.2, 0.08, 0.22, 0.03, 0, 0.04, 0)
  b.cyl(M.steel, m.clone().multiply(T(0, 0.081, -0.02)), 0.05, 0.05, 0.004, 20)
  for (const s of [-1, 1]) b.rbox(P.bakelite, m, 0.035, 0.035, 0.05, 0.012, s * 0.07, 0.095, 0.05)
  // Handset on its back on the blotter, turned.
  const h = m.clone().multiply(T(-0.24, 0.02, -0.08, 0.9))
  b.rbox(P.bakelite, h, 0.2, 0.03, 0.045, 0.014, 0, 0, 0)
  for (const s of [-1, 1]) b.rbox(P.bakelite, h, 0.05, 0.04, 0.055, 0.02, s * 0.09, 0.005, 0)
  for (let k = 0; k < 9; k++) {
    const a = pt(m, -0.07 - k * 0.018, 0.015, 0.06 - k * 0.013)
    b.add(P.cord, new THREE.TorusGeometry(0.009, 0.0025, 4, 8).rotateY(yaw + 0.6).translate(a[0], a[1], a[2]), { cast: false })
  }
}

/** Open briefcase on a surface: shell, lid hinged back, papers inside. */
export function briefcaseOpen(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.leather, m, 0.44, 0.07, 0.32, 0.012, 0, 0.035, 0)
  b.boxM(P.oakDark, m, 0.41, 0.005, 0.29, 0, 0.068, 0, { cast: false })
  b.boxM(M.paper, m, 0.3, 0.012, 0.22, 0.02, 0.074, 0.01, { cast: false })
  const lid = m.clone().multiply(T(0, 0.07, 0.16, 0, -1.85))
  b.rbox(P.leather, lid, 0.44, 0.03, 0.32, 0.01, 0, 0.015, -0.16)
  for (const s of [-1, 1]) b.boxM(KEY_BRASS, m, 0.03, 0.02, 0.012, s * 0.12, 0.05, -0.165)
}
const KEY_BRASS = paint(0x8a6a2a, 0.3, 0.9)

/** Overcoat draped over an office chair's back (chair at x, z facing yaw: back at local +Z). */
export function coatOnChair(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  // Shoulders over the backrest top, body hanging down the back, a sleeve over the arm.
  b.rbox(P.wool, m.clone().multiply(T(0, 0.98, 0.27, 0, 0.15)), 0.5, 0.06, 0.16, 0.03)
  b.rbox(P.wool, m.clone().multiply(T(0, 0.66, 0.37, 0, 0.08)), 0.5, 0.62, 0.05, 0.025)
  b.rbox(P.woolDark, m.clone().multiply(T(0, 0.9, 0.2, 0, -0.05)), 0.46, 0.14, 0.04, 0.018)
  b.rbox(P.wool, m.clone().multiply(T(0.3, 0.55, 0.12, 0.2, 0, 0.35)), 0.09, 0.42, 0.1, 0.04)
}

/** Glass ashtray with a few butts. */
export function ashtray(b: Builder, x: number, y: number, z: number, rnd: Rnd, butts = 3) {
  b.cyl(P.amberGlass, T(x, y + 0.015, z), 0.06, 0.055, 0.03, 18)
  b.cyl(P.ash, T(x, y + 0.026, z), 0.045, 0.045, 0.004, 14, { cast: false })
  for (let k = 0; k < butts; k++) {
    const a = rnd() * Math.PI * 2
    b.cyl(P.butt, T(x + Math.cos(a) * 0.03, y + 0.032, z + Math.sin(a) * 0.03, a, 0, Math.PI / 2 - 0.2), 0.004, 0.004, 0.03, 6, { cast: false })
  }
}

// ------------------------------------------------------------------------------------------------ furniture

/** Veneer bookcase, back on the wall (local +Z), filled with books. */
export function bookcase(b: Builder, x: number, z: number, yaw: number, rnd: Rnd, opts: { w?: number; h?: number; d?: number; shelves?: number; mat?: Mat; fill?: number } = {}) {
  const w = opts.w ?? 0.9
  const h = opts.h ?? 1.85
  const d = opts.d ?? 0.32
  const mat = opts.mat ?? M.veneer
  const m = at(x, z, yaw)
  const t = 0.02
  for (const s of [-1, 1]) b.boxM(mat, m, t, h, d, s * (w / 2 - t / 2), h / 2, 0)
  b.boxM(mat, m, w, t, d, 0, h - t / 2, 0)
  b.boxM(mat, m, w - 2 * t, 0.08, d - 0.02, 0, 0.04, 0.01)
  b.boxM(M.veneerDark, m, w - 2 * t, h - 0.1, 0.006, 0, h / 2 + 0.04, d / 2 - 0.003)
  const n = opts.shelves ?? 5
  const pitch = (h - 0.1 - t) / n
  for (let k = 0; k < n; k++) {
    const y0 = 0.08 + k * pitch
    if (k > 0) b.boxM(mat, m, w - 2 * t, t, d - 0.02, 0, y0, 0.005)
    // Books standing on this shelf, leaving a gap here and there; some leaning.
    let u = -w / 2 + t + 0.005
    while (u < w / 2 - t - 0.04) {
      if (rnd() > (opts.fill ?? 0.9)) {
        u += 0.04 + rnd() * 0.1
        continue
      }
      const bw = 0.02 + rnd() * 0.035
      const bh = Math.min(pitch - 0.04, 0.17 + rnd() * 0.12)
      const bd = 0.15 + rnd() * 0.08
      if (u + bw > w / 2 - t) break
      b.boxM(BOOK_COLOURS[Math.floor(rnd() * BOOK_COLOURS.length)]!, m, bw, bh, bd, u + bw / 2, y0 + t / 2 + bh / 2, d / 2 - 0.01 - bd / 2)
      u += bw + 0.001
    }
  }
  coll(b, m, w, h, d)
}

/** Library card catalogue: oak cabinet of 6 × 5 small drawers on a stand; one drawer pulled. */
export function cardCatalogue(b: Builder, x: number, z: number, yaw: number, rnd: Rnd, opts: { cols?: number; rows?: number } = {}) {
  const cols = opts.cols ?? 6
  const rows = opts.rows ?? 5
  const dw = 0.14
  const dh = 0.12
  const w = cols * dw + 0.06
  const h = rows * dh + 0.06
  const d = 0.44
  const m = at(x, z, yaw)
  const top = 0.72
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(P.oakDark, m, 0.05, top, 0.05, sx * (w / 2 - 0.04), top / 2, sz * (d / 2 - 0.04))
  b.boxM(P.oakDark, m, w - 0.04, 0.06, d - 0.04, 0, top - 0.03, 0)
  b.rbox(P.oak, m, w, h, d, 0.01, 0, top + h / 2, 0)
  b.rbox(P.oak, m, w + 0.04, 0.03, d + 0.03, 0.008, 0, top + h + 0.015, 0)
  const pulled = Math.floor(rnd() * cols * rows)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const u = -w / 2 + 0.03 + dw * (c + 0.5)
      const v = top + 0.03 + dh * (r + 0.5)
      const out = r * cols + c === pulled ? 0.26 : 0
      if (out) {
        b.boxM(P.oak, m, dw - 0.012, dh - 0.012, 0.36, u, v, -d / 2 + 0.18 - out)
        for (let k = 0; k < 14; k++) b.boxM(M.paper, m, dw - 0.03, dh - 0.035, 0.002, u, v + 0.005, -d / 2 - out + 0.04 + k * 0.018, { cast: false })
      } else b.boxM(P.oak, m, dw - 0.012, dh - 0.012, 0.012, u, v, -d / 2 - 0.004)
      b.boxM(KEY_BRASS, m, 0.05, 0.022, 0.004, u, v + 0.025, -d / 2 - 0.012 - out, { cast: false })
      b.boxM(M.paper, m, 0.04, 0.014, 0.002, u, v + 0.025, -d / 2 - 0.0145 - out, { cast: false })
      b.boxM(KEY_BRASS, m, 0.03, 0.012, 0.018, u, v - 0.02, -d / 2 - 0.015 - out)
    }
  coll(b, m, w, top + h + 0.03, d)
}

/** Plain-paper copier (early-80s floor model): cabinet, platen unit with lid, side trays, panel with a ready LED. */
export function copier(b: Builder, x: number, z: number, yaw: number) {
  const m = at(x, z, yaw)
  b.rbox(P.putty, m, 1.05, 0.72, 0.66, 0.02, 0, 0.36, 0)
  b.boxM(M.rubber, m, 1.0, 0.08, 0.6, 0, 0.04, 0.02)
  b.boxM(P.puttyDark, m, 0.96, 0.004, 0.004, 0, 0.42, -0.332, { cast: false })
  b.rbox(P.putty, m, 1.0, 0.24, 0.62, 0.03, 0, 0.84, 0.02)
  b.rbox(P.puttyDark, m, 0.66, 0.035, 0.46, 0.01, -0.1, 0.978, 0.05)
  b.boxM(P.keys, m, 0.25, 0.03, 0.12, 0.33, 0.97, -0.2)
  b.boxM(READY, m, 0.012, 0.004, 0.012, 0.25, 0.987, -0.2, { cast: false })
  for (let k = 0; k < 5; k++) b.boxM(P.putty, m, 0.02, 0.006, 0.02, 0.29 + k * 0.03, 0.987, -0.18, { cast: false })
  // Paper tray and catch tray on the right side.
  b.rbox(P.puttyDark, m.clone().multiply(T(0.6, 0.78, 0.02, 0, 0, -0.12)), 0.22, 0.02, 0.34, 0.006)
  b.boxM(M.paper, m.clone().multiply(T(0.6, 0.795, 0.02, 0, 0, -0.12)), 0.2, 0.012, 0.28, 0, 0, 0, { cast: false })
  b.rbox(P.puttyDark, m, 0.18, 0.12, 0.34, 0.01, -0.58, 0.66, 0.02)
  coll(b, m, 1.3, 1.0, 0.66)
}

/** Daisy-wheel printer under an acoustic hood on a steel stand, fanfold paper box below. */
export function printerHood(b: Builder, x: number, z: number, yaw: number) {
  const m = at(x, z, yaw)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(M.darkSteel, m, 0.03, 0.66, 0.03, sx * 0.4, 0.33, sz * 0.27)
  b.boxM(M.darkSteel, m, 0.84, 0.03, 0.6, 0, 0.66, 0)
  b.boxM(M.darkSteel, m, 0.8, 0.02, 0.56, 0, 0.12, 0)
  b.rbox(M.cardboard, m, 0.42, 0.18, 0.32, 0.01, 0, 0.22, 0)
  b.boxM(M.paper, m, 0.38, 0.02, 0.28, 0, 0.32, 0, { cast: false })
  // Hood: putty shell with a smoked acrylic lid, printer silhouette inside.
  b.rbox(P.putty, m, 0.86, 0.34, 0.62, 0.025, 0, 0.84, 0)
  b.rbox(P.puttyDark, m, 0.6, 0.12, 0.36, 0.02, 0, 0.74, 0.04)
  b.quad(P.smoke, m.clone().multiply(T(0, 1.02, -0.05, 0, -Math.PI / 2 + 0.25)), 0.7, 0.4, { cast: false })
  b.boxM(P.putty, m, 0.86, 0.04, 0.12, 0, 1.03, 0.25)
  // Fanfold paper feeding in at the back.
  b.boxM(M.paper, m.clone().multiply(T(0, 0.5, 0.33, 0, 0.2)), 0.38, 0.4, 0.004, 0, 0, 0, { cast: false })
  coll(b, m, 0.86, 1.05, 0.62)
}

/** Microfiche reader on a surface at height y: body, hood, glowing screen (lamp when on). */
export function ficheReader(b: Builder, x: number, y: number, z: number, yaw: number, on: boolean) {
  const m = T(x, y, z, yaw)
  b.rbox(P.putty, m, 0.4, 0.1, 0.42, 0.02, 0, 0.05, 0)
  b.rbox(P.putty, m.clone().multiply(T(0, 0.1, 0.06, 0, 0.12)), 0.42, 0.42, 0.24, 0.03, 0, 0.21, 0)
  b.rbox(P.puttyDark, m, 0.3, 0.012, 0.18, 0.004, 0, 0.106, -0.13)
  const sm = m.clone().multiply(T(0, 0.33, -0.065, 0, 0.12))
  screen(b, sm, 0.32, 0.25, 0xd8e8c8, { intensity: on ? 0.9 : 0.02, lamp: on })
  b.boxM(P.puttyDark, sm, 0.36, 0.02, 0.02, 0, 0.135, 0.01)
}

/** Flip chart on an easel. */
export function flipChart(b: Builder, x: number, z: number, yaw: number) {
  const m = at(x, z, yaw)
  b.rod(M.steel, pt(m, -0.3, 0, -0.1), pt(m, -0.3, 1.85, 0.05), 0.012, 6)
  b.rod(M.steel, pt(m, 0.3, 0, -0.1), pt(m, 0.3, 1.85, 0.05), 0.012, 6)
  b.rod(M.steel, pt(m, 0, 0, 0.55), pt(m, 0, 1.75, 0.08), 0.012, 6)
  const p = m.clone().multiply(T(0, 1.4, 0.0, 0, -0.08))
  b.rbox(P.board, p, 0.7, 0.9, 0.015, 0.004)
  b.boxM(M.paper, p, 0.66, 0.84, 0.01, 0, -0.02, -0.012, { cast: false })
  b.boxM(M.steel, m, 0.7, 0.04, 0.06, 0, 0.92, -0.05)
  // A sheet thrown over the top.
  b.boxM(M.paper, p.clone().multiply(T(0, 0.45, 0.01, 0, -2.7)), 0.66, 0.004, 0.25, 0, 0, 0.12, { cast: false })
  b.collideLocal(m, [-0.35, 0, -0.15], [0.35, 1.9, 0.55])
}

/** Overhead projector on a surface at height y. */
export function overheadProjector(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.puttyDark, m, 0.36, 0.16, 0.36, 0.02, 0, 0.08, 0)
  b.boxM(M.glass, m, 0.3, 0.004, 0.3, 0, 0.162, 0, { cast: false })
  b.boxM(M.darkSteel, m, 0.03, 0.42, 0.04, 0, 0.37, 0.2)
  b.rbox(M.darkSteel, m, 0.12, 0.1, 0.12, 0.02, 0, 0.6, 0.12)
}

/** Slide projector with a carousel tray, on a surface at height y. */
export function slideProjector(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.puttyDark, m, 0.28, 0.13, 0.32, 0.02, 0, 0.065, 0)
  b.cyl(P.keys, m.clone().multiply(T(0, 0.07, -0.19, 0, Math.PI / 2)), 0.035, 0.04, 0.08, 14)
  b.cyl(P.keys, m.clone().multiply(T(0, 0.17, 0.02)), 0.14, 0.14, 0.07, 28)
  b.cyl(M.darkSteel, m.clone().multiply(T(0, 0.21, 0.02)), 0.03, 0.03, 0.01, 12)
}

/** Magnetic in/out board on a wall at height y (back on the wall, local +Z): name strips with IN/OUT columns and an
 *  "SL" column; `slRows` rows have their magnet on the SL line, the rest OUT. */
export function inOutBoard(b: Builder, x: number, y: number, z: number, yaw: number, rows: number, slRows: number[]) {
  const m = T(x, y, z, yaw)
  const w = 1.2
  const rh = 0.045
  const h = rows * rh + 0.16
  b.rbox(M.frame, m, w + 0.04, h + 0.04, 0.025, 0.006, 0, 0, 0.0125)
  b.boxM(P.board, m, w, h, 0.004, 0, 0, -0.002, { cast: false })
  // Header strip and column rules.
  b.boxM(M.felt, m, w - 0.04, 0.05, 0.003, 0, h / 2 - 0.05, -0.005, { cast: false })
  for (const u of [0.05, 0.25, 0.42]) b.boxM(M.felt, m, 0.004, h - 0.12, 0.003, u, -0.03, -0.005, { cast: false })
  b.boxM(M.red, m, 0.15, 0.03, 0.003, 0.51, h / 2 - 0.05, -0.007, { cast: false })
  for (let r = 0; r < rows; r++) {
    const v = h / 2 - 0.11 - r * rh
    b.boxM(M.paper, m, 0.5, rh - 0.01, 0.003, -0.25, v, -0.005, { cast: false })
    const sl = slRows.includes(r)
    const u = sl ? 0.51 : 0.335
    b.cyl(sl ? P.magnetRed : P.magnetGreen, m.clone().multiply(T(u, v, -0.012, 0, Math.PI / 2)), 0.014, 0.014, 0.01, 12, { cast: false })
  }
}

/** Library book truck: three sloped shelves on casters, half full. */
export function bookTruck(b: Builder, x: number, z: number, yaw: number, rnd: Rnd) {
  const m = at(x, z, yaw)
  const w = 0.85
  const d = 0.4
  for (const s of [-1, 1]) b.boxM(M.darkSteel, m, 0.02, 1.0, d, s * (w / 2 - 0.01), 0.58, 0)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(M.rubber, m.clone().multiply(T(sx * (w / 2 - 0.05), 0.04, sz * (d / 2 - 0.05), 0, 0, Math.PI / 2)), 0.04, 0.04, 0.025, 12)
  for (let k = 0; k < 3; k++) {
    const y = 0.18 + k * 0.32
    const sh = m.clone().multiply(T(0, y, 0, 0, 0.18))
    b.boxM(M.darkSteel, sh, w - 0.04, 0.015, d, 0, 0, 0)
    let u = -w / 2 + 0.04
    while (u < w / 2 - 0.08) {
      if (rnd() < 0.3) {
        u += 0.06
        continue
      }
      const bw = 0.025 + rnd() * 0.035
      const bh = 0.18 + rnd() * 0.08
      b.boxM(BOOK_COLOURS[Math.floor(rnd() * BOOK_COLOURS.length)]!, sh, bw, bh, 0.16 + rnd() * 0.06, u + bw / 2, bh / 2 + 0.008, 0.06)
      u += bw + 0.002
    }
  }
  coll(b, m, w, 1.1, d)
}

/** Fibreglass planter with a rubber plant (stem, glossy leaves). */
export function planter(b: Builder, x: number, z: number, rnd: Rnd, h = 1.1) {
  b.cyl(P.potWhite, T(x, FLOOR_Y + 0.22, z), 0.2, 0.17, 0.44, 20)
  b.cyl(M.soil, T(x, FLOOR_Y + 0.43, z), 0.185, 0.185, 0.01, 16, { cast: false })
  const top = FLOOR_Y + 0.44 + h
  b.rod(M.wood, [x, FLOOR_Y + 0.42, z], [x + 0.03, top, z - 0.02], 0.012, 6)
  for (let k = 0; k < 14; k++) {
    const t = 0.25 + (k / 14) * 0.75
    const a = k * 2.4 + rnd() * 0.5
    const y = FLOOR_Y + 0.44 + h * t
    const len = 0.16 + rnd() * 0.08
    const g = new THREE.SphereGeometry(1, 8, 4)
    g.scale(len, 0.008, len * 0.38)
    g.translate(len * 0.8, 0, 0)
    g.rotateZ(-0.35 - rnd() * 0.4)
    g.rotateY(a)
    g.translate(x + 0.02 * t, y, z)
    b.add(rnd() < 0.5 ? M.leaf : P.leafDark, g, { cast: true })
  }
  b.collide(x - 0.2, FLOOR_Y, z - 0.2, x + 0.2, FLOOR_Y + 0.44, z + 0.2)
}

/** Vertical blinds along a glazed wall: a head rail and slats, partly turned open. `axis` "x": blind runs along x at
 *  z = c (slats offset towards `side`). */
export function verticalBlinds(b: Builder, axis: "x" | "z", c: number, from: number, to: number, rnd: Rnd, opts: { y0?: number; y1?: number; open?: number } = {}) {
  const y1 = FLOOR_Y + (opts.y1 ?? 2.3)
  const y0 = FLOOR_Y + (opts.y0 ?? 0.95)
  const slat = paint(0xa8a28c, 0.7)
  if (axis === "x") b.box(M.beige, from, y1, c - 0.03, to, y1 + 0.04, c + 0.03, { cast: false })
  else b.box(M.beige, c - 0.03, y1, from, c + 0.03, y1 + 0.04, to, { cast: false })
  const open = opts.open ?? 0.9
  // Bunched (drawn) section at one end, the rest hanging, turned.
  for (let u = from + 0.06; u < to - 0.04; u += 0.085) {
    const turn = open + (rnd() - 0.5) * 0.18
    const m = axis === "x" ? T(u, (y0 + y1) / 2, c, turn) : T(c, (y0 + y1) / 2, u, Math.PI / 2 + turn)
    b.boxM(slat, m, 0.089, y1 - y0, 0.003, 0, 0, 0, { cast: false })
    b.boxM(M.beige, m, 0.03, 0.012, 0.012, 0, -(y1 - y0) / 2 - 0.004, 0, { cast: false })
  }
}

/** AV cart (steel, two shelves, casters); returns the top's height for a television. */
export function avCart(b: Builder, x: number, z: number, yaw: number) {
  const m = at(x, z, yaw)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.boxM(M.darkSteel, m, 0.025, 1.0, 0.025, sx * 0.3, 0.55, sz * 0.22)
    b.cyl(M.rubber, m.clone().multiply(T(sx * 0.3, 0.035, sz * 0.22, 0, 0, Math.PI / 2)), 0.035, 0.035, 0.02, 10)
  }
  for (const y of [0.2, 0.62, 1.05]) b.rbox(M.darkSteel, m, 0.66, 0.025, 0.5, 0.006, 0, y, 0)
  coll(b, m, 0.66, 1.07, 0.5)
  return FLOOR_Y + 1.063
}

/** Security container (GSA-style two-drawer safe) in the vault, back on the wall. */
export function securityContainer(b: Builder, x: number, z: number, yaw: number, drawers = 4) {
  const m = at(x, z, yaw)
  const h = drawers * 0.33 + 0.08
  b.rbox(M.cabinet, m, 0.55, h, 0.72, 0.01, 0, h / 2, 0)
  for (let k = 0; k < drawers; k++) {
    const v = 0.04 + 0.33 * (k + 0.5)
    b.boxM(M.darkSteel, m, 0.5, 0.004, 0.004, 0, v + 0.165, -0.362, { cast: false })
    b.boxM(M.steel, m, 0.16, 0.025, 0.035, 0, v + 0.06, -0.375)
    b.boxM(M.paper, m, 0.08, 0.04, 0.003, 0, v - 0.04, -0.362, { cast: false })
  }
  b.cyl(M.darkSteel, m.clone().multiply(T(0, h - 0.2, -0.37, 0, Math.PI / 2)), 0.04, 0.045, 0.025, 20)
  coll(b, m, 0.55, h, 0.72)
}

/** Combination dial and spoked bolt wheel for a vault door leaf: added as children of the leaf object so they swing
 *  with it if the door ever unlocks. `leaf` frame: hinge at origin, panel along +x (width lw), front face +z. */
export function vaultHardware(leaf: THREE.Object3D, lw: number) {
  const add = (g: THREE.BufferGeometry, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(g, mat)
    mesh.castShadow = true
    leaf.add(mesh)
  }
  const z = 0.0225
  // Dial: knurled ring, numbered face, spindle.
  add(new THREE.CylinderGeometry(0.075, 0.08, 0.03, 32).rotateX(Math.PI / 2).translate(lw * 0.5, 1.45, z + 0.015), P.vaultDark)
  add(new THREE.CylinderGeometry(0.06, 0.06, 0.035, 32).rotateX(Math.PI / 2).translate(lw * 0.5, 1.45, z + 0.02), P.vault)
  add(new THREE.CylinderGeometry(0.015, 0.015, 0.02, 12).rotateX(Math.PI / 2).translate(lw * 0.5, 1.45, z + 0.045), P.vaultDark)
  // Three-spoke bolt wheel below it.
  const hub = new THREE.Vector3(lw * 0.5, 1.08, z + 0.05)
  add(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 16).rotateX(Math.PI / 2).translate(hub.x, hub.y, z + 0.03), P.vault)
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3
    const g = new THREE.CylinderGeometry(0.011, 0.011, 0.2, 8).rotateZ(a).translate(hub.x + Math.sin(-a) * 0.1, hub.y + Math.cos(a) * 0.1, hub.z)
    add(g, P.vault)
    add(new THREE.SphereGeometry(0.022, 12, 8).translate(hub.x + Math.sin(-a) * 0.2, hub.y + Math.cos(a) * 0.2, hub.z), P.vaultDark)
  }
  // Strap hinge bands on the face.
  for (const y of [0.35, 1.8]) add(new THREE.BoxGeometry(0.22, 0.06, 0.012).translate(0.12, y, z + 0.006), P.vaultDark)
}

/** Simple timber table (reading table, sorting table, typing table). */
export function table(b: Builder, x: number, z: number, yaw: number, w: number, d: number, opts: { h?: number; mat?: Mat; legs?: Mat } = {}) {
  const h = opts.h ?? 0.74
  const m = at(x, z, yaw)
  b.rbox(opts.mat ?? P.oak, m, w, 0.035, d, 0.008, 0, h - 0.0175, 0)
  b.boxM(opts.legs ?? P.oakDark, m, w - 0.12, 0.08, d - 0.12, 0, h - 0.075, 0)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(opts.legs ?? P.oakDark, m, 0.055, h - 0.035, 0.055, sx * (w / 2 - 0.06), (h - 0.035) / 2, sz * (d / 2 - 0.06))
  coll(b, m, w, h, d)
  return FLOOR_Y + h
}

/** Periodicals display rack: sloped shelves with magazines face-out, back on the wall. */
export function periodicalsRack(b: Builder, x: number, z: number, yaw: number, rnd: Rnd) {
  const m = at(x, z, yaw)
  const w = 1.2
  for (const s of [-1, 1]) b.boxM(P.oak, m, 0.025, 1.6, 0.4, s * (w / 2 - 0.0125), 0.8, 0)
  b.boxM(P.oakDark, m, w - 0.05, 1.55, 0.01, 0, 0.8, 0.19)
  for (let k = 0; k < 4; k++) {
    const sh = m.clone().multiply(T(0, 0.35 + k * 0.36, 0.02, 0, -0.35))
    b.boxM(P.oak, sh, w - 0.05, 0.3, 0.015, 0, 0.12, 0)
    b.boxM(P.oak, sh, w - 0.05, 0.04, 0.03, 0, -0.03, -0.02)
    for (let j = 0; j < 4; j++)
      if (rnd() < 0.85) b.boxM(BOOK_COLOURS[Math.floor(rnd() * BOOK_COLOURS.length)]!, sh, 0.21, 0.28, 0.006, -0.42 + j * 0.28, 0.13, -0.012, { cast: false })
  }
  coll(b, m, w, 1.6, 0.4)
}

/** Folding step stool. */
export function stepStool(b: Builder, x: number, z: number, yaw: number) {
  const m = at(x, z, yaw)
  b.cyl(M.darkSteel, m.clone().multiply(T(0, 0.2, 0)), 0.15, 0.2, 0.4, 20, { open: true })
  b.cyl(M.rubber, m.clone().multiply(T(0, 0.405, 0)), 0.15, 0.15, 0.012, 20)
  b.cyl(M.rubber, m.clone().multiply(T(0, 0.01, 0)), 0.2, 0.2, 0.02, 20)
  b.collide(x - 0.2, FLOOR_Y, z - 0.2, x + 0.2, FLOOR_Y + 0.41, z + 0.2)
}

/** Cork notice board on a wall (back at local +Z), centred at height y; returns its face frame for documents. */
export function corkBoard(b: Builder, x: number, y: number, z: number, yaw: number, w: number, h: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.oak, m, w + 0.05, h + 0.05, 0.02, 0.005, 0, 0, 0.01)
  b.boxM(M.cork, m, w, h, 0.006, 0, 0, -0.002, { cast: false })
  return { face: pt(m, 0, 0, -0.005), normal: [-Math.sin(yaw), 0, -Math.cos(yaw)] as [number, number, number] }
}

/** Pull-down projection screen in its case below the ceiling, pulled part way. */
export function projectionScreen(b: Builder, x: number, z: number, yaw: number, w = 2.0, drop = 1.3) {
  const m = T(x, CEIL_Y - 0.08, z, yaw)
  b.rbox(M.darkSteel, m, w + 0.12, 0.08, 0.08, 0.02)
  b.boxM(paint(0xd8d8d0, 0.6), m, w, drop, 0.003, 0, -drop / 2 - 0.04, 0, { cast: false })
  b.boxM(M.darkSteel, m, w + 0.02, 0.02, 0.02, 0, -drop - 0.05, 0)
}

/** Telephone + desk props shared by desks: places a model batch (caller collects). */
export function deskTopY() {
  return FLOOR_Y + 0.787
}

/** Low steel credenza / AV cabinet, back at local +Z. */
export function credenza(b: Builder, x: number, z: number, yaw: number, w = 1.8, mat: Mat = M.veneerDark) {
  const m = at(x, z, yaw)
  b.rbox(mat, m, w, 0.72, 0.48, 0.01, 0, 0.36, 0)
  b.rbox(M.veneer, m, w + 0.02, 0.03, 0.5, 0.008, 0, 0.735, 0)
  for (let k = 1; k < Math.round(w / 0.45); k++) b.boxM(M.felt, m, 0.004, 0.62, 0.004, -w / 2 + k * (w / Math.round(w / 0.45)), 0.36, -0.242, { cast: false })
  coll(b, m, w, 0.75, 0.48)
  return FLOOR_Y + 0.75
}

export { placeModels }

/** Terminal (VT100-class) built here so the lit screen sits exactly in its bezel: putty body tapering back, recessed
 *  phosphor screen, detached keyboard in front. On a surface at height y, screen towards local −Z. */
export function crtTerminal(b: Builder, x: number, y: number, z: number, yaw: number, on: boolean) {
  const m = T(x, y, z, yaw)
  b.rbox(P.putty, m, 0.42, 0.34, 0.3, 0.03, 0, 0.2, 0.0)
  b.rbox(P.putty, m, 0.32, 0.26, 0.2, 0.04, 0, 0.19, 0.2)
  b.rbox(P.puttyDark, m, 0.34, 0.03, 0.26, 0.01, 0, 0.015, 0.05)
  b.rbox(P.keys, m, 0.33, 0.25, 0.02, 0.01, 0, 0.21, -0.145)
  const sm = m.clone().multiply(T(0, 0.21, -0.153, Math.PI))
  b.quad(on ? PHOSPHOR : SCREEN_OFF, sm, 0.27, 0.2, { cast: false })
  const kb = m.clone().multiply(T(0, 0.02, -0.34, 0, 0.08))
  b.rbox(P.putty, kb, 0.46, 0.035, 0.18, 0.01, 0, 0, 0)
  for (let r = 0; r < 4; r++) for (let k = 0; k < 13; k++) b.boxM(P.keys, kb, 0.024, 0.01, 0.024, -0.19 + k * 0.03 + (r % 2) * 0.01, 0.02, -0.05 + r * 0.033, { cast: false })
  if (on) {
    const p = pt(m, 0, 0.21, -0.45)
    b.lamp({ kind: "window", position: p, color: [0.35, 1.0, 0.45], intensity: 0.9, range: 2.6, size: 0.2 })
  }
}
const PHOSPHOR = glow(0x020502, 0x3cff64, 0.8, "s1_crt_phosphor")
const SCREEN_OFF = paint(0x0d1210, 0.12)

/** Deck heights of the `steel_shelves` model (measured from the asset): bottom, two intermediate decks, top. */
export const SHELF_DECKS = [0.07, 0.67, 1.32, 2.315] as const
const BOX_TONES = [0x6a5236, 0x75603f, 0x5e4a30, 0x806a48].map((c) => paint(c, 0.9))

/** Fill one `steel_shelves` unit (placed at x, z with yaw π/2: long side along z) with storage boxes from both
 *  aisles, or books (`books`), on the given decks. */
export function fillShelf(b: Builder, x: number, z: number, rnd: Rnd, opts: { books?: boolean; decks?: readonly number[]; y0?: number; gap?: number } = {}) {
  const half = 1.13
  const y0 = (opts.y0 ?? FLOOR_Y)
  for (const deck of opts.decks ?? SHELF_DECKS.slice(0, 3)) {
    const y = y0 + deck
    for (const s of [-1, 1]) {
      let u = z - half
      while (u < z + half - 0.05) {
        if (rnd() < (opts.gap ?? 0.08)) {
          u += opts.books ? 0.05 + rnd() * 0.15 : 0.31
          continue
        }
        if (opts.books) {
          const bw = 0.022 + rnd() * 0.04
          if (u + bw > z + half) break
          const bh = 0.2 + rnd() * 0.1
          const bd = 0.17 + rnd() * 0.08
          const x0 = s > 0 ? x + 0.33 - bd : x - 0.33
          b.box(BOOK_COLOURS[Math.floor(rnd() * BOOK_COLOURS.length)]!, x0, y, u, x0 + bd, y + bh, u + bw, { skip: "y" })
          u += bw + 0.002
        } else {
          const w = 0.3
          if (u + w > z + half) break
          const h = 0.25
          const x0 = s > 0 ? x + 0.005 : x - 0.345
          const x1 = x0 + 0.34
          b.box(BOX_TONES[Math.floor(rnd() * BOX_TONES.length)]!, x0, y, u + 0.005, x1, y + h, u + w - 0.005, { skip: "y" })
          // Label card and a hand hole on the aisle face.
          const fx = s > 0 ? x1 + 0.002 : x0 - 0.002
          b.box(M.paper, fx - 0.001, y + 0.12, u + 0.08, fx + 0.001, y + 0.2, u + 0.22, { cast: false })
          b.box(M.felt, fx - 0.001, y + 0.04, u + 0.12, fx + 0.001, y + 0.07, u + 0.18, { cast: false })
          u += w
        }
      }
    }
  }
}
