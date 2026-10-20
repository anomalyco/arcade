import * as THREE from "three/webgpu"
import { type Builder, type Mat, CEIL_Y, FLOOR_Y, INCANDESCENT, M, T, WARM } from "../../api"
import { BRASS, CERAMIC, GYPSUM, HARDHAT, LEATHER, LED_AMBER, LED_GREEN, LED_RED, PLY, RUBBLE, RUST, SELECTRIC, SHADE, SHADE_LIT, TIMBER } from "./mats"

// Storey 4's procedural set dressing (construction kit on the west half, Directorate furnishings on the east). Frame
// convention as the kit's fixtures: (x, z) on the floor, front faces local −Z, everything adds its own colliders.

export type Rnd = () => number
export const rng = (seed: number): Rnd => () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

const pt = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0) => b.collideLocal(m, [ox - w / 2, 0, oz - d / 2], [ox + w / 2, h, oz + d / 2])

// ------------------------------------------------------------------------------------------------ construction

/** Timber sawhorse: 2.4 m-ish beam on four splayed legs, beam along local x. */
export function sawhorse(b: Builder, x: number, z: number, yaw: number, len = 1.1) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(TIMBER, m, len, 0.09, 0.045, 0.004, 0, 0.72, 0)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) b.rod(TIMBER, pt(m, sx * (len / 2 - 0.12), 0.7, 0), pt(m, sx * (len / 2 - 0.02), 0, sz * 0.26), 0.02, 4)
  for (const sx of [-1, 1]) b.boxM(TIMBER, m, 0.02, 0.09, 0.4, sx * (len / 2 - 0.08), 0.3, 0)
  coll(b, m, len, 0.75, 0.55)
}

/** Aluminium A-frame step ladder, open, rungs facing local −Z. */
export function stepLadder(b: Builder, x: number, z: number, yaw: number, h = 1.8) {
  const m = T(x, FLOOR_Y, z, yaw)
  const spread = h * 0.3
  for (const sx of [-0.22, 0.22]) {
    b.rod("metal_galvanized", pt(m, sx, 0, -spread), pt(m, sx * 0.85, h, -0.03), 0.016, 6)
    b.rod("metal_galvanized", pt(m, sx, 0, spread), pt(m, sx * 0.85, h, 0.03), 0.014, 6)
  }
  for (let k = 1; k <= 4; k++) {
    const f = k / 5
    const w = 0.44 - f * 0.07
    b.boxM("metal_galvanized", m, w, 0.025, 0.09, 0, f * h, -spread * (1 - f) - 0.03)
  }
  b.rbox(M.safety, m, 0.4, 0.05, 0.2, 0.01, 0, h + 0.02, 0)
  b.rod(M.darkSteel, pt(m, -0.18, h * 0.45, -spread * 0.55), pt(m, -0.18, h * 0.45, spread * 0.55), 0.005, 4)
  coll(b, m, 0.5, h, spread * 2)
}

/** Cable reel (plywood drum, black cable wound on it); `standing` on its rim, else lying flat. */
export function cableReel(b: Builder, x: number, z: number, yaw: number, standing: boolean, r = 0.38) {
  const w = 0.42
  const base = standing ? T(x, FLOOR_Y + r, z, yaw, 0, Math.PI / 2) : T(x, FLOOR_Y + w / 2, z, yaw)
  for (const s of [-1, 1]) b.cyl(PLY, base.clone().multiply(T(0, s * (w / 2 - 0.015), 0)), r, r, 0.03, 20)
  b.cyl(M.rubber, base, r * 0.78, r * 0.78, w - 0.04, 20, { open: true })
  b.cyl(TIMBER, base, 0.1, 0.1, w, 10)
  if (standing) b.collide(x - 0.4, FLOOR_Y, z - 0.4, x + 0.4, FLOOR_Y + 2 * r, z + 0.4)
  else b.collide(x - r, FLOOR_Y, z - r, x + r, FLOOR_Y + w, z + r)
}

