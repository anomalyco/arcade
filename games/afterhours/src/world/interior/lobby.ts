import { INTERIOR } from "../layout"
import { type Builder, CEIL_Y, FLOOR_Y, M, T, ceiling, door, doorOpening, fluorescentPanel, lobbyBands, troffer, wall } from "./kit"
import { WALL_T, fluoro } from "./corridor"

// Lobby (concept r5-02): terrazzo floor, tiled wainscot, drop ceiling with one troffer left on, reception counter and
// dark security desk with a CRT, a row of orange shell chairs, a directory board, potted plants, and propped-open
// double doors north into the link corridor.

export function buildLobby(b: Builder) {
  const { min, max } = INTERIOR.lobby
  const [x0, z0] = min
  const [x1, z1] = max
  const on = fluorescentPanel(1).material

  b.floor("terrazzo", x0, z0, x1, z1)
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, z0 - WALL_T, z0, lobbyBands, [doorOpening(0, 1.8)])
  wall(b, "z", z0, z1, x0 - WALL_T, x0, lobbyBands, [doorOpening(12)])
  wall(b, "z", z0, z1, x1, x1 + WALL_T, lobbyBands, [doorOpening(12)])
  door(b, 0, z0 - WALL_T / 2, { rot: 0, width: 1.8, leaves: 2, open: Math.PI / 2, plate: false })
  door(b, x0 - WALL_T / 2, 12, { rot: Math.PI / 2 })
  door(b, x1 + WALL_T / 2, 12, { rot: -Math.PI / 2 })

  ceiling(b, x0, z0, x1, z1)
  for (const x of [-4.8, 0, 4.8])
    for (const z of [12, 15.6, 19.2]) {
      const lit = x === 0 && z === 15.6
      troffer(b, x, z, lit ? "on" : "off", on)
      if (lit) b.lamp(fluoro(x, z, undefined, 45))
    }

  reception(b)
  chairs(b, x1 - 0.32, 13.2, 5)
  directory(b, -4.6, z0)
  plant(b, x0 + 0.45, z0 + 0.45)
  plant(b, x1 - 0.45, z0 + 0.45)
  plant(b, x1 - 0.5, z1 - 0.6)

  // Wastebasket by the chairs.
  b.cyl("metal_dark", T(x1 - 0.3, FLOOR_Y + 0.17, 12.5), 0.15, 0.13, 0.34, 14, { open: true })
}

function reception(b: Builder) {
  const y = FLOOR_Y
  // Front counter (L-shaped), dark laminate with a lighter top.
  const fx0 = -7.6
  const fx1 = -2.8
  const fz0 = 15.2
  const fz1 = 15.75
  b.box(M.laminate, fx0, y, fz0, fx1, y + 1.08, fz1)
  b.box(M.laminateTop, fx0 - 0.03, y + 1.08, fz0 - 0.08, fx1 + 0.03, y + 1.12, fz1 + 0.06)
  b.box("rubber", fx0, y, fz1, fx1, y + 0.1, fz1 + 0.01, { cast: false })
  b.box(M.laminate, fx1 - 0.55, y, 12.6, fx1, y + 1.08, fz0)
  b.box(M.laminateTop, fx1 - 0.58, y + 1.08, 12.6, fx1 + 0.03, y + 1.12, fz0)
  b.collide(fx0, y, fz0 - 0.08, fx1 + 0.03, y + 1.12, fz1 + 0.06)
  b.collide(fx1 - 0.58, y, 12.6, fx1 + 0.03, y + 1.12, fz0)
  // Clipboard and paper on the counter, a mug.
  const clip = T(-5.2, y + 1.121, 15.45, 0.15)
  b.boxM(M.clipboard, clip, 0.23, 0.006, 0.32, 0, 0.003, 0, { cast: false })
  b.boxM(M.paper, clip, 0.21, 0.002, 0.27, 0, 0.007, 0.015, { cast: false })
  b.boxM("metal_galvanized", clip, 0.08, 0.012, 0.025, 0, 0.012, -0.14)
  b.cyl(M.paper, T(-3.4, y + 1.17, 15.5), 0.04, 0.04, 0.1, 12)
}

/** Row of moulded orange shell chairs on a steel beam against the east wall at `xWall`, facing -X, from z = zStart. */
function chairs(b: Builder, xWall: number, zStart: number, n: number) {
  const y = FLOOR_Y
  const pitch = 0.6
  const zEnd = zStart + (n - 1) * pitch
  // Built facing +Z in a local frame, then rotated so local +Z points to -X.
  const F = T(xWall, y, 0, -Math.PI / 2)
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    b.boxM("metal_dark", F, x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  // The rotation maps local +X to world +Z, so local x is world z.
  const lx = (z: number) => z
  box(lx(zStart) - 0.25, 0.36, 0.05, lx(zEnd) + 0.25, 0.4, 0.13)
  for (const z of [zStart - 0.1, zEnd + 0.1]) {
    box(lx(z) - 0.02, 0, 0.07, lx(z) + 0.02, 0.38, 0.11)
    box(lx(z) - 0.03, 0, -0.15, lx(z) + 0.03, 0.02, 0.45)
  }
  for (let i = 0; i < n; i++) {
    const x = lx(zStart + i * pitch)
    const s = F.clone().multiply(T(x, 0.45, 0.24, 0, -0.08))
    b.boxM("plastic_orange", s, 0.48, 0.03, 0.42, 0, 0, 0)
    b.boxM("plastic_orange", s, 0.48, 0.04, 0.06, 0, 0.01, 0.2)
    const back = F.clone().multiply(T(x, 0.72, 0.02, 0, -0.18))
    b.boxM("plastic_orange", back, 0.47, 0.42, 0.03, 0, 0, 0)
    b.boxM("metal_dark", F, 0.06, 0.06, 0.06, x, 0.44, 0.08)
  }
  b.collide(xWall - 0.5, y, zStart - 0.35, xWall, y + 0.95, zEnd + 0.35)
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
