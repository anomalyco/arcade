import { BUILDING, INTERIOR } from "../layout"
import * as THREE from "three/webgpu"
import { type Builder, FLOOR_Y, M, PANEL_WARM, T, TUBE_WARM, ceiling, door, doorOpening, lobbyBands, troffer, wall } from "./kit"
import { WALL_T, fluoro } from "./corridor"
import { wastebasket } from "./props"

// Lobby (concept r5-02): terrazzo floor, tiled wainscot, drop ceiling with one troffer left on, reception counter and
// dark security desk with a CRT, a row of orange shell chairs, a directory board, potted plants, and propped-open
// double doors north into the link corridor.

export function buildLobby(b: Builder) {
  const { min, max } = INTERIOR.lobby
  const [x0, z0] = min
  const [x1, z1] = max

  // Terrazzo runs right out under the storefront to the door sill, its top flush with the shell slab and the entrance
  // landing (BUILDING.floorY), so the threshold has no step.
  const fy = BUILDING.floorY + 0.005
  b.box("terrazzo", x0, fy - 0.012, z0, x1, fy, 21.81, { cast: false, skip: "y" })
  b.walk(x0, z0, x1, 21.81, fy)
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, z0 - WALL_T, z0, lobbyBands, [doorOpening(0, 1.8)])
  wall(b, "z", z0, z1, x0 - WALL_T, x0, lobbyBands, [doorOpening(12)])
  wall(b, "z", z0, z1, x1, x1 + WALL_T, lobbyBands, [doorOpening(12)])
  door(b, 0, z0 - WALL_T / 2, { rot: 0, width: 1.8, leaves: 2, open: Math.PI / 2, plate: false })
  door(b, x0 - WALL_T / 2, 12, { rot: Math.PI / 2, locked: true })
  door(b, x1 + WALL_T / 2, 12, { rot: -Math.PI / 2, locked: true })

  ceiling(b, x0, z0, x1, z1)
  for (const x of [-4.8, 0, 4.8])
    for (const z of [12, 15.6, 19.2]) {
      const lit = x === 0 && z === 15.6
      troffer(b, x, z, lit ? "on" : "off", PANEL_WARM)
      if (lit) b.lamp({ ...fluoro(x, z, undefined, 45), color: TUBE_WARM })
    }

  reception(b)
  chairs(b, -2.6, 14.6, 5, 1)
  directory(b, 4.6, z0)
  plant(b, x0 + 0.45, z0 + 0.45)
  plant(b, x1 - 0.45, z0 + 0.45)
  plant(b, x1 - 0.5, z1 - 0.6)

  // Wastebasket by the chairs.
  wastebasket(b, -2.5, 17.6)
}

function reception(b: Builder) {
  const y = FLOOR_Y
  // Front counter (L-shaped), dark laminate with a lighter top.
  const fx0 = 2.8
  const fx1 = 7.6
  const fz0 = 15.2
  const fz1 = 15.75
  b.box(M.laminate, fx0, y, fz0, fx1, y + 1.08, fz1)
  b.box(M.laminateTop, fx0 - 0.03, y + 1.08, fz0 - 0.08, fx1 + 0.03, y + 1.12, fz1 + 0.06)
  b.box("rubber", fx0, y, fz1, fx1, y + 0.1, fz1 + 0.01, { cast: false })
  b.box(M.laminate, fx0, y, 12.6, fx0 + 0.55, y + 1.08, fz0)
  b.box(M.laminateTop, fx0 - 0.03, y + 1.08, 12.6, fx0 + 0.58, y + 1.12, fz0)
  b.collide(fx0 - 0.03, y, fz0 - 0.08, fx1, y + 1.12, fz1 + 0.06)
  b.collide(fx0 - 0.03, y, 12.6, fx0 + 0.58, y + 1.12, fz0)
  // Clipboard and paper on the counter, a mug.
  const clip = T(5.2, y + 1.121, 15.45, -0.15)
  b.boxM(M.clipboard, clip, 0.23, 0.006, 0.32, 0, 0.003, 0, { cast: false })
  b.boxM(M.paper, clip, 0.21, 0.002, 0.27, 0, 0.007, 0.015, { cast: false })
  b.boxM("metal_galvanized", clip, 0.08, 0.012, 0.025, 0, 0.012, -0.14)
  b.cyl(M.paper, T(3.4, y + 1.17, 15.5), 0.04, 0.04, 0.1, 12)
}

