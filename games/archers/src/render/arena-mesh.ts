import { type Mat, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { Rng, seedOf } from "@arcade/kit/sim/rng"
import { type Arena, solidAt } from "../../shared/arena"
import { M } from "./shaders"

const STONE: Rgb = [0.07, 0.068, 0.072]
const STONE_TOP: Rgb = [0.11, 0.105, 0.1]
const MOSS: Rgb = [0.09, 0.1, 0.085]
const INK: Rgb = [0.012, 0.012, 0.014]
const FAR: Rgb = [1, 1, 1]

/** Depth of the gameplay blocks: from the back face to the front face. */
export const BLOCK_BACK = -1.4
export const BLOCK_FRONT = 0.7

const m = (x: number) => x as Mat

/** A flat silhouette sheet facing the camera: a polygon given as a ridge line over a baseline. */
function ridge(mesh: Mesh, xs: number[], tops: number[], base: number, z: number, color: Rgb, mat: number): void {
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]!, x1 = xs[i + 1]!
    mesh.quad([x0, base, z], [x1, base, z], [x1, tops[i + 1]!, z], [x0, tops[i]!, z], [0, 0, 1], color, m(mat))
  }
}

function rect(mesh: Mesh, x0: number, y0: number, x1: number, y1: number, z: number, color: Rgb, mat: number): void {
  mesh.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1], color, m(mat))
}

function tri(mesh: Mesh, a: number[], b: number[], c: number[], color: Rgb, mat: number): void {
  mesh.facet(a, b, c, color, m(mat))
}

/** A conifer silhouette: stacked tiers whose lower edges break into drooping branch tips. */
function pine(mesh: Mesh, r: Rng, x: number, y: number, h: number, z: number, color: Rgb, mat: number): void {
  const tiers = 6 + r.int(4)
  for (let i = 0; i < tiers; i++) {
    const u = i / tiers
    const w = h * 0.3 * (1 - u * 0.8) * (0.8 + r.next() * 0.4)
    const y0 = y + h * u * 0.82
    const th = h * (0.22 + 0.08 * r.next())
    const apex = [x + (r.next() - 0.5) * 0.15 * h * 0.1, y0 + th, z]
    const cy = y0 + th * 0.3
    const pts: number[][] = []
    const spikes = 3 + r.int(3)
    for (let k = 0; k <= spikes * 2; k++) {
      const v = k / (spikes * 2)
      const px = x - w + 2 * w * v
      const edge = Math.abs(v - 0.5) * 2
      const droop = k % 2 === 0 ? th * (0.08 + 0.12 * edge) : -th * 0.05 * r.next()
      pts.push([px + (r.next() - 0.5) * w * 0.12, y0 - droop, z])
    }
    for (let k = 0; k + 1 < pts.length; k++) tri(mesh, pts[k]!, pts[k + 1]!, [x, cy, z], color, mat)
    tri(mesh, pts[0]!, [x, cy, z], apex, color, mat)
    tri(mesh, [x, cy, z], pts[pts.length - 1]!, apex, color, mat)
  }
  rect(mesh, x - h * 0.025, y - 3, x + h * 0.025, y + h * 0.3, z, color, mat)
}

/** A broadleaf canopy: a lumpy disc of leaves on a trunk. */
function broadleaf(mesh: Mesh, r: Rng, x: number, y: number, h: number, z: number, color: Rgb, mat: number): void {
  rect(mesh, x - h * 0.04, y - 3, x + h * 0.04, y + h * 0.6, z, color, mat)
  for (let b = 0; b < 4; b++) {
    const bx = x + (r.next() - 0.5) * h * 0.5, by = y + h * (0.55 + r.next() * 0.35)
    const rad = h * (0.2 + r.next() * 0.16)
    const n = 14
    let prev: number[] | null = null
    let first: number[] | null = null
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      const rr = rad * (0.75 + r.next() * 0.4)
      const p: number[] = i === n && first ? first : [bx + Math.cos(a) * rr, by + Math.sin(a) * rr * 0.85, z]
      if (!first) first = p
      if (prev) tri(mesh, prev, p, [bx, by, z], color, mat)
      prev = p
    }
  }
}

