import * as THREE from "three/webgpu"
import { type Builder, type Mat, FLOOR_Y, M, T, glow, paint } from "../../api"
import { materialFor } from "../../../../render/materials"
import { type DocumentId, type DocumentPlacement, documentGeometry, documentMaterial } from "../../../../render/documents"

// Storey 2 (Sample Sciences) local props: lab clutter, equipment and signage that only this storey uses. Static
// fixtures go into the storey builder `b`; bench clutter (bottles, jars, glassware) into `s`, a second builder flushed
// into `b.small` so it only draws on the camera's storey. Frames follow the kit: front faces local −Z, back at +Z.

export type K = {
  b: Builder
  /** Small-prop builder (flushed into b.small). */
  s: Builder
  docs: DocumentPlacement[]
  rnd: () => number
  updates: ((t: number) => void)[]
}

export const F = (x: number, z: number, yaw = 0, y = FLOOR_Y) => T(x, y, z, yaw)
export const pt = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const mul = (m: THREE.Matrix4, n: THREE.Matrix4) => m.clone().multiply(n)
const coll = (b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oz = 0, oy = 0) => b.collideLocal(m, [ox - w / 2, oy, oz - d / 2], [ox + w / 2, oy + h, oz + d / 2])

/** Bench/worktop heights above the finished floor (kit fixtures). */
export const BENCH = FLOOR_Y + 0.935
export const SPINE_TOP = FLOOR_Y + 1.26
export const HOOD_DECK = FLOOR_Y + 0.94
export const DESK = FLOOR_Y + 0.787

export const P = {
  amber: paint(0x3a1a06, 0.12, 0),
  clear: paint(0x8fa39c, 0.06, 0),
  poly: paint(0xb9b6a8, 0.5, 0),
  cap: paint(0x151515, 0.5, 0),
  capRed: paint(0x6a150f, 0.5, 0),
  capBlue: paint(0x1b2c4a, 0.5, 0),
  coldPanel: paint(0xc6cac2, 0.36, 0.2),
  stainless: paint(0xa6a8a4, 0.26, 0.85),
  enamel: paint(0xcfcdc2, 0.42, 0.05),
  marble: paint(0xc5c3ba, 0.14, 0),
  dark: paint(0x151716, 0.85, 0),
  coreBox: paint(0x6f5f43, 0.85, 0),
  coreCap: paint(0x8a7a58, 0.8, 0),
  cylGreen: paint(0x1f3d26, 0.45, 0.4),
  cylGrey: paint(0x5a5c58, 0.45, 0.4),
  cylBlack: paint(0x141414, 0.45, 0.4),
  cylBrown: paint(0x4a3020, 0.45, 0.4),
  hazBlue: paint(0x1f3d86, 0.5, 0),
  hazRed: paint(0x9a1a12, 0.5, 0),
  hazYellow: paint(0xb8960e, 0.5, 0),
  hazWhite: paint(0xd8d6cc, 0.5, 0),
  bio: paint(0xc8701a, 0.5, 0),
  glove: paint(0x0e0e0e, 0.7, 0),
  gloveInner: paint(0x8a857a, 0.92, 0),
  coat: paint(0xcfcdc2, 0.95, 0),
  suit: paint(0x8f7a14, 0.8, 0),
  chart: paint(0xd6d1bb, 0.9, 0),
  beige: paint(0xa49a80, 0.5, 0.05),
  blueGrey: paint(0x4a5560, 0.45, 0.2),
  green: paint(0x2a5a34, 0.5, 0),
  crust: paint(0x2a160a, 0.9, 0),
  specimen: paint(0x5a4836, 0.6, 0),
  specimenPale: paint(0x8a7a62, 0.6, 0),
  wood: paint(0x6a4a2a, 0.75, 0),
  black: paint(0x080808, 0.6, 0),
}

export const GL = {
  uv: glow(0x140a24, 0x7a40ff, 6, "s2_uv_tube"),
  safelight: glow(0x200404, 0xff1806, 2.2, "s2_safelight"),
  isolator: glow(0x182028, 0xd8ecff, 4, "s2_isolator_tube"),
  hot: glow(0x2a0804, 0xff3a0a, 1.4, "s2_hotplate"),
  ledGreen: glow(0x041a04, 0x30ff40, 1.8, "s2_led_green"),
  crt: glow(0x040804, 0x46ff7a, 0.7, "s2_crt_green"),
  amber: M.amberGlow,
  red: M.hazardRed,
}

/** Specimen fluid (formalin gone yellow) and thin lab glass. Both share the flat class shader. */
export const FLUID = materialFor("flat", { color: 0xa89a58, roughness: 0.04, transparent: 0.5, name: "s2_jar_fluid" })
export const GLASS = M.glass

