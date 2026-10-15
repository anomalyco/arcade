import { type Mat, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { ArrowKind } from "../../shared/world"
import { M } from "./shaders"

const m = (x: number) => x as Mat
const K: Rgb = [1, 1, 1]
const A = M.actor

/** How each archer is told apart in silhouette: a head shape, a scarf and an ember mark in their colour. */
export type Hat = "hood" | "brim" | "horns" | "cowl"
export type Identity = { hat: Hat; name: string; scarf: Rgb; ember: Rgb }
export const IDENTITIES: readonly Identity[] = [
  { hat: "hood", name: "TEAL", scarf: [0.03, 0.3, 0.32], ember: [0.25, 0.95, 1.0] },
  { hat: "brim", name: "WINE", scarf: [0.42, 0.04, 0.12], ember: [1.0, 0.28, 0.5] },
  { hat: "horns", name: "MOSS", scarf: [0.16, 0.34, 0.05], ember: [0.6, 1.0, 0.28] },
  { hat: "cowl", name: "OCHRE", scarf: [0.48, 0.32, 0.05], ember: [1.0, 0.82, 0.32] },
]

/** Faceted rings stacked along y: [x offset, y, radius] rows. */
function rings(mesh: Mesh, rows: readonly (readonly [number, number, number])[], color: Rgb, mat: number, sides = 10, zs = 1): void {
  for (let j = 1; j < rows.length; j++) {
    const [x0, y0, r0] = rows[j - 1]!
    const [x1, y1, r1] = rows[j]!
    for (let i = 0; i < sides; i++) {
      const a = (i * Math.PI * 2) / sides, b = ((i + 1) * Math.PI * 2) / sides
      const p = (x: number, y: number, r: number, t: number) => [x + Math.cos(t) * r, y, Math.sin(t) * r * zs]
      if (r1 === 0) mesh.facet(p(x0, y0, r0, a), [x1, y1, 0], p(x0, y0, r0, b), color, m(mat))
      else if (r0 === 0) mesh.facet([x0, y0, 0], p(x1, y1, r1, a), p(x1, y1, r1, b), color, m(mat))
      else mesh.quadAuto(p(x0, y0, r0, a), p(x1, y1, r1, a), p(x1, y1, r1, b), p(x0, y0, r0, b), color, m(mat))
    }
  }
}

export type ArcherParts = { pelvis: Mesh; torso: Mesh; head: Mesh; upperArm: Mesh; foreArm: Mesh; thigh: Mesh; shin: Mesh; foot: Mesh; toe: Mesh }

/** A slim hooded archer on the shared rig's frames (x forward, y up, z right; limbs hang along -y). */
export function archerParts(hat: Hat): ArcherParts {
  const pelvis = new Mesh()
  pelvis.box(-0.12, -0.08, -0.15, 0.11, 0.12, 0.15, K, m(A))
  // Tunic skirt flaring over the hips.
  rings(pelvis, [[0, 0.1, 0.16], [0.01, -0.12, 0.2], [0.02, -0.26, 0.24]], K, A, 9, 0.9)
  const torso = new Mesh()
  torso.box(-0.11, -0.02, -0.14, 0.1, 0.2, 0.14, K, m(A))
  torso.bevelBox(-0.13, 0.16, -0.19, 0.12, 0.45, 0.19, 0.04, K, K, m(A))
  torso.box(-0.05, 0.43, -0.05, 0.05, 0.52, 0.05, K, m(A))
  // Quiver across the back with fletchings poking out above the shoulder, and its strap.
  const qx = -0.17
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2
    const r = 0.065, y0 = 0.02, y1 = 0.5
    const tilt = 0.18
    const p = (y: number, a: number) => [qx + Math.cos(a) * r - (y - 0.26) * tilt, y, Math.sin(a) * r - 0.06]
    torso.quadAuto(p(y0, a0), p(y1, a0), p(y1, a1), p(y0, a1), K, m(A))
  }
  for (const [dx, dz] of [[-0.02, -0.08], [0.03, -0.03], [-0.05, -0.02]]) {
    const bx = qx - 0.05 + dx, by = 0.5
    torso.facet([bx - 0.03, by, dz], [bx + 0.03, by, dz], [bx - 0.06, by + 0.16, dz], K, m(A))
  }
  torso.box(-0.14, 0.12, -0.17, 0.135, 0.17, 0.17, K, m(A))
  // A short cloak from the shoulders to the backs of the knees with a tattered hem: the silhouette's bulk.
  const hem = 9
  for (let i = 0; i < hem; i++) {
    const u0 = i / hem, u1 = (i + 1) / hem
    const z0 = -0.24 + 0.48 * u0, z1 = -0.24 + 0.48 * u1
    const curve = (u: number) => -0.1 - 0.08 * Math.sin(u * Math.PI)
    const drop0 = -0.5 - (i % 2 ? 0.1 : 0) - 0.06 * Math.sin(i * 2.1)
    torso.quadAuto([curve(u0) + 0.02, 0.44, z0 * 0.85], [curve(u1) + 0.02, 0.44, z1 * 0.85], [curve(u1) - 0.14, -0.42, z1 * 1.08], [curve(u0) - 0.14, -0.42, z0 * 1.08], K, m(A))
    torso.facet([curve(u0) - 0.14, -0.42, z0 * 1.08], [curve(u1) - 0.14, -0.42, z1 * 1.08], [curve((u0 + u1) / 2) - 0.17, drop0, (z0 + z1) * 0.54], K, m(A))
  }
  // The ember mark on the strap: the player's colour (instance tint), small and glowing.
  torso.box(0.11, 0.28, -0.045, 0.155, 0.36, 0.045, K, m(M.accent), 1.4)
  const head = new Mesh()
  head.box(-0.05, -0.02, -0.05, 0.05, 0.08, 0.05, K, m(A))
  rings(head, [[0, 0.04, 0], [0.01, 0.07, 0.13], [0.01, 0.17, 0.145], [0, 0.27, 0.12], [0, 0.3, 0]], K, A, 10)
  // A long nose so facing reads in profile.
  head.facet([0.12, 0.17, -0.02], [0.12, 0.13, 0.0], [0.17, 0.15, 0.0], K, m(A))
  head.facet([0.12, 0.17, 0.02], [0.17, 0.15, 0.0], [0.12, 0.13, 0.0], K, m(A))
  hatOn(head, hat)
  // Limbs are chunky on purpose: thin limbs vanish at arena scale, and the concept's figures read as solid shapes.
  const upperArm = new Mesh()
  rings(upperArm, [[0, 0.06, 0.07], [0, -0.12, 0.068], [0, -0.29, 0.055]], K, A, 7)
  const foreArm = new Mesh()
  rings(foreArm, [[0, 0.03, 0.055], [0, -0.2, 0.05], [0, -0.27, 0.06], [0.01, -0.34, 0.05]], K, A, 7)
  const thigh = new Mesh()
  rings(thigh, [[0, 0.05, 0.095], [0.01, -0.2, 0.085], [0, -0.43, 0.065]], K, A, 8)
  const shin = new Mesh()
  rings(shin, [[0, 0.03, 0.065], [0.01, -0.12, 0.07], [0, -0.42, 0.06]], K, A, 8)
  // Boot cuff.
  shin.box(-0.075, -0.42, -0.07, 0.075, -0.28, 0.07, K, m(A))
  const foot = new Mesh()
  foot.box(-0.08, -0.085, -0.06, 0.13, 0.03, 0.06, K, m(A))
  const toe = new Mesh()
  toe.box(-0.01, 0, -0.05, 0.075, 0.07, 0.05, K, m(A))
  return { pelvis, torso, head, upperArm, foreArm, thigh, shin, foot, toe }
}

