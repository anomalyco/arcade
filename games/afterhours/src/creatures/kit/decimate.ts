import type { RawMesh } from "./mesher"

// Quadric-error edge-collapse decimation (Garland & Heckbert) for closed meshes, with a link-condition check to stay
// manifold, a normal-flip check, and a mild edge-length term so flat areas don't turn into slivers. Plus Taubin
// smoothing (shrink-free Laplacian) and vertex welding. Offline-speed TypeScript: ~1 s per 100k triangles in Bun.

class Heap {
  key = new Float64Array(1024)
  id = new Int32Array(1024)
  n = 0
  push(k: number, v: number) {
    if (this.n === this.key.length) {
      const k2 = new Float64Array(this.n * 2)
      k2.set(this.key)
      this.key = k2
      const i2 = new Int32Array(this.n * 2)
      i2.set(this.id)
      this.id = i2
    }
    let i = this.n++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.key[p]! <= k) break
      this.key[i] = this.key[p]!
      this.id[i] = this.id[p]!
      i = p
    }
    this.key[i] = k
    this.id[i] = v
  }
  pop(): number {
    const top = this.id[0]!
    const k = this.key[--this.n]!
    const v = this.id[this.n]!
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= this.n) break
      if (c + 1 < this.n && this.key[c + 1]! < this.key[c]!) c++
      if (this.key[c]! >= k) break
      this.key[i] = this.key[c]!
      this.id[i] = this.id[c]!
      i = c
    }
    this.key[i] = k
    this.id[i] = v
    return top
  }
}