// ------------------------------------------------------------------------------------------------ documents

/** A sheet on a wall (normal along ±x or ±z). */
export function wallDoc(k: K, id: DocumentId, x: number, y: number, z: number, nx: number, nz: number, o: Partial<DocumentPlacement> = {}) {
  k.docs.push({ id, position: [x, y, z], normal: [nx, 0, nz], rotation: (k.rnd() - 0.5) * 0.06, ...o })
}
/** A sheet lying flat on a surface at height y; rot turns it about the vertical. */
export function flatDoc(k: K, id: DocumentId, x: number, y: number, z: number, rot = 0, o: Partial<DocumentPlacement> = {}) {
  k.docs.push({ id, position: [x, y, z], normal: [0, 1, 0], up: [Math.sin(rot), 0, -Math.cos(rot)], ...o })
}
/** Hardboard clipboard hung on a wall hook, its sheet clipped on. */
export function wallClipboard(k: K, id: DocumentId, x: number, y: number, z: number, nx: number, nz: number) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  k.b.rbox(M.clipboard, m, 0.235, 0.33, 0.005, 0.004, 0, 0, 0.004)
  k.b.rbox(M.steel, m, 0.1, 0.03, 0.012, 0.004, 0, 0.14, 0.012)
  k.b.cyl(M.darkSteel, mul(m, T(0, 0.19, 0.004, 0, Math.PI / 2)), 0.004, 0.004, 0.01, 6)
  k.docs.push({ id, position: [x + nx * 0.0075, y - 0.012, z + nz * 0.0075], normal: [nx, 0, nz], pin: "none", curl: 0.05, offset: 0.001 })
}
/** Clipboard lying on a bench or desk. */
export function deskClipboard(k: K, id: DocumentId, x: number, y: number, z: number, rot = 0) {
  const m = T(x, y, z, rot)
  k.s.rbox(M.clipboard, m, 0.235, 0.005, 0.33, 0.003, 0, 0.0025, 0)
  k.s.rbox(M.steel, m, 0.1, 0.012, 0.03, 0.004, 0, 0.008, -0.14)
  k.docs.push({ id, position: [x, y + 0.005, z + 0.012 * Math.cos(rot)], normal: [0, 1, 0], up: [Math.sin(rot), 0, -Math.cos(rot)], pin: "none", curl: 0.04, offset: 0.001 })
}
/** Cork board (w × h) on a wall with real documents pinned to it. */
export function corkBoard(k: K, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, ids: DocumentId[]) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  k.b.rbox(M.wood, m, w + 0.05, h + 0.05, 0.022, 0.006, 0, 0, 0.011)
  k.b.boxM(M.cork, m, w, h, 0.004, 0, 0, 0.022, { cast: false })
  const cols = Math.max(1, Math.round(w / 0.3))
  ids.forEach((id, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const u = -w / 2 + (w / cols) * (c + 0.5) + (k.rnd() - 0.5) * 0.04
    const v = h / 2 - 0.2 - r * 0.33 + (k.rnd() - 0.5) * 0.03
    const p = pt(m, u, v, 0.024)
    k.docs.push({ id, position: p, normal: [nx, 0, nz], rotation: (k.rnd() - 0.5) * 0.12, pin: "pin" })
  })
}
/** Merged document mesh for the storey (one draw), lifted to the storey and added to `parent`. */
export function flushDocs(k: K, parent: THREE.Object3D) {
  if (!k.docs.length) return
  const g = documentGeometry(k.docs)
  g.translate(0, k.b.oy, 0)
  g.computeBoundingSphere()
  const mesh = new THREE.Mesh(g, documentMaterial())
  mesh.name = `s2-documents×${k.docs.length}`
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.matrixAutoUpdate = false
  parent.add(mesh)
}

// ------------------------------------------------------------------------------------------------ signage

/** NFPA 704 hazard diamond on a wall: four coloured squares turned 45° on a white board, digits as dark bars. */
export function hazardDiamond(b: Builder, x: number, y: number, z: number, nx: number, nz: number, size = 0.26) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  const s = size / 2
  const r = Math.SQRT1_2 * s
  b.boxM(P.hazWhite, mul(m, T(0, 0, 0.004, 0, 0, Math.PI / 4)), size * 1.04, size * 1.04, 0.006)
  const q = [
    [0, r, P.hazRed, 3],
    [-r, 0, P.hazBlue, 3],
    [r, 0, P.hazYellow, 1],
    [0, -r, P.hazWhite, 0],
  ] as const
  for (const [dx, dy, mat, n] of q) {
    b.boxM(mat, mul(m, T(dx, dy, 0.008, 0, 0, Math.PI / 4)), s * 0.96, s * 0.96, 0.003, 0, 0, 0, { cast: false })
    if (n) b.boxM(P.black, m, 0.012, 0.045, 0.002, dx, dy, 0.0105, { cast: false })
  }
  b.boxM(P.black, m, 0.05, 0.012, 0.002, 0, -r, 0.0105, { cast: false })
}

