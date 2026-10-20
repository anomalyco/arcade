import * as THREE from "three/webgpu"
import { abs, float, floor, fract, hash, max, mix, sin, smoothstep, time, uv, vec2, vec3 } from "three/tsl"
import type { DocumentId, DocumentPlacement } from "../../../../render/documents"
import { addDocuments } from "../../api"
import {
  type Band,
  type Builder,
  type Mat,
  type Rect,
  type RoomHandle,
  type RoomOpts,
  CEIL_Y,
  FLOOR_Y,
  M,
  SHELL,
  T,
  WINDOWS,
  ZONE,
  aaFade,
  aaLines,
  aaWindow,
  ceiling,
  dressWindow,
  glow,
  paint,
  room,
  wall,
} from "../../api"

// Storey 0 local helpers: document batch, room wrapper that leaves a facade face to the storey (door openings in the
// lining), lining walls with door holes, caged bulkheads, a few shared finishes and the CCTV / slide screen shaders.

export const rng = (seed: number) => {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

/** Lobby: the corridor's tile courses and dark band at the same heights (they meet at the link), painted above. */
export const LOBBY_BANDS: Band[] = [
  [0, 0.3, "tile_green_dark"],
  [0.3, 1.02, "tile_green"],
  [1.02, 1.2, "tile_green_dark"],
  [1.2, 99, "painted_wall"],
]
/** Decon, showers: glazed tile to 2.4 m. */
export const SHOWER_BANDS: Band[] = [
  [0, 0.15, "tile_green_dark"],
  [0.15, 2.4, "tile_green"],
  [2.4, 99, "painted_wall"],
]
/** Receiving and plant: painted block. */
export const BLOCK_BANDS: Band[] = [[0, 99, M.block]]
/** Cafeteria: vertical-grain veneer wainscot under a painted wall (concept r4-03). */
export const PANEL_BANDS: Band[] = [
  [0, 0.1, M.rubber],
  [0.1, 1.3, M.veneer],
  [1.3, 1.34, M.veneerDark],
  [1.34, 99, "painted_wall"],
]

// ---------------------------------------------------------------------------------------------------------------- paper

/** Collects every document of the storey and emits them as one draw (the documents atlas material). */
export class Docs {
  private list: DocumentPlacement[] = []
  add(id: DocumentId, position: readonly [number, number, number], normal: readonly [number, number, number], o: Partial<DocumentPlacement> = {}) {
    this.list.push({ id, position, normal, seed: this.list.length * 31 + 7, ...o })
  }
  /** Flat on a horizontal surface at height y, top of the sheet towards (ux, uz). */
  flat(id: DocumentId, x: number, y: number, z: number, rot = 0, o: Partial<DocumentPlacement> = {}) {
    this.add(id, [x, y, z], [0, 1, 0], { rotation: rot, ...o })
  }
  /** On a wall plane at (x, y, z) facing (nx, nz). */
  wall(id: DocumentId, x: number, y: number, z: number, nx: number, nz: number, o: Partial<DocumentPlacement> = {}) {
    this.add(id, [x, y, z], [nx, 0, nz], o)
  }
  flush(b: Builder) {
    if (!this.list.length) return
    addDocuments(b, this.list)
    this.list = []
  }
}

// ---------------------------------------------------------------------------------------------------------------- rooms

/**
 * `room()` for rooms whose facade face needs door openings the kit's lining doesn't cut (staff entrance, dock wall,
 * annex door): the rect is pulled 0.32 m off the listed shell faces so room() skips their lining, the strip gets its
 * floor and ceiling here, and `lining()` builds that face with the openings. (Kit request: room lining openings.)
 */
export function roomOpen(b: Builder, o: RoomOpts, faces: ("north" | "south" | "west" | "east")[]): RoomHandle {
  const r = o.rect
  // (Inset past room()'s 0.3 m lining tolerance from the lining plane, so room() leaves the open face to the caller:
  // at 0.32 a north/south room still got a full, unholed lining over its dock and door openings.)
  const inner: Rect = {
    x0: faces.includes("west") ? r.x0 + 0.35 : r.x0,
    x1: faces.includes("east") ? r.x1 - 0.35 : r.x1,
    z0: faces.includes("north") ? r.z0 + 0.35 : r.z0,
    z1: faces.includes("south") ? r.z1 - 0.35 : r.z1,
  }
  const h = room(b, { ...o, rect: inner })
  const fl = o.floor ?? "linoleum"
  const strip = (x0: number, z0: number, x1: number, z1: number) => {
    b.floor(fl, x0, z0, x1, z1)
    if (!o.ceiling?.none) ceiling(b, x0, z0, x1, z1)
  }
  if (faces.includes("west")) strip(r.x0, inner.z0, inner.x0, inner.z1)
  if (faces.includes("east")) strip(inner.x1, inner.z0, r.x1, inner.z1)
  if (faces.includes("north")) strip(r.x0, r.z0, r.x1, inner.z0)
  if (faces.includes("south")) strip(r.x0, inner.z1, r.x1, r.z1)
  return { ...h, rect: r, at: (u, v) => [r.x0 + (r.x1 - r.x0) * u, r.z0 + (r.z1 - r.z0) * v], centre: [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2] }
}

export type Hole = { a0: number; a1: number; bottom?: number; top: number }

/** Lining over one shell face between a0..a1 with door/opening holes plus the facade's windows (dressed). */
export function lining(b: Builder, face: "north" | "south" | "west" | "east", a0: number, a1: number, holes: Hole[], blinds: "random" | "closed" | "open" | "up" = "random", seed = 1) {
  const wins = WINDOWS(b.storey, face).filter((w) => w.u0 >= a0 - 0.01 && w.u1 <= a1 + 0.01)
  const all = [...holes, ...wins.map((w) => ({ a0: w.u0, a1: w.u1, bottom: w.sill, top: w.head }))]
  const ext = { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false }
  const bands: Band[] = [
    [0, 0.1, M.rubber],
    [0.1, 99, "painted_wall"],
  ]
  if (face === "north") wall(b, "x", a0, a1, SHELL.z0, -ZONE.lining, bands, all, ext)
  if (face === "south") wall(b, "x", a0, a1, ZONE.lining, SHELL.z1, bands, all, ext)
  if (face === "west") wall(b, "z", a0, a1, SHELL.x0, SHELL.x0 + 0.04, bands, all, ext)
  if (face === "east") wall(b, "z", a0, a1, SHELL.x1 - 0.04, SHELL.x1, bands, all, ext)
  const rnd = rng(seed)
  for (const w of wins) dressWindow(b, w, { blinds, radiators: "convector" }, rnd)
}

// ---------------------------------------------------------------------------------------------------------------- fittings

const CAGE = paint(0x2a2c28, 0.5, 0.7)

/** Caged bulkhead (cast base, glass globe, wire guard) on a wall (normal nx, nz) or the ceiling (nx = nz = 0). */
export function bulkhead(b: Builder, x: number, y: number, z: number, nx: number, nz: number, on: boolean, intensity = 14, opts: { shadow?: boolean; range?: number } = {}) {
  const ceilingMount = nx === 0 && nz === 0
  const m = ceilingMount ? T(x, y, z, 0, Math.PI) : T(x, y, z, Math.atan2(nx, nz), Math.PI / 2)
  // Local +Y points out of the mounting surface.
  b.cyl(CAGE, m.clone().multiply(T(0, 0.025, 0)), 0.075, 0.08, 0.05, 16)
  const globe = new THREE.SphereGeometry(0.06, 14, 10)
  globe.scale(1, 1.3, 1)
  globe.applyMatrix4(m.clone().multiply(T(0, 0.11, 0)))
  b.add(on ? M.bulbWarm : M.diffuserOff, globe, { cast: false })
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2
    const p0 = new THREE.Vector3(Math.cos(a) * 0.07, 0.05, Math.sin(a) * 0.07).applyMatrix4(m)
    const p1 = new THREE.Vector3(Math.cos(a) * 0.072, 0.17, Math.sin(a) * 0.072).applyMatrix4(m)
    const p2 = new THREE.Vector3(0, 0.205, 0).applyMatrix4(m)
    b.rod(CAGE, [p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], 0.004, 4)
    b.rod(CAGE, [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], 0.004, 4)
  }
  const ring = new THREE.TorusGeometry(0.072, 0.004, 4, 20)
  ring.rotateX(Math.PI / 2)
  ring.applyMatrix4(m.clone().multiply(T(0, 0.12, 0)))
  b.add(CAGE, ring)
  if (on) {
    const p = new THREE.Vector3(0, 0.3, 0).applyMatrix4(m)
    b.lamp({ kind: "incandescent", position: [p.x, p.y, p.z], color: [1.0, 0.72, 0.42], intensity, range: opts.range ?? 6, shadow: opts.shadow ?? false, size: 0.08 })
  }
}

