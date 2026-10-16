import * as THREE from "three/webgpu"
import { abs, float, floor, fract, hash, max, mix, pow, sin, step, time, uniform, uv, vec2, vec3 } from "three/tsl"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type { Lamp, WorldContext } from "../context"
import { material, type MaterialName } from "../../render/materials"

// Shared construction kit for the interior: merged static geometry per material with world-space metre UVs, walls
// with tile bands, steel doors, drop ceilings with troffers, and the few one-off materials the library lacks.

export type Mat = MaterialName | THREE.Material
export type Band = readonly [y0: number, y1: number, mat: Mat]

export const FLOOR_Y = 0.16
export const CEIL_Y = 3.1
export const DOOR_W = 0.92
export const DOOR_H = 2.12

const std = (color: number, roughness: number, metalness = 0, name = "") => {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness })
  m.name = `interior_${name}`
  return m
}

const emissive = (color: number, emissiveColor: number, intensity: number, name: string) => {
  const m = std(color, 0.5, 0, name)
  m.emissive = new THREE.Color(emissiveColor)
  m.emissiveIntensity = intensity
  return m
}

/** Wire glass: dark frosted pane with a square wire mesh, in the pane's local 0..1 UVs. */
function wireGlass() {
  const m = std(0x2a3431, 0.22, 0, "wire_glass")
  const g = fract(uv().mul(vec2(12, 18)))
  const wire = max(step(0.93, g.x), step(0.93, g.y))
  m.colorNode = mix(vec3(0.05, 0.07, 0.066), vec3(0.2, 0.21, 0.2), wire)
  return m
}

/** Fluorescent diffuser lens with four tubes showing through (stripes across the short side of the panel). */
export function fluorescentPanel(level = 1) {
  const m = std(0x101210, 0.4, 0, "fluorescent_panel")
  const u = uniform(level)
  const stripes = pow(abs(sin(uv().x.mul(Math.PI * 4))), float(2.5)).mul(0.55).add(0.45)
  const edge = step(0.04, uv().x).mul(step(uv().x, 0.96)).mul(step(0.02, uv().y)).mul(step(uv().y, 0.98))
  m.emissiveNode = vec3(0.86, 0.95, 1.0).mul(stripes).mul(edge).mul(u).mul(5.5)
  return { material: m, level: u }
}

/** Frosted pane lit from behind by something like a television tuned to nothing: coarse flickering white static. */
function staticGlass() {
  const m = std(0x101414, 0.3, 0, "static_glass")
  const u = uniform(1)
  const cell = floor(uv().mul(vec2(46, 64)))
  const frame = floor(time.mul(22))
  const n = hash(cell.x.add(cell.y.mul(157)).add(frame.mul(911)))
  const roll = sin(uv().y.mul(9).add(time.mul(3.1))).mul(0.12).add(0.88)
  const g = fract(uv().mul(vec2(12, 18)))
  const wire = max(step(0.93, g.x), step(0.93, g.y))
  m.emissiveNode = vec3(0.82, 0.9, 1.0).mul(n.mul(0.6).add(0.4)).mul(roll).mul(u).mul(float(1).sub(wire.mul(0.7))).mul(3.2)
  return { material: m, level: u }
}