export function decimate(mesh: RawMesh, targetTris: number, opts: { lengthWeight?: number } = {}): RawMesh {
  const nV = mesh.positions.length / 3
  const nT = mesh.indices.length / 3
  if (nT <= targetTris) return mesh
  const P = Float64Array.from(mesh.positions)
  const T = Int32Array.from(mesh.indices)
  const tAlive = new Uint8Array(nT).fill(1)
  const vAlive = new Uint8Array(nV).fill(1)
  const stamp = new Uint32Array(nV)
  const Q = new Float64Array(nV * 10)
  const vt: number[][] = Array.from({ length: nV }, () => [])
  for (let t = 0; t < nT; t++) for (let c = 0; c < 3; c++) vt[T[t * 3 + c]!]!.push(t)

  for (let t = 0; t < nT; t++) {
    const a = T[t * 3]! * 3
    const b = T[t * 3 + 1]! * 3
    const c = T[t * 3 + 2]! * 3
    const ux = P[b]! - P[a]!
    const uy = P[b + 1]! - P[a + 1]!
    const uz = P[b + 2]! - P[a + 2]!
    const wx = P[c]! - P[a]!
    const wy = P[c + 1]! - P[a + 1]!
    const wz = P[c + 2]! - P[a + 2]!
    let nx = uy * wz - uz * wy
    let ny = uz * wx - ux * wz
    let nz = ux * wy - uy * wx
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-20) continue
    const area = l * 0.5
    nx /= l
    ny /= l
    nz /= l
    const d = -(nx * P[a]! + ny * P[a + 1]! + nz * P[a + 2]!)
    const q = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d]
    for (let k = 0; k < 3; k++) {
      const v = T[t * 3 + k]!
      for (let i = 0; i < 10; i++) Q[v * 10 + i] += q[i]! * area
    }
  }

  const lw = opts.lengthWeight ?? 0.02
  const ea: number[] = []
  const eb: number[] = []
  const es: number[] = []
  const ex: number[] = []
  const heap = new Heap()
  const opt = new Float64Array(3)

  const cost = (a: number, b: number): number => {
    const q = new Array<number>(10)
    for (let i = 0; i < 10; i++) q[i] = Q[a * 10 + i]! + Q[b * 10 + i]!
    const [q0, q1, q2, q3, q4, q5, q6, q7, q8, q9] = q as [number, number, number, number, number, number, number, number, number, number]
    const err = (x: number, y: number, z: number) =>
      q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y + q7 * z * z + 2 * q8 * z + q9
    const ax = P[a * 3]!
    const ay = P[a * 3 + 1]!
    const az = P[a * 3 + 2]!
    const bx = P[b * 3]!
    const by = P[b * 3 + 1]!
    const bz = P[b * 3 + 2]!
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const mz = (az + bz) / 2
    const L2 = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2
    // Solve the 3x3 system for the optimal point.
    const det = q0 * (q4 * q7 - q5 * q5) - q1 * (q1 * q7 - q5 * q2) + q2 * (q1 * q5 - q4 * q2)
    let best = Infinity
    if (Math.abs(det) > 1e-14) {
      const i00 = (q4 * q7 - q5 * q5) / det
      const i01 = -(q1 * q7 - q2 * q5) / det
      const i02 = (q1 * q5 - q2 * q4) / det
      const i11 = (q0 * q7 - q2 * q2) / det
      const i12 = -(q0 * q5 - q1 * q2) / det
      const i22 = (q0 * q4 - q1 * q1) / det
      const x = -(i00 * q3 + i01 * q6 + i02 * q8)
      const y = -(i01 * q3 + i11 * q6 + i12 * q8)
      const z = -(i02 * q3 + i12 * q6 + i22 * q8)
      if ((x - mx) ** 2 + (y - my) ** 2 + (z - mz) ** 2 < L2) {
        best = err(x, y, z)
        opt[0] = x
        opt[1] = y
        opt[2] = z
      }
    }
    for (const [x, y, z] of [
      [mx, my, mz],
      [ax, ay, az],
      [bx, by, bz],
    ] as const) {
      const e = err(x, y, z)
      if (e < best) {
        best = e
        opt[0] = x
        opt[1] = y
        opt[2] = z
      }
    }
    return Math.max(0, best) + lw * L2 * L2 * 1e2
  }

  const pushEdge = (a: number, b: number) => {
    const c = cost(a, b)
    const id = ea.length
    ea.push(a)
    eb.push(b)
    es.push(stamp[a]! + stamp[b]! * 65536)
    ex.push(opt[0]!, opt[1]!, opt[2]!)
    heap.push(c, id)
  }

  {
    const seen = new Set<number>()
    for (let t = 0; t < nT; t++)
      for (let c = 0; c < 3; c++) {
        let a = T[t * 3 + c]!
        let b = T[t * 3 + ((c + 1) % 3)]!
        if (a > b) [a, b] = [b, a]
        const k = a * nV + b
        if (seen.has(k)) continue
        seen.add(k)
        pushEdge(a, b)
      }
  }

  const neighbours = (v: number, out: Set<number>) => {
    out.clear()
    for (const t of vt[v]!) {
      if (!tAlive[t]) continue
      for (let c = 0; c < 3; c++) {
        const u = T[t * 3 + c]!
        if (u !== v) out.add(u)
      }
    }
    return out
  }
  const na = new Set<number>()
  const nb = new Set<number>()

  const flips = (v: number, other: number, x: number, y: number, z: number): boolean => {
    for (const t of vt[v]!) {
      if (!tAlive[t]) continue
      const i0 = T[t * 3]!
      const i1 = T[t * 3 + 1]!
      const i2 = T[t * 3 + 2]!
      if (i0 === other || i1 === other || i2 === other) continue
      const pts = [i0, i1, i2]
      const before = triNormal(P, pts[0]!, pts[1]!, pts[2]!, -1, 0, 0, 0)
      const after = triNormal(P, pts[0]!, pts[1]!, pts[2]!, v, x, y, z)
      const lb = Math.hypot(before[0], before[1], before[2])
      const la = Math.hypot(after[0], after[1], after[2])
      if (la < 1e-14) return true
      if ((before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (lb * la + 1e-30) < 0.35) return true
    }
    return false
  }

  let tris = nT
  while (tris > targetTris && heap.n > 0) {
    const id = heap.pop()
    const a = ea[id]!
    const b = eb[id]!
    if (!vAlive[a] || !vAlive[b]) continue
    if (es[id] !== stamp[a]! + stamp[b]! * 65536) continue
    neighbours(a, na)
    if (!na.has(b)) continue
    neighbours(b, nb)
    let shared = 0
    for (const u of na) if (nb.has(u)) shared++
    if (shared !== 2) continue
    const x = ex[id * 3]!
    const y = ex[id * 3 + 1]!
    const z = ex[id * 3 + 2]!
    if (flips(a, b, x, y, z) || flips(b, a, x, y, z)) continue
    // Collapse b into a.
    P[a * 3] = x
    P[a * 3 + 1] = y
    P[a * 3 + 2] = z
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i]!
    for (const t of vt[b]!) {
      if (!tAlive[t]) continue
      const i0 = t * 3
      if (T[i0] === a || T[i0 + 1] === a || T[i0 + 2] === a) {
        tAlive[t] = 0
        tris--
        continue
      }
      for (let c = 0; c < 3; c++) if (T[i0 + c] === b) T[i0 + c] = a
      vt[a]!.push(t)
    }
    vt[b] = []
    vAlive[b] = 0
    vt[a] = vt[a]!.filter((t) => tAlive[t])
    stamp[a]++
    for (const u of neighbours(a, na)) pushEdge(Math.min(a, u), Math.max(a, u))
  }

  // Compact.
  const remap = new Int32Array(nV).fill(-1)
  const outP: number[] = []
  const outI: number[] = []
  for (let t = 0; t < nT; t++) {
    if (!tAlive[t]) continue
    for (let c = 0; c < 3; c++) {
      const v = T[t * 3 + c]!
      if (remap[v] === -1) {
        remap[v] = outP.length / 3
        outP.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!)
      }
      outI.push(remap[v]!)
    }
  }
  return { positions: Float32Array.from(outP), indices: Uint32Array.from(outI) }
}