/** Framed cork board on a wall at (x, y0..y0+h, zWall/xWall) facing (nx, nz), with real documents pinned on it. */
export function corkBoard(b: Builder, docs: Docs, x: number, z: number, nx: number, nz: number, w: number, h: number, ids: DocumentId[], seed = 1, y0 = FLOOR_Y + 1.05) {
  const yaw = Math.atan2(nx, nz)
  const m = T(x, y0 + h / 2, z, yaw)
  b.boxM(M.wood, m, w + 0.06, h + 0.06, 0.03, 0, 0, 0.015)
  b.boxM(M.cork, m, w, h, 0.004, 0, 0, 0.032, { cast: false })
  const rnd = rng(seed)
  const cols = Math.max(1, Math.round(w / 0.27))
  ids.forEach((id, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const u = -w / 2 + (w / cols) * (c + 0.5) + (rnd() - 0.5) * 0.04
    const v = h / 2 - 0.19 - r * 0.33 + (rnd() - 0.5) * 0.03
    if (v < -h / 2 + 0.1) return
    const p = new THREE.Vector3(u, v, 0.034).applyMatrix4(m)
    docs.add(id, [p.x, p.y, p.z], [nx, 0, nz], { rotation: (rnd() - 0.5) * 0.12, pin: "pin" })
  })
}