/**
 * One-piece moulded shell (seat pan, waist curve, raked back) with real thickness and a rolled edge all round: a top
 * surface grid, the same grid offset 9 mm along its normals underneath, and a rounded rim ring stitched between them,
 * all sharing vertices so normals run smoothly over the edge. Local frame: centre of the seat pan's underside at the
 * origin's (0, 0.445, 0), front facing +Z, width along X. Built once and copied.
 */
const SHELL_T = 0.009
const SEAT_UNDER = 0.446
const shellGeo = (() => {
  // Centreline profile [z, y], front lip to top of the back.
  const raw: [number, number][] = [
    [0.222, 0.418], [0.212, 0.446], [0.17, 0.458], [0.08, 0.457], [-0.02, 0.452], [-0.11, 0.455], [-0.165, 0.472],
    [-0.2, 0.505], [-0.218, 0.56], [-0.233, 0.64], [-0.248, 0.72], [-0.262, 0.8], [-0.27, 0.845], [-0.268, 0.868],
  ]
  // Resample evenly along the arc.
  const len = [0]
  for (let k = 1; k < raw.length; k++) len.push(len[k - 1]! + Math.hypot(raw[k]![0] - raw[k - 1]![0], raw[k]![1] - raw[k - 1]![1]))
  const nv = 22
  const nu = 13
  const prof: [number, number][] = []
  for (let j = 0; j < nv; j++) {
    const d = (j / (nv - 1)) * len[len.length - 1]!
    let k = 1
    while (k < len.length - 1 && len[k]! < d) k++
    const t = (d - len[k - 1]!) / (len[k]! - len[k - 1]!)
    prof.push([raw[k - 1]![0] + (raw[k]![0] - raw[k - 1]![0]) * t, raw[k - 1]![1] + (raw[k]![1] - raw[k - 1]![1]) * t])
  }
  const pos: number[] = []
  const v = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
  // Top surface: dished across (sides of the seat rise, sides of the back wrap forward), corners rounded in plan.
  for (let j = 0; j < nv; j++) {
    const [pz, py] = prof[j]!
    const backness = THREE.MathUtils.smoothstep(py, 0.47, 0.56)
    const ends = Math.min(j, nv - 1 - j)
    const round = ends === 0 ? 0.84 : ends === 1 ? 0.95 : ends === 2 ? 0.985 : 1
    const hw = (0.232 - backness * 0.012) * round
    for (let i = 0; i < nu; i++) {
      const u = (i / (nu - 1)) * 2 - 1
      const dish = u * u * 0.028
      pos.push(u * hw, py + dish * (1 - backness), pz + dish * backness * 1.3)
    }
  }
  const at = (j: number, i: number) => j * nu + i
  // Normals of the top grid (finite differences), oriented up/forward.
  const nrm: THREE.Vector3[] = []
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const du = v(at(j, Math.min(nu - 1, i + 1))).sub(v(at(j, Math.max(0, i - 1))))
      const dv = v(at(Math.min(nv - 1, j + 1), i)).sub(v(at(Math.max(0, j - 1), i)))
      nrm.push(new THREE.Vector3().crossVectors(dv, du).normalize())
    }
  const seatN = nrm[at(4, (nu - 1) / 2)]!
  if (seatN.y < 0) for (const n of nrm) n.negate()
  const nTop = nv * nu
  for (let k = 0; k < nTop; k++) {
    const p = v(k).addScaledVector(nrm[k]!, -SHELL_T)
    pos.push(p.x, p.y, p.z)
  }
  // Border loop and the rolled rim ring (half-way through the thickness, pushed outwards by half of it).
  const loop: [number, number][] = []
  for (let i = 0; i < nu; i++) loop.push([0, i])
  for (let j = 1; j < nv; j++) loop.push([j, nu - 1])
  for (let i = nu - 2; i >= 0; i--) loop.push([nv - 1, i])
  for (let j = nv - 2; j >= 1; j--) loop.push([j, 0])
  const rimStart = pos.length / 3
  for (const [j, i] of loop) {
    const ij = at(Math.min(nv - 2, Math.max(1, j)), Math.min(nu - 2, Math.max(1, i)))
    const out = v(at(j, i)).sub(v(ij))
    out.addScaledVector(nrm[at(j, i)]!, -out.dot(nrm[at(j, i)]!)).normalize()
    const p = v(at(j, i)).addScaledVector(nrm[at(j, i)]!, -SHELL_T / 2).addScaledVector(out, SHELL_T * 0.55)
    pos.push(p.x, p.y, p.z)
  }
  const idx: number[] = []
  const tri = (a: number, b: number, c: number, want: THREE.Vector3) => {
    const n = new THREE.Vector3().crossVectors(v(b).sub(v(a)), v(c).sub(v(a)))
    if (n.dot(want) >= 0) idx.push(a, b, c)
    else idx.push(a, c, b)
  }
  for (let j = 0; j < nv - 1; j++)
    for (let i = 0; i < nu - 1; i++) {
      const a = at(j, i), b2 = at(j, i + 1), c = at(j + 1, i), d = at(j + 1, i + 1)
      const n = nrm[a]!
      tri(a, b2, c, n)
      tri(b2, d, c, n)
      const m = n.clone().negate()
      tri(a + nTop, b2 + nTop, c + nTop, m)
      tri(b2 + nTop, d + nTop, c + nTop, m)
    }
  for (let k = 0; k < loop.length; k++) {
    const k1 = (k + 1) % loop.length
    const t0 = at(...loop[k]!), t1 = at(...loop[k1]!)
    const m0 = rimStart + k, m1 = rimStart + k1
    const out = v(m0).sub(v(t0).addScaledVector(nrm[t0]!, -SHELL_T / 2))
    tri(t0, t1, m1, out)
    tri(t0, m1, m0, out)
    tri(m0, m1, t1 + nTop, out)
    tri(m0, t1 + nTop, t0 + nTop, out)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
})()