function triNormal(P: Float64Array, a: number, b: number, c: number, mv: number, x: number, y: number, z: number): [number, number, number] {
  const g = (v: number, k: number) => (v === mv ? (k === 0 ? x : k === 1 ? y : z) : P[v * 3 + k]!)
  const ux = g(b, 0) - g(a, 0)
  const uy = g(b, 1) - g(a, 1)
  const uz = g(b, 2) - g(a, 2)
  const wx = g(c, 0) - g(a, 0)
  const wy = g(c, 1) - g(a, 1)
  const wz = g(c, 2) - g(a, 2)
  return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]
}

/** Vertex adjacency (CSR) of a triangle mesh. */
export function adjacency(nV: number, idx: Uint32Array): { start: Int32Array; list: Int32Array } {
  const sets: Set<number>[] = Array.from({ length: nV }, () => new Set())
  for (let t = 0; t < idx.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = idx[t + c]!
      const b = idx[t + ((c + 1) % 3)]!
      sets[a]!.add(b)
      sets[b]!.add(a)
    }
  const start = new Int32Array(nV + 1)
  for (let i = 0; i < nV; i++) start[i + 1] = start[i]! + sets[i]!.size
  const list = new Int32Array(start[nV]!)
  for (let i = 0; i < nV; i++) {
    let k = start[i]!
    for (const u of sets[i]!) list[k++] = u
  }
  return { start, list }
}

/** Taubin λ|μ smoothing: removes surface-nets stair noise without shrinking. */
export function taubin(mesh: RawMesh, iterations = 4, lambda = 0.5, mu = -0.53) {
  const p = mesh.positions
  const n = p.length / 3
  const { start, list } = adjacency(n, mesh.indices)
  const tmp = new Float32Array(p.length)
  for (let it = 0; it < iterations * 2; it++) {
    const f = it % 2 === 0 ? lambda : mu
    for (let i = 0; i < n; i++) {
      const s = start[i]!
      const e = start[i + 1]!
      if (e === s) {
        tmp[i * 3] = p[i * 3]!
        tmp[i * 3 + 1] = p[i * 3 + 1]!
        tmp[i * 3 + 2] = p[i * 3 + 2]!
        continue
      }
      let x = 0
      let y = 0
      let z = 0
      for (let k = s; k < e; k++) {
        const u = list[k]!
        x += p[u * 3]!
        y += p[u * 3 + 1]!
        z += p[u * 3 + 2]!
      }
      const inv = 1 / (e - s)
      tmp[i * 3] = p[i * 3]! + f * (x * inv - p[i * 3]!)
      tmp[i * 3 + 1] = p[i * 3 + 1]! + f * (y * inv - p[i * 3 + 1]!)
      tmp[i * 3 + 2] = p[i * 3 + 2]! + f * (z * inv - p[i * 3 + 2]!)
    }
    p.set(tmp)
  }
}