/** Biohazard placard: orange plate, black trefoil (three rings round a hub). */
export function bioPlacard(b: Builder, x: number, y: number, z: number, nx: number, nz: number, w = 0.24) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  b.rbox(P.bio, m, w, w * 1.25, 0.004, 0.003, 0, 0, 0.002)
  const ring = (a: number) => {
    const g = new THREE.TorusGeometry(w * 0.13, w * 0.025, 4, 18)
    g.applyMatrix4(mul(m, T(Math.sin(a) * w * 0.11, w * 0.1 + Math.cos(a) * w * 0.11, 0.005)))
    b.add(P.black, g, { cast: false })
  }
  for (let i = 0; i < 3; i++) ring((i / 3) * Math.PI * 2)
  b.cyl(P.black, mul(m, T(0, w * 0.1, 0.005, 0, Math.PI / 2)), w * 0.05, w * 0.05, 0.002, 12, { cast: false })
  b.boxM(P.black, m, w * 0.8, w * 0.07, 0.002, 0, -w * 0.38, 0.005, { cast: false })
}

/** Small engraved plate (dark with a pale strip of "text"). */
export function plate(b: Builder, x: number, y: number, z: number, nx: number, nz: number, w = 0.3, h = 0.1, mat: Mat = M.plate) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  b.boxM(mat, m, w, h, 0.006, 0, 0, 0.003)
  b.boxM(M.stencil, m, w * 0.75, h * 0.25, 0.002, 0, 0, 0.007, { cast: false })
}

/** Intercom box with a speaker grille and a call button. */
export function intercom(b: Builder, x: number, y: number, z: number, nx: number, nz: number) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  b.rbox(P.beige, m, 0.12, 0.18, 0.04, 0.006, 0, 0, 0.02)
  for (let i = 0; i < 5; i++) b.boxM(P.dark, m, 0.07, 0.006, 0.002, 0, 0.04 - i * 0.014, 0.041, { cast: false })
  b.cyl(M.red, mul(m, T(0, -0.05, 0.042, 0, Math.PI / 2)), 0.012, 0.012, 0.008, 10)
}

// ------------------------------------------------------------------------------------------------ bench clutter

const BOTTLE_MATS = [P.amber, P.amber, P.clear, P.poly] as const
const CAP_MATS = [P.cap, P.cap, P.capRed, P.capBlue] as const

/** Reagent bottle: body, shoulder, neck, cap, paper label band. kind 0/1 amber, 2 clear, 3 white poly. */
export function bottle(s: Builder, x: number, y: number, z: number, kind: number, h = 0.17, r = 0.036, capKind = 0) {
  const body = h * 0.72
  s.cyl(BOTTLE_MATS[kind % 4]!, T(x, y + body / 2, z), r, r, body, 10)
  s.cyl(BOTTLE_MATS[kind % 4]!, T(x, y + body + h * 0.07, z), r * 0.42, r, h * 0.14, 10, { open: true })
  s.cyl(BOTTLE_MATS[kind % 4]!, T(x, y + body + h * 0.17, z), r * 0.36, r * 0.36, h * 0.06, 8, { open: true })
  s.cyl(CAP_MATS[capKind % 4]!, T(x, y + h - h * 0.04, z), r * 0.46, r * 0.46, h * 0.09, 10)
  s.cyl(M.paper, T(x, y + body * 0.48, z), r + 0.0015, r + 0.0015, body * 0.45, 10, { open: true, cast: false })
}

/** A tidy row of reagent bottles along a line (x0,z0)→(x1,z1) on a surface at height y. */
export function bottleRow(k: K, x0: number, z0: number, x1: number, z1: number, y: number, n: number) {
  for (let i = 0; i < n; i++) {
    if (k.rnd() < 0.15) continue
    const t = (i + 0.5) / n
    const big = k.rnd() < 0.3
    bottle(k.s, x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, Math.floor(k.rnd() * 4), big ? 0.24 : 0.15 + k.rnd() * 0.04, big ? 0.048 : 0.032, Math.floor(k.rnd() * 4))
  }
}

