import * as THREE from "three/webgpu"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { paint, type Builder, type Mat, CEIL_Y, FLOOR_Y, M, PANEL_ON, T, ceiling, closetBands, corridorBands, troffer, wall } from "./kit"
import { fluoro } from "./corridor"
import { INTERIOR } from "../layout"
import { MODELS } from "../../render/models"
import { placeModels } from "./props"

// The two rooms you can walk into off the corridor: a lab (concept r5-05) north of the corridor, and the janitor's
// closet to the south. Every other door is closed.

// Plain numbers from layout here (not corridor.ts): corridor.ts → props.ts → rooms.ts is an import cycle.
const WALL_T = 0.15
export const LAB = { x0: -25.5, x1: -17, z0: -9.6, z1: INTERIOR.corridor.min[1] - WALL_T }
export const CLOSET = { x0: -32.6, x1: -29.4, z0: INTERIOR.corridor.max[1] + WALL_T, z1: 5.0 }

const WARM: [number, number, number] = [1.0, 0.68, 0.38]

export function buildLab(b: Builder) {
  const { x0, x1, z0, z1 } = LAB
  const y = FLOOR_Y
  b.floor("linoleum", x0, z0, x1, z1)
  wall(b, "z", z0 - WALL_T, z1, x0 - WALL_T, x0, corridorBands)
  wall(b, "z", z0 - WALL_T, z1, x1, x1 + WALL_T, corridorBands)
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, z0 - WALL_T, z0, corridorBands)
  ceiling(b, x0, z0, x1, z1)
  // Lit from the corridor door (concept r5-05): the panel over the far bench on, the rest dead.
  for (const tx of [-23.4, -19.2])
    for (const tz of [-3.6, -7.2]) {
      const lit = tx === -23.4 && tz === -7.2
      troffer(b, tx, tz, lit ? "on" : "off", PANEL_ON)
      if (lit) b.lamp(fluoro(tx, tz, 0.15, 60))
    }

  // Perimeter benches: north wall and west wall, steel base cabinets with drawers, black epoxy tops.
  benchRun(b, "x", x0, -19.8, z0, z0 + 0.68)
  benchRun(b, "z", z0 + 0.68, -4.1, x0, x0 + 0.68)
  // Sink in the north bench with a gooseneck faucet.
  const sx = -20.6
  b.box(M.steel, sx - 0.3, y + 0.925, z0 + 0.12, sx + 0.3, y + 0.935, z0 + 0.56, { cast: false })
  b.box("metal_dark", sx - 0.24, y + 0.93, z0 + 0.17, sx + 0.24, y + 0.936, z0 + 0.51, { cast: false })
  b.rod(M.steel, [sx, y + 0.93, z0 + 0.08], [sx, y + 1.25, z0 + 0.08], 0.012)
  b.rod(M.steel, [sx, y + 1.25, z0 + 0.08], [sx, y + 1.22, z0 + 0.3], 0.012)

  // Canopy fume hood over the west bench by the far corner (seen at the side through the door), duct into the ceiling.
  const hz = -8.35
  const hxc = x0 + 0.43
  const hood = new THREE.CylinderGeometry(0.33, Math.SQRT1_2, 1, 4, 1)
  hood.rotateY(Math.PI / 4)
  hood.scale(0.85, 0.42, 1.9)
  hood.translate(hxc, y + 2.08, hz)
  b.add("metal_galvanized", hood)
  b.box("metal_galvanized", x0 + 0.005, y + 1.82, hz - 0.95, x0 + 0.86, y + 1.87, hz + 0.95)
  b.cyl("metal_galvanized", T(x0 + 0.4, (y + 2.25 + CEIL_Y) / 2, hz), 0.15, 0.15, CEIL_Y - y - 2.25, 14)
  for (let k = 0; k < 4; k++) b.cyl("metal_dark", T(x0 + 0.4, y + 2.35 + k * 0.17, hz), 0.153, 0.153, 0.015, 14)

  const top = y + 0.935
  const zb = z0 + 0.38
  // A stack of notebooks.
  b.box(M.paper, -23.55, top, zb - 0.05, -23.32, top + 0.04, zb + 0.25)
  b.box(M.cardboard, -23.53, top + 0.04, zb - 0.03, -23.34, top + 0.06, zb + 0.22)

  // Desk lamp: the only warm light in the building.
  // On the far (north) bench under the chalkboard, arm reaching out over the bench towards the door.
  const lx = -24.35
  const lz = z0 + 0.14
  // Sprung-arm lamp (library model), arm reaching towards the door; its spot light hangs under the shade.
  placeModels(b, "desk_lamp", [{ position: [lx, top, lz + MODELS.desk_lamp.size[2] / 2 - 0.05], yaw: Math.PI, collide: false, blob: 0 }])
  b.lamp({
    kind: "incandescent",
    position: [lx, top + 0.4, lz + 0.5],
    direction: [0, -0.85, 0.53],
    color: WARM,
    intensity: 260,
    range: 5,
    angle: 1.0,
    penumbra: 0.8,
    shadow: true,
    size: 0.08,
  })

  // Island lab table with four stools.
  const tx0 = -23.7
  const tx1 = -21.5
  const tz0 = -6.2
  const tz1 = -5.2
  b.box(M.epoxy, tx0, y + 0.88, tz0, tx1, y + 0.92, tz1)
  b.box(M.cabinet, tx0 + 0.05, y + 0.8, tz0 + 0.05, tx1 - 0.05, y + 0.88, tz1 - 0.05)
  for (const lx2 of [tx0 + 0.08, tx1 - 0.08])
    for (const lz2 of [tz0 + 0.08, tz1 - 0.08]) b.box(M.cabinet, lx2 - 0.025, y, lz2 - 0.025, lx2 + 0.025, y + 0.8, lz2 + 0.025)
  b.collide(tx0, y, tz0, tx1, y + 0.92, tz1)
  b.box(M.paper, -22.3, y + 0.92, -5.85, -22.08, y + 0.922, -5.57, { cast: false })
  stool(b, -22.05, -4.55)
  stool(b, -23.05, -4.7)
  stool(b, -21.0, -5.9)
  stool(b, -22.7, -6.85)

  // Chalkboard on the far (north) wall over the bench, framed by the doorway from the corridor; wiped, not clean.
  const cbx0 = -24.75
  const cbx1 = -22.45
  const cby0 = y + 1.12
  const cby1 = y + 2.2
  const wz = z0
  b.box(M.wood, cbx0 - 0.05, cby0 - 0.05, wz, cbx1 + 0.05, cby1 + 0.05, wz + 0.04)
  b.box(M.chalkboard, cbx0, cby0, wz + 0.04, cbx1, cby1, wz + 0.045, { cast: false })
  b.box("metal_galvanized", cbx0, cby0 - 0.06, wz + 0.04, cbx1, cby0 - 0.04, wz + 0.11)
  const smears = [
    [-24.0, 1.85, 1.2, 0.42, 0.05],
    [-23.1, 1.58, 1.1, 0.5, -0.04],
    [-23.6, 1.34, 0.8, 0.22, 0.02],
  ] as const
  smears.forEach(([x, h, w, hh, r], i) => b.quad(M.chalkSmear, T(x, y + h, wz + 0.0465 + i * 0.0003, 0, 0, r), w, hh, { cast: false }))
  b.box(M.paper, -23.0, cby0 - 0.05, wz + 0.07, -22.92, cby0 - 0.035, wz + 0.1, { cast: false })

  // Tall glass-fronted supply cabinet by the door wall.
  const cx0 = x0
  const cx1 = x0 + 0.5
  b.box(M.cabinet, cx0, y, -3.7, cx1, y + 2.0, -2.0)
  b.quad(M.wireGlass, T(cx1 + 0.003, y + 1.45, -2.85, Math.PI / 2), 1.5, 1.0, { cast: false })
  for (const sy of [1.05, 1.45, 1.85]) {
    for (let k = 0; k < 6; k++) b.cyl(k % 2 ? M.jugBrown : M.jugWhite, T(cx1 - 0.15, y + sy + 0.07, -3.5 + k * 0.25), 0.04, 0.04, 0.14, 10)
  }
  b.collide(cx0, y, -3.7, cx1, y + 2.0, -2.0)
}