function hatOn(head: Mesh, hat: Hat): void {
  switch (hat) {
    case "hood":
      // A deep hood: a cowl over the head that peaks back and down into a long tail.
      rings(head, [[-0.01, 0.0, 0.0], [-0.02, 0.05, 0.15], [-0.03, 0.2, 0.165], [-0.06, 0.32, 0.12], [-0.16, 0.42, 0]], K, A, 10)
      head.facet([-0.12, 0.3, -0.06], [-0.12, 0.3, 0.06], [-0.34, 0.12, 0], K, m(A))
      head.facet([-0.12, 0.3, 0.06], [-0.12, 0.15, 0.0], [-0.34, 0.12, 0], K, m(A))
      head.facet([-0.12, 0.15, 0.0], [-0.12, 0.3, -0.06], [-0.34, 0.12, 0], K, m(A))
      break
    case "brim":
      // A wide brim tilted down at the front, a crown and a feather standing up behind.
      head.prism(0, 0, 0.3, 0.3, 0.26, 0.29, 14, K, m(A))
      head.prism(0, 0, 0.13, 0.11, 0.28, 0.42, 10, K, m(A))
      head.facet([-0.08, 0.36, 0.11], [-0.04, 0.37, 0.12], [-0.32, 0.66, 0.12], K, m(A))
      head.facet([-0.04, 0.37, 0.12], [-0.28, 0.6, 0.13], [-0.32, 0.66, 0.12], K, m(A))
      break
    case "horns":
      // A round helm with two curved horns sweeping forward and up.
      rings(head, [[0, 0.12, 0.15], [0, 0.22, 0.155], [0, 0.32, 0.1], [0, 0.35, 0]], K, A, 10)
      for (const s of [-1, 1]) {
        let px = 0, py = 0.24, pz = s * 0.13, w = 0.05
        for (let i = 0; i < 5; i++) {
          const nx = px + 0.03 + i * 0.012, ny = py + 0.06 + i * 0.012, nz = pz + s * (0.06 - i * 0.012)
          const nw = w * 0.75
          head.quadAuto([px - w, py, pz], [nx - nw, ny, nz], [nx + nw, ny, nz], [px + w, py, pz], K, m(A))
          head.quadAuto([px + w, py, pz], [nx + nw, ny, nz], [nx - nw, ny, nz], [px - w, py, pz], K, m(A))
          px = nx
          py = ny
          pz = nz
          w = nw
        }
      }
      break
    case "cowl":
      // A tall pointed cowl that bends back at the tip.
      rings(head, [[0, 0.1, 0.16], [-0.02, 0.24, 0.13], [-0.06, 0.4, 0.08], [-0.14, 0.56, 0.04], [-0.26, 0.64, 0]], K, A, 9)
      head.prism(0, 0, 0.2, 0.2, 0.1, 0.13, 12, K, m(A))
      break
  }
}