/** Exposed conduit run along a wall top (axis x at zWall, offset into the room by dir). */
export function conduit(b: Builder, x0: number, x1: number, zWall: number, dir: 1 | -1) {
  const cy = CEIL_Y - 0.12
  b.rod("metal_galvanized", [x0, cy, zWall + dir * 0.05], [x1, cy, zWall + dir * 0.05], 0.016, 6)
  for (let x = x0 + 0.75; x < x1; x += 1.5) {
    const a = Math.min(zWall, zWall + dir * 0.08)
    const c = Math.max(zWall, zWall + dir * 0.08)
    b.box("metal_galvanized", x - 0.012, cy - 0.025, a, x + 0.012, cy + 0.025, c)
  }
}

/** Wall-mounted caged hazard light (red), lit or not. */
export function hazardLight(b: Builder, x: number, zWall: number, lit: boolean) {
  const s = zWall < 0 ? 1 : -1
  const y = FLOOR_Y + 2.55
  const lo = (d: number) => zWall + s * d
  b.box("metal_dark", x - 0.08, y - 0.1, Math.min(lo(0), lo(0.08)), x + 0.08, y - 0.06, Math.max(lo(0), lo(0.08)))
  b.cyl(lit ? M.hazardRed : M.hazardOff, T(x, y, lo(0.1)), 0.055, 0.06, 0.14, 12, { cast: false })
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    b.box("metal_dark", x + Math.cos(a) * 0.065 - 0.004, y - 0.07, lo(0.1) + Math.sin(a) * 0.065 - 0.004, x + Math.cos(a) * 0.065 + 0.004, y + 0.08, lo(0.1) + Math.sin(a) * 0.065 + 0.004)
  }
  b.cyl("metal_dark", T(x, y + 0.085, lo(0.1)), 0.07, 0.07, 0.02, 12)
  if (lit) b.lamp({ kind: "warning", position: [x, y, lo(0.25)], color: [1, 0.12, 0.05], intensity: 1.5, range: 3, size: 0.12 })
}