/** Stack of gypsum board (1.22 × 2.44 m) on two timber dunnage bearers; long side along local x. */
export function drywallStack(b: Builder, x: number, z: number, yaw: number, sheets = 14, rnd: Rnd) {
  const m = T(x, FLOOR_Y, z, yaw)
  for (const u of [-0.8, 0.8]) b.boxM(TIMBER, m, 0.09, 0.09, 1.25, u, 0.045, 0)
  const t = 0.0127
  const h = sheets * t
  b.rbox(GYPSUM, m, 2.44, h, 1.22, 0.004, 0, 0.09 + h / 2, 0)
  // Sheet edges on the long sides and a few sheets slid out of true.
  for (let k = 1; k < sheets; k += 2) for (const s of [-1, 1]) b.boxM(M.debris, m, 2.42, 0.0015, 0.002, 0, 0.09 + k * t, s * 0.611, { cast: false })
  const top = rnd() * 0.08 - 0.04
  b.boxM(GYPSUM, T(x, FLOOR_Y, z, yaw + top), 2.44, t, 1.22, 0.04, 0.09 + h + t / 2, 0.03)
  b.collideLocal(m, [-1.25, 0, -0.62], [1.25, 0.1 + h + t, 0.62])
}

/** Bundle of steel studs lying on the floor (length along local x). */
export function studBundle(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) b.boxM(M.steel, m, 3.0, 0.04, 0.092, 0, 0.02 + j * 0.042, -0.25 + i * 0.1)
  b.boxM(M.rubber, m, 0.02, 0.1, 0.62, -0.8, 0.05, 0.0, { cast: false })
  b.boxM(M.rubber, m, 0.02, 0.1, 0.62, 0.8, 0.05, 0.0, { cast: false })
  b.collideLocal(m, [-1.5, 0, -0.3], [1.5, 0.09, 0.3])
}

/** Wheeled tilt-truck rubbish hopper (1 cu yd) heaped with plaster rubble and offcuts. */
export function rubbleHopper(b: Builder, x: number, z: number, yaw: number, rnd: Rnd) {
  const m = T(x, FLOOR_Y, z, yaw)
  // Steel cradle on castors.
  for (const sx of [-1, 1]) {
    b.boxM(M.darkSteel, m, 0.05, 0.05, 1.3, sx * 0.42, 0.16, 0)
    for (const sz of [-1, 1]) {
      b.cyl(M.rubber, m.clone().multiply(T(sx * 0.42, 0.06, sz * 0.55, 0, 0, Math.PI / 2)), 0.06, 0.06, 0.04, 12)
      b.boxM(M.darkSteel, m, 0.03, 0.08, 0.03, sx * 0.42, 0.12, sz * 0.55)
    }
  }
  // Tapered hopper body: floor, sides, sloping front.
  const y0 = 0.2
  b.boxM(RUST, m, 0.8, 0.03, 0.9, 0, y0, 0.1)
  for (const sx of [-1, 1]) b.boxM(RUST, m, 0.03, 0.85, 1.2, sx * 0.43, y0 + 0.42, 0)
  b.boxM(RUST, m, 0.86, 0.85, 0.03, 0, y0 + 0.42, 0.6)
  b.boxM(RUST, T(...pt(m, 0, y0 + 0.4, -0.45), yaw, 0.5), 0.86, 0.95, 0.03)
  b.boxM(M.safety, m, 0.9, 0.05, 1.24, 0, y0 + 0.86, 0, { cast: false })
  // Rubble heap: lumps and broken board.
  for (let k = 0; k < 22; k++) {
    const s = 0.08 + rnd() * 0.16
    b.boxM(k % 4 === 0 ? GYPSUM : RUBBLE, T(...pt(m, (rnd() - 0.5) * 0.7, y0 + 0.7 + rnd() * 0.3, (rnd() - 0.5) * 0.9), rnd() * 3, rnd(), rnd()), s, s * 0.6, s * 0.9)
  }
  b.boxM(GYPSUM, T(...pt(m, 0.1, y0 + 1.0, 0.1), yaw + 0.4, 0.7, 0.3), 0.6, 0.012, 0.9)
  coll(b, m, 0.92, 1.1, 1.3)
}