/** A tube through a polyline in the xy plane: square section, half thickness from `w(u)`. */
function tube(mesh: Mesh, pts: readonly (readonly [number, number])[], w: (u: number) => number): void {
  const n = pts.length
  const ring = (i: number): number[][] => {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const nx = -dy / l, ny = dx / l
    const r = w(i / (n - 1))
    const [x, y] = pts[i]!
    return [[x + nx * r, y + ny * r, -r], [x + nx * r, y + ny * r, r], [x - nx * r, y - ny * r, r], [x - nx * r, y - ny * r, -r]]
  }
  for (let i = 0; i + 1 < n; i++) {
    const p = ring(i), q = ring(i + 1)
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      mesh.quadAuto(p[k]!, q[k]!, q[k2]!, p[k2]!, K, m(A))
    }
  }
}

/** A recurve bow along its own y axis (tips at ±0.42), belly toward +x; held in the bow hand. */
export function bowMesh(): Mesh {
  const mesh = new Mesh()
  const pts: [number, number][] = []
  const n = 16
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * 2 - 1
    // Braced limbs bow away from the archer, and the tips recurve back toward the string.
    const x = -0.13 * (1 - u * u) + 0.07 * Math.pow(Math.abs(u), 7)
    pts.push([x, u * 0.42])
  }
  tube(mesh, pts, (u) => 0.012 + 0.012 * (1 - Math.abs(u * 2 - 1)))
  // The grip.
  mesh.box(-0.16, -0.05, -0.025, -0.1, 0.05, 0.025, K, m(A))
  return mesh
}

export const ARROW_LEN = 0.9

/** An arrow along +x from its nock (0) to its head (ARROW_LEN): dark shaft and fletching, a glowing head. */
export function arrowMesh(kind: ArrowKind): Mesh {
  const mesh = new Mesh()
  const L = ARROW_LEN
  mesh.box(0, -0.018, -0.018, L - 0.1, 0.018, 0.018, K, m(A))
  for (const s of [-1, 1]) mesh.facet([0.02, 0, 0], [0.2, 0, 0], [0.0, s * 0.08, 0], K, m(A))
  mesh.facet([0.02, 0, 0], [0.2, 0, 0], [0.0, 0, 0.08], K, m(A))
  const head = (x0: number, x1: number, r: number) => {
    mesh.facet([x0, -r, -r], [x0, r, -r], [x1, 0, 0], K, m(M.emissive), 3)
    mesh.facet([x0, r, -r], [x0, r, r], [x1, 0, 0], K, m(M.emissive), 3)
    mesh.facet([x0, r, r], [x0, -r, r], [x1, 0, 0], K, m(M.emissive), 3)
    mesh.facet([x0, -r, r], [x0, -r, -r], [x1, 0, 0], K, m(M.emissive), 3)
  }
  switch (kind) {
    case "bomb":
      mesh.prism(0, 0, 0.001, 0.001, 0, 0, 3, K, m(A))
      mesh.box(L - 0.2, -0.07, -0.07, L - 0.04, 0.07, 0.07, K, m(A))
      head(L - 0.04, L + 0.04, 0.03)
      break
    case "drill":
      for (let i = 0; i < 4; i++) head(L - 0.16 + i * 0.05, L + 0.02 + i * 0.03, 0.055 - i * 0.01)
      break
    case "bramble":
      head(L - 0.1, L + 0.06, 0.04)
      for (let i = 0; i < 5; i++) {
        const x = 0.25 + i * 0.12, s = i % 2 ? 1 : -1
        mesh.facet([x, 0, 0], [x + 0.05, 0, 0], [x + 0.02, s * 0.06, 0], K, m(A))
      }
      break
    default:
      head(L - 0.12, L + 0.04, 0.04)
  }
  return mesh
}

