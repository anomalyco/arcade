import * as THREE from "three/webgpu"
import { abs, attribute, float, floor, fract, hash, max, mix, positionWorld, pow, sin, step, time, uniform, uv, vec2, vec3 } from "three/tsl"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import type { Lamp, WorldContext } from "../context"
import { BUILDING } from "../layout"
import { material, type MaterialName } from "../../render/materials"

// Shared construction kit for the interior: merged static geometry per material with world-space metre UVs, walls
// with tile bands, steel doors, drop ceilings with troffers, and the few one-off materials the library lacks.

export type Mat = MaterialName | THREE.Material | Paint
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

export const PANEL_ON = fluorescentPanel(1).material

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

/** A flat-coloured surface drawn with the shared vertex-colour material (one shader, merged per storey). */
export type Paint = { readonly paint: true; readonly c: readonly [number, number, number]; readonly r: number; readonly m: number }
const col = new THREE.Color()
export const paint = (hex: number, roughness: number, metalness = 0): Paint => {
  col.setHex(hex)
  return { paint: true, c: [col.r, col.g, col.b], r: roughness, m: metalness }
}

/** The one material every Paint shares: albedo from the vertex colour, roughness/metalness from the `rm` attribute,
 *  with a faint world-space mottling so large flat-painted planes don't read as CG. */
const vcMaterial = (() => {
  const m = new THREE.MeshStandardNodeMaterial()
  const rm = attribute<"vec2">("rm", "vec2")
  const mottle = hash(floor(positionWorld.mul(9)).dot(vec3(1, 57, 113))).mul(0.06).add(0.97)
  m.colorNode = attribute<"vec3">("color", "vec3").mul(mottle)
  m.roughnessNode = rm.x
  m.metalnessNode = rm.y
  m.name = "interior_paint"
  return m
})()

export const M = {
  frame: paint(0x2b3a31, 0.45, 0.45),
  tbar: paint(0x6e6f68, 0.7, 0.1),
  housing: paint(0x5a5b56, 0.7, 0.2),
  diffuserOff: paint(0x8d9290, 0.35, 0),
  stripe: paint(0x1e3b2c, 0.18, 0),
  kick: paint(0x8c8e8a, 0.35, 0.85),
  plate: paint(0x3a3d38, 0.5, 0.6),
  wireGlass: wireGlass(),
  laminate: paint(0x231d18, 0.5, 0),
  laminateTop: paint(0x34302a, 0.35, 0),
  paper: paint(0xcfcbbb, 0.9, 0),
  clipboard: paint(0x5a3e22, 0.6, 0),
  felt: paint(0x0f1110, 0.95, 0),
  feltText: paint(0x9a9a92, 0.7, 0),
  cork: paint(0x5e4329, 0.95, 0),
  potClay: paint(0x3e3127, 0.8, 0),
  leaf: paint(0x1b2e1d, 0.65, 0),
  soil: paint(0x15110d, 1, 0),
  red: paint(0x7a1610, 0.45, 0.1),
  hazardRed: emissive(0x2a0806, 0xff2a12, 1.4, "hazard_red"),
  hazardOff: paint(0x3a1410, 0.4, 0),
  exitSign: emissive(0x1a0404, 0xff1a0c, 2.2, "exit_sign"),
  cabinet: paint(0x5d665e, 0.5, 0.35),
  epoxy: paint(0x161817, 0.3, 0),
  steel: paint(0x9a9c98, 0.32, 0.9),
  darkSteel: paint(0x2c2e2d, 0.45, 0.8),
  stoolSeat: paint(0x121212, 0.55, 0),
  chalkboard: paint(0x1a2620, 0.88, 0),
  chalkSmear: paint(0x2a3832, 0.95, 0),
  wood: paint(0x4a3420, 0.6, 0),
  glass: Object.assign(std(0xcfe2dc, 0.04, 0, "glass"), { transparent: true, opacity: 0.22, depthWrite: false }),
  bulbWarm: emissive(0x332211, 0xffb060, 6, "bulb_warm"),
  bulbCool: emissive(0x223030, 0xd8eeff, 5, "bulb_cool"),
  lampShade: paint(0xb8b4a4, 0.4, 0.6),
  yellow: paint(0x8f7212, 0.5, 0),
  jugWhite: paint(0xbcbcb0, 0.55, 0),
  jugBrown: paint(0x3a2412, 0.3, 0),
  cardboard: paint(0x6a5236, 0.9, 0),
  concreteSink: paint(0x6e6e66, 0.8, 0),
  rubber: paint(0x141414, 0.9, 0),
  beige: paint(0x9a927c, 0.55, 0),
  enamel: paint(0x7d8a7e, 0.4, 0.1),
  stencil: paint(0xb9b29a, 0.8, 0),
  safety: paint(0x9a7a1a, 0.6, 0.2),
  plaster: paint(0xb3b4a6, 0.9, 0),
  concrete: paint(0x5c5c56, 0.92, 0),
  debris: paint(0x8a877c, 0.95, 0),
  stain: paint(0x6f6a5c, 0.95, 0),
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

/** Planar world UV (metres) for a point with normal n, projected along the dominant normal axis. */
function uvFor(x: number, y: number, z: number, nx: number, ny: number, nz: number, out: number[]) {
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  const az = Math.abs(nz)
  if (ay >= ax && ay >= az) out.push(x, z)
  else if (ax >= az) out.push(nx > 0 ? -z : z, y)
  else out.push(nz > 0 ? x : -x, y)
}

const mat4 = new THREE.Matrix4()
const quat = new THREE.Quaternion()
const euler = new THREE.Euler()
const one = new THREE.Vector3(1, 1, 1)

/** Translation then rotation (Euler YXZ order by default), as a fresh matrix. */
export function T(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, order: THREE.EulerOrder = "YXZ") {
  euler.set(rx, ry, rz, order)
  quat.setFromEuler(euler)
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), quat, one)
}