/** The bell tower silhouette with its arched window, bell and broken crown. Returns the window's centre. */
function tower(mesh: Mesh, r: Rng, cx: number, base: number, z: number, color: Rgb, mat: number): [number, number, number] {
  const w = 9, h = 30
  const top = base + h
  const winY0 = top - 10, winY1 = top - 3.6, winW = 2.6
  // Body below the window, the two sides of the window, and the lintel above.
  rect(mesh, cx - w / 2, base, cx + w / 2, winY0, z, color, mat)
  rect(mesh, cx - w / 2, winY0, cx - winW, top, z, color, mat)
  rect(mesh, cx + winW, winY0, cx + w / 2, top, z, color, mat)
  // Arch: a band over the window with a rounded underside.
  const steps = 10
  for (let i = 0; i < steps; i++) {
    const a0 = Math.PI * (i / steps), a1 = Math.PI * ((i + 1) / steps)
    const p0 = [cx + Math.cos(a0) * winW, winY1 + Math.sin(a0) * winW * 0.55, z]
    const p1 = [cx + Math.cos(a1) * winW, winY1 + Math.sin(a1) * winW * 0.55, z]
    mesh.quad([p1[0]!, p1[1]!, z], [p0[0]!, p0[1]!, z], [p0[0]!, top, z], [p1[0]!, top, z], [0, 0, 1], color, m(mat))
  }
  // The bell and its yoke.
  rect(mesh, cx - 2.6, winY1 + 0.6, cx + 2.6, winY1 + 1.0, z + 0.1, color, mat)
  const bellTop = winY1 + 0.6, bellH = 3.2
  for (let i = 0; i < 8; i++) {
    const u0 = i / 8, u1 = (i + 1) / 8
    const wd = (u: number) => 0.55 + 1.05 * Math.pow(1 - u, 1.6) + (u < 0.12 ? 0.25 * (1 - u / 0.12) : 0)
    const y0 = bellTop - bellH * (1 - u0), y1 = bellTop - bellH * (1 - u1)
    mesh.quad([cx - wd(1 - u0), y0, z + 0.1], [cx + wd(1 - u0), y0, z + 0.1], [cx + wd(1 - u1), y1, z + 0.1], [cx - wd(1 - u1), y1, z + 0.1], [0, 0, 1], color, m(mat))
  }
  // Broken crown: ragged teeth with a missing chunk.
  const xs: number[] = [], tops: number[] = []
  for (let i = 0; i <= 18; i++) {
    const u = i / 18
    xs.push(cx - w / 2 - 0.4 + (w + 0.8) * u)
    const broken = u > 0.58 && u < 0.86
    tops.push(top + (broken ? -1.5 - r.next() * 1.2 : 1.2 + (i % 3 === 0 ? 1.4 : 0) + r.next() * 0.6))
  }
  ridge(mesh, xs, tops, top - 0.5, z, color, mat)
  // Buttresses and rubble skirt.
  for (const s of [-1, 1]) {
    tri(mesh, [cx + s * w / 2, base, z], [cx + s * (w / 2 + 3.5), base, z], [cx + s * w / 2, base + 12, z], color, mat)
  }
  return [cx, (winY0 + winY1) / 2 + 0.6, z]
}

/** A broken arcade of arches between two x positions. */
function arcade(mesh: Mesh, r: Rng, x0: number, x1: number, base: number, h: number, z: number, color: Rgb, mat: number): void {
  const n = Math.max(1, Math.round((x1 - x0) / 5))
  const span = (x1 - x0) / n
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * span
    const ph = h * (0.55 + r.next() * 0.5)
    rect(mesh, x - 0.6, base, x + 0.6, base + ph, z, color, mat)
    if (i < n && r.next() > 0.3) {
      const steps = 8
      const ay = base + h * 0.62
      for (let k = 0; k < steps; k++) {
        const a0 = Math.PI * (k / steps), a1 = Math.PI * ((k + 1) / steps)
        const cx = x + span / 2, rw = span / 2
        mesh.quad([cx - Math.cos(a1) * rw, ay + Math.sin(a1) * rw * 0.7, z], [cx - Math.cos(a0) * rw, ay + Math.sin(a0) * rw * 0.7, z], [cx - Math.cos(a0) * rw, ay + rw * 0.7 + 0.9, z], [cx - Math.cos(a1) * rw, ay + rw * 0.7 + 0.9, z], [0, 0, 1], color, m(mat))
      }
    }
  }
}

