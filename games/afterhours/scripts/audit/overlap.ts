// Coplanar overlap audit (adapted from the kit agent's zfight script): coplanar, same-facing, overlapping axis-aligned
// triangles between interior and facility meshes (z-fighting), grouped by mesh pair with total area.
//   bun scripts/audit/overlap.ts [out.txt] [tol=0.0003]
import { writeFileSync } from "node:fs"
import { launch, AUDIT, OUT } from "./lib"
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
await page.goto(`${AUDIT}?shot=1&view=corridor&only=interior,facility&${process.env.ZQ ?? ""}`)
await page.waitForFunction(() => (globalThis as any).__afterhours?.frames > 30, null, { timeout: 240000 })
await new Promise((r) => setTimeout(r, 4000))
await page.evaluate((t) => ((globalThis as any).__zf_tol = t), Number(process.argv[3] ?? 0.0003))
const res = await page.evaluate(() => {
  const { scene } = (globalThis as any).__afterhoursDebug
  const TOL = 0.002
  type Tri = { m: number; ax: number; s: number; c: number; p: number[][] }
  const meshes: string[] = []
  const planes = new Map<string, Tri[]>()
  const v = [0, 0, 0].map(() => ({ x: 0, y: 0, z: 0 }))
  scene.updateMatrixWorld(true)
  scene.traverse((o: any) => {
    if (!o.isMesh || o.isInstancedMesh) return
    let p = o, root = ""
    while (p) { if (/^interior|^facility/.test(p.name)) root = p.name; p = p.parent }
    const mat = o.material
    if (!root && !/facility|interior/.test(mat?.name ?? "")) return
    if (mat?.transparent && !mat.depthWrite && mat.polygonOffset) return
    if (mat?.name === "opaque" || mat?.name === "glass") return
    if (mat?.visible === false || mat?.colorWrite === false) return
    const mi = meshes.push(`${root}|${o.name}|${mat?.name}`) - 1
    const g = o.geometry, P = g.attributes.position, I = g.index
    const e = o.matrixWorld.elements
    const n = I ? I.count : P.count
    const T = (i: number, out: any) => {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i)
      out.x = e[0] * x + e[4] * y + e[8] * z + e[12]; out.y = e[1] * x + e[5] * y + e[9] * z + e[13]; out.z = e[2] * x + e[6] * y + e[10] * z + e[14]
    }
    for (let k = 0; k < n; k += 3) {
      for (let j = 0; j < 3; j++) T(I ? I.getX(k + j) : k + j, v[j])
      const ux = v[1].x - v[0].x, uy = v[1].y - v[0].y, uz = v[1].z - v[0].z
      const wx = v[2].x - v[0].x, wy = v[2].y - v[0].y, wz = v[2].z - v[0].z
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
      const L = Math.hypot(nx, ny, nz)
      if (L < 1e-7) continue
      nx /= L; ny /= L; nz /= L
      const a = [Math.abs(nx), Math.abs(ny), Math.abs(nz)]
      const ax = a[0] > 0.9995 ? 0 : a[1] > 0.9995 ? 1 : a[2] > 0.9995 ? 2 : -1
      if (ax < 0) continue
      const s = [nx, ny, nz][ax] > 0 ? 1 : -1
      // Hidden by construction inside the main block: downward faces on a floor (wall/prop bottoms), anything wholly
      // in the plenum between the suspended ceiling (3.1) and the slab above (3.8), upward faces at the ceiling line.
      {
        const ys = [v[0].y, v[1].y, v[2].y]
        const inBlock = v.every((q) => q.x > -55.05 && q.x < 35.05 && q.z > -22.05 && q.z < 22.05 && q.y < 19.1)
        if (inBlock) {
          const loc = ys.map((y) => (((y - 0.15) % 3.8) + 3.8) % 3.8)
          if (ax === 1 && s < 0 && loc.every((l) => l < 0.04 || l > 3.76)) continue
          if (loc.every((l) => l > 3.115)) continue
          if (ax === 1 && s > 0 && loc.every((l) => l > 3.09)) continue
        }
      }
      const c = ([v[0].x, v[0].y, v[0].z][ax] + [v[1].x, v[1].y, v[1].z][ax] + [v[2].x, v[2].y, v[2].z][ax]) / 3
      const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1]
      const pts = v.map((q) => { const arr = [q.x, q.y, q.z]; return [arr[i0], arr[i1]] })
      const key = `${ax}|${s}|${Math.round(c / TOL)}`
      let L2 = planes.get(key); if (!L2) planes.set(key, (L2 = []))
      L2.push({ m: mi, ax, s, c, p: pts })
    }
  })
  const area = (poly: number[][]) => { let A = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; A += a[0] * b[1] - b[0] * a[1] } return A / 2 }
  const clip = (subj: number[][], clipP: number[][]) => {
    let out = subj
    const ccw = area(clipP) > 0 ? 1 : -1
    for (let i = 0; i < clipP.length && out.length; i++) {
      const a = clipP[i], b = clipP[(i + 1) % clipP.length]
      const inside = (p: number[]) => ccw * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) > 1e-9
      const inp = out; out = []
      for (let j = 0; j < inp.length; j++) {
        const P = inp[j], Q = inp[(j + 1) % inp.length]
        const pi = inside(P), qi = inside(Q)
        if (pi) out.push(P)
        if (pi !== qi) {
          const dx = Q[0] - P[0], dy = Q[1] - P[1]
          const den = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx
          const t = ((b[0] - a[0]) * (a[1] - P[1]) - (b[1] - a[1]) * (a[0] - P[0])) / (den || 1e-12)
          out.push([P[0] + dx * t, P[1] + dy * t])
        }
      }
    }
    return out
  }
  const found = new Map<string, { n: number; area: number; at: number[]; ex: string[] }>()
  const keys = [...planes.keys()]
  for (const key of keys) {
    const [ax, s, ci] = key.split("|").map(Number)
    const tris: Tri[] = []
    for (const d of [-1, 0, 1]) { const l = planes.get(`${ax}|${s}|${ci + d}`); if (l) tris.push(...(d === 0 ? l : l)) }
    const own = planes.get(key)!
    // grid hash on own + neighbours
    const cell = 0.5, grid = new Map<string, number[]>()
    const bb = tris.map((t) => [Math.min(...t.p.map((q) => q[0])), Math.min(...t.p.map((q) => q[1])), Math.max(...t.p.map((q) => q[0])), Math.max(...t.p.map((q) => q[1]))])
    tris.forEach((t, i) => { const b = bb[i]; for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) { const k = gx + "," + gy; let L = grid.get(k); if (!L) grid.set(k, (L = [])); L.push(i) } })
    const nOwn = own.length
    const seen = new Set<string>()
    for (let i = 0; i < nOwn; i++) {
      const ti = own[i], b = bb[tris.indexOf(ti)] ?? bb[i]
      const cand = new Set<number>()
      for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) for (const j of grid.get(gx + "," + gy) ?? []) cand.add(j)
      for (const j of cand) {
        const tj = tris[j]
        if (tj === ti || Math.abs(tj.c - ti.c) > (globalThis as any).__zf_tol) continue
        const bj = bb[j]
        if (bj[0] >= b[2] - 1e-4 || bj[2] <= b[0] + 1e-4 || bj[1] >= b[3] - 1e-4 || bj[3] <= b[1] + 1e-4) continue
        const pk = ti.m < tj.m || (ti.m === tj.m && i < j) ? `${i}:${j}:${key}` : `${j}:${i}:${key}`
        if (seen.has(pk)) continue
        seen.add(pk)
        const A = Math.abs(area(clip(ti.p, tj.p)))
        if (A < 2e-4) continue
        const names = [meshes[ti.m], meshes[tj.m]].sort().join("  <>  ")
        const k2 = `${names}  [axis ${s > 0 ? "+" : "-"}${"xyz"[ax]}]`
        const f = found.get(k2) ?? { n: 0, area: 0, at: [] as number[], ex: [] as string[] }
        if (f.ex.length < 3 && Math.random() < 0.3) f.ex.push(`[${b.map((x: number) => x.toFixed(2))}]~[${bj.map((x: number) => x.toFixed(2))}] c=${ti.c.toFixed(4)}`)
        f.n++; f.area += A
        if (!f.at.length) { const q = ti.p[0]; const w = [0, 0, 0]; const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1]; w[ax] = ti.c; w[i0] = q[0]; w[i1] = q[1]; f.at = w.map((x) => +x.toFixed(3)) }
        found.set(k2, f)
      }
    }
  }
  return [...found.entries()].sort((a, b) => b[1].area - a[1].area).map(([k, f]) => `${f.n}\t${f.area.toFixed(2)} m²\t${k}\tat ${f.at.join(",")}\n\t\t${(f as any).ex.join(" | ")}`)
})
writeFileSync(process.argv[2] ?? `${OUT}/overlap.txt`, res.join("\n"))
console.log(`${res.length} overlapping pairs groups; total tri pairs ${res.reduce((s, l) => s + Number(l.split("\t")[0]), 0)}`)
console.log(res.slice(0, 60).join("\n"))
await browser.close()