/** Rectangular steel table: laminate top, four tube legs (dx along local x). Collider included. */
export function table(b: Builder, x: number, z: number, yaw: number, w: number, d: number, h = 0.74, top: Mat = M.laminateTop, legs: Mat = M.darkSteel) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(top, m, w, 0.032, d, 0.01, 0, h - 0.016, 0)
  b.boxM(legs, m, w - 0.12, 0.06, 0.02, 0, h - 0.062, d / 2 - 0.06)
  b.boxM(legs, m, w - 0.12, 0.06, 0.02, 0, h - 0.062, -d / 2 + 0.06)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(legs, m, 0.035, h - 0.032, 0.035, sx * (w / 2 - 0.06), (h - 0.032) / 2, sz * (d / 2 - 0.06))
  b.collideLocal(m, [-w / 2, 0, -d / 2], [w / 2, h, d / 2])
}

/** Wall bench (slatted seat on steel brackets) along local x, back at +Z. */
export function bench(b: Builder, x: number, z: number, yaw: number, len: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  for (let k = 0; k < 4; k++) b.rbox(M.wood, m, len, 0.025, 0.075, 0.006, 0, 0.44, -0.12 + k * 0.085)
  for (const u of [-len / 2 + 0.15, len / 2 - 0.15]) {
    b.boxM(M.darkSteel, m, 0.04, 0.42, 0.04, u, 0.21, -0.12)
    b.boxM(M.darkSteel, m, 0.04, 0.04, 0.36, u, 0.41, 0.0)
    b.boxM(M.darkSteel, m, 0.04, 0.42, 0.04, u, 0.21, 0.14)
  }
  b.collideLocal(m, [-len / 2, 0, -0.2], [len / 2, 0.46, 0.2])
}

/** Coat hooks on a rail on a wall, local x along the wall. */
export function hookRail(b: Builder, x: number, z: number, yaw: number, len: number, n: number, y = FLOOR_Y + 1.65) {
  const m = T(x, y, z, yaw)
  b.rbox(M.wood, m, len, 0.08, 0.02, 0.005, 0, 0, -0.01)
  for (let k = 0; k < n; k++) {
    const u = -len / 2 + (len / n) * (k + 0.5)
    const p0 = new THREE.Vector3(u, 0, -0.02).applyMatrix4(m)
    const p1 = new THREE.Vector3(u, 0.03, -0.09).applyMatrix4(m)
    b.rod(M.darkSteel, [p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], 0.006, 6)
  }
}

/** Hanging coverall / lab coat on a hook: a soft draped slab with sleeves. */
export function garment(b: Builder, x: number, y: number, z: number, yaw: number, mat: Mat, len = 1.25) {
  const m = T(x, y, z, yaw)
  b.rbox(mat, m.clone().multiply(T(0, 0, 0, 0, 0.03)), 0.42, len, 0.07, 0.03, 0, -len / 2, -0.08)
  b.rbox(mat, m.clone().multiply(T(0, 0, 0, 0, 0, 0.12)), 0.1, len * 0.5, 0.07, 0.03, -0.24, -len * 0.3, -0.08)
  b.rbox(mat, m.clone().multiply(T(0, 0, 0, 0, 0, -0.12)), 0.1, len * 0.5, 0.07, 0.03, 0.24, -len * 0.3, -0.08)
  b.rbox(mat, m, 0.22, 0.05, 0.08, 0.02, 0, 0.0, -0.08)
}

export const YELLOW_SUIT = paint(0x8a7418, 0.85)
export const WHITE_COAT = paint(0xb8b8ac, 0.9)
export const CLOTH_DARK = paint(0x2a2c30, 0.95)