/** Hanging ivy strands: thin tapering quads with a jagged end. */
function vines(mesh: Mesh, r: Rng, x0: number, x1: number, y: number, z: number, density: number, maxLen: number, color: Rgb, mat: number): void {
  for (let x = x0; x < x1; x += 0.12 + r.next() * 0.35 / density) {
    if (r.next() > density) continue
    const len = 0.2 + Math.pow(r.next(), 1.8) * maxLen
    const w = 0.03 + r.next() * 0.06
    const sway = (r.next() - 0.5) * 0.3
    const segs = Math.max(2, Math.ceil(len / 0.35))
    for (let i = 0; i < segs; i++) {
      const u0 = i / segs, u1 = (i + 1) / segs
      const w0 = w * (1 - u0 * 0.6), w1 = w * (1 - u1 * 0.6)
      const xa = x + sway * u0 * u0, xb = x + sway * u1 * u1
      mesh.quad([xa - w0, y - len * u0, z], [xa + w0, y - len * u0, z], [xb + w1, y - len * u1, z], [xb - w1, y - len * u1, z], [0, 0, 1], color, m(mat))
      if (r.next() < 0.3) {
        const lx = xb + (r.next() - 0.5) * 0.25
        tri(mesh, [xb, y - len * u1, z + 0.01], [lx + 0.09, y - len * u1 - 0.05, z + 0.01], [lx, y - len * u1 + 0.1, z + 0.01], color, mat)
      }
    }
  }
}

/** Grass and moss tufts along a top edge. */
function tufts(mesh: Mesh, r: Rng, x0: number, x1: number, y: number, z0: number, z1: number, color: Rgb, mat: number): void {
  for (let x = x0; x < x1; x += 0.08 + r.next() * 0.16) {
    // Clumps of short blades and moss, rarely a taller stalk.
    const h = 0.025 + Math.pow(r.next(), 3) * 0.16
    const z = z0 + (z1 - z0) * r.next()
    const lean = (r.next() - 0.5) * 0.12
    const w = 0.03 + r.next() * 0.05
    tri(mesh, [x - w, y - 0.02, z], [x + w, y - 0.02, z], [x + lean, y + h, z], color, mat)
    if (r.next() < 0.5) tri(mesh, [x - w * 1.6, y - 0.02, z + 0.01], [x + w * 1.6, y - 0.02, z + 0.01], [x + lean * 0.5, y + h * 0.45, z + 0.01], color, mat)
  }
}

/**
 * The static scene for an arena: wrapped copies of the gameplay blocks (crumbly edges, moss, hanging vines), then
 * the backdrop layers behind them (pines and hills, the bell tower, broken arcades, near pillars) and a few black
 * foreground shapes. Returns the mesh and the point light shafts radiate from.
 */
