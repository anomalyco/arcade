import type { Mat, Mesh, Rgb } from "@arcade/kit/gpu/mesh"

/**
 * Vertical shading baked into vertex colour: 1 at the top of a part, `low` at its bottom, and `under` on faces that
 * point down, so creases (armpits, under the jacket hem, under the chin) read darker without a shader term.
 */
export type BakedShade = { low?: number; under?: number }

/**
 * Axis-aligned box with every edge chamfered by `b`: 6 inset faces, 12 bevel strips and 8 corner facets. The bevels
 * catch the rim and the flashlight, which is what makes a low-poly part read as a solid toy rather than a flat card.
 */
export function chamferBox(
  m: Mesh,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  b: number,
  col: Rgb,
  mat: Mat,
  shade: BakedShade = {},
  aux = 0,
): void {
  const bb = Math.max(0, Math.min(b, (x1 - x0) / 2.1, (y1 - y0) / 2.1, (z1 - z0) / 2.1))
  const lo = [x0, y0, z0]
  const hi = [x1, y1, z1]
  const low = shade.low ?? 1
  const under = shade.under ?? 1
  const tone = (p: readonly number[], n: readonly number[]): Rgb => {
    const t = y1 > y0 ? (p[1]! - y0) / (y1 - y0) : 1
    const k = (low + (1 - low) * t) * (n[1]! < -0.3 ? under : 1)
    return [col[0] * k, col[1] * k, col[2] * k]
  }
  // Corner point for signs s (0 low, 1 high per axis), flush on axis `a`, inset by bb on the other two.
  const P = (s: readonly number[], a: number): number[] =>
    [0, 1, 2].map(i => (s[i] ? hi[i]! : lo[i]!) + (i === a ? 0 : s[i] ? -bb : bb))
  const poly = (pts: number[][], n: number[]) => {
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    const nn = [n[0]! / l, n[1]! / l, n[2]! / l]
    const tri = (a: number[], c: number[], d: number[]) => {
      const u = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
      const v = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!]
      const f = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      const area = Math.hypot(f[0]!, f[1]!, f[2]!)
      if (area < 1e-12) return
      const order = f[0]! * nn[0]! + f[1]! * nn[1]! + f[2]! * nn[2]! >= 0 ? [a, c, d] : [a, d, c]
      for (const p of order) m.vert(p, nn, tone(p, nn), mat, aux)
    }
    tri(pts[0]!, pts[1]!, pts[2]!)
    if (pts.length === 4) tri(pts[0]!, pts[2]!, pts[3]!)
  }
  // Faces: flush on axis a at side sa, the four corners around it in order.
  for (let a = 0; a < 3; a++) {
    const [u, v] = [(a + 1) % 3, (a + 2) % 3]
    for (const sa of [0, 1]) {
      const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([su, sv]) => {
        const s = [0, 0, 0]
        s[a] = sa
        s[u] = su!
        s[v] = sv!
        return P(s, a)
      })
      const n = [0, 0, 0]
      n[a] = sa ? 1 : -1
      poly(pts, n)
    }
  }
  if (bb <= 0) return
  // Edges: between the faces flush on axes a and c, running along axis r.
  for (let r = 0; r < 3; r++) {
    const [a, c] = [(r + 1) % 3, (r + 2) % 3]
    for (const sa of [0, 1]) {
      for (const sc of [0, 1]) {
        const at = (sr: number, flush: number) => {
          const s = [0, 0, 0]
          s[r] = sr
          s[a] = sa
          s[c] = sc
          return P(s, flush)
        }
        const n = [0, 0, 0]
        n[a] = sa ? 1 : -1
        n[c] = sc ? 1 : -1
        poly([at(0, a), at(1, a), at(1, c), at(0, c)], n)
      }
    }
  }
  for (const sx of [0, 1]) for (const sy of [0, 1]) for (const sz of [0, 1]) {
    const s = [sx, sy, sz]
    poly([P(s, 0), P(s, 1), P(s, 2)], [sx ? 1 : -1, sy ? 1 : -1, sz ? 1 : -1])
  }
}

/**
 * 12-triangle axis-aligned box with vertical and under-face shading baked into vertex colour (`chamferBox` with `b = 0`).
 * Used for flat garment trim, pockets, ties, straps, badges and torn hems where bevels would waste triangles.
 */
export function shadedBox(
  m: Mesh,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  col: Rgb,
  mat: Mat,
  shade: BakedShade = {},
  aux = 0,
): void {
  chamferBox(m, x0, y0, z0, x1, y1, z1, 0, col, mat, shade, aux)
}