export const M = {
  frame: std(0x2b3a31, 0.45, 0.45, "door_frame"),
  tbar: std(0x6e6f68, 0.7, 0.1, "tbar"),
  housing: std(0x5a5b56, 0.7, 0.2, "troffer_housing"),
  diffuserOff: std(0x8d9290, 0.35, 0, "diffuser_off"),
  stripe: std(0x1e3b2c, 0.18, 0, "floor_stripe"),
  kick: std(0x8c8e8a, 0.35, 0.85, "kick_plate"),
  plate: std(0x3a3d38, 0.5, 0.6, "room_plate"),
  wireGlass: wireGlass(),
  laminate: std(0x231d18, 0.5, 0, "laminate"),
  laminateTop: std(0x34302a, 0.35, 0, "counter_top"),
  beige: std(0x8a8574, 0.6, 0, "crt_beige"),
  crtScreen: emissive(0x050807, 0x3d7a58, 0.5, "crt_screen"),
  phone: std(0x1a1a18, 0.4, 0, "phone"),
  paper: std(0xcfcbbb, 0.9, 0, "paper"),
  clipboard: std(0x5a3e22, 0.6, 0, "clipboard"),
  felt: std(0x0f1110, 0.95, 0, "felt"),
  feltText: std(0x9a9a92, 0.7, 0, "felt_text"),
  cork: std(0x5e4329, 0.95, 0, "cork"),
  potClay: std(0x3e3127, 0.8, 0, "pot"),
  leaf: std(0x1b2e1d, 0.65, 0, "leaf"),
  soil: std(0x15110d, 1, 0, "soil"),
  red: std(0x7a1610, 0.45, 0.1, "red"),
  hazardRed: emissive(0x2a0806, 0xff2a12, 1.4, "hazard_red"),
  hazardOff: std(0x3a1410, 0.4, 0, "hazard_off"),
  exitSign: emissive(0x1a0404, 0xff1a0c, 2.2, "exit_sign"),
  cabinet: std(0x5d665e, 0.5, 0.35, "lab_cabinet"),
  epoxy: std(0x161817, 0.3, 0, "epoxy_top"),
  steel: std(0x9a9c98, 0.32, 0.9, "stainless"),
  stoolSeat: std(0x121212, 0.55, 0, "stool_seat"),
  chalkboard: std(0x1a2620, 0.88, 0, "chalkboard"),
  chalkSmear: std(0x2a3832, 0.95, 0, "chalk_smear"),
  wood: std(0x4a3420, 0.6, 0, "wood"),
  glass: Object.assign(std(0xcfe2dc, 0.04, 0, "glassware"), { transparent: true, opacity: 0.28, depthWrite: false }),
  bulbWarm: emissive(0x332211, 0xffb060, 6, "bulb_warm"),
  lampShade: std(0xb8b4a4, 0.4, 0.6, "lamp_shade"),
  yellow: std(0x8f7212, 0.5, 0, "bucket_yellow"),
  jugWhite: std(0xbcbcb0, 0.55, 0, "jug_white"),
  jugBlue: std(0x22406a, 0.45, 0, "jug_blue"),
  jugBrown: std(0x3a2412, 0.3, 0, "bottle_brown"),
  cardboard: std(0x6a5236, 0.9, 0, "cardboard"),
  concreteSink: std(0x6e6e66, 0.8, 0, "mop_sink"),
  camera: std(0xb0ada0, 0.5, 0.3, "camera_body"),
  cameraLens: std(0x050505, 0.1, 0.5, "camera_lens"),
  chairBlack: std(0x161616, 0.6, 0, "chair_black"),
}

export const corridorBands: Band[] = [
  [0, 0.3, "tile_green_dark"],
  [0.3, 1.02, "tile_green"],
  [1.02, 1.2, "tile_green_dark"],
  [1.2, DOOR_H + 0.05, "tile_green"],
  [DOOR_H + 0.05, CEIL_Y, "painted_wall"],
]

export const lobbyBands: Band[] = [
  [0, 0.25, "tile_green_dark"],
  [0.25, 1.1, "tile_green"],
  [1.1, 1.2, "tile_green_dark"],
  [1.2, CEIL_Y, "painted_wall"],
]

export const closetBands: Band[] = [
  [0, 0.2, "tile_green_dark"],
  [0.2, CEIL_Y, "painted_wall"],
]

const tmpV = new THREE.Vector3()
const tmpN = new THREE.Vector3()

/** Planar world UVs in metres, projected along each vertex's dominant normal axis, so tiles line up across pieces. */
function worldUV(g: THREE.BufferGeometry) {
  const pos = g.getAttribute("position")
  const nor = g.getAttribute("normal")
  const out = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    tmpV.fromBufferAttribute(pos, i)
    tmpN.fromBufferAttribute(nor, i)
    const ax = Math.abs(tmpN.x)
    const ay = Math.abs(tmpN.y)
    const az = Math.abs(tmpN.z)
    if (ay >= ax && ay >= az) {
      out[i * 2] = tmpV.x
      out[i * 2 + 1] = tmpV.z
    } else if (ax >= az) {
      out[i * 2] = tmpN.x > 0 ? -tmpV.z : tmpV.z
      out[i * 2 + 1] = tmpV.y
    } else {
      out[i * 2] = tmpN.z > 0 ? tmpV.x : -tmpV.x
      out[i * 2 + 1] = tmpV.y
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(out, 2))
}

const mat4 = new THREE.Matrix4()
const quat = new THREE.Quaternion()
const euler = new THREE.Euler()
const one = new THREE.Vector3(1, 1, 1)