/** Glass beaker (open cylinder with a thin base) — `crust` leaves a burnt residue in the bottom. */
export function beaker(s: Builder, x: number, y: number, z: number, r = 0.04, h = 0.11, crust = false) {
  s.cyl(GLASS, T(x, y + h / 2, z), r, r, h, 14, { open: true, cast: false })
  s.cyl(GLASS, T(x, y + 0.002, z), r, r, 0.004, 14, { cast: false })
  if (crust) {
    s.cyl(P.crust, T(x, y + 0.006, z), r - 0.002, r - 0.002, 0.006, 14)
    s.cyl(P.crust, T(x, y + 0.02, z), r - 0.0015, r - 0.0015, 0.02, 14, { open: true })
  }
}

/** Erlenmeyer flask (cone body, neck). */
export function flask(s: Builder, x: number, y: number, z: number, r = 0.05) {
  s.cyl(GLASS, T(x, y + r * 0.8, z), r * 0.3, r, r * 1.6, 12, { cast: false })
  s.cyl(GLASS, T(x, y + r * 1.9, z), r * 0.26, r * 0.28, r * 0.6, 10, { open: true, cast: false })
}

/** Hot plate/stirrer with its glowing element visible round the pan (on = still hot). */
export function hotPlate(k: K, x: number, y: number, z: number, yaw: number, on: boolean) {
  const m = T(x, y, z, yaw)
  k.s.rbox(P.enamel, m, 0.2, 0.09, 0.26, 0.012, 0, 0.045, 0)
  k.s.boxM(P.dark, m, 0.18, 0.004, 0.18, 0, 0.092, 0.02, { cast: false })
  if (on) {
    const ring = new THREE.TorusGeometry(0.06, 0.006, 4, 24)
    ring.rotateX(Math.PI / 2)
    ring.applyMatrix4(mul(m, T(0, 0.095, 0.02)))
    k.s.add(GL.hot, ring, { cast: false })
  }
  for (const dx of [-0.05, 0.05]) k.s.cyl(P.dark, mul(m, T(dx, 0.045, -0.131, 0, Math.PI / 2)), 0.014, 0.014, 0.012, 10)
  k.s.boxM(on ? GL.amber : M.hazardOff, m, 0.012, 0.008, 0.003, 0, 0.07, -0.131, { cast: false })
}

/** Wind-up kitchen timer (dome with a dial band). */
export function kitchenTimer(s: Builder, x: number, y: number, z: number, yaw: number) {
  const g = new THREE.SphereGeometry(0.035, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  g.applyMatrix4(T(x, y, z, yaw))
  s.add(P.enamel, g)
  s.cyl(M.red, T(x, y + 0.006, z, yaw), 0.036, 0.036, 0.012, 14, { open: true })
  s.cyl(P.dark, T(x, y + 0.036, z, yaw), 0.008, 0.008, 0.008, 8)
}

/** Ashtray (glass) with a few stubbed-out butts. */
export function ashtray(k: K, x: number, y: number, z: number) {
  k.s.cyl(GLASS, T(x, y + 0.012, z), 0.06, 0.055, 0.024, 16, { cast: false })
  k.s.cyl(P.dark, T(x, y + 0.004, z), 0.05, 0.05, 0.003, 12, { cast: false })
  for (let i = 0; i < 4; i++) {
    const a = k.rnd() * Math.PI * 2
    const p0: [number, number, number] = [x + Math.cos(a) * 0.015, y + 0.012, z + Math.sin(a) * 0.015]
    const p1: [number, number, number] = [x + Math.cos(a) * 0.05, y + 0.025, z + Math.sin(a) * 0.05]
    k.s.rod(i % 2 ? M.paper : P.chart, p0, p1, 0.004, 5)
  }
}

// ------------------------------------------------------------------------------------------------ storage

/** Welded steel shelving unit (w along local x, d deep), back at +Z; returns shelf top heights (absolute local y). */
export function shelfUnit(b: Builder, x: number, z: number, yaw: number, w = 1.2, d = 0.5, levels = [0.14, 0.58, 1.02, 1.46, 1.9], mat: Mat = P.blueGrey, h = 2.2) {
  const m = F(x, z, yaw)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      b.boxM(mat, m, 0.032, h, 0.004, sx * (w / 2 - 0.016), h / 2, sz * (d / 2 - 0.002))
      b.boxM(mat, m, 0.004, h, 0.032, sx * (w / 2 - 0.002), h / 2, sz * (d / 2 - 0.016))
    }
  for (const l of levels) {
    b.boxM(mat, m, w - 0.01, 0.018, d - 0.01, 0, l + 0.009, 0)
    b.boxM(mat, m, w - 0.01, 0.035, 0.008, 0, l + 0.0, -d / 2 + 0.008)
  }
  // Back X-brace.
  const p0 = pt(m, -w / 2 + 0.03, 0.1, d / 2 - 0.004)
  const p1 = pt(m, w / 2 - 0.03, h - 0.1, d / 2 - 0.004)
  const p2 = pt(m, w / 2 - 0.03, 0.1, d / 2 - 0.004)
  const p3 = pt(m, -w / 2 + 0.03, h - 0.1, d / 2 - 0.004)
  b.rod(mat, p0, p1, 0.004, 4)
  b.rod(mat, p2, p3, 0.004, 4)
  coll(b, m, w, h, d)
  return levels.map((l) => FLOOR_Y + l + 0.018)
}