/**
 * Airport-style beam seating along local x (row centred on `zStart…`), facing +X (`facing` 1) or -X: a rectangular
 * steel beam on two T-legs with rubber pads, each shell bolted down through a cast bracket (post + saddle plate) to
 * the beam. One seat is missing its shell (bare bracket and bolts), one hangs loose on a lost bolt.
 */
function chairs(b: Builder, xRow: number, zStart: number, n: number, facing: 1 | -1) {
  const y = FLOOR_Y
  const pitch = 0.58
  const zEnd = zStart + (n - 1) * pitch
  const F = T(xRow, y, 0, facing * (Math.PI / 2))
  const lx = (z: number) => -facing * z
  const xa = Math.min(lx(zStart), lx(zEnd)) - 0.2
  const xb = Math.max(lx(zStart), lx(zEnd)) + 0.2
  const steel = M.darkSteel
  // Beam: 80 × 50 mm box section, end caps.
  const beamY = 0.335
  b.rbox(steel, F, xb - xa, 0.05, 0.08, 0.006, (xa + xb) / 2, beamY, -0.04)
  for (const x of [xa, xb]) b.rbox(M.rubber, F, 0.006, 0.044, 0.074, 0.002, x - Math.sign(x - (xa + xb) / 2) * -0.003, beamY, -0.04)
  // T-legs in the gaps between the first two and last two seats: post, foot bar, pads.
  const legs = [lx(zStart + pitch / 2), lx(zEnd - pitch / 2)]
  for (const x of legs) {
    b.rbox(steel, F, 0.06, beamY - 0.025 - 0.03, 0.05, 0.006, x, (beamY - 0.025 + 0.03) / 2, -0.04)
    b.rbox(steel, F, 0.07, 0.03, 0.62, 0.006, x, 0.015 + 0.012, -0.04)
    for (const z of [-0.33, 0.25]) b.rbox(M.rubber, F, 0.08, 0.012, 0.08, 0.004, x, 0.006, z)
  }
  for (let i = 0; i < n; i++) {
    const x = lx(zStart + i * pitch)
    const missing = i === 2
    const loose = i === 4
    // Bracket: post from the beam top up to a saddle plate under the seat pan, two bolt heads on the plate.
    const plateY = SEAT_UNDER - 0.006
    b.rbox(steel, F, 0.05, plateY - (beamY + 0.025), 0.04, 0.005, x, (plateY + beamY + 0.025) / 2, -0.03)
    b.rbox(steel, F, 0.2, 0.012, 0.16, 0.004, x, plateY, -0.02)
    for (const bx of [-0.07, 0.07]) b.cyl(missing ? M.steel : steel, F.clone().multiply(T(x + bx, plateY + 0.009, -0.02)), 0.009, 0.009, 0.006, 8)
    if (missing) continue
    const S = F.clone().multiply(T(x, loose ? 0.004 : 0, 0, loose ? 0.06 : 0, loose ? -0.035 : 0, loose ? 0.025 : 0))
    b.add("plastic_orange", shellGeo.clone().applyMatrix4(S))
  }
  const z0 = Math.min(zStart, zEnd) - 0.4
  const z1 = Math.max(zStart, zEnd) + 0.4
  b.collide(xRow - 0.34, y, z0, xRow + 0.3, y + 0.9, z1)
}