/** Run of steel base cabinets with an epoxy top along a wall; c0 is the wall side, c1 the front (either sign). */
export function benchRun(b: Builder, axis: "x" | "z", a0: number, a1: number, c0: number, c1: number) {
  const y = FLOOR_Y
  const f = Math.sign(c1 - c0) || 1
  const box = (p0: number, p1: number, q0: number, q1: number, y0: number, y1: number, mat: Mat, cast = true) =>
    axis === "x" ? b.box(mat, p0, y0, q0, p1, y1, q1, { cast }) : b.box(mat, q0, y0, p0, q1, y1, p1, { cast })
  // Cabinet body (front face at c1), toe kick, top.
  box(a0, a1, c0, c1 - f * 0.02, y + 0.1, y + 0.9, M.cabinet)
  box(a0, a1, c0, c1 - f * 0.08, y, y + 0.1, M.rubber, false)
  box(a0, a1, c0, c1 + f * 0.02, y + 0.9, y + 0.935, M.epoxy)
  // Drawer and door fronts with handles.
  const unit = 0.6
  const n = Math.floor((a1 - a0) / unit)
  for (let i = 0; i < n; i++) {
    const p0 = a0 + i * unit + 0.015
    const p1 = p0 + unit - 0.03
    const drawers = i % 3 === 1
    const rows = drawers ? [[0.12, 0.3], [0.32, 0.5], [0.52, 0.7], [0.72, 0.88]] : [[0.12, 0.88]]
    for (const [r0, r1] of rows) {
      box(p0, p1, c1 - f * 0.02, c1 - f * 0.005, y + r0!, y + r1!, M.cabinet)
      const hy = drawers ? y + (r0! + r1!) / 2 + 0.03 : y + 0.78
      box((p0 + p1) / 2 - 0.07, (p0 + p1) / 2 + 0.07, c1 - f * 0.005, c1 + f * 0.015, hy - 0.008, hy + 0.008, M.steel)
    }
  }
  if (axis === "x") b.collide(a0, y, c0, a1, y + 0.935, c1 + f * 0.02)
  else b.collide(c0, y, a0, c1 + f * 0.02, y + 0.935, a1)
}