/** Specimen jar in fluid with a lid and a label; some hold something. */
export function jar(k: K, x: number, y: number, z: number, r: number, h: number, thing: number) {
  k.s.cyl(FLUID, T(x, y + h / 2, z), r, r, h, 10, { cast: false })
  k.s.cyl(thing > 0.5 ? P.cap : P.cylGrey, T(x, y + h + 0.012, z), r * 1.04, r * 1.04, 0.024, 10)
  k.s.boxM(M.paper, T(x, y + h * 0.55, z), r * 1.1, h * 0.28, 0.002, 0, 0, -r - 0.001, { cast: false })
  if (thing > 0.35) {
    const g = new THREE.IcosahedronGeometry(r * 0.62, 0)
    g.scale(1, (h / r) * 0.32, 0.8 + thing * 0.3)
    g.rotateY(thing * 7)
    g.translate(x, y + h * 0.45, z)
    k.s.add(thing > 0.7 ? P.specimenPale : P.specimen, g)
  }
}

/** Waxed core box (lid on) with a depth label at the end. */
export function coreBox(s: Builder, x: number, y: number, z: number, yaw: number, open = false) {
  const m = T(x, y, z, yaw)
  s.boxM(P.coreBox, m, 0.76, 0.09, 0.3, 0, 0.045, 0)
  if (!open) s.boxM(P.coreCap, m, 0.77, 0.012, 0.31, 0, 0.096, 0)
  else for (let i = 0; i < 3; i++) s.cyl(P.cylGrey, mul(m, T(0, 0.07, -0.1 + i * 0.1, 0, 0, Math.PI / 2)), 0.03, 0.03, 0.7, 8)
  s.boxM(M.paper, m, 0.002, 0.05, 0.1, -0.381, 0.05, 0, { cast: false })
}

// ------------------------------------------------------------------------------------------------ equipment

/** Compressed gas cylinder (dome top, valve, collar), standing at (x, z). */
export function gasCylinder(b: Builder, x: number, z: number, mat: Mat, h = 1.4, r = 0.115, capped = true) {
  b.cyl(mat, T(x, FLOOR_Y + (h - r) / 2, z), r, r, h - r, 14)
  const dome = new THREE.SphereGeometry(r, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  dome.translate(x, FLOOR_Y + h - r, z)
  b.add(mat, dome)
  b.cyl(M.paper, T(x, FLOOR_Y + h - r - 0.12, z), r + 0.002, r + 0.002, 0.1, 14, { open: true, cast: false })
  if (capped) b.cyl(M.darkSteel, T(x, FLOOR_Y + h + 0.06, z), 0.05, 0.055, 0.17, 10)
  else {
    b.cyl(M.steel, T(x, FLOOR_Y + h + 0.03, z), 0.02, 0.02, 0.07, 8)
    b.cyl(M.steel, T(x, FLOOR_Y + h + 0.08, z, 0, 0, Math.PI / 2), 0.025, 0.025, 0.06, 10)
    b.cyl(M.darkSteel, T(x, FLOOR_Y + h + 0.13, z), 0.03, 0.03, 0.02, 10)
  }
  b.collide(x - r, FLOOR_Y, z - r, x + r, FLOOR_Y + h, z + r)
}

/** Wall strap chain holding cylinders against a wall (strap along the wall at two heights). */
export function cylinderStrap(b: Builder, x0: number, x1: number, wz: number, nz: number, axis: "x" | "z" = "x") {
  for (const y of [0.85, 1.2]) {
    if (axis === "x") {
      b.box(M.darkSteel, x0, FLOOR_Y + y, wz + nz * 0.005, x1, FLOOR_Y + y + 0.04, wz + nz * 0.03)
      b.rod(M.steel, [x0, FLOOR_Y + y + 0.02, wz + nz * 0.27], [x1, FLOOR_Y + y + 0.02, wz + nz * 0.27], 0.006, 4)
    } else {
      b.box(M.darkSteel, wz + nz * 0.005, FLOOR_Y + y, x0, wz + nz * 0.03, FLOOR_Y + y + 0.04, x1)
      b.rod(M.steel, [wz + nz * 0.27, FLOOR_Y + y + 0.02, x0], [wz + nz * 0.27, FLOOR_Y + y + 0.02, x1], 0.006, 4)
    }
  }
}

/** Stainless two-shelf lab cart on casters (w along local x). */
export function labCart(b: Builder, x: number, z: number, yaw: number, w = 0.9, d = 0.5) {
  const m = F(x, z, yaw)
  for (const y of [0.25, 0.85]) {
    b.rbox(P.stainless, m, w, 0.03, d, 0.01, 0, y, 0)
    b.boxM(P.stainless, m, w, 0.03, 0.01, 0, y + 0.03, -d / 2 + 0.005)
    b.boxM(P.stainless, m, w, 0.03, 0.01, 0, y + 0.03, d / 2 - 0.005)
  }
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const p = pt(m, sx * (w / 2 - 0.02), 0, sz * (d / 2 - 0.02))
      b.cyl(P.stainless, T(p[0], FLOOR_Y + 0.5, p[2]), 0.012, 0.012, 0.84, 8)
      b.cyl(M.rubber, mul(m, T(sx * (w / 2 - 0.02), 0.035, sz * (d / 2 - 0.02), 0, 0, Math.PI / 2)), 0.035, 0.035, 0.025, 12)
    }
  b.rod(P.stainless, pt(m, w / 2, 0.85, -d / 2 + 0.05), pt(m, w / 2 + 0.08, 0.95, -d / 2 + 0.05), 0.01, 6)
  b.rod(P.stainless, pt(m, w / 2, 0.85, d / 2 - 0.05), pt(m, w / 2 + 0.08, 0.95, d / 2 - 0.05), 0.01, 6)
  b.rod(P.stainless, pt(m, w / 2 + 0.08, 0.95, -d / 2 + 0.05), pt(m, w / 2 + 0.08, 0.95, d / 2 - 0.05), 0.012, 6)
  coll(b, m, w + 0.1, 0.95, d)
  return m
}