/** Translation then rotation (Euler XYZ order by default), as a fresh matrix. */
export function T(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, order: THREE.EulerOrder = "YXZ") {
  euler.set(rx, ry, rz, order)
  quat.setFromEuler(euler)
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), quat, one)
}

type AddOpts = { worldUV?: boolean; cast?: boolean }

export class Builder {
  private parts = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>()
  readonly group = new THREE.Group()

  constructor(readonly ctx: WorldContext) {
    this.group.name = "interior"
  }

  add(mat: Mat, g: THREE.BufferGeometry, opts: AddOpts = {}) {
    const m = typeof mat === "string" ? material(mat) : mat
    const cast = opts.cast ?? true
    let geo = g.index ? g.toNonIndexed() : g
    for (const name of Object.keys(geo.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") geo.deleteAttribute(name)
    if (opts.worldUV ?? true) worldUV(geo)
    const key = `${m.uuid}:${cast}`
    let p = this.parts.get(key)
    if (!p) this.parts.set(key, (p = { mat: m, cast, geos: [] }))
    p.geos.push(geo)
    if (geo !== g) g.dispose()
  }

  /** Axis-aligned box from min to max corners. */
  box(mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts?: AddOpts) {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0))
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    this.add(mat, g, opts)
  }

  /** Box of size w×h×d centred at the origin of `m` (plus a local offset). */
  boxM(mat: Mat, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oy = 0, oz = 0, opts?: AddOpts) {
    const g = new THREE.BoxGeometry(w, h, d)
    g.translate(ox, oy, oz)
    g.applyMatrix4(m)
    this.add(mat, g, opts)
  }

  cyl(mat: Mat, m: THREE.Matrix4, rTop: number, rBot: number, h: number, seg = 12, opts?: AddOpts & { open?: boolean }) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, opts?.open ?? false)
    g.applyMatrix4(m)
    this.add(mat, g, opts)
  }

  /** Flat quad of w×h in the local XY plane facing local +Z, keeping its own 0..1 UVs. */
  quad(mat: Mat, m: THREE.Matrix4, w: number, h: number, opts?: AddOpts) {
    const g = new THREE.PlaneGeometry(w, h)
    g.applyMatrix4(m)
    this.add(mat, g, { worldUV: false, ...opts })
  }

  collide(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    this.ctx.colliders.push({
      min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
      max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
    })
  }

  /** Collider for a local box (min/max in the frame of `m`), as the world AABB of its corners. */
  collideLocal(m: THREE.Matrix4, min: readonly [number, number, number], max: readonly [number, number, number]) {
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)).applyMatrix4(m)
    this.collide(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z)
  }

  floor(mat: Mat, x0: number, z0: number, x1: number, z1: number) {
    this.box(mat, x0, FLOOR_Y - 0.012, z0, x1, FLOOR_Y, z1, { cast: false })
    this.ctx.floors.push({ min: [Math.min(x0, x1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(z0, z1)], y: FLOOR_Y })
  }

  lamp(l: Lamp) {
    this.ctx.lamps.push(l)
  }

  /** Separate mesh (not merged) for parts whose material animates per instance. */
  mesh(mat: THREE.Material, g: THREE.BufferGeometry) {
    const mesh = new THREE.Mesh(g, mat)
    mesh.matrixAutoUpdate = false
    this.group.add(mesh)
    return mesh
  }

  flush() {
    for (const p of this.parts.values()) {
      const g = mergeGeometries(p.geos, false)
      for (const s of p.geos) s.dispose()
      if (!g) continue
      g.computeBoundingSphere()
      const mesh = new THREE.Mesh(g, p.mat)
      mesh.name = `interior:${p.mat.name}`
      mesh.castShadow = p.cast
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
    }
    this.parts.clear()
    this.ctx.scene.add(this.group)
  }
}

export type Opening = { a0: number; a1: number; top: number }

/**
 * A straight wall built from horizontal bands. `axis` "x" runs along X (c0..c1 is its Z thickness); "z" runs along Z.
 * Openings cut doorways; colliders cover the solid segments only (door leaves add their own).
 */