type AddOpts = { worldUV?: boolean; cast?: boolean }
type Part = { mat: THREE.Material; cast: boolean; vc: boolean; pos: number[]; nor: number[]; uv: number[]; col: number[]; rm: number[] }

export const STOREY_H = BUILDING.main.storeyHeight

// Box faces: normal, then the four corners as (x, y, z) picks from [min, max] (0 = min, 1 = max), counter-clockwise.
const FACES: [number, number, number, number[][]][] = [
  [1, 0, 0, [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
  [-1, 0, 0, [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  [0, 1, 0, [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
  [0, -1, 0, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  [0, 0, 1, [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
  [0, 0, -1, [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
]

/**
 * Collects static geometry per material (Paint surfaces all share one vertex-colour material) and emits one merged
 * mesh each into its own group. Geometry is authored in ground-floor coordinates; `storey` lifts everything (meshes,
 * colliders, floors, lamps) by whole storeys, so the same code builds every floor. UVs are computed before the lift so
 * tile courses line up the same way on every storey.
 */
export class Builder {
  private parts = new Map<string, Part>()
  readonly group = new THREE.Group()
  oy = 0
  zone = "interior:0"
  private storeyIndex = 0

  constructor(
    readonly ctx: WorldContext,
    name: string,
    storey = 0,
  ) {
    this.group.name = `interior:${name}`
    this.storey = storey
  }

  get storey() {
    return this.storeyIndex
  }
  set storey(i: number) {
    this.storeyIndex = i
    this.oy = i * STOREY_H
    this.zone = `interior:${Math.min(i, BUILDING.main.storeys - 1)}`
  }

  private part(mat: Mat, cast: boolean): Part {
    const isPaint = typeof mat === "object" && "paint" in mat
    const m = isPaint ? vcMaterial : typeof mat === "string" ? material(mat) : (mat as THREE.Material)
    const key = `${m.uuid}:${cast}`
    let p = this.parts.get(key)
    if (!p) this.parts.set(key, (p = { mat: m, cast, vc: isPaint, pos: [], nor: [], uv: [], col: [], rm: [] }))
    return p
  }

  private paintVerts(p: Part, mat: Mat, n: number) {
    if (!p.vc) return
    const c = (mat as Paint).c
    for (let i = 0; i < n; i++) {
      p.col.push(c[0], c[1], c[2])
      p.rm.push((mat as Paint).r, (mat as Paint).m)
    }
  }

  add(mat: Mat, g: THREE.BufferGeometry, opts: AddOpts = {}) {
    const p = this.part(mat, opts.cast ?? true)
    if (!g.getAttribute("normal")) g.computeVertexNormals()
    const pos = g.getAttribute("position")
    const nor = g.getAttribute("normal")
    const uv = g.getAttribute("uv")
    const index = g.index
    const n = index ? index.count : pos.count
    const world = opts.worldUV ?? true
    const oy = this.oy
    for (let k = 0; k < n; k++) {
      const i = index ? index.getX(k) : k
      tmpV.fromBufferAttribute(pos, i)
      tmpN.fromBufferAttribute(nor, i)
      p.pos.push(tmpV.x, tmpV.y + oy, tmpV.z)
      p.nor.push(tmpN.x, tmpN.y, tmpN.z)
      if (world || !uv) uvFor(tmpV.x, tmpV.y, tmpV.z, tmpN.x, tmpN.y, tmpN.z, p.uv)
      else p.uv.push(uv.getX(i), uv.getY(i))
    }
    this.paintVerts(p, mat, n)
    g.dispose()
  }

  /** Axis-aligned box from min to max corners (emitted directly: the interior has thousands of them). */
  /** `skip` lists faces to leave out: X/Y/Z = the + faces, x/y/z = the - faces. */
  box(mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts?: AddOpts & { skip?: string }) {
    const p = this.part(mat, opts?.cast ?? true)
    const lo = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)]
    const hi = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]
    const oy = this.oy
    let n = 0
    for (let f = 0; f < 6; f++) {
      if (opts?.skip && opts.skip.includes("XxYyZz"[f]!)) continue
      const [nx, ny, nz, cs] = FACES[f]!
      const v = cs.map(([a, b, c]) => [a ? hi[0]! : lo[0]!, b ? hi[1]! : lo[1]!, c ? hi[2]! : lo[2]!])
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const [x, y, z] = v[k]!
        p.pos.push(x!, y! + oy, z!)
        p.nor.push(nx, ny, nz)
        uvFor(x!, y!, z!, nx, ny, nz, p.uv)
      }
      n += 6
    }
    this.paintVerts(p, mat, n)
  }

  /** Box of size w×h×d centred at the origin of `m` (plus a local offset). */
  boxM(mat: Mat, m: THREE.Matrix4, w: number, h: number, d: number, ox = 0, oy = 0, oz = 0, opts?: AddOpts) {
    const g = new THREE.BoxGeometry(w, h, d)
    g.translate(ox, oy, oz)
    g.applyMatrix4(m)
    this.add(mat, g, opts)
  }

  /** Bevelled box (rounded edges) of size w×h×d centred at the origin of `m` plus an offset. */
  rbox(mat: Mat, m: THREE.Matrix4, w: number, h: number, d: number, r = 0.02, ox = 0, oy = 0, oz = 0, opts?: AddOpts) {
    const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3))
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

  /** Cylinder rod between two points. */
  rod(mat: Mat, p0: readonly number[], p1: readonly number[], r: number, seg = 8, opts?: AddOpts) {
    tmpV.set(p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!)
    const len = tmpV.length()
    quat.setFromUnitVectors(UP, tmpV.normalize())
    mat4.compose(tmpN.set((p0[0]! + p1[0]!) / 2, (p0[1]! + p1[1]!) / 2, (p0[2]! + p1[2]!) / 2), quat, one)
    this.cyl(mat, mat4, r, r, len, seg, opts)
  }

  collide(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    this.ctx.colliders.push({
      min: [Math.min(x0, x1), Math.min(y0, y1) + this.oy, Math.min(z0, z1)],
      max: [Math.max(x0, x1), Math.max(y0, y1) + this.oy, Math.max(z0, z1)],
    })
  }

  /** Collider for a local box (min/max in the frame of `m`), as the world AABB of its corners. */
  collideLocal(m: THREE.Matrix4, min: readonly [number, number, number], max: readonly [number, number, number]) {
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)).applyMatrix4(m)
    this.collide(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z)
  }

  /** Walkable surface at local height y (registers only; draw it separately). */
  walk(x0: number, z0: number, x1: number, z1: number, y = FLOOR_Y) {
    this.ctx.floors.push({ min: [Math.min(x0, x1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(z0, z1)], y: y + this.oy })
  }

  floor(mat: Mat, x0: number, z0: number, x1: number, z1: number) {
    this.box(mat, x0, FLOOR_Y - 0.012, z0, x1, FLOOR_Y, z1, { cast: false, skip: "y" })
    this.walk(x0, z0, x1, z1)
  }

  /** Registers a lamp (local position) in this storey's zone and returns the registered object. */
  lamp(l: Lamp): Lamp {
    const out: Lamp = { ...l, position: [l.position[0], l.position[1] + this.oy, l.position[2]], zone: this.zone }
    this.ctx.lamps.push(out)
    return out
  }

  /** Separate mesh (not merged) for parts whose material animates per instance. */
  mesh(mat: THREE.Material, g: THREE.BufferGeometry) {
    g.translate(0, this.oy, 0)
    const mesh = new THREE.Mesh(g, mat)
    mesh.matrixAutoUpdate = false
    this.group.add(mesh)
    return mesh
  }

  flush(parent: THREE.Object3D = this.ctx.scene) {
    for (const p of this.parts.values()) {
      if (!p.pos.length) continue
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(p.pos, 3))
      g.setAttribute("normal", new THREE.Float32BufferAttribute(p.nor, 3))
      g.setAttribute("uv", new THREE.Float32BufferAttribute(p.uv, 2))
      if (p.vc) {
        g.setAttribute("color", new THREE.Float32BufferAttribute(p.col, 3))
        g.setAttribute("rm", new THREE.Float32BufferAttribute(p.rm, 2))
      }
      g.computeBoundingSphere()
      g.computeBoundingBox()
      const mesh = new THREE.Mesh(g, p.mat)
      mesh.name = `${this.group.name}:${p.mat.name}`
      mesh.castShadow = p.cast
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
    }
    this.parts.clear()
    parent.add(this.group)
  }
}

const UP = new THREE.Vector3(0, 1, 0)

/** A gap in a wall from `bottom` (default the floor) to `top`, both relative to the finished floor. */
export type Opening = { a0: number; a1: number; top: number; bottom?: number }

/**
 * A straight wall built from horizontal bands. `axis` "x" runs along X (c0..c1 is its Z thickness); "z" runs along Z.
 * Openings cut doorways and windows; colliders cover the solid segments (door leaves add their own).
 * `y0`/`y1` override the vertical extent (local heights) for walls that aren't floor-to-ceiling (stairwells).
 */
export function wall(
  b: Builder,
  axis: "x" | "z",
  a0: number,
  a1: number,
  c0: number,
  c1: number,
  bands: readonly Band[],
  openings: Opening[] = [],
  extent?: { y0: number; y1: number; collide?: boolean },
) {
  const sorted = [...openings].sort((p, q) => p.a0 - q.a0)
  const seg = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return
    if (axis === "x") b.box(mat, s0, y0, c0, s1, y1, c1)
    else b.box(mat, c0, y0, s0, c1, y1, s1)
  }
  const top = extent?.y1 ?? CEIL_Y + 0.02
  const base = extent?.y0 ?? FLOOR_Y - 0.01
  let mat: Mat = "painted_wall"
  let cursor = a0
  const spans: [number, number][] = []
  for (const o of sorted) {
    spans.push([cursor, o.a0])
    cursor = o.a1
  }
  spans.push([cursor, a1])
  bands.forEach(([y0r, y1r, m], bi) => {
    mat = m
    const y0 = bi === 0 ? base : Math.max(base, FLOOR_Y + y0r)
    const y1 = bi === bands.length - 1 || y1r >= CEIL_Y ? top : Math.min(top, FLOOR_Y + y1r)
    if (y1 <= y0) return
    for (const [s0, s1] of spans) seg(s0, s1, y0, y1)
    for (const o of sorted) {
      seg(o.a0, o.a1, Math.max(y0, FLOOR_Y + o.top), y1)
      if (o.bottom !== undefined) seg(o.a0, o.a1, y0, Math.min(y1, FLOOR_Y + o.bottom))
    }
  })
  if (extent?.collide === false) return
  for (const [s0, s1] of spans) {
    if (s1 - s0 < 1e-3) continue
    if (axis === "x") b.collide(s0, base, c0, s1, top, c1)
    else b.collide(c0, base, s0, c1, top, s1)
  }
  for (const o of sorted) {
    if (o.bottom === undefined) continue
    if (axis === "x") b.collide(o.a0, base, c0, o.a1, FLOOR_Y + o.bottom, c1)
    else b.collide(c0, base, o.a0, c1, FLOOR_Y + o.bottom, o.a1)
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
  /** Horizontal push bar instead of levers (fire exits). */
  panic?: boolean
  /** Rubber wedge under the open leaf. */
  wedge?: boolean
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
    const pivotZ = open > 0 ? -wallT / 2 : wallT / 2
    const L = open
      ? F.clone().multiply(T(hingeX + dir * t / 2, 0, pivotZ, mirror ? Math.PI - open : open))
      : F.clone().multiply(T(hingeX + dir * 0.003, 0, 0, mirror ? Math.PI : 0))
    const cx = lw / 2
    b.boxM("door_steel", L, lw, DOOR_H - 0.01, t, cx, (DOOR_H - 0.01) / 2 + 0.005, 0)
    for (const s of [1, -1]) {
      const fz = s * (t / 2 + 0.002)
      b.boxM(M.kick, L, lw - 0.04, 0.25, 0.003, cx, 0.14, fz)
      if (o.panic && s > 0) {
        b.boxM(M.kick, L, 0.05, 0.08, 0.07, 0.08, 1.0, t / 2 + 0.035)
        b.boxM(M.kick, L, 0.05, 0.08, 0.07, lw - 0.08, 1.0, t / 2 + 0.035)
        b.rbox(M.darkSteel, L, lw - 0.16, 0.06, 0.05, 0.02, lw / 2, 1.0, t / 2 + 0.07)
      } else {
        // lever handle on the latch side
        b.boxM(M.kick, L, 0.05, 0.05, 0.05, lw - 0.07, 1.04, s * (t / 2 + 0.025))
        b.boxM(M.kick, L, 0.13, 0.022, 0.022, lw - 0.12, 1.04, s * (t / 2 + 0.05))
      }
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
    if (open && o.wedge) b.boxM(M.rubber, L, 0.07, 0.035, 0.14, lw - 0.1, 0.017, open > 0 ? -0.09 : 0.09)
  }
}

/**
 * Drop ceiling with an exposed 0.6 × 1.2 m T-bar grid (global alignment: X lines at 0.3+0.6k, Z lines at 0.6+1.2k).
 * With `missing` > 0 the tiles are laid one by one and that fraction is left out (or lies on the floor, see `fallen`),
 * showing the plenum and the slab above.
 */
export function ceiling(b: Builder, x0: number, z0: number, x1: number, z1: number, missing = 0, seed = 1, fallen?: (x: number, z: number) => void) {
  const y0 = CEIL_Y - 0.006
  if (missing <= 0) b.box("ceiling_tile", x0, CEIL_Y, z0, x1, CEIL_Y + 0.03, z1, { cast: false, skip: "Y" })
  else {
    let s = seed * 9973 + 7
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const xs = [x0]
    for (let k = Math.ceil((x0 - 0.3) / 0.6); 0.3 + k * 0.6 < x1; k++) if (0.3 + k * 0.6 - x0 > 0.05) xs.push(0.3 + k * 0.6)
    xs.push(x1)
    const zs = [z0]
    for (let k = Math.ceil((z0 - 0.6) / 1.2); 0.6 + k * 1.2 < z1; k++) if (0.6 + k * 1.2 - z0 > 0.05) zs.push(0.6 + k * 1.2)
    zs.push(z1)
    for (let i = 0; i < xs.length - 1; i++)
      for (let j = 0; j < zs.length - 1; j++) {
        const r = rnd()
        const cx = (xs[i]! + xs[i + 1]!) / 2
        const cz = (zs[j]! + zs[j + 1]!) / 2
        if (r < missing) {
          if (fallen && r < missing * 0.45) fallen(cx, cz)
          continue
        }
        // Water-stained or sagging tiles sit a little lower and darker.
        const sag = r > 0.93 ? 0.015 : 0
        b.box(r > 0.88 ? M.stain : "ceiling_tile", xs[i]!, CEIL_Y - sag, zs[j]!, xs[i + 1]!, CEIL_Y + 0.02 - sag, zs[j + 1]!, { cast: false, skip: "Y" })
      }
  }
  for (let k = Math.ceil((x0 - 0.3) / 0.6); 0.3 + k * 0.6 < x1; k++) {
    const x = 0.3 + k * 0.6
    if (x - x0 < 0.05) continue
    b.box(M.tbar, x - 0.012, y0, z0, x + 0.012, CEIL_Y, z1, { cast: false, skip: "Y" })
  }
  for (let k = Math.ceil((z0 - 0.6) / 1.2); 0.6 + k * 1.2 < z1; k++) {
    const z = 0.6 + k * 1.2
    if (z - z0 < 0.05) continue
    b.box(M.tbar, x0, y0, z - 0.012, x1, CEIL_Y, z + 0.012, { cast: false, skip: "Y" })
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
