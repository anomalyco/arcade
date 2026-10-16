import * as THREE from "three/webgpu"
import { type Builder, type Mat, CEIL_Y, FLOOR_Y, M, T, ceiling, closetBands, corridorBands, fluorescentPanel, troffer, wall } from "./kit"
import { CORRIDOR, WALL_T, fluoro } from "./corridor"

// The two rooms you can walk into off the corridor: a lab (concept r5-05) north of the corridor, and the janitor's
// closet to the south. Every other door is closed.

export const LAB = { x0: -25.5, x1: -17, z0: -9.6, z1: CORRIDOR.zn - WALL_T }
export const CLOSET = { x0: -32.6, x1: -29.4, z0: CORRIDOR.zs + WALL_T, z1: 5.0 }

const WARM: [number, number, number] = [1.0, 0.68, 0.38]
const up = new THREE.Vector3(0, 1, 0)
const dirV = new THREE.Vector3()

/** Cylinder rod between two points. */
function rod(b: Builder, mat: Mat, p0: readonly number[], p1: readonly number[], r: number, seg = 8) {
  dirV.set(p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!)
  const len = dirV.length()
  const q = new THREE.Quaternion().setFromUnitVectors(up, dirV.normalize())
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((p0[0]! + p1[0]!) / 2, (p0[1]! + p1[1]!) / 2, (p0[2]! + p1[2]!) / 2),
    q,
    new THREE.Vector3(1, 1, 1),
  )
  b.cyl(mat, m, r, r, len, seg)
}