/** Steel-legged table (w × d, top height h) with a chosen top. */
export function table(b: Builder, x: number, z: number, yaw: number, w: number, d: number, h = 0.74, top: Mat = M.laminateTop, leg: Mat = M.darkSteel) {
  const m = F(x, z, yaw)
  b.rbox(top, m, w, 0.035, d, 0.008, 0, h - 0.0175, 0)
  b.boxM(leg, m, w - 0.1, 0.06, 0.03, 0, h - 0.065, -d / 2 + 0.06)
  b.boxM(leg, m, w - 0.1, 0.06, 0.03, 0, h - 0.065, d / 2 - 0.06)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(leg, m, 0.04, h - 0.035, 0.04, sx * (w / 2 - 0.05), (h - 0.035) / 2, sz * (d / 2 - 0.05))
  coll(b, m, w, h, d)
  return m
}

/** Marble balance table: heavy slab on a welded frame, with an analytical balance (glass draft shield). */
export function balanceTable(k: K, x: number, z: number, yaw: number, balances = 1) {
  const m = table(k.b, x, z, yaw, 1.2, 0.62, 0.8, P.marble, P.blueGrey)
  k.b.rbox(P.marble, m, 1.2, 0.05, 0.62, 0.006, 0, 0.775, 0)
  for (let i = 0; i < balances; i++) balance(k.s, mul(m, T(-0.25 + i * 0.5, 0.8, 0)))
}
export function balance(s: Builder, m: THREE.Matrix4) {
  s.rbox(P.enamel, m, 0.22, 0.08, 0.34, 0.012, 0, 0.04, 0.02)
  s.rbox(P.enamel, m, 0.22, 0.32, 0.06, 0.01, 0, 0.2, 0.16)
  for (const sx of [-1, 1]) s.boxM(GLASS, m, 0.004, 0.22, 0.26, sx * 0.1, 0.19, -0.01, { cast: false })
  s.boxM(GLASS, m, 0.2, 0.004, 0.26, 0, 0.3, -0.01, { cast: false })
  s.boxM(GLASS, m, 0.2, 0.22, 0.004, 0, 0.19, -0.14, { cast: false })
  s.cyl(M.steel, mul(m, T(0, 0.085, -0.02)), 0.04, 0.04, 0.004, 14)
  s.boxM(GL.ledGreen, m, 0.07, 0.016, 0.002, 0, 0.05, -0.15, { cast: false })
}