export function buildArenaScene(a: Arena): { mesh: Mesh; sun: [number, number, number] } {
  const mesh = new Mesh()
  const r = new Rng(seedOf(a.id))
  const W = a.w, H = a.h
  for (const [ox, oy] of [[0, 0], [-W, 0], [W, 0], [0, -H], [0, H], [-W, -H], [W, -H], [-W, H], [W, H]] as const) blocks(mesh, a, new Rng(seedOf(a.id) ^ 0x51ed), ox, oy)
  let sun: [number, number, number] = [W / 2, H + 4, -40]
  const cx = W / 2
  if (a.backdrop === "belltower") {
    // Far hills and forest, pale in the fog.
    const xs: number[] = [], tops: number[] = []
    for (let x = -90; x <= 122; x += 1.5) {
      xs.push(x)
      tops.push(2 + Math.sin(x * 0.05) * 3 + Math.sin(x * 0.17 + 1) * 1.2 + r.next() * 0.8)
    }
    ridge(mesh, xs, tops, -40, -95, FAR, M.far)
    for (let i = 0; i < 60; i++) pine(mesh, r, -70 + r.next() * 172, -2 + r.next() * 5, 9 + r.next() * 12, -62 - r.next() * 16, FAR, M.far)
    tower(mesh, r, cx + 22, -9, -58, FAR, M.far)
    // The bell tower, its window the light everything is backlit by.
    sun = tower(mesh, r, cx + 0.5, -5.3, -30, FAR, M.far)
    // A darker band of woods behind the arena floor, and ruined arcades.
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1
      const x = cx + side * (5 + r.next() * 30)
      if (r.next() < 0.6) pine(mesh, r, x, -6 + r.next() * 3, 10 + r.next() * 9, -20 - r.next() * 5, FAR, M.far)
      else broadleaf(mesh, r, x, -5 + r.next() * 2, 7 + r.next() * 5, -19 - r.next() * 5, FAR, M.far)
    }
    for (let i = 0; i < 16; i++) broadleaf(mesh, r, cx + (r.next() - 0.5) * 50, -9 + r.next() * 3, 6 + r.next() * 5, -11 - r.next() * 3, FAR, M.far)
    arcade(mesh, r, -14, 6, -6, 13, -15, FAR, M.far)
    arcade(mesh, r, 26, 46, -6, 13, -15, FAR, M.far)
    vines(mesh, r, -14, 6, 7, -14.9, 0.5, 4, FAR, M.far)
    vines(mesh, r, 26, 46, 7, -14.9, 0.5, 4, FAR, M.far)
  } else {
    // Cloister: a courtyard of colonnades receding into fog, a rose window as the light.
    const xs: number[] = [], tops: number[] = []
    for (let x = -90; x <= 122; x += 2) {
      xs.push(x)
      tops.push(6 + (Math.abs(x - cx) < 14 ? 10 : 0) + r.next() * 0.5)
    }
    ridge(mesh, xs, tops, -40, -80, FAR, M.far)
    // A great wall with a round window.
    const wz = -45, wy = H + 1
    const ring = 20
    for (let i = 0; i < ring; i++) {
      const a0 = (i / ring) * Math.PI * 2, a1 = ((i + 1) / ring) * Math.PI * 2
      const r0 = 3.6, r1 = 9
      mesh.quad([cx + Math.cos(a0) * r0, wy + Math.sin(a0) * r0, wz], [cx + Math.cos(a1) * r0, wy + Math.sin(a1) * r0, wz], [cx + Math.cos(a1) * r1, wy + Math.sin(a1) * r1, wz], [cx + Math.cos(a0) * r1, wy + Math.sin(a0) * r1, wz], [0, 0, 1], FAR, m(M.far))
    }
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2
      mesh.quad([cx - 0.15, wy, wz + 0.05], [cx + 0.15, wy, wz + 0.05], [cx + Math.cos(a0) * 3.7 + 0.15, wy + Math.sin(a0) * 3.7, wz + 0.05], [cx + Math.cos(a0) * 3.7 - 0.15, wy + Math.sin(a0) * 3.7, wz + 0.05], [0, 0, 1], FAR, m(M.far))
    }
    rect(mesh, cx - 40, -30, cx - 9, wy + 14, wz, FAR, M.far)
    rect(mesh, cx + 9, -30, cx + 40, wy + 14, wz, FAR, M.far)
    rect(mesh, cx - 9, -30, cx + 9, wy - 9, wz, FAR, M.far)
    rect(mesh, cx - 9, wy + 9, cx + 9, wy + 14, wz, FAR, M.far)
    sun = [cx, wy, wz]
    for (const z of [-28, -18]) arcade(mesh, r, -30, 62, -8, z === -28 ? 22 : 16, z, FAR, M.far)
    vines(mesh, r, -30, 62, 9, -17.9, 0.45, 5, FAR, M.far)
  }
  // Near pillars beside the arena walls, with ivy, and a few dead branches.
  for (const x of [-3.5, W + 3.5]) {
    rect(mesh, x - 1.6, -6, x + 1.6, H + 6, -6, STONE, M.stone)
    vines(mesh, r, x - 1.6, x + 1.6, H + 2, -5.95, 0.8, 8, MOSS, M.foliage)
  }
  for (let i = 0; i < 6; i++) {
    const x = r.next() < 0.5 ? -2 - r.next() * 6 : W + 2 + r.next() * 6
    const y = 2 + r.next() * (H - 4)
    const dir = x < 0 ? 1 : -1
    let px = x, py = y
    for (let k = 0; k < 5; k++) {
      const nx = px + dir * (0.8 + r.next()), ny = py + (r.next() - 0.35) * 0.8
      const w = 0.12 * (1 - k / 5) + 0.02
      mesh.quad([px, py - w, -4], [nx, ny - w * 0.7, -4], [nx, ny + w * 0.7, -4], [px, py + w, -4], [0, 0, 1], INK, m(M.foliage))
      px = nx
      py = ny
    }
  }
  // Foreground: black leaves in the bottom corners, out in front of the plane.
  for (const [x0, x1] of [[-6, 3.5], [W - 3.5, W + 6]] as const) {
    for (let i = 0; i < 40; i++) {
      const x = x0 + r.next() * (x1 - x0)
      const y = -1.5 + Math.pow(r.next(), 2) * 2.6
      const s = 0.35 + r.next() * 0.6
      const ang = r.next() * Math.PI * 2
      const z = 2.5 + r.next() * 2
      tri(mesh, [x, y, z], [x + Math.cos(ang) * s, y + Math.sin(ang) * s, z], [x + Math.cos(ang + 0.5) * s * 0.8, y + Math.sin(ang + 0.5) * s * 0.8, z], INK, M.foliage)
    }
  }
  return { mesh, sun }
}