export function buildLab(b: Builder) {
  const { x0, x1, z0, z1 } = LAB
  const y = FLOOR_Y
  b.floor("linoleum", x0, z0, x1, z1)
  wall(b, "z", z0 - WALL_T, z1, x0 - WALL_T, x0, corridorBands)
  wall(b, "z", z0 - WALL_T, z1, x1, x1 + WALL_T, corridorBands)
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, z0 - WALL_T, z0, corridorBands)
  ceiling(b, x0, z0, x1, z1)
  const on = fluorescentPanel(0.8).material
  for (const tx of [-23.4, -19.2])
    for (const tz of [-3.6, -7.2]) {
      const lit = tx === -19.2 && tz === -7.2
      troffer(b, tx, tz, lit ? "on" : "off", on)
      if (lit) b.lamp(fluoro(tx, tz, 0.15, 5))
    }

  // Perimeter benches: north wall and west wall, steel base cabinets with drawers, black epoxy tops.
  benchRun(b, "x", x0, -19.8, z0, z0 + 0.68)
  benchRun(b, "z", z0 + 0.68, -4.1, x0, x0 + 0.68)
  // Sink in the north bench with a gooseneck faucet.
  const sx = -20.6
  b.box(M.steel, sx - 0.3, y + 0.925, z0 + 0.12, sx + 0.3, y + 0.935, z0 + 0.56, { cast: false })
  b.box("metal_dark", sx - 0.24, y + 0.93, z0 + 0.17, sx + 0.24, y + 0.936, z0 + 0.51, { cast: false })
  rod(b, M.steel, [sx, y + 0.93, z0 + 0.08], [sx, y + 1.25, z0 + 0.08], 0.012)
  rod(b, M.steel, [sx, y + 1.25, z0 + 0.08], [sx, y + 1.22, z0 + 0.3], 0.012)

  // Canopy fume hood over the north bench with its duct into the ceiling.
  const hx = -24.0
  const hood = new THREE.CylinderGeometry(0.33, Math.SQRT1_2, 1, 4, 1)
  hood.rotateY(Math.PI / 4)
  hood.scale(1.9, 0.42, 0.85)
  hood.translate(hx, y + 2.08, z0 + 0.43)
  b.add("metal_galvanized", hood)
  b.box("metal_galvanized", hx - 0.95, y + 1.82, z0 + 0.005, hx + 0.95, y + 1.87, z0 + 0.86)
  b.cyl("metal_galvanized", T(hx, (y + 2.25 + CEIL_Y) / 2, z0 + 0.4), 0.15, 0.15, CEIL_Y - y - 2.25, 14)
  for (let k = 0; k < 4; k++) b.cyl("metal_dark", T(hx, y + 2.35 + k * 0.17, z0 + 0.4), 0.153, 0.153, 0.015, 14)

  // Glassware and bottles along the bench.
  const top = y + 0.935
  const zb = z0 + 0.38
  glassBeaker(b, -25.0, top, zb, 0.05, 0.14)
  glassBeaker(b, -24.82, top, zb + 0.12, 0.035, 0.1)
  flask(b, -24.5, top, zb - 0.05, 0.075)
  flask(b, -24.25, top, zb + 0.1, 0.055)
  glassBeaker(b, -23.9, top, zb, 0.06, 0.18)
  b.cyl(M.jugBrown, T(-23.55, top + 0.11, zb - 0.1), 0.045, 0.045, 0.22, 12)
  b.cyl(M.jugBrown, T(-23.55, top + 0.25, zb - 0.1), 0.015, 0.03, 0.06, 8)
  b.cyl(M.jugWhite, T(-23.4, top + 0.08, zb + 0.08), 0.035, 0.035, 0.16, 12)
  // Ring stand with a clamp and a flask.
  b.box("metal_dark", -22.95, top, zb - 0.1, -22.75, top + 0.015, zb + 0.15)
  rod(b, M.steel, [-22.9, top, zb - 0.05], [-22.9, top + 0.6, zb - 0.05], 0.006)
  rod(b, M.steel, [-22.9, top + 0.32, zb - 0.05], [-22.72, top + 0.32, zb + 0.05], 0.005)
  b.cyl(M.steel, T(-22.72, top + 0.32, zb + 0.05), 0.05, 0.05, 0.008, 14)
  flask(b, -22.72, top + 0.33, zb + 0.05, 0.05)
  glassBeaker(b, -22.4, top, zb + 0.05, 0.045, 0.13)
  // Coffee maker style carafe and a stack of notebooks.
  b.box(M.paper, -22.05, top, zb - 0.05, -21.82, top + 0.04, zb + 0.25)
  b.box(M.cardboard, -22.03, top + 0.04, zb - 0.03, -21.84, top + 0.06, zb + 0.22)

  // Desk lamp: the only warm light in the building.
  const lx = -21.3
  const lz = z0 + 0.3
  b.cyl("metal_dark", T(lx, top + 0.012, lz), 0.075, 0.085, 0.024, 16)
  rod(b, M.lampShade, [lx, top + 0.02, lz], [lx + 0.06, top + 0.36, lz + 0.05], 0.008)
  rod(b, M.lampShade, [lx + 0.06, top + 0.36, lz + 0.05], [lx + 0.18, top + 0.42, lz + 0.26], 0.008)
  const shade = new THREE.Matrix4().compose(
    new THREE.Vector3(lx + 0.2, top + 0.36, lz + 0.3),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  )
  b.cyl(M.lampShade, shade, 0.035, 0.085, 0.13, 16, { open: true })
  b.cyl(M.lampShade, shade.clone().multiply(T(0, 0.065, 0)), 0.035, 0.035, 0.01, 12)
  const bulb = new THREE.SphereGeometry(0.03, 10, 8)
  bulb.applyMatrix4(shade.clone().multiply(T(0, -0.04, 0)))
  b.add(M.bulbWarm, bulb, { cast: false })
  b.lamp({
    kind: "incandescent",
    position: [lx + 0.2, top + 0.3, lz + 0.33],
    direction: [0, -0.85, 0.53],
    color: WARM,
    intensity: 6,
    range: 5,
    angle: 1.0,
    penumbra: 0.8,
    shadow: true,
    size: 0.08,
  })

  // Island lab table with four stools.
  const tx0 = -21.7
  const tx1 = -18.7
  const tz0 = -6.5
  const tz1 = -5.1
  b.box(M.epoxy, tx0, y + 0.88, tz0, tx1, y + 0.92, tz1)
  b.box(M.cabinet, tx0 + 0.05, y + 0.8, tz0 + 0.05, tx1 - 0.05, y + 0.88, tz1 - 0.05)
  for (const lx2 of [tx0 + 0.08, tx1 - 0.08])
    for (const lz2 of [tz0 + 0.08, tz1 - 0.08]) b.box(M.cabinet, lx2 - 0.025, y, lz2 - 0.025, lx2 + 0.025, y + 0.8, lz2 + 0.025)
  b.collide(tx0, y, tz0, tx1, y + 0.92, tz1)
  b.box(M.paper, -20.6, y + 0.92, -5.95, -20.38, y + 0.922, -5.67, { cast: false })
  glassBeaker(b, -19.4, y + 0.92, -5.6, 0.05, 0.12)
  stool(b, -21.0, -4.6)
  stool(b, -19.55, -4.45)
  stool(b, -20.5, -7.05)
  stool(b, -19.1, -7.0)

  // Chalkboard on the east wall, wiped but not clean.
  const cbz0 = -7.7
  const cbz1 = -3.3
  const cby0 = y + 0.95
  const cby1 = y + 2.12
  b.box(M.wood, x1 - 0.04, cby0 - 0.05, cbz0 - 0.05, x1, cby1 + 0.05, cbz1 + 0.05)
  b.box(M.chalkboard, x1 - 0.045, cby0, cbz0, x1 - 0.04, cby1, cbz1, { cast: false })
  b.box("metal_galvanized", x1 - 0.11, cby0 - 0.06, cbz0, x1 - 0.04, cby0 - 0.04, cbz1)
  const smears = [
    [-6.6, 1.75, 1.6, 0.5, 0.05],
    [-4.6, 1.5, 1.9, 0.6, -0.04],
    [-5.4, 1.25, 1.2, 0.3, 0.02],
  ] as const
  smears.forEach(([z, h, w, hh, r], i) =>
    b.quad(M.chalkSmear, T(x1 - 0.0465 - i * 0.0003, y + h, z, -Math.PI / 2, 0, r), w, hh, { cast: false }),
  )
  b.box(M.paper, x1 - 0.1, cby0 - 0.05, -4.1, x1 - 0.07, cby0 - 0.035, -4.02, { cast: false })

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