/** Loose rubble and plaster dust on the slab around (x, z). */
export function rubbleScatter(b: Builder, x: number, z: number, r: number, rnd: Rnd, n = 14) {
  for (let k = 0; k < n; k++) {
    const s = 0.03 + rnd() * 0.09
    const a = rnd() * Math.PI * 2
    const d = Math.sqrt(rnd()) * r
    b.boxM(k % 3 ? RUBBLE : GYPSUM, T(x + Math.cos(a) * d, FLOOR_Y + s * 0.25, z + Math.sin(a) * d, rnd() * 3, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4), s, s * 0.5, s * 0.8, 0, 0, 0, { cast: false })
  }
}

/** Builder's hard hat (dome with a brim) resting at (x, y, z). */
export function hardHat(b: Builder, x: number, y: number, z: number, yaw: number, mat: Mat = HARDHAT) {
  const g = new THREE.SphereGeometry(0.11, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  g.scale(1.1, 0.95, 1.25)
  g.applyMatrix4(T(x, y + 0.012, z, yaw))
  b.add(mat, g, { worldUV: false })
  const brim = new THREE.CylinderGeometry(0.15, 0.15, 0.012, 20)
  brim.scale(1, 1, 1.25)
  brim.applyMatrix4(T(x, y + 0.012, z - 0.02, yaw))
  b.add(mat, brim, { worldUV: false })
  b.boxM(mat, T(x, y + 0.08, z, yaw), 0.02, 0.06, 0.26, 0, 0, 0, { cast: false })
}

/** Plastic tarp thrown over a heap (a draped mound) at (x, z), w × d. */
export function drapedTarp(b: Builder, x: number, z: number, yaw: number, w: number, d: number, h: number, mat: Mat, rnd: Rnd) {
  const g = new THREE.PlaneGeometry(w, d, 14, 10)
  const pos = g.getAttribute("position")
  const ph = rnd() * 6
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / (w / 2)
    const v = pos.getY(i) / (d / 2)
    const e = Math.max(Math.abs(u), Math.abs(v))
    const body = e < 0.78 ? h * (1 - Math.pow(e / 0.78, 6)) : 0
    pos.setZ(i, body + Math.sin(u * 7 + ph) * 0.02 + Math.sin(v * 9 + ph) * 0.015 + (e >= 0.78 ? 0.006 + (1 - e) * 0.03 : 0))
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, FLOOR_Y + 0.003, z, yaw, -Math.PI / 2))
  b.add(mat, g, { worldUV: false })
  b.collideLocal(T(x, FLOOR_Y, z, yaw), [-w * 0.39, 0, -d * 0.39], [w * 0.39, h, d * 0.39])
}

// ------------------------------------------------------------------------------------------------ directorate

/** Table lamp: ceramic urn base, pleated drum shade; lit = warm shade + incandescent lamp. */
export function tableLamp(b: Builder, x: number, y: number, z: number, on: boolean, intensity = 14) {
  const vase = new THREE.LatheGeometry([new THREE.Vector2(0.0, 0), new THREE.Vector2(0.08, 0.005), new THREE.Vector2(0.1, 0.08), new THREE.Vector2(0.09, 0.2), new THREE.Vector2(0.04, 0.3), new THREE.Vector2(0.025, 0.34)], 20)
  vase.translate(x, y, z)
  b.add(CERAMIC, vase)
  b.rod(BRASS, [x, y + 0.34, z], [x, y + 0.5, z], 0.008, 6)
  b.cyl(on ? SHADE_LIT : SHADE, T(x, y + 0.53, z), 0.12, 0.17, 0.24, 24, { open: true, cast: false })
  if (on) b.lamp({ kind: "incandescent", position: [x, y + 0.48, z], color: INCANDESCENT, intensity, range: 5, size: 0.1 })
}