/** Gameplay blocks with faces only toward open tiles, crumbly rims, moss on top and vines below. */
function blocks(mesh: Mesh, a: Arena, r: Rng, ox: number, oy: number): void {
  const z0 = BLOCK_BACK, z1 = BLOCK_FRONT
  for (let ty = 0; ty < a.h; ty++) {
    for (let tx = 0; tx < a.w; tx++) {
      if (!solidAt(a, tx, ty)) continue
      const x0 = tx + ox, y0 = ty + oy, x1 = x0 + 1, y1 = y0 + 1
      const up = !solidAt(a, tx, ty + 1), down = !solidAt(a, tx, ty - 1)
      const left = !solidAt(a, tx - 1, ty), right = !solidAt(a, tx + 1, ty)
      const shade = 0.85 + r.next() * 0.3
      const c: Rgb = [STONE[0] * shade, STONE[1] * shade, STONE[2] * shade]
      mesh.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], c, m(M.stone))
      if (up) mesh.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], STONE_TOP, m(M.stone))
      if (down) mesh.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], STONE, m(M.stone))
      if (left) mesh.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], STONE, m(M.stone))
      if (right) mesh.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], STONE, m(M.stone))
      // Crumbly rims: small stones sitting proud of the edges.
      if (up) {
        for (let k = 0; k < 3; k++) {
          if (r.next() < 0.45) continue
          const sx = x0 + r.next() * 0.85, sw = 0.08 + r.next() * 0.2, sh = 0.04 + r.next() * 0.1
          mesh.box(sx, y1 - 0.02, z1 - 0.3 - r.next() * 0.5, sx + sw, y1 + sh, z1 + 0.04, c, m(M.stone), 0, STONE_TOP)
        }
        tufts(mesh, r, x0, x1, y1, z1 - 0.05, z1 + 0.02, MOSS, M.foliage)
      }
      if (down) {
        if (r.next() < 0.7) vines(mesh, r, x0 + 0.05, x1 - 0.05, y0, z1 + 0.02, 0.55, 1.6, MOSS, M.foliage)
        if (r.next() < 0.4) {
          const sx = x0 + r.next() * 0.7
          mesh.box(sx, y0 - 0.12 - r.next() * 0.15, z1 - 0.4, sx + 0.15 + r.next() * 0.2, y0 + 0.02, z1 + 0.03, c, m(M.stone))
        }
      }
      if ((left || right) && r.next() < 0.5) {
        const sx = left ? x0 - 0.08 : x1 - 0.06
        const sy = y0 + r.next() * 0.8
        mesh.box(sx, sy, z1 - 0.5, sx + 0.14, sy + 0.12 + r.next() * 0.15, z1 + 0.03, c, m(M.stone))
      }
    }
  }
}