/** Treasure chest body (wood, iron bands, a glowing keyhole) with its lid as a separate model hinged at the back. */
export function chestMeshes(): { body: Mesh; lid: Mesh } {
  const wood: Rgb = [0.35, 0.22, 0.12]
  const iron: Rgb = [0.4, 0.38, 0.36]
  const body = new Mesh()
  body.box(-0.42, 0, -0.28, 0.42, 0.42, 0.28, wood, m(M.wood))
  for (const x of [-0.32, 0.28]) body.box(x, -0.01, -0.29, x + 0.06, 0.43, 0.29, iron, m(M.metal))
  body.box(-0.06, 0.24, 0.28, 0.06, 0.36, 0.3, [1, 0.6, 0.25], m(M.emissive), 2)
  const lid = new Mesh()
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI, a1 = ((i + 1) / 6) * Math.PI
    const y0 = Math.sin(a0) * 0.2, y1 = Math.sin(a1) * 0.2
    const z0 = -Math.cos(a0) * 0.28 + 0.28, z1 = -Math.cos(a1) * 0.28 + 0.28
    lid.quadAuto([-0.42, y0, z0 - 0.56], [0.42, y0, z0 - 0.56], [0.42, y1, z1 - 0.56], [-0.42, y1, z1 - 0.56], wood, m(M.wood))
  }
  lid.box(-0.42, -0.02, -0.56, 0.42, 0.0, 0.0, wood, m(M.wood))
  for (const x of [-0.32, 0.28]) lid.box(x, 0, -0.57, x + 0.06, 0.21, 0.01, iron, m(M.metal))
  // Shift the lid so its hinge (the back edge) sits on z = 0; it opens by turning about its x axis.
  for (let i = 0; i < lid.v.length; i += 11) lid.v[i + 2]! += 0.56
  return { body, lid }
}

/** An iron fire bowl on a tripod with glowing coals. */
export function brazierMesh(): Mesh {
  const iron: Rgb = [0.25, 0.24, 0.23]
  const mesh = new Mesh()
  for (const s of [-1, 1]) {
    mesh.quadAuto([s * 0.05, 0.55, -0.03], [s * 0.38, 0, -0.03], [s * 0.38, 0, 0.03], [s * 0.05, 0.55, 0.03], iron, m(M.metal))
  }
  mesh.box(-0.03, 0, -0.03, 0.03, 0.55, 0.03, iron, m(M.metal))
  rings(mesh, [[0, 0.5, 0.08], [0, 0.56, 0.32], [0, 0.72, 0.42], [0, 0.76, 0.44]], iron, M.metal, 12)
  mesh.prism(0, 0, 0.38, 0.38, 0.7, 0.74, 12, [1, 0.45, 0.12], m(M.emissive), 4)
  return mesh
}

/** One feathered wing along +x (root at 0, tip at ~0.75), spread in the xy plane; mirrored by the instance frame. */
export function wingMesh(): Mesh {
  const mesh = new Mesh()
  const feathers = 7
  for (let i = 0; i < feathers; i++) {
    const u = i / (feathers - 1)
    const len = 0.34 + 0.42 * Math.sin(u * Math.PI * 0.6 + 0.4)
    const ang = 0.9 - u * 1.25
    const bx = 0.06 + u * 0.26, by = 0.04 - u * 0.03
    const tx = bx + Math.cos(ang) * len, ty = by + Math.sin(ang) * len
    const w = 0.045
    mesh.facet([bx, by - w, 0], [tx, ty, 0], [bx, by + w, 0], K, m(A))
    mesh.facet([bx, by + w, 0], [tx, ty, 0], [bx, by - w, 0], K, m(A))
  }
  mesh.box(0, -0.03, -0.02, 0.36, 0.06, 0.02, K, m(A))
  return mesh
}