/** Wall cabinet (w × h) on a wall, glazed or solid doors, contents drawn by `fill`. */
export function wallCabinet(b: Builder, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, d: number, glazed: boolean, mat: Mat = M.cabinet) {
  const m = T(x, y, z, Math.atan2(nx, nz))
  b.rbox(mat, m, w, 0.02, d, 0.004, 0, -h / 2 + 0.01, d / 2)
  b.rbox(mat, m, w, 0.02, d, 0.004, 0, h / 2 - 0.01, d / 2)
  for (const sx of [-1, 1]) b.boxM(mat, m, 0.02, h, d, sx * (w / 2 - 0.01), 0, d / 2)
  b.boxM(mat, m, w, h, 0.012, 0, 0, 0.006)
  b.boxM(mat, m, w - 0.04, 0.012, d - 0.03, 0, 0, d / 2)
  for (const sx of [-1, 1]) {
    const dm = mul(m, T(sx * w * 0.25, 0, d + 0.006))
    if (glazed) {
      b.boxM(mat, dm, w / 2 - 0.004, 0.04, 0.02, 0, h / 2 - 0.02, 0)
      b.boxM(mat, dm, w / 2 - 0.004, 0.04, 0.02, 0, -h / 2 + 0.02, 0)
      b.boxM(mat, dm, 0.04, h - 0.08, 0.02, -sx * (w / 4 - 0.022), 0, 0)
      b.boxM(mat, dm, 0.04, h - 0.08, 0.02, sx * (w / 4 - 0.022), 0, 0)
      b.quad(GLASS, mul(dm, T(0, 0, 0.002)), w / 2 - 0.08, h - 0.08, { cast: false })
    } else b.rbox(mat, dm, w / 2 - 0.006, h - 0.004, 0.02, 0.004)
    b.boxM(M.steel, dm, 0.015, 0.1, 0.02, -sx * (w / 4 - 0.05), 0, 0.016)
  }
  b.collideLocal(m, [-w / 2, -h / 2, 0], [w / 2, h / 2, d + 0.02])
  return m
}

/** Chest freezer (−80 °C), length along local x, controller with a temperature readout on the front. */
export function chestFreezer(b: Builder, x: number, z: number, yaw: number, len = 1.6) {
  const m = F(x, z, yaw)
  b.rbox(P.enamel, m, len, 0.86, 0.78, 0.03, 0, 0.45, 0)
  b.boxM(M.rubber, m, len - 0.1, 0.06, 0.7, 0, 0.03, 0)
  b.rbox(P.enamel, m, len - 0.02, 0.1, 0.76, 0.02, 0, 0.93, 0)
  b.boxM(M.rubber, m, len - 0.06, 0.012, 0.74, 0, 0.875, 0)
  b.boxM(P.blueGrey, m, 0.5, 0.15, 0.01, -len / 2 + 0.35, 0.7, -0.395)
  b.boxM(GL.red, m, 0.1, 0.03, 0.002, -len / 2 + 0.3, 0.72, -0.401, { cast: false })
  b.boxM(GL.ledGreen, m, 0.012, 0.012, 0.002, -len / 2 + 0.45, 0.72, -0.401, { cast: false })
  b.boxM(M.steel, m, 0.25, 0.025, 0.03, 0.2, 0.9, -0.395)
  coll(b, m, len, 0.98, 0.78)
}

/** Tall steel cabinet (w × h × d) with two doors; `glass` adds a vision pane (respirators, drying film). */
export function tallCabinet(b: Builder, x: number, z: number, yaw: number, w = 0.9, h = 1.95, d = 0.5, mat: Mat = M.cabinet) {
  const m = F(x, z, yaw)
  b.rbox(mat, m, w, h, d, 0.01, 0, h / 2, 0)
  b.boxM(M.darkSteel, m, 0.004, h - 0.06, 0.004, 0, h / 2, -d / 2 - 0.001, { cast: false })
  for (const sx of [-1, 1]) b.boxM(M.steel, m, 0.02, 0.18, 0.03, sx * 0.04, h * 0.52, -d / 2 - 0.015)
  b.boxM(M.plate, m, 0.16, 0.06, 0.004, 0, h - 0.18, -d / 2 - 0.002, { cast: false })
  coll(b, m, w, h, d)
  return m
}

/** Bench-top instrument: a beige case with a front panel, a dark display window and knobs. */
export function instrument(b: Builder, m: THREE.Matrix4, w: number, h: number, d: number, screen?: Mat) {
  b.rbox(P.beige, m, w, h, d, 0.01, 0, h / 2, 0)
  b.boxM(P.dark, m, w * 0.92, h * 0.5, 0.004, 0, h * 0.55, -d / 2 - 0.001, { cast: false })
  if (screen) b.boxM(screen, m, w * 0.3, h * 0.28, 0.003, -w * 0.25, h * 0.58, -d / 2 - 0.004, { cast: false })
  for (let i = 0; i < 4; i++) b.cyl(P.dark, mul(m, T(w * 0.05 + i * w * 0.1, h * 0.55, -d / 2 - 0.01, 0, Math.PI / 2)), 0.011, 0.011, 0.016, 10)
  b.boxM(GL.ledGreen, m, 0.008, 0.008, 0.002, w * 0.4, h * 0.2, -d / 2 - 0.002, { cast: false })
}

