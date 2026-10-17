import { BUILDING, INTERIOR } from "../layout"
import * as THREE from "three/webgpu"
import { type Builder, FLOOR_Y, M, PANEL_WARM, T, TUBE_WARM, ceiling, door, doorOpening, lobbyBands, troffer, wall } from "./kit"
import { WALL_T, fluoro } from "./corridor"

// Lobby (concept r5-02): terrazzo floor, tiled wainscot, drop ceiling with one troffer left on, reception counter and
// dark security desk with a CRT, a row of orange shell chairs, a directory board, potted plants, and propped-open
// double doors north into the link corridor.

export function buildLobby(b: Builder) {
  const { min, max } = INTERIOR.lobby
  const [x0, z0] = min
  const [x1, z1] = max

  // Terrazzo runs right out under the storefront to the door sill, its top flush with the shell slab and the entrance
  // landing (BUILDING.floorY), so the threshold has no step.
  const fy = BUILDING.floorY + 0.001
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
  b.cyl("metal_dark", T(-2.5, FLOOR_Y + 0.17, 17.6), 0.15, 0.13, 0.34, 14, { open: true })
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

/** Moulded shell seat (seat pan curving up into the back, dished across), two-sided, base of the back at the origin,
 *  front facing local +Z. Built once and copied. */
const shellGeo = (() => {
  // Profile from the front lip of the seat to the top of the back: [z, y].
  const prof: [number, number][] = [
    [0.21, 0.43], [0.19, 0.455], [0.1, 0.46], [0.0, 0.455], [-0.1, 0.45], [-0.16, 0.46], [-0.2, 0.5],
    [-0.22, 0.56], [-0.235, 0.64], [-0.25, 0.72], [-0.265, 0.8], [-0.275, 0.86], [-0.27, 0.885],
  ]
  const nu = 9
  const pos: number[] = []
  const idx: number[] = []
  for (let j = 0; j < prof.length; j++) {
    const [pz, py] = prof[j]!
    const back = py > 0.5
    const hw = back ? 0.22 : 0.235
    for (let i = 0; i < nu; i++) {
      const u = (i / (nu - 1)) * 2 - 1
      const dish = u * u * 0.035
      pos.push(u * hw, py + (back ? 0 : dish), pz + (back ? dish : 0))
    }
  }
  for (let j = 0; j < prof.length - 1; j++)
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i
      idx.push(a, a + 1, a + nu, a + 1, a + nu + 1, a + nu)
    }
  const front = new THREE.BufferGeometry()
  front.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  front.setIndex(idx)
  front.computeVertexNormals()
  // Underside: offset along the normal, reversed winding.
  const n = front.getAttribute("normal")
  const pos2 = pos.map((v, k) => v - n.array[k]! * 0.007)
  const idx2: number[] = []
  for (let k = 0; k < idx.length; k += 3) idx2.push(idx[k]!, idx[k + 2]!, idx[k + 1]!)
  const under = new THREE.BufferGeometry()
  under.setAttribute("position", new THREE.Float32BufferAttribute(pos2, 3))
  under.setIndex(idx2)
  under.computeVertexNormals()
  return [front, under]
})()

/**
 * Row of moulded orange shell chairs on a steel beam at x, from z = zStart, facing +X (`facing` 1) or -X (-1).
 */
function chairs(b: Builder, xRow: number, zStart: number, n: number, facing: 1 | -1) {
  const y = FLOOR_Y
  const pitch = 0.6
  const zEnd = zStart + (n - 1) * pitch
  // Built facing +Z in a local frame; the rotation turns local +Z to world ±X, and local x to world ∓z·facing.
  const F = T(xRow, y, 0, facing * (Math.PI / 2))
  const lx = (z: number) => -facing * z
  const pipe = (p0: number[], p1: number[], r: number) => {
    const a = new THREE.Vector3(p0[0], p0[1], p0[2]).applyMatrix4(F)
    const c = new THREE.Vector3(p1[0], p1[1], p1[2]).applyMatrix4(F)
    b.rod(M.steel, [a.x, a.y, a.z], [c.x, c.y, c.z], r, 10)
  }
  const ends = [lx(zStart - 0.15), lx(zEnd + 0.15)]
  // Tubular beam, two T-legs with splayed feet, a bracket under every seat.
  pipe([Math.min(...ends), 0.38, 0], [Math.max(...ends), 0.38, 0], 0.025)
  for (const e of ends) {
    pipe([e, 0.38, 0], [e, 0.03, 0], 0.022)
    pipe([e, 0.02, -0.25], [e, 0.02, 0.3], 0.016)
    b.rbox(M.rubber, F, 0.04, 0.02, 0.05, 0.008, e, 0.01, -0.25)
    b.rbox(M.rubber, F, 0.04, 0.02, 0.05, 0.008, e, 0.01, 0.3)
  }
  for (let i = 0; i < n; i++) {
    const x = lx(zStart + i * pitch)
    const S = F.clone().multiply(T(x, 0, 0.04))
    for (const g of shellGeo) b.add("plastic_orange", g.clone().applyMatrix4(S))
    pipe([x, 0.38, 0], [x, 0.44, 0.02], 0.014)
    pipe([x, 0.4, -0.02], [x, 0.6, -0.2], 0.012)
  }
  const z0 = Math.min(zStart, zEnd) - 0.4
  const z1 = Math.max(zStart, zEnd) + 0.4
  b.collide(xRow - 0.32, y, z0, xRow + 0.32, y + 0.9, z1)
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