export function wall(b: Builder, axis: "x" | "z", a0: number, a1: number, c0: number, c1: number, bands: readonly Band[], openings: Opening[] = []) {
  const sorted = [...openings].sort((p, q) => p.a0 - q.a0)
  const seg = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return
    if (axis === "x") b.box(mat, s0, y0, c0, s1, y1, c1)
    else b.box(mat, c0, y0, s0, c1, y1, s1)
  }
  let mat: Mat = "painted_wall"
  let cursor = a0
  const spans: [number, number][] = []
  for (const o of sorted) {
    spans.push([cursor, o.a0])
    cursor = o.a1
  }
  spans.push([cursor, a1])
  for (const [y0r, y1r, m] of bands) {
    mat = m
    const y0 = FLOOR_Y - 0.01 + y0r
    const y1 = y1r >= CEIL_Y ? CEIL_Y + 0.02 : FLOOR_Y + y1r
    for (const [s0, s1] of spans) seg(s0, s1, y0, y1)
    for (const o of sorted) seg(o.a0, o.a1, Math.max(y0, FLOOR_Y + o.top), y1)
  }
  for (const [s0, s1] of spans) {
    if (s1 - s0 < 1e-3) continue
    if (axis === "x") b.collide(s0, FLOOR_Y, c0, s1, CEIL_Y, c1)
    else b.collide(c0, FLOOR_Y, s0, c1, CEIL_Y, s1)
  }
}

/** Opening for a door frame centred at `a` (frame jambs included). */
export const doorOpening = (a: number, w = DOOR_W): Opening => ({ a0: a - w / 2 - 0.05, a1: a + w / 2 + 0.05, top: DOOR_H + 0.05 })

export type DoorOpts = {
  /** Frame rotation: local +X runs along the wall, local +Z points to the "front" (corridor) side. */
  rot: number
  wallT?: number
  width?: number
  leaves?: 1 | 2
  /** Opening angle in radians; positive swings the leaf to the back (-Z local) side. */
  open?: number
  glass?: THREE.Material | null
  plate?: boolean
}

/** Institutional steel door: frame, leaf (or pair), wire-glass vision panel, kick plates, lever, red push band. */
export function door(b: Builder, x: number, z: number, o: DoorOpts) {
  const w = o.width ?? DOOR_W
  const t = 0.045
  const wallT = o.wallT ?? 0.15
  const leaves = o.leaves ?? 1
  const open = o.open ?? 0
  const y = FLOOR_Y
  const F = T(x, y, z, o.rot)
  const fd = wallT + 0.04
  // Frame
  b.boxM(M.frame, F, 0.05, DOOR_H + 0.05, fd, -w / 2 - 0.025, (DOOR_H + 0.05) / 2, 0)
  b.boxM(M.frame, F, 0.05, DOOR_H + 0.05, fd, w / 2 + 0.025, (DOOR_H + 0.05) / 2, 0)
  b.boxM(M.frame, F, w + 0.1, 0.05, fd, 0, DOOR_H + 0.025, 0)
  if (o.plate ?? true) {
    b.boxM(M.plate, F, 0.16, 0.1, 0.012, w / 2 + 0.22, 1.5, wallT / 2 + 0.006)
    b.boxM(M.plate, F, 0.16, 0.1, 0.012, w / 2 + 0.22, 1.5, -wallT / 2 - 0.006)
  }
  const lw = w / leaves - (leaves === 2 ? 0.004 : 0.006)
  const glass = o.glass === undefined ? M.wireGlass : o.glass
  for (let i = 0; i < leaves; i++) {
    const mirror = i === 1
    const hingeX = mirror ? w / 2 : -w / 2
    const dir = mirror ? -1 : 1
    const L = open
      ? F.clone().multiply(T(hingeX + dir * t / 2, 0, -wallT / 2, mirror ? Math.PI - open : open))
      : F.clone().multiply(T(hingeX + dir * 0.003, 0, 0, mirror ? Math.PI : 0))
    const cx = lw / 2
    b.boxM("door_steel", L, lw, DOOR_H - 0.01, t, cx, (DOOR_H - 0.01) / 2 + 0.005, 0)
    for (const s of [1, -1]) {
      const fz = s * (t / 2 + 0.002)
      b.boxM(M.kick, L, lw - 0.04, 0.25, 0.003, cx, 0.14, fz)
      // lever handle on the latch side
      b.boxM(M.kick, L, 0.05, 0.05, 0.05, lw - 0.07, 1.04, s * (t / 2 + 0.025))
      b.boxM(M.kick, L, 0.13, 0.022, 0.022, lw - 0.12, 1.04, s * (t / 2 + 0.05))
      if (glass) {
        const gw = leaves === 2 ? 0.2 : 0.3
        const gh = leaves === 2 ? 0.7 : 0.46
        const gx = leaves === 2 ? lw / 2 : lw * 0.56
        const gy = leaves === 2 ? 1.45 : 1.6
        b.quad(glass, L.clone().multiply(T(gx, gy, s * (t / 2 + 0.003), s > 0 ? 0 : Math.PI)), gw, gh, { cast: false })
        b.boxM("door_steel", L, gw + 0.06, 0.03, 0.012, gx, gy + gh / 2 + 0.015, s * (t / 2 + 0.006))
        b.boxM("door_steel", L, gw + 0.06, 0.03, 0.012, gx, gy - gh / 2 - 0.015, s * (t / 2 + 0.006))
        b.boxM("door_steel", L, 0.03, gh, 0.012, gx - gw / 2 - 0.015, gy, s * (t / 2 + 0.006))
        b.boxM("door_steel", L, 0.03, gh, 0.012, gx + gw / 2 + 0.015, gy, s * (t / 2 + 0.006))
      }
    }
    b.collideLocal(L, [0, 0, -t / 2 - 0.02], [lw, DOOR_H, t / 2 + 0.02])
  }
}