/** Steel lab stool (library model), a little turned. */
export function stool(b: Builder, x: number, z: number) {
  placeModels(b, "lab_stool", [{ position: [x, FLOOR_Y, z], yaw: Math.sin(x * 12.9 + z * 7.1) * 3, inset: 0.06 }])
}

export function buildCloset(b: Builder) {
  const { x0, x1, z0, z1 } = CLOSET
  const y = FLOOR_Y
  b.floor("concrete_floor", x0, z0, x1, z1)
  wall(b, "z", z0, z1 + WALL_T, x0 - WALL_T, x0, closetBands)
  wall(b, "z", z0, z1 + WALL_T, x1, x1 + WALL_T, closetBands)
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, z1, z1 + WALL_T, closetBands)
  b.box("ceiling_tile", x0, CEIL_Y - 0.25, z0, x1, CEIL_Y - 0.22, z1, { cast: false })

  // Bare bulb on a porcelain socket, on a pull chain.
  const bx = (x0 + x1) / 2
  const bz = 3.3
  const by = CEIL_Y - 0.25
  b.cyl(M.paper, T(bx, by - 0.04, bz), 0.05, 0.06, 0.08, 12)
  const bulb = new THREE.SphereGeometry(0.04, 12, 8)
  bulb.translate(bx, by - 0.13, bz)
  b.add(M.bulbWarm, bulb, { cast: false })
  b.rod(M.steel, [bx + 0.03, by - 0.06, bz], [bx + 0.03, by - 0.5, bz], 0.002, 4)
  b.lamp({ kind: "incandescent", position: [bx, by - 0.2, bz], color: WARM, intensity: 3, range: 4.5, shadow: true, size: 0.06 })

  // Floor-mounted mop sink in the back corner with a wall faucet.
  const mx0 = x0
  const mx1 = x0 + 0.75
  const mz0 = z1 - 0.75
  const mz1 = z1
  const h = 0.28
  b.box(M.concreteSink, mx0, y, mz0, mx1, y + 0.04, mz1)
  b.box(M.concreteSink, mx0, y, mz0, mx1, y + h, mz0 + 0.07)
  b.box(M.concreteSink, mx1 - 0.07, y, mz0, mx1, y + h, mz1)
  b.box(M.concreteSink, mx0, y, mz1 - 0.04, mx1, y + h, mz1)
  b.box(M.concreteSink, mx0, y, mz0, mx0 + 0.04, y + h, mz1)
  b.cyl("metal_dark", T((mx0 + mx1) / 2, y + 0.045, (mz0 + mz1) / 2), 0.04, 0.04, 0.01, 10, { cast: false })
  b.rod(M.steel, [(mx0 + mx1) / 2 - 0.15, y + 0.95, z1], [(mx0 + mx1) / 2 + 0.15, y + 0.95, z1], 0.015)
  b.rod(M.steel, [(mx0 + mx1) / 2, y + 0.95, z1], [(mx0 + mx1) / 2, y + 0.95, z1 - 0.2], 0.014)
  b.rod(M.steel, [(mx0 + mx1) / 2, y + 0.95, z1 - 0.2], [(mx0 + mx1) / 2, y + 0.85, z1 - 0.22], 0.012)
  for (const s of [-1, 1]) b.cyl(M.red, T((mx0 + mx1) / 2 + s * 0.15, y + 1.0, z1 - 0.03), 0.03, 0.03, 0.02, 8)
  b.collide(mx0, y, mz0, mx1, y + h, mz1)

  // Yellow mop bucket with wringer, a mop leaning against the wall, a broom.
  bucket(b, x0 + 0.35, 3.6)
  b.rod(M.wood, [x0 + 0.1, y + 0.05, 2.75], [x0 + 0.03, y + 1.45, 2.6], 0.012)
  b.box(M.paper, x0 + 0.03, y, 2.67, x0 + 0.25, y + 0.12, 2.86)
  b.rod(M.wood, [x0 + 0.1, y + 0.08, 4.1], [x0 + 0.02, y + 1.45, 4.25], 0.012)
  b.box(M.stoolSeat, x0 + 0.06, y, 3.98, x0 + 0.16, y + 0.1, 4.25)
}