function benchRun(b: Builder, axis: "x" | "z", a0: number, a1: number, c0: number, c1: number) {
  const y = FLOOR_Y
  const box = (p0: number, p1: number, q0: number, q1: number, y0: number, y1: number, mat: Mat, cast = true) =>
    axis === "x" ? b.box(mat, p0, y0, q0, p1, y1, q1, { cast }) : b.box(mat, q0, y0, p0, q1, y1, p1, { cast })
  // Cabinet body (front face at c1), toe kick, top.
  box(a0, a1, c0, c1 - 0.02, y + 0.1, y + 0.9, M.cabinet)
  box(a0, a1, c0, c1 - 0.08, y, y + 0.1, "rubber", false)
  box(a0, a1 + (axis === "x" ? 0.02 : 0), c0, c1 + 0.02, y + 0.9, y + 0.935, M.epoxy)
  // Drawer and door fronts with handles.
  const unit = 0.6
  const n = Math.floor((a1 - a0) / unit)
  for (let i = 0; i < n; i++) {
    const p0 = a0 + i * unit + 0.015
    const p1 = p0 + unit - 0.03
    const drawers = i % 3 === 1
    const rows = drawers ? [[0.12, 0.3], [0.32, 0.5], [0.52, 0.7], [0.72, 0.88]] : [[0.12, 0.88]]
    for (const [r0, r1] of rows) {
      box(p0, p1, c1 - 0.02, c1 - 0.005, y + r0!, y + r1!, M.cabinet)
      const hy = drawers ? y + (r0! + r1!) / 2 + 0.03 : y + 0.78
      box((p0 + p1) / 2 - 0.07, (p0 + p1) / 2 + 0.07, c1 - 0.005, c1 + 0.015, hy - 0.008, hy + 0.008, M.steel)
    }
  }
  if (axis === "x") b.collide(a0, y, c0, a1, y + 0.935, c1 + 0.02)
  else b.collide(c0, y, a0, c1 + 0.02, y + 0.935, a1)
}

function glassBeaker(b: Builder, x: number, y: number, z: number, r: number, h: number) {
  b.cyl(M.glass, T(x, y + h / 2, z), r, r * 0.97, h, 14, { cast: false })
}

function flask(b: Builder, x: number, y: number, z: number, r: number) {
  b.cyl(M.glass, T(x, y + r * 1.0, z), r * 0.3, r, r * 2, 14, { cast: false })
  b.cyl(M.glass, T(x, y + r * 2.5, z), r * 0.28, r * 0.3, r * 1.0, 10, { cast: false })
}