/** Oscilloscope with a hood round its green screen (front −Z). */
export function scope(b: Builder, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  b.rbox(P.blueGrey, m, 0.34, 0.2, 0.46, 0.012, 0, 0.1, 0)
  b.boxM(P.dark, m, 0.32, 0.18, 0.004, 0, 0.1, -0.232, { cast: false })
  b.boxM(GL.crt, m, 0.12, 0.1, 0.002, -0.08, 0.11, -0.236, { cast: false })
  for (let i = 0; i < 6; i++) b.cyl(M.steel, mul(m, T(0.03 + (i % 3) * 0.045, 0.06 + Math.floor(i / 3) * 0.07, -0.24, 0, Math.PI / 2)), 0.01, 0.01, 0.014, 8)
  for (const sx of [-1, 1]) b.boxM(P.dark, m, 0.004, 0.11, 0.05, -0.08 + sx * 0.065, 0.11, -0.255)
  b.boxM(P.dark, m, 0.13, 0.004, 0.05, -0.08, 0.167, -0.255)
}

/** Lab coat hung on a hook rail: a slim tapered shape. */
export function coat(b: Builder, x: number, y: number, z: number, yaw: number, mat: Mat = P.coat) {
  const m = T(x, y, z, yaw)
  const g = new THREE.CylinderGeometry(0.17, 0.26, 1.0, 10, 1)
  g.scale(1, 1, 0.38)
  g.translate(0, -0.55, 0.11)
  g.applyMatrix4(m)
  b.add(mat, g)
  b.rbox(mat, m, 0.4, 0.06, 0.12, 0.03, 0, -0.06, 0.1)
}

/** Hook rail on a wall (at x = wall for axis "z", z = wall for axis "x") with coats/suits; `inward` = room side sign. */
export function coatRail(b: Builder, a0: number, a1: number, wall: number, axis: "x" | "z", inward: 1 | -1, n: number, mat: Mat = P.coat, rnd = Math.random) {
  const y = FLOOR_Y + 1.75
  const s = inward
  if (axis === "x") b.box(M.wood, a0, y, wall, a1, y + 0.1, wall + s * 0.02)
  else b.box(M.wood, wall, y, a0, wall + s * 0.02, y + 0.1, a1)
  const yaw = axis === "x" ? (s > 0 ? 0 : Math.PI) : s > 0 ? Math.PI / 2 : -Math.PI / 2
  for (let i = 0; i < n; i++) {
    const u = a0 + ((a1 - a0) * (i + 0.5)) / n
    const [px, pz] = axis === "x" ? [u, wall + s * 0.02] : [wall + s * 0.02, u]
    b.rod(M.steel, [px, y + 0.05, pz], axis === "x" ? [px, y + 0.03, pz + s * 0.06] : [px + s * 0.06, y + 0.03, pz], 0.006, 5)
    if (rnd() < 0.75) coat(b, px, y + 0.02, pz, yaw + (rnd() - 0.5) * 0.1, mat)
  }
}

/** Ceiling bulkhead (caged oval) with its bulb; registers an incandescent lamp when on. */
export function bulkhead(b: Builder, x: number, y: number, z: number, on: boolean, intensity = 6, colour: [number, number, number] = [1, 0.74, 0.46]) {
  b.cyl(M.darkSteel, T(x, y - 0.02, z), 0.12, 0.12, 0.04, 16)
  const g = new THREE.SphereGeometry(0.1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  g.scale(1, 0.6, 1)
  g.rotateX(Math.PI)
  g.translate(x, y - 0.04, z)
  b.add(on ? M.bulbWarm : M.diffuserOff, g, { cast: false })
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI
    b.rod(M.darkSteel, [x + Math.cos(a) * 0.11, y - 0.04, z + Math.sin(a) * 0.11], [x - Math.cos(a) * 0.11, y - 0.04, z - Math.sin(a) * 0.11], 0.004, 4)
  }
  if (on) b.lamp({ kind: "incandescent", position: [x, y - 0.12, z], direction: [0, -1, 0], color: colour, intensity, range: 4.5, angle: 1.3, penumbra: 0.7, size: 0.1 })
}