/** Ceiling slab with an exposed 0.6 × 1.2 m T-bar grid (global alignment: X lines at 0.3+0.6k, Z lines at 0.6+1.2k). */
export function ceiling(b: Builder, x0: number, z0: number, x1: number, z1: number) {
  b.box("ceiling_tile", x0, CEIL_Y, z0, x1, CEIL_Y + 0.03, z1, { cast: false })
  const y0 = CEIL_Y - 0.006
  for (let k = Math.ceil((x0 - 0.3) / 0.6); 0.3 + k * 0.6 < x1; k++) {
    const x = 0.3 + k * 0.6
    if (x - x0 < 0.05) continue
    b.box(M.tbar, x - 0.012, y0, z0, x + 0.012, CEIL_Y, z1, { cast: false })
  }
  for (let k = Math.ceil((z0 - 0.6) / 1.2); 0.6 + k * 1.2 < z1; k++) {
    const z = 0.6 + k * 1.2
    if (z - z0 < 0.05) continue
    b.box(M.tbar, x0, y0, z - 0.012, x1, CEIL_Y, z + 0.012, { cast: false })
  }
}

export type TrofferState = "on" | "off" | { flicker: number; level: THREE.UniformNode<"float", number>; material: THREE.Material }

/** Recessed 0.6 × 1.2 m troffer (long side along Z) at grid-aligned (x, z). */
export function troffer(b: Builder, x: number, z: number, state: TrofferState, on: THREE.Material) {
  const y = CEIL_Y - 0.004
  b.box(M.housing, x - 0.31, y - 0.02, z - 0.61, x + 0.31, y, z - 0.585, { cast: false })
  b.box(M.housing, x - 0.31, y - 0.02, z + 0.585, x + 0.31, y, z + 0.61, { cast: false })
  b.box(M.housing, x - 0.31, y - 0.02, z - 0.585, x - 0.285, y, z + 0.585, { cast: false })
  b.box(M.housing, x + 0.285, y - 0.02, z - 0.585, x + 0.31, y, z + 0.585, { cast: false })
  const pm = T(x, y - 0.006, z, 0, Math.PI / 2)
  if (state === "off") b.quad(M.diffuserOff, pm, 0.57, 1.17, { cast: false })
  else if (state === "on") b.quad(on, pm, 0.57, 1.17, { cast: false })
  else {
    const g = new THREE.PlaneGeometry(0.57, 1.17)
    g.applyMatrix4(pm)
    b.mesh(state.material, g)
  }
}

/** Cheap deterministic flicker: mostly on, with stuttering bursts. Returns 0..1. */
export function flicker(t: number, seed: number, amount: number) {
  const slow = Math.sin(t * 0.9 + seed * 1.3) * Math.sin(t * 0.37 + seed * 2.1)
  const frame = Math.floor(t * 18)
  const n = fract1(Math.sin((frame + seed * 131) * 12.9898) * 43758.5453)
  const burst = slow > 0.35
  const on = burst ? (n > 0.5 ? 1 : n > 0.3 ? 0.35 : 0.05) : n > 0.02 ? 1 : 0.4
  return 1 - amount * (1 - on)
}

const fract1 = (v: number) => v - Math.floor(v)

export { staticGlass }
