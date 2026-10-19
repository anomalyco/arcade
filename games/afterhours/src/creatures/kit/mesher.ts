import { type SdfModel, type V3 } from "./sdf"

// Sparse surface nets: the bounding box is split into blocks of BxBxB cells; a block is sampled only if the field says
// the surface may pass through it (tested at its centre and its eight octant centres with a generous Lipschitz
// margin). Each sign-changing cell gets one vertex at the mean of its edge crossings, projected onto the surface along
// the gradient; each sign-changing edge emits a quad joining the four cells around it. Cells referenced from an
// inactive neighbour block are evaluated on demand, so block borders never tear.

export type RawMesh = { positions: Float32Array; indices: Uint32Array }

const B = 16

export function meshSdf(model: SdfModel, h: number, opts: { min?: V3; max?: V3; project?: boolean } = {}): RawMesh {
  const bb = model.bounds()
  const pad = 2 * h
  const min: V3 = opts.min ?? [bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad]
  const max: V3 = opts.max ?? [bb.max[0] + pad, bb.max[1] + pad, bb.max[2] + pad]
  const nx = Math.ceil((max[0] - min[0]) / h)
  const ny = Math.ceil((max[1] - min[1]) / h)
  const nz = Math.ceil((max[2] - min[2]) / h)
  const bx = Math.ceil(nx / B)
  const by = Math.ceil(ny / B)
  const bz = Math.ceil(nz / B)
  const S = B + 1
  // Corner keys: plenty of room per axis.
  const KX = nx + 2
  const KY = ny + 2
  const key = (i: number, j: number, k: number) => i + KX * (j + KY * k)

  const blocks = new Map<number, Float32Array>()
  const blockLists = new Map<number, Int32Array>()
  const bkey = (i: number, j: number, k: number) => i + bx * (j + by * k)
  const bs = B * h

  const lst = (bi: number, bj: number, bk: number) => {
    const kk = bkey(bi, bj, bk)
    let l = blockLists.get(kk)
    if (!l) {
      const lo: V3 = [min[0] + bi * bs, min[1] + bj * bs, min[2] + bk * bs]
      l = model.listFor(lo, [lo[0] + bs, lo[1] + bs, lo[2] + bs], h * 2)
      blockLists.set(kk, l)
    }
    return l
  }

  // 1. Activate blocks.
  const active: [number, number, number][] = []
  const half = bs / 2
  const q = bs / 4
  const diag = Math.sqrt(3) * half
  for (let k = 0; k < bz; k++)
    for (let j = 0; j < by; j++)
      for (let i = 0; i < bx; i++) {
        const l = lst(i, j, k)
        if (l.length === 0) continue
        const cx = min[0] + i * bs + half
        const cy = min[1] + j * bs + half
        const cz = min[2] + k * bs + half
        let hit = Math.abs(model.evalList(l, cx, cy, cz)) < diag * 1.6 + h
        if (!hit) {
          for (let o = 0; o < 8 && !hit; o++) {
            const d = model.evalList(l, cx + (o & 1 ? q : -q), cy + (o & 2 ? q : -q), cz + (o & 4 ? q : -q))
            if (Math.abs(d) < diag * 0.8 + h) hit = true
          }
        }
        if (hit) active.push([i, j, k])
      }

  // 2. Sample corners of active blocks.
  for (const [bi, bj, bk] of active) {
    const l = lst(bi, bj, bk)
    const arr = new Float32Array(S * S * S)
    const ox = bi * B
    const oy = bj * B
    const oz = bk * B
    let n = 0
    for (let k = 0; k < S; k++)
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) arr[n++] = model.evalList(l, min[0] + (ox + i) * h, min[1] + (oy + j) * h, min[2] + (oz + k) * h)
    blocks.set(bkey(bi, bj, bk), arr)
  }

  const extra = new Map<number, number>()
  const corner = (i: number, j: number, k: number): number => {
    const bi = Math.floor(i / B)
    const bj = Math.floor(j / B)
    const bk = Math.floor(k / B)
    if (bi >= 0 && bj >= 0 && bk >= 0 && bi < bx && bj < by && bk < bz) {
      const arr = blocks.get(bkey(bi, bj, bk))
      if (arr) return arr[i - bi * B + S * (j - bj * B + S * (k - bk * B))]!
    }
    const kk = key(i, j, k)
    let v = extra.get(kk)
    if (v === undefined) {
      v = model.eval(min[0] + i * h, min[1] + j * h, min[2] + k * h)
      extra.set(kk, v)
    }
    return v
  }

  // 3. Cell vertices.
  const pos: number[] = []
  const cellVert = new Map<number, number>()
  const c8 = new Float64Array(8)
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ] as const
  const vertexOf = (i: number, j: number, k: number): number => {
    const kk = key(i, j, k)
    const got = cellVert.get(kk)
    if (got !== undefined) return got
    for (let o = 0; o < 8; o++) c8[o] = corner(i + (o & 1), j + ((o >> 1) & 1), k + ((o >> 2) & 1))
    let sx = 0
    let sy = 0
    let sz = 0
    let n = 0
    for (const [a, b] of EDGES) {
      const va = c8[a]!
      const vb = c8[b]!
      if (va < 0 === vb < 0) continue
      const t = va / (va - vb)
      sx += (a & 1) + (((b & 1) - (a & 1)) * t)
      sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t)
      sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t)
      n++
    }
    let px = min[0] + (i + (n ? sx / n : 0.5)) * h
    let py = min[1] + (j + (n ? sy / n : 0.5)) * h
    let pz = min[2] + (k + (n ? sz / n : 0.5)) * h
    if (opts.project !== false) {
      // Two Newton steps onto the zero set, clamped to stay inside the cell's neighbourhood.
      const x0 = px
      const y0 = py
      const z0 = pz
      for (let it = 0; it < 2; it++) {
        const e = h * 0.25
        const d = model.eval(px, py, pz)
        const gx = (model.eval(px + e, py, pz) - model.eval(px - e, py, pz)) / (2 * e)
        const gy = (model.eval(px, py + e, pz) - model.eval(px, py - e, pz)) / (2 * e)
        const gz = (model.eval(px, py, pz + e) - model.eval(px, py, pz - e)) / (2 * e)
        const g2 = gx * gx + gy * gy + gz * gz
        if (g2 < 1e-8) break
        px -= (d * gx) / g2
        py -= (d * gy) / g2
        pz -= (d * gz) / g2
      }
      const dx = px - x0
      const dy = py - y0
      const dz = pz - z0
      const m = Math.hypot(dx, dy, dz)
      if (m > h * 0.9) {
        const s = (h * 0.9) / m
        px = x0 + dx * s
        py = y0 + dy * s
        pz = z0 + dz * s
      }
    }
    const idx = pos.length / 3
    pos.push(px, py, pz)
    cellVert.set(kk, idx)
    return idx
  }

  // 4. Quads around every sign-changing edge whose low corner lies in an active block.
  const tris: number[] = []
  const P = (v: number, a: number) => pos[v * 3 + a]!
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) {
      const t = b
      b = d
      d = t
    }
    // Split along the shorter diagonal.
    const ac = (P(a, 0) - P(c, 0)) ** 2 + (P(a, 1) - P(c, 1)) ** 2 + (P(a, 2) - P(c, 2)) ** 2
    const bd = (P(b, 0) - P(d, 0)) ** 2 + (P(b, 1) - P(d, 1)) ** 2 + (P(b, 2) - P(d, 2)) ** 2
    if (ac <= bd) tris.push(a, b, c, a, c, d)
    else tris.push(a, b, d, b, c, d)
  }
  for (const [bi, bj, bk] of active) {
    const arr = blocks.get(bkey(bi, bj, bk))!
    for (let k = 0; k < B; k++)
      for (let j = 0; j < B; j++)
        for (let i = 0; i < B; i++) {
          const gi = bi * B + i
          const gj = bj * B + j
          const gk = bk * B + k
          if (gi < 1 || gj < 1 || gk < 1 || gi >= nx - 1 || gj >= ny - 1 || gk >= nz - 1) continue
          const v0 = arr[i + S * (j + S * k)]!
          const in0 = v0 < 0
          const vx = arr[i + 1 + S * (j + S * k)]!
          const vy = arr[i + S * (j + 1 + S * k)]!
          const vz = arr[i + S * (j + S * (k + 1))]!
          if (in0 !== vx < 0) quad(vertexOf(gi, gj - 1, gk - 1), vertexOf(gi, gj, gk - 1), vertexOf(gi, gj, gk), vertexOf(gi, gj - 1, gk), !in0)
          if (in0 !== vy < 0) quad(vertexOf(gi - 1, gj, gk - 1), vertexOf(gi - 1, gj, gk), vertexOf(gi, gj, gk), vertexOf(gi, gj, gk - 1), !in0)
          if (in0 !== vz < 0) quad(vertexOf(gi - 1, gj - 1, gk), vertexOf(gi, gj - 1, gk), vertexOf(gi, gj, gk), vertexOf(gi - 1, gj, gk), !in0)
        }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(tris) }
}