/** Floor lamp: weighted base, brass pole, drum shade at 1.55 m. */
export function floorLamp(b: Builder, x: number, z: number, on: boolean, intensity = 30, shadow = false) {
  b.cyl(BRASS, T(x, FLOOR_Y + 0.015, z), 0.16, 0.17, 0.03, 20)
  b.rod(BRASS, [x, FLOOR_Y + 0.03, z], [x, FLOOR_Y + 1.42, z], 0.011, 8)
  b.cyl(on ? SHADE_LIT : SHADE, T(x, FLOOR_Y + 1.55, z), 0.17, 0.22, 0.3, 24, { open: true, cast: false })
  b.collide(x - 0.17, FLOOR_Y, z - 0.17, x + 0.17, FLOOR_Y + 1.7, z + 0.17)
  if (on) b.lamp({ kind: "incandescent", position: [x, FLOOR_Y + 1.48, z], color: WARM, intensity, range: 6.5, shadow, size: 0.12 })
}

/** Framed picture on a wall plane (back at local +Z), w × h, with a dark mount and a photo face. */
export function frame(b: Builder, x: number, y: number, z: number, yaw: number, w: number, h: number, face: Mat) {
  const m = T(x, y, z, yaw)
  b.rbox(M.veneerDark, m, w, h, 0.03, 0.005, 0, 0, 0.015)
  b.boxM(M.paper, m, w - 0.06, h - 0.06, 0.004, 0, 0, -0.001, { cast: false })
  b.boxM(face, m, w - 0.16, h - 0.16, 0.004, 0, 0, -0.003, { cast: false })
}

/** IBM Selectric-style typewriter on a desk top (y), front −Z: sculpted body, platen, golf-ball cover. */
export function selectric(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(SELECTRIC, m, 0.5, 0.11, 0.4, 0.04, 0, 0.055, 0)
  b.rbox(SELECTRIC, m, 0.48, 0.07, 0.18, 0.03, 0, 0.13, 0.08)
  b.rbox(M.darkSteel, m, 0.38, 0.02, 0.15, 0.008, 0, 0.11, -0.12)
  b.cyl(M.rubber, m.clone().multiply(T(0, 0.17, 0.05, 0, 0, Math.PI / 2)), 0.03, 0.03, 0.46, 14)
  for (const s of [-1, 1]) b.cyl(M.darkSteel, m.clone().multiply(T(s * 0.25, 0.17, 0.05, 0, 0, Math.PI / 2)), 0.025, 0.025, 0.03, 12)
  b.boxM(LED_RED, m, 0.01, 0.01, 0.004, 0.2, 0.08, -0.201, { cast: false })
}

/** Intercom box (speaker grille, talk bar, call keys, a red "line" LED) on a desk, front −Z. */
export function intercom(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(M.beige, T(...pt(m, 0, 0.05, 0), yaw, -0.25), 0.24, 0.1, 0.16, 0.015)
  for (let k = 0; k < 6; k++) b.boxM(M.darkSteel, T(...pt(m, 0, 0.075, -0.02), yaw, -0.25), 0.15, 0.004, 0.006, 0, 0.026, -0.06 + k * 0.016, { cast: false })
  for (let k = 0; k < 4; k++) b.boxM(k === 0 ? LED_RED : M.felt, T(...pt(m, 0, 0.06, -0.06), yaw, -0.25), 0.03, 0.012, 0.02, -0.08 + k * 0.05, 0.03, 0.0, { cast: false })
  b.rod(M.rubber, pt(m, 0.1, 0.01, 0.08), pt(m, 0.35, 0.0, 0.25), 0.003, 4)
}