function stool(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  b.cyl(M.stoolSeat, T(x, y + 0.66, z), 0.17, 0.17, 0.05, 18)
  b.cyl("metal_dark", T(x, y + 0.625, z), 0.12, 0.12, 0.02, 12)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4
    rod(b, "metal_dark", [x + Math.cos(a) * 0.1, y + 0.62, z + Math.sin(a) * 0.1], [x + Math.cos(a) * 0.2, y, z + Math.sin(a) * 0.2], 0.011, 6)
  }
  const ring = new THREE.TorusGeometry(0.16, 0.008, 6, 20)
  ring.rotateX(Math.PI / 2)
  ring.translate(x, y + 0.24, z)
  b.add("metal_dark", ring)
  b.collide(x - 0.18, y, z - 0.18, x + 0.18, y + 0.68, z + 0.18)
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
  rod(b, M.steel, [bx + 0.03, by - 0.06, bz], [bx + 0.03, by - 0.5, bz], 0.002, 4)
  b.lamp({ kind: "incandescent", position: [bx, by - 0.2, bz], color: WARM, intensity: 3, range: 4.5, shadow: true, size: 0.06 })

  // Wire shelving along the east wall stocked with cleaning chemicals and boxes.
  const sx0 = x1 - 0.5
  const sx1 = x1 - 0.02
  const sz0 = 2.75
  const sz1 = 4.9
  for (const px of [sx0, sx1 - 0.02])
    for (const pz of [sz0, sz1 - 0.02]) b.box("metal_galvanized", px, y, pz, px + 0.02, y + 2.0, pz + 0.02)
  let seed = 11
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const shelfYs = [0.12, 0.55, 0.98, 1.41, 1.84]
  for (const sh of shelfYs) {
    b.box("metal_galvanized", sx0, y + sh, sz0, sx1, y + sh + 0.02, sz1)
    if (sh > 1.8) continue
    let z = sz0 + 0.05
    while (z < sz1 - 0.15) {
      const kind = rnd()
      const sy = y + sh + 0.02
      if (kind < 0.35) {
        const w = 0.16
        b.box(rnd() < 0.5 ? M.jugWhite : M.jugBlue, sx0 + 0.08, sy, z, sx0 + 0.08 + 0.13, sy + 0.28, z + w)
        b.cyl(M.red, T(sx0 + 0.145, sy + 0.3, z + w / 2), 0.02, 0.02, 0.04, 8)
        z += w + 0.03
      } else if (kind < 0.6) {
        const r = 0.04 + rnd() * 0.02
        const h = 0.18 + rnd() * 0.12
        b.cyl(rnd() < 0.5 ? M.jugBrown : M.jugWhite, T(sx0 + 0.2, sy + h / 2, z + r), r, r, h, 10)
        z += r * 2 + 0.03
      } else if (kind < 0.85) {
        const w = 0.25 + rnd() * 0.15
        b.box(M.cardboard, sx0 + 0.03, sy, z, sx1 - 0.03, sy + 0.2 + rnd() * 0.15, z + w)
        z += w + 0.02
      } else z += 0.12
    }
  }
  b.collide(sx0, y, sz0, x1, y + 2.0, sz1)

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
  rod(b, M.steel, [(mx0 + mx1) / 2 - 0.15, y + 0.95, z1], [(mx0 + mx1) / 2 + 0.15, y + 0.95, z1], 0.015)
  rod(b, M.steel, [(mx0 + mx1) / 2, y + 0.95, z1], [(mx0 + mx1) / 2, y + 0.95, z1 - 0.2], 0.014)
  rod(b, M.steel, [(mx0 + mx1) / 2, y + 0.95, z1 - 0.2], [(mx0 + mx1) / 2, y + 0.85, z1 - 0.22], 0.012)
  for (const s of [-1, 1]) b.cyl(M.red, T((mx0 + mx1) / 2 + s * 0.15, y + 1.0, z1 - 0.03), 0.03, 0.03, 0.02, 8)
  b.collide(mx0, y, mz0, mx1, y + h, mz1)

  // Yellow mop bucket with wringer, a mop leaning against the wall, a broom.
  bucket(b, x0 + 0.35, 3.6)
  rod(b, M.wood, [x0 + 0.1, y + 0.05, 2.75], [x0 + 0.03, y + 1.45, 2.6], 0.012)
  b.box(M.paper, x0 + 0.03, y, 2.67, x0 + 0.25, y + 0.12, 2.86)
  rod(b, M.wood, [x0 + 0.1, y + 0.08, 4.1], [x0 + 0.02, y + 1.45, 4.25], 0.012)
  b.box(M.stoolSeat, x0 + 0.06, y, 3.98, x0 + 0.16, y + 0.1, 4.25)
}

function bucket(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  b.box(M.yellow, x - 0.2, y + 0.06, z - 0.25, x + 0.2, y + 0.38, z + 0.25)
  b.box("metal_dark", x - 0.17, y + 0.38, z - 0.22, x + 0.17, y + 0.381, z + 0.05, { cast: false })
  b.box(M.yellow, x - 0.16, y + 0.38, z + 0.06, x + 0.16, y + 0.58, z + 0.22)
  rod(b, "metal_dark", [x, y + 0.58, z + 0.14], [x, y + 1.05, z + 0.24], 0.012)
  for (const dx of [-0.17, 0.17]) for (const dz of [-0.22, 0.22]) b.cyl("rubber", T(x + dx, y + 0.03, z + dz), 0.03, 0.03, 0.03, 8)
  rod(b, M.wood, [x - 0.05, y + 0.2, z - 0.1], [x - 0.12, y + 1.5, z - 0.3], 0.013)
  b.collide(x - 0.22, y, z - 0.27, x + 0.22, y + 0.6, z + 0.27)
}