/** Ring of points around a rounded rectangle (half extents hw × hd, corner radius r) at height y, counter-clockwise
 *  seen from above. */
function roundedRing(hw: number, hd: number, r: number, y: number, n: number, out: number[]) {
  const corners: [number, number, number][] = [
    [hw - r, hd - r, 0],
    [-(hw - r), hd - r, Math.PI / 2],
    [-(hw - r), -(hd - r), Math.PI],
    [hw - r, -(hd - r), Math.PI * 1.5],
  ]
  for (const [cx, cz, a0] of corners)
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / (n - 1)) * (Math.PI / 2)
      out.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r)
    }
}

/** Surface swept through a list of rounded-rectangle rings [hw, hd, r, y] (a moulded tub, rim and inner wall). */
function sweptTub(rings: readonly (readonly [number, number, number, number])[], n = 6, capBottom = true) {
  const pos: number[] = []
  for (const [hw, hd, r, y] of rings) roundedRing(hw, hd, r, y, n, pos)
  const per = n * 4
  const idx: number[] = []
  for (let k = 0; k < rings.length - 1; k++)
    for (let i = 0; i < per; i++) {
      const a = k * per + i
      const b2 = k * per + ((i + 1) % per)
      const c = a + per
      const d = b2 + per
      idx.push(a, c, b2, b2, c, d)
    }
  if (capBottom) {
    const centre = pos.length / 3
    pos.push(0, rings[0]![3], 0)
    for (let i = 0; i < per; i++) idx.push(centre, i, (i + 1) % per)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Rounded-rectangle cap (water surface, lids) at height y. */
function roundedCap(hw: number, hd: number, r: number, y: number, n = 6) {
  const pos: number[] = [0, y, 0]
  roundedRing(hw, hd, r, y, n, pos)
  const per = n * 4
  const idx: number[] = []
  for (let i = 0; i < per; i++) idx.push(0, 1 + ((i + 1) % per), 1 + i)
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Commercial mop bucket: tapered moulded tub with a rolled rim, grey water, side-press wringer, casters, mop. */
function bucket(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  const at = (g: THREE.BufferGeometry, yaw = 0) => g.applyMatrix4(T(x, y, z, yaw))
  // Tub (long axis along Z), wall leaning out towards the rim.
  const tub = sweptTub([
    [0.15, 0.2, 0.05, 0.075],
    [0.165, 0.215, 0.06, 0.1],
    [0.19, 0.245, 0.075, 0.36],
    [0.2, 0.255, 0.08, 0.375],
    [0.197, 0.252, 0.078, 0.392],
    [0.184, 0.239, 0.07, 0.385],
    [0.17, 0.225, 0.062, 0.2],
  ])
  b.add(M.yellow, at(tub))
  b.add(water, at(roundedCap(0.172, 0.227, 0.062, 0.215)), { cast: false })
  // Caster forks and wheels under the corners.
  for (const dx of [-0.13, 0.13])
    for (const dz of [-0.18, 0.18]) {
      b.box("metal_dark", x + dx - 0.015, y + 0.045, z + dz - 0.02, x + dx + 0.015, y + 0.075, z + dz + 0.02)
      b.cyl("rubber", T(x + dx, y + 0.028, z + dz, 0, 0, Math.PI / 2), 0.028, 0.028, 0.022, 14)
    }
  // Wringer sitting across the rear of the tub: rounded box with a press plate, lever and grip.
  const W = T(x, y + 0.39, z + 0.13)
  const body = new RoundedBoxGeometry(0.3, 0.2, 0.17, 3, 0.025)
  body.applyMatrix4(W.clone().multiply(T(0, 0.1, 0)))
  b.add(M.yellow, body)
  const plate = new RoundedBoxGeometry(0.24, 0.16, 0.025, 2, 0.008)
  plate.applyMatrix4(W.clone().multiply(T(0, 0.11, -0.04)))
  b.add("metal_dark", plate)
  b.rod("metal_galvanized", [x + 0.155, y + 0.52, z + 0.13], [x + 0.17, y + 0.95, z + 0.2], 0.011)
  b.rod("metal_galvanized", [x + 0.17, y + 0.95, z + 0.2], [x - 0.02, y + 0.98, z + 0.21], 0.011)
  b.rod("rubber", [x + 0.02, y + 0.98, z + 0.21], [x - 0.1, y + 0.985, z + 0.215], 0.017, 10)
  // Mop standing in the water: wooden handle, clamp and a hank of grey strands.
  const mx = x - 0.04
  const mz = z - 0.09
  b.rod(M.wood, [mx, y + 0.24, mz], [mx - 0.1, y + 1.45, mz - 0.2], 0.013)
  b.cyl("metal_dark", T(mx, y + 0.27, mz), 0.03, 0.03, 0.05, 10)
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2
    b.rod(mopStrand, [mx + Math.cos(a) * 0.02, y + 0.26, mz + Math.sin(a) * 0.02], [mx + Math.cos(a) * 0.075, y + 0.2, mz + Math.sin(a) * 0.07], 0.012, 5)
  }
  b.collide(x - 0.22, y, z - 0.27, x + 0.22, y + 0.6, z + 0.27)
}

const water = paint(0x1d2019, 0.05)
const mopStrand = paint(0x6a665a, 1)