/** Heavy floor safe (combination dial, handle) in a corner, front −Z. */
export function safe(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(M.frame, m, 0.75, 1.05, 0.7, 0.03, 0, 0.6, 0)
  b.boxM(M.darkSteel, m, 0.76, 0.08, 0.66, 0, 0.04, 0)
  b.rbox(M.frame, m, 0.62, 0.86, 0.04, 0.015, 0, 0.6, -0.355)
  b.cyl(M.steel, m.clone().multiply(T(-0.08, 0.78, -0.39, 0, Math.PI / 2)), 0.06, 0.065, 0.035, 24)
  b.cyl(M.darkSteel, m.clone().multiply(T(-0.08, 0.78, -0.41, 0, Math.PI / 2)), 0.02, 0.02, 0.02, 12)
  b.rod(M.steel, pt(m, 0.15, 0.6, -0.39), pt(m, 0.15, 0.6, -0.45), 0.012, 8)
  b.rod(M.steel, pt(m, 0.15, 0.6, -0.45), pt(m, 0.15, 0.48, -0.45), 0.012, 8)
  b.boxM(BRASS, m, 0.18, 0.04, 0.004, 0, 0.98, -0.377, { cast: false })
  coll(b, m, 0.76, 1.13, 0.72)
}

/** Shredder head on its bin, the bin overflowing with strips. */
export function shredder(b: Builder, x: number, z: number, yaw: number, rnd: Rnd) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(M.beige, m, 0.42, 0.62, 0.32, 0.02, 0, 0.31, 0)
  b.rbox(M.darkSteel, m, 0.44, 0.14, 0.34, 0.02, 0, 0.69, 0)
  b.boxM(M.felt, m, 0.3, 0.005, 0.02, 0, 0.762, 0, { cast: false })
  b.boxM(LED_GREEN, m, 0.012, 0.012, 0.004, 0.16, 0.7, -0.171, { cast: false })
  // Strips spilling out of the half-open bin and onto the floor.
  for (let k = 0; k < 30; k++) {
    const a = rnd() * Math.PI * 2
    const d = 0.15 + rnd() * 0.45
    b.boxM(M.paper, T(x + Math.cos(a) * d, FLOOR_Y + 0.003 + k * 0.0004, z + Math.sin(a) * d, rnd() * 3), 0.005, 0.0015, 0.12 + rnd() * 0.2, 0, 0, 0, { cast: false })
  }
  coll(b, m, 0.44, 0.76, 0.34)
}

/** Bookcase against a wall (back at local +Z): veneer carcass, five shelves of books. */
export function bookcase(b: Builder, x: number, z: number, yaw: number, rnd: Rnd, w = 0.9) {
  const m = T(x, FLOOR_Y, z, yaw)
  const d = 0.32
  const h = 2.0
  for (const s of [-1, 1]) b.boxM(M.veneer, m, 0.02, h, d, s * (w / 2 - 0.01), h / 2, 0)
  b.boxM(M.veneer, m, w, 0.02, d, 0, h - 0.01, 0)
  b.boxM(M.veneerDark, m, w - 0.04, h, 0.01, 0, h / 2, d / 2 - 0.005)
  const cols = [M.red, M.blue, M.leaf, M.cardboard, LEATHER, M.jugBrown, M.beige]
  for (let s = 0; s < 5; s++) {
    const y = 0.08 + s * 0.38
    b.boxM(M.veneer, m, w - 0.04, 0.02, d - 0.01, 0, y, 0)
    let u = -w / 2 + 0.03
    while (u < w / 2 - 0.06) {
      const bw = 0.025 + rnd() * 0.035
      const bh = 0.2 + rnd() * 0.1
      if (rnd() < 0.08) {
        u += 0.08
        continue
      }
      b.boxM(cols[Math.floor(rnd() * cols.length)]!, m, bw, bh, 0.2 + rnd() * 0.05, u + bw / 2, y + 0.01 + bh / 2, 0.02, { cast: false })
      u += bw + 0.002
    }
  }
  coll(b, m, w, h, d)
}

/** Sideboard / credenza against a wall, back at local +Z, length along x. */
export function credenza(b: Builder, x: number, z: number, yaw: number, len = 1.8) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(M.veneer, m, len, 0.68, 0.48, 0.01, 0, 0.42, 0)
  b.boxM(M.veneerDark, m, len - 0.06, 0.08, 0.42, 0, 0.04, 0.02)
  b.rbox(M.veneerDark, m, len + 0.02, 0.03, 0.5, 0.006, 0, 0.775, 0)
  const n = Math.round(len / 0.45)
  for (let k = 0; k < n; k++) {
    const u = -len / 2 + (len * (k + 0.5)) / n
    b.boxM(M.veneerDark, m, 0.004, 0.6, 0.004, u + len / n / 2, 0.42, -0.241, { cast: false })
    b.boxM(BRASS, m, 0.012, 0.08, 0.02, u + len / n / 2 - 0.04, 0.5, -0.25)
  }
  coll(b, m, len, 0.79, 0.5)
  return FLOOR_Y + 0.79
}