/** Felt letter board with rows of white letters too small and blurred to read. */
function directory(b: Builder, x: number, zWall: number) {
  const y0 = FLOOR_Y + 1.25
  const w = 0.9
  const h = 1.1
  b.box(M.wood, x - w / 2 - 0.04, y0 - 0.04, zWall, x + w / 2 + 0.04, y0 + h + 0.04, zWall + 0.05)
  b.box(M.felt, x - w / 2, y0, zWall + 0.05, x + w / 2, y0 + h, zWall + 0.052, { cast: false })
  let seed = 3
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let row = 0; row < 14; row++) {
    const ry = y0 + h - 0.12 - row * 0.068
    if (row === 1 || row === 7) continue
    let cx = x - w / 2 + 0.06
    const words = row === 0 ? 2 : 2 + Math.floor(rnd() * 3)
    for (let k = 0; k < words; k++) {
      const len = row === 0 ? 0.16 : 0.05 + rnd() * 0.13
      if (cx + len > x + w / 2 - 0.2) break
      b.box(M.feltText, cx, ry, zWall + 0.052, cx + len, ry + (row === 0 ? 0.03 : 0.018), zWall + 0.054, { cast: false })
      cx += len + 0.025
    }
    if (row > 1) b.box(M.feltText, x + w / 2 - 0.12, ry, zWall + 0.052, x + w / 2 - 0.06, ry + 0.018, zWall + 0.054, { cast: false })
  }
  b.box("metal_galvanized", x - w / 2 - 0.04, y0 + h + 0.04, zWall, x + w / 2 + 0.04, y0 + h + 0.06, zWall + 0.06)
}

function plant(b: Builder, x: number, z: number) {
  const y = FLOOR_Y
  b.cyl(M.potClay, T(x, y + 0.22, z), 0.21, 0.16, 0.44, 14)
  b.cyl(M.soil, T(x, y + 0.42, z), 0.19, 0.19, 0.02, 14, { cast: false })
  let seed = Math.round(Math.abs(x * 13 + z * 7)) + 1
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  b.cyl(M.wood, T(x, y + 0.75, z), 0.015, 0.02, 0.7, 6)
  for (let i = 0; i < 26; i++) {
    const yaw = rnd() * Math.PI * 2
    const tilt = 0.5 + rnd() * 0.8
    const len = 0.35 + rnd() * 0.3
    const h = y + 0.5 + rnd() * 0.75
    const m = T(x, h, z, yaw, tilt)
    b.boxM(M.leaf, m, 0.06 + rnd() * 0.04, 0.006, len, 0, 0, -len / 2)
  }
  b.collide(x - 0.22, y, z - 0.22, x + 0.22, y + 1.2, z + 0.22)
}