// ---------------------------------------------------------------------------------------------------------------- screens

/** CCTV feed: a grainy B&W corridor (one-point perspective tunnel, a lit panel overhead), rolling scan lines. Screens
 *  vary by their UV frame (pass `variant` to `cctvQuad`). One shader for every monitor. */
export const CCTV = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x050605, roughness: 0.25 })
  m.name = "interior_cctv"
  const p = uv().sub(0.5).mul(vec2(1.33, 1))
  const ring = max(abs(p.x), abs(p.y))
  // Tunnel: bright walls/floor near the edge falling to a dark end wall; floor lighter than the ceiling.
  const depth = smoothstep(0.06, 0.5, ring)
  const floorBand = smoothstep(0.0, 0.3, p.y.negate()).mul(0.35)
  const end = float(1).sub(aaWindow(ring, 0, 0.07)).mul(0.9).add(0.1)
  const panel = aaWindow(p.x, -0.06, 0.06).mul(aaWindow(p.y, 0.3, 0.36))
  const lines = aaLines(uv().y.mul(140), 0.35).mul(aaFade(uv().y.mul(140))).mul(0.18)
  const cell = floor(uv().mul(vec2(120, 90)))
  const grain = hash(cell.x.add(cell.y.mul(131)).add(floor(time.mul(24)).mul(733))).mul(0.25).mul(aaFade(uv().x.mul(120)))
  const roll = sin(uv().y.mul(3).sub(time.mul(0.7))).mul(0.06).add(0.94)
  const lum = depth.mul(0.55).add(floorBand).mul(end).add(panel.mul(0.8)).sub(lines).add(grain).mul(roll).clamp(0, 1.2)
  const vign = float(1).sub(smoothstep(0.35, 0.75, p.length()))
  m.emissiveNode = vec3(0.62, 0.78, 0.66).mul(lum).mul(vign).mul(1.1)
  return m
})()

/** Projected slide: an aerial photo of the north lot (grey canopy texture, the building's edge) with a red circle. */
export const SLIDE = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x0a0a0a, roughness: 0.9 })
  m.name = "interior_slide"
  const q = uv()
  const cell = floor(q.mul(vec2(64, 48)))
  const n1 = hash(cell.x.add(cell.y.mul(97)))
  const coarse = hash(floor(q.mul(vec2(9, 7))).dot(vec2(1, 53)))
  const trees = mix(float(0.18), n1.mul(0.25).add(0.12), aaFade(q.x.mul(64))).mul(coarse.mul(0.6).add(0.6))
  const lot = aaWindow(q.y, 0.0, 0.28).mul(0.35)
  const roof = aaWindow(q.x, 0.15, 0.85).mul(aaWindow(q.y, 0.0, 0.12)).mul(0.25)
  const c = q.sub(vec2(0.56, 0.52)).mul(vec2(1.33, 1)).length()
  const circle = aaWindow(c, 0.16, 0.185)
  const grey = trees.add(lot).add(roof)
  const edge = aaWindow(q.x, 0.02, 0.98).mul(aaWindow(q.y, 0.03, 0.97))
  m.emissiveNode = mix(vec3(grey, grey.mul(0.98), grey.mul(0.9)), vec3(1.4, 0.1, 0.06), circle).mul(edge).mul(0.9)
  return m
})()

/** Fluttering screen of a TV left on (static) — a cheap emissive animated noise, one shader. */
export const TV_STATIC = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x080a0a, roughness: 0.3 })
  m.name = "interior_tv_static"
  const cell = floor(uv().mul(vec2(80, 60)))
  const n = hash(cell.x.add(cell.y.mul(157)).add(floor(time.mul(20)).mul(911)))
  const g = mix(float(0.55), n.mul(0.7).add(0.2), aaFade(uv().x.mul(80)))
  m.emissiveNode = vec3(0.7, 0.78, 0.85).mul(g).mul(sin(uv().y.mul(5).add(time.mul(2))).mul(0.1).add(0.9)).mul(1.4)
  return m
})()