/** Crystal decanter with whisky and two tumblers on a silver tray, on a top at height y. */
export function decanter(b: Builder, x: number, y: number, z: number) {
  b.cyl(M.steel, T(x, y + 0.006, z), 0.2, 0.2, 0.012, 24)
  const g = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.065, 0.004), new THREE.Vector2(0.075, 0.12), new THREE.Vector2(0.05, 0.18), new THREE.Vector2(0.02, 0.22), new THREE.Vector2(0.02, 0.26)], 20)
  g.translate(x, y + 0.012, z)
  b.add(M.glass, g, { cast: false })
  b.cyl(M.jugBrown, T(x, y + 0.07, z), 0.066, 0.064, 0.1, 18, { cast: false })
  b.add(M.glass, (() => {
    const s = new THREE.SphereGeometry(0.035, 12, 8)
    s.translate(x, y + 0.29, z)
    return s
  })(), { cast: false })
  for (const [dx, dz] of [[0.12, 0.06], [0.1, -0.09]] as const) {
    b.cyl(M.glass, T(x + dx, y + 0.052, z + dz), 0.036, 0.032, 0.08, 14, { open: true, cast: false })
    b.cyl(M.jugBrown, T(x + dx, y + 0.025, z + dz), 0.031, 0.03, 0.02, 12, { cast: false })
  }
}

/** Folded table name card (tent), standing or knocked flat, on a top at height y, long side along yaw. */
export function nameCard(b: Builder, x: number, y: number, z: number, yaw: number, flat: boolean) {
  if (flat) {
    b.boxM(M.paper, T(x, y + 0.002, z, yaw), 0.21, 0.002, 0.1, 0, 0, 0, { cast: false })
    return
  }
  for (const s of [-1, 1]) b.boxM(M.paper, T(x, y + 0.045, z, yaw, s * 0.32), 0.21, 0.095, 0.0015, 0, 0, s * 0.015, { cast: false })
}

/** Slide projector on a low cart (off), lens toward local −Z. */
export function projectorCart(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(M.darkSteel, m, 0.5, 0.025, 0.4, 0.008, 0, 0.7, 0)
  b.rbox(M.darkSteel, m, 0.5, 0.025, 0.4, 0.008, 0, 0.15, 0)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      b.rod(M.steel, pt(m, sx * 0.23, 0.06, sz * 0.18), pt(m, sx * 0.23, 0.71, sz * 0.18), 0.01, 6)
      b.cyl(M.rubber, m.clone().multiply(T(sx * 0.23, 0.035, sz * 0.18, 0, 0, Math.PI / 2)), 0.035, 0.035, 0.025, 10)
    }
  b.rbox(M.beige, m, 0.3, 0.12, 0.28, 0.02, 0, 0.775, 0.02)
  b.cyl(M.darkSteel, m.clone().multiply(T(0, 0.79, -0.15, 0, Math.PI / 2)), 0.035, 0.035, 0.08, 14)
  b.cyl(M.darkSteel, m.clone().multiply(T(0, 0.86, 0.05)), 0.12, 0.12, 0.03, 24)
  coll(b, m, 0.5, 0.92, 0.42)
}

/** Two-burner hot plate with a dented saucepan on a top at height y. */
export function hotPlate(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(M.jugWhite, m, 0.5, 0.07, 0.3, 0.01, 0, 0.035, 0)
  for (const u of [-0.12, 0.12]) b.cyl(M.darkSteel, m.clone().multiply(T(u, 0.073, 0)), 0.09, 0.09, 0.006, 20)
  b.cyl(M.steel, m.clone().multiply(T(-0.12, 0.13, 0)), 0.085, 0.08, 0.11, 18, { open: true })
  b.rod(M.rubber, pt(m, -0.12, 0.16, -0.08), pt(m, -0.12, 0.17, -0.25), 0.01, 6)
  b.boxM(LED_AMBER, m, 0.012, 0.012, 0.004, 0.2, 0.04, -0.152, { cast: false })
}

/** Tins stacked in a pyramid on the floor or a shelf at height y. */
export function cans(b: Builder, x: number, y: number, z: number, rnd: Rnd, rows = 3) {
  const labels = [M.red, M.yellow, M.leaf, M.jugWhite]
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < rows - r; k++)
      for (let j = 0; j < 2; j++) {
        const cx = x + (k - (rows - r - 1) / 2) * 0.085
        const cz = z + j * 0.085
        const cy = y + r * 0.115
        b.cyl(M.steel, T(cx, cy + 0.0575, cz), 0.04, 0.04, 0.115, 12)
        b.cyl(labels[Math.floor(rnd() * labels.length)]!, T(cx, cy + 0.0575, cz), 0.0405, 0.0405, 0.08, 12, { open: true, cast: false })
      }
}

/** Cardboard lunch box / cool box and a thermos on a top. */
export function lunch(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(M.red, m, 0.3, 0.18, 0.2, 0.03, 0, 0.09, 0)
  b.rbox(M.jugWhite, m, 0.31, 0.04, 0.21, 0.015, 0, 0.18, 0)
  b.cyl(M.leaf, m.clone().multiply(T(0.26, 0.15, 0)), 0.045, 0.045, 0.3, 14)
  b.cyl(M.darkSteel, m.clone().multiply(T(0.26, 0.32, 0)), 0.04, 0.042, 0.05, 14)
}

/** Telephone handset lying on the floor off its cradle, coiled cord back to the set at (tx, tz). */
export function handset(b: Builder, x: number, z: number, yaw: number, tx: number, tz: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(M.beige, m, 0.05, 0.035, 0.2, 0.015, 0, 0.02, 0)
  for (const s of [-1, 1]) b.rbox(M.beige, m, 0.06, 0.045, 0.06, 0.02, 0, 0.03, s * 0.09)
  const n = 26
  let prev: [number, number, number] = [x, FLOOR_Y + 0.02, z]
  for (let k = 1; k <= n; k++) {
    const f = k / n
    const cx = x + (tx - x) * f + Math.sin(f * Math.PI * 3) * 0.12
    const cz = z + (tz - z) * f + Math.cos(f * Math.PI * 2) * 0.06
    const p: [number, number, number] = [cx, FLOOR_Y + 0.008 + Math.sin(f * Math.PI) * 0.01, cz]
    b.rod(M.beige, prev, p, 0.004, 4, { cast: false })
    prev = p
  }
}

/** Plenum services above a gutted grid: a galvanized duct run along x and a sprinkler main. */
export function plenumRun(b: Builder, x0: number, x1: number, zDuct: number, zPipe: number, pipeMat: Mat) {
  const y = CEIL_Y + 0.12
  b.box("metal_galvanized", x0, y, zDuct - 0.3, x1, y + 0.3, zDuct + 0.3, { cast: false })
  for (let x = x0 + 0.6; x < x1; x += 1.2) b.box(M.darkSteel, x - 0.015, y - 0.006, zDuct - 0.31, x + 0.015, y + 0.306, zDuct + 0.31, { cast: false })
  b.rod(pipeMat, [x0, CEIL_Y + 0.28, zPipe], [x1, CEIL_Y + 0.28, zPipe], 0.04, 8, { cast: false })
  for (let x = x0 + 1.5; x < x1; x += 3) {
    b.rod(pipeMat, [x, CEIL_Y + 0.28, zPipe], [x, CEIL_Y + 0.04, zPipe], 0.012, 6, { cast: false })
    b.cyl(BRASS, T(x, CEIL_Y + 0.02, zPipe), 0.02, 0.012, 0.035, 8, { cast: false })
  }
}
