// Geometry hygiene gate for the whole world (interior focus). Loads the full world from a frozen production build
// (all modules streamed in) and fails (exit 1) if the INTERIOR has any of:
//   1. coplanar: same-facing axis-aligned faces within 3 mm of each other, overlapping > 0.002 m², on a visible side
//      (faces looking into a collider or wall solid are buried and ignored);
//   2. slit: two wall solids whose ends/faces stop 0.5–40 mm apart so light shows through between them, or two parallel
//      walls of different assemblies overlapping (a joint sunk past the crossing wall: a strip of the wrong finish);
//   3. mount: a wall-mounted item (a face that is not a wall face) within 3 mm of a wall face;
//   4. flicker: a render sweep over every door and wall corner on every storey — the camera stands 1.5 m away at two
//      angles, 12 stand-still frames (grain and lamp flicker off), pixels whose temporal range exceeds 24 near the
//      target are counted; a view with ≥ FLICKER_PIXELS such pixels fails.
//   5. floor flicker (torch): every room and every 6 m of each corridor, the camera at eye height looking along the floor
//      at a grazing angle (~3.5 m ahead, both ways along the long axis) with the FLASHLIGHT ON; 12 still frames over a
//      wide crop of the floor. Catches floors, decals and stand-ins z-fighting under the torch (the door/corner views
//      look at walls in the lamps' light and miss them). `--no-torch` skips it.
// Findings owned by other modules (facility shell, fire-escape doors...) are listed separately and don't fail the
// gate unless --strict.
//
//   bun run audit:hygiene                       # build + all checks
//   bun scripts/audit/hygiene.ts --no-build     # reuse the last build
//   bun scripts/audit/hygiene.ts --dev          # against the dev server (:5196), no build
//   bun scripts/audit/hygiene.ts --sweep 0      # static checks only; --sweep 40 caps the render views
//   bun scripts/audit/hygiene.ts --storey 1     # only storey 1 (static checks and sweep)
//   bun scripts/audit/hygiene.ts --kinds floor  # only the flashlight floor views
//
// Output: $AH_OUT/hygiene/report.json, report.txt and crops of failing views (flicker-*.png).
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { serve } from "../../bench/lib"

const args = process.argv.slice(2)
const has = (n: string) => args.includes(`--${n}`)
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i < 0 ? undefined : args[i + 1]
}
const root = new URL("../..", import.meta.url).pathname
const tmp = process.env.TMPDIR ?? "/tmp"
const out = join(process.env.AH_OUT ?? join(tmp, "ah-audit", "out"), "hygiene")
mkdirSync(out, { recursive: true })
const sweepCap = Number(flag("sweep") ?? Infinity)
const onlyStorey = flag("storey") === undefined ? -1 : Number(flag("storey"))
const FLICKER_PIXELS = Number(flag("flicker-pixels") ?? 12)
const strict = has("strict")

let base: string
if (has("dev")) base = "http://localhost:5196/"
else {
  const dir = join(tmp, "ah-hygiene", "build")
  if (!has("no-build") || !existsSync(join(dir, "scripts/audit/audit.html"))) {
    const t = performance.now()
    const b = Bun.spawnSync(["bunx", "vite", "build", "-c", "scripts/audit/vite.config.ts", "--outDir", dir, "--logLevel", "error"], { cwd: root, stdout: "inherit", stderr: "inherit" })
    if (b.exitCode !== 0) process.exit(2)
    console.log(`build ${((performance.now() - t) / 1000).toFixed(1)} s`)
  }
  const port = Number(flag("port") ?? 5241)
  serve(dir, port)
  base = `http://localhost:${port}/`
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
// body=0: the first-person body (hands in idle sway) fills the sweep's centre crop and reads as flicker.
await page.goto(`${base}scripts/audit/audit.html?view=corridor&body=0`)
await page.waitForFunction(() => {
  const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
  return !!s?.complete && s.ready && !!(globalThis as { __interior?: unknown }).__interior
}, null, { timeout: 600_000 })
// Furniture bakes after its models load.
await page.waitForTimeout(6000)
console.log(`interior depth pass: ${await page.evaluate(() => Math.round((globalThis as { __interiorDepthMs?: number }).__interiorDepthMs ?? 0) + " ms " + JSON.stringify((globalThis as { __interiorDepthPhase?: Record<string, number> }).__interiorDepthPhase, (_, v) => (typeof v === "number" ? Math.round(v) : v)))}`)

export type Finding = { cls: "coplanar" | "slit" | "mount" | "flicker"; storey: number; owner: string; at: [number, number, number]; what: string; amount: number }

// ------------------------------------------------------------------------------------------------ static checks
const statics: Finding[] = await page.evaluate((only) => {
  const g = globalThis as any
  const scene = g.__afterhoursDebug.scene
  const interior = g.__interior
  const solids: { min: number[]; max: number[]; id: number }[] = interior.solids
  const colliders: { min: number[]; max: number[] }[] = interior.ctx.colliders
  const storeyOf = (y: number) => Math.max(-1, Math.min(5, Math.floor((y - 0.15 + 0.05) / 3.8)))
  const out: any[] = []
  // Spatial hash of boxes (2 m cells on x/z) for "is this point buried" queries.
  const CELL = 2
  const grid = new Map<string, { min: number[]; max: number[] }[]>()
  for (const b of [...solids, ...colliders]) {
    for (let gx = Math.floor(b.min[0] / CELL); gx <= Math.floor(b.max[0] / CELL); gx++)
      for (let gz = Math.floor(b.min[2] / CELL); gz <= Math.floor(b.max[2] / CELL); gz++) {
        const k = gx + "," + gz
        let l = grid.get(k)
        if (!l) grid.set(k, (l = []))
        l.push(b)
      }
  }
  const floors: { min: number[]; max: number[]; y: number }[] = interior.ctx.floors ?? []
  const inside = (x: number, y: number, z: number, pad = 0) => {
    // Below a walkable floor (within its slab) is buried too.
    for (const f of floors) if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && y < f.y && y > f.y - 0.3) return true
    const l = grid.get(Math.floor(x / CELL) + "," + Math.floor(z / CELL))
    if (!l) return false
    for (const b of l) if (x > b.min[0] - pad && x < b.max[0] + pad && y > b.min[1] - pad && y < b.max[1] + pad && z > b.min[2] - pad && z < b.max[2] + pad) return true
    return false
  }
  // ---- 1 + 3: coplanar / mounts
  type Tri = { m: number; ax: number; s: number; c: number; p: number[][]; area: number; model: boolean; onWall: boolean }
  const meshes: { name: string; owner: string; model: boolean }[] = []
  const planes = new Map<string, Tri[]>()
  const TOL = 0.003
  scene.updateMatrixWorld(true)
  const v = [0, 0, 0].map(() => ({ x: 0, y: 0, z: 0 }))
  // Wall faces (from the solids) per plane key, for the "on a wall face" test.
  const wallFaces = new Map<string, { a: number[]; b: number[] }[]>()
  for (const k of solids)
    for (const ax of [0, 2])
      for (const s of [-1, 1]) {
        const c = s > 0 ? k.max[ax] : k.min[ax]
        const ui = ax === 0 ? 2 : 0
        const key = `${ax}|${s}|${Math.round(c / 0.001)}`
        let l = wallFaces.get(key)
        if (!l) wallFaces.set(key, (l = []))
        l.push({ a: [k.min[ui], k.min[1]], b: [k.max[ui], k.max[1]] })
      }
  const onWallFace = (ax: number, s: number, c: number, u: number, y: number) => {
    for (const d of [-1, 0, 1]) {
      const l = wallFaces.get(`${ax}|${s}|${Math.round(c / 0.001) + d}`)
      if (l) for (const f of l) if (u >= f.a[0] - 1e-3 && u <= f.b[0] + 1e-3 && y >= f.a[1] - 1e-3 && y <= f.b[1] + 1e-3) return true
    }
    return false
  }
  scene.traverse((o: any) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSprite) return
    // Only what the view camera draws (reflect-only stand-ins live on other layers).
    if ((o.layers.mask & 1) === 0) return
    let top = o
    while (top.parent && top.parent !== scene && !top.parent.isScene) top = top.parent
    let owner = top.name || ""
    for (let p = o; p; p = p.parent) if (/^interior/.test(p.name)) owner = "interior"
    if (owner !== "interior" && !/^facility|^shell/.test(owner)) owner = owner.startsWith("interior") ? "interior" : owner
    if (owner !== "interior" && owner !== "facility") return
    const mat = Array.isArray(o.material) ? o.material[0] : o.material
    if (!mat || mat.visible === false || mat.colorWrite === false) return
    if (mat.transparent && !mat.depthWrite) return
    if (mat.polygonOffset) return
    const model = mat.name === "opaque" || mat.name === "glass" || /×|merged|fixtures/.test(o.name)
    const mi = meshes.push({ name: `${o.parent?.name ?? ""}/${o.name}|${mat.name}`, owner, model }) - 1
    const gm = o.geometry
    const P = gm.attributes.position
    const I = gm.index
    const e = o.matrixWorld.elements
    const n = I ? I.count : P.count
    const T = (i: number, r: any) => {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i)
      r.x = e[0] * x + e[4] * y + e[8] * z + e[12]
      r.y = e[1] * x + e[5] * y + e[9] * z + e[13]
      r.z = e[2] * x + e[6] * y + e[10] * z + e[14]
    }
    for (let k = 0; k < n; k += 3) {
      for (let j = 0; j < 3; j++) T(I ? I.getX(k + j) : k + j, v[j])
      const ux = v[1].x - v[0].x, uy = v[1].y - v[0].y, uz = v[1].z - v[0].z
      const wx = v[2].x - v[0].x, wy = v[2].y - v[0].y, wz = v[2].z - v[0].z
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
      const L = Math.hypot(nx, ny, nz)
      if (L < 1e-8) continue
      nx /= L; ny /= L; nz /= L
      const a = [Math.abs(nx), Math.abs(ny), Math.abs(nz)]
      // Strictly axis-aligned only (0.6°): a leaf open at 1.6 rad is nearly x-facing, but its triangles are not one plane.
      const ax = a[0] > 0.99995 ? 0 : a[1] > 0.99995 ? 1 : a[2] > 0.99995 ? 2 : -1
      if (ax < 0) continue
      const s = [nx, ny, nz][ax] > 0 ? 1 : -1
      const pts3 = v.map((q) => [q.x, q.y, q.z])
      const c = (pts3[0][ax] + pts3[1][ax] + pts3[2][ax]) / 3
      if (only >= 0 && storeyOf((pts3[0][1] + pts3[1][1] + pts3[2][1]) / 3) !== only) continue
      const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1]
      const pts = pts3.map((q) => [q[i0], q[i1]])
      const cu = (pts[0][0] + pts[1][0] + pts[2][0]) / 3
      const cv = (pts[0][1] + pts[1][1] + pts[2][1]) / 3
      const wallTri = ax !== 1 && onWallFace(ax, s, c, ax === 0 ? cv : cu, ax === 0 ? cu : cv)
      const key = `${ax}|${s}|${Math.round(c / TOL)}`
      let l = planes.get(key)
      if (!l) planes.set(key, (l = []))
      l.push({ m: mi, ax, s, c, p: pts, area: L / 2, model, onWall: wallTri, w3: pts3 } as Tri)
    }
  })
  const area = (poly: number[][]) => {
    let A = 0
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!
      A += a[0] * b[1] - b[0] * a[1]
    }
    return A / 2
  }
  const clip = (subj: number[][], clipP: number[][]) => {
    let res = subj
    const ccw = area(clipP) > 0 ? 1 : -1
    for (let i = 0; i < clipP.length && res.length; i++) {
      const a = clipP[i]!, b = clipP[(i + 1) % clipP.length]!
      const ins = (p: number[]) => ccw * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) > 1e-10
      const inp = res
      res = []
      for (let j = 0; j < inp.length; j++) {
        const P = inp[j]!, Q = inp[(j + 1) % inp.length]!
        const pi = ins(P), qi = ins(Q)
        if (pi) res.push(P)
        if (pi !== qi) {
          const dx = Q[0] - P[0], dy = Q[1] - P[1]
          const den = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx
          const t = ((b[0] - a[0]) * (a[1] - P[1]) - (b[1] - a[1]) * (a[0] - P[0])) / (den || 1e-12)
          res.push([P[0] + dx * t, P[1] + dy * t])
        }
      }
    }
    return res
  }
  const seen = new Set<string>()
  const groups = new Map<string, any>()
  for (const [key, own] of planes) {
    const [ax, s, ci] = key.split("|").map(Number) as [number, number, number]
    const cand: Tri[] = []
    for (const d of [0, 1]) {
      const l = planes.get(`${ax}|${s}|${ci + d}`)
      if (l) cand.push(...l)
    }
    const CG = 0.5
    const hash = new Map<string, number[]>()
    const bb = cand.map((t) => [Math.min(t.p[0][0], t.p[1][0], t.p[2][0]), Math.min(t.p[0][1], t.p[1][1], t.p[2][1]), Math.max(t.p[0][0], t.p[1][0], t.p[2][0]), Math.max(t.p[0][1], t.p[1][1], t.p[2][1])])
    cand.forEach((_, i) => {
      const b = bb[i]!
      for (let gx = Math.floor(b[0] / CG); gx <= Math.floor(b[2] / CG); gx++)
        for (let gy = Math.floor(b[1] / CG); gy <= Math.floor(b[3] / CG); gy++) {
          const k = gx + "," + gy
          let l = hash.get(k)
          if (!l) hash.set(k, (l = []))
          l.push(i)
        }
    })
    for (let i = 0; i < own.length; i++) {
      const ti = own[i]!
      const ii = cand.indexOf(ti)
      const b = bb[ii]!
      const near = new Set<number>()
      for (let gx = Math.floor(b[0] / CG); gx <= Math.floor(b[2] / CG); gx++)
        for (let gy = Math.floor(b[1] / CG); gy <= Math.floor(b[3] / CG); gy++) for (const j of hash.get(gx + "," + gy) ?? []) near.add(j)
      for (const j of near) {
        if (j === ii) continue
        const tj = cand[j]!
        if (Math.abs(tj.c - ti.c) > TOL) continue
        if (ti.model && tj.model) continue
        if (ti.m === tj.m && Math.abs(tj.c - ti.c) < 1e-6) continue
        const mi = meshes[ti.m]!, mj = meshes[tj.m]!
        if (mi.owner !== "interior" && mj.owner !== "interior") continue
        const bj = bb[j]!
        if (bj[0] >= b[2] - 1e-4 || bj[2] <= b[0] + 1e-4 || bj[1] >= b[3] - 1e-4 || bj[3] <= b[1] + 1e-4) continue
        const pk = ii < j ? `${key}|${ii}|${j}` : `${key}|${j}|${ii}`
        if (seen.has(pk)) continue
        seen.add(pk)
        const poly = clip(ti.p, tj.p)
        const A = Math.abs(area(poly))
        if (A < 2e-4 || poly.length < 3) continue
        // Visible side: centroid of the overlap pushed 1 cm out along the normal must be in open space.
        const cu = poly.reduce((s2, q) => s2 + q[0], 0) / poly.length
        const cv = poly.reduce((s2, q) => s2 + q[1], 0) / poly.length
        const w = [0, 0, 0]
        const [i0, i1] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1]
        w[ax] = Math.max(ti.c, tj.c) * (s > 0 ? 1 : 0) + Math.min(ti.c, tj.c) * (s > 0 ? 0 : 1) + s * 0.0045 // a face whose 4.5 mm front is inside a wall faces into a slot too thin to see into (matches the kit)
        w[i0] = cu
        w[i1] = cv
        if (inside(w[0]!, w[1]!, w[2]!)) continue
        const st = storeyOf(w[1]!)
        const cls = ti.onWall !== tj.onWall ? "mount" : "coplanar"
        const owner = mi.owner === "interior" && mj.owner === "interior" ? "interior" : "facility"
        const gk = `${cls}|${st}|${owner}|${Math.round(w[0]! / 0.5)},${Math.round(w[1]! / 0.5)},${Math.round(w[2]! / 0.5)}`
        let gr = groups.get(gk)
        if (!gr) groups.set(gk, (gr = { cls, storey: st, owner, at: w.map((q) => +q.toFixed(3)), what: `${mi.name} <> ${mj.name} [${"xyz"[ax]}${s > 0 ? "+" : "-"}, Δ${(Math.abs(ti.c - tj.c) * 1000).toFixed(1)} mm] A ${ti.c.toFixed(4)} ${bb[ii]!.map((q) => q.toFixed(3)).join(",")} B ${tj.c.toFixed(4)} ${bj.map((q) => q.toFixed(3)).join(",")} Bv ${JSON.stringify((tj as any).w3.map((q: number[]) => q.map((x) => +x.toFixed(4))))}`, amount: 0 }))
        gr.amount += A
      }
    }
  }
  for (const gr of groups.values()) if (gr.amount > 0.002) out.push({ ...gr, amount: +gr.amount.toFixed(4) })
  // ---- 2: slits between wall solids
  const tall = solids.filter((k) => k.max[1] - k.min[1] > 1.2)
  const sg = new Map<string, number[]>()
  tall.forEach((k, i) => {
    for (let gx = Math.floor((k.min[0] - 0.05) / 1); gx <= Math.floor((k.max[0] + 0.05) / 1); gx++)
      for (let gz = Math.floor((k.min[2] - 0.05) / 1); gz <= Math.floor((k.max[2] + 0.05) / 1); gz++) {
        const key = gx + "," + gz
        let l = sg.get(key)
        if (!l) sg.set(key, (l = []))
        l.push(i)
      }
  })
  const slitSeen = new Set<string>()
  tall.forEach((A, i) => {
    const near = new Set<number>()
    for (let gx = Math.floor((A.min[0] - 0.05) / 1); gx <= Math.floor((A.max[0] + 0.05) / 1); gx++)
      for (let gz = Math.floor((A.min[2] - 0.05) / 1); gz <= Math.floor((A.max[2] + 0.05) / 1); gz++) for (const j of sg.get(gx + "," + gz) ?? []) near.add(j)
    for (const j of near) {
      if (j <= i) continue
      const B = tall[j]!
      if (A.id === B.id) continue
      const yo = Math.min(A.max[1], B.max[1]) - Math.max(A.min[1], B.min[1])
      if (yo < 0.3) continue
      // Joint overreach: two parallel walls of different assemblies overlapping in volume (an end sunk past the
      // crossing wall into the next wall shows a strip of the wrong finish at the corner).
      {
        const lax = A.max[0] - A.min[0] > A.max[2] - A.min[2] ? 0 : 2
        const lbx = B.max[0] - B.min[0] > B.max[2] - B.min[2] ? 0 : 2
        const ox = Math.min(A.max[0], B.max[0]) - Math.max(A.min[0], B.min[0])
        const oz = Math.min(A.max[2], B.max[2]) - Math.max(A.min[2], B.min[2])
        // Only a short overlap at an end counts (a lining over a wall overlaps it over its whole length by design).
        const ol = lax === 0 ? ox : oz
        const la = A.max[lax] - A.min[lax]
        const lb = B.max[lax] - B.min[lax]
        if (lax === lbx && ox > 0.002 && oz > 0.002 && yo > 0.3 && ol < 0.25 && ol < 0.5 * Math.min(la, lb) && Math.min(A.max[lax], B.max[lax]) - Math.max(A.min[lax], B.min[lax]) < Math.min(la, lb) - 0.01) {
          const p = [(Math.max(A.min[0], B.min[0]) + Math.min(A.max[0], B.max[0])) / 2, (Math.max(A.min[1], B.min[1]) + Math.min(A.max[1], B.max[1])) / 2, (Math.max(A.min[2], B.min[2]) + Math.min(A.max[2], B.max[2])) / 2]
          if (only < 0 || storeyOf(p[1]!) === only)
            out.push({ cls: "slit", storey: storeyOf(p[1]!), owner: "interior", at: p.map((q) => +q.toFixed(3)), what: `overreach ${((lax === 0 ? ox : oz) * 1000).toFixed(0)} mm: parallel walls ${A.id} and ${B.id} overlap`, amount: +(lax === 0 ? ox : oz).toFixed(4) })
        }
      }
      for (const gax of [0, 2]) {
        const oax = gax === 0 ? 2 : 0
        const [L, R] = A.max[gax] <= B.min[gax] + 1e-6 ? [A, B] : B.max[gax] <= A.min[gax] + 1e-6 ? [B, A] : [null, null]
        if (!L || !R) continue
        const gap = R.min[gax] - L.max[gax]
        if (gap < 0.0005 || gap > 0.04) continue
        const o0 = Math.max(A.min[oax], B.min[oax])
        const o1 = Math.min(A.max[oax], B.max[oax])
        if (o1 - o0 < 0.03) continue
        // An end gap: the gap axis is the long axis of one of them (light passes straight through the wall line).
        const longA = A.max[gax] - A.min[gax] > A.max[oax] - A.min[oax]
        const longB = B.max[gax] - B.min[gax] > B.max[oax] - B.min[oax]
        if (!longA && !longB) continue
        const p = [0, 0, 0]
        p[gax] = (L.max[gax] + R.min[gax]) / 2
        p[oax] = (o0 + o1) / 2
        p[1] = (Math.max(A.min[1], B.min[1]) + Math.min(A.max[1], B.max[1])) / 2
        if (only >= 0 && storeyOf(p[1]!) !== only) continue
        // Filled by something else (a third wall, a lining)?
        let filled = false
        for (const k of solids) if (k !== A && k !== B && p[0]! > k.min[0] && p[0]! < k.max[0] && p[2]! > k.min[2] && p[2]! < k.max[2] && p[1]! > k.min[1] && p[1]! < k.max[1]) filled = true
        if (filled) continue
        const sk = `${Math.round(p[0]! / 0.2)},${Math.round(p[1]! / 0.5)},${Math.round(p[2]! / 0.2)}`
        if (slitSeen.has(sk)) continue
        slitSeen.add(sk)
        out.push({ cls: "slit", storey: storeyOf(p[1]!), owner: "interior", at: p.map((q) => +q.toFixed(3)), what: `gap ${(gap * 1000).toFixed(1)} mm along ${"xyz"[gax]} between solids ${A.id} and ${B.id}`, amount: +gap.toFixed(4) })
      }
    }
  })
  return out
}, onlyStorey)
console.log(`static: ${statics.length} findings`)

// ------------------------------------------------------------------------------------------------ render sweep
type View = { kind: "door" | "corner" | "floor"; id: string; owner: string; storey: number; cam: [number, number, number]; target: [number, number, number] }
const views: View[] = await page.evaluate(({ only, torch }) => {
  const g = globalThis as any
  const interior = g.__interior
  const solids: { min: number[]; max: number[]; id: number }[] = interior.solids
  const colliders: { min: number[]; max: number[] }[] = interior.ctx.colliders
  const floors: { min: number[]; max: number[]; y: number }[] = interior.ctx.floors
  const storeyY = (i: number) => 0.15 + i * 3.8
  const storeyOf = (y: number) => Math.max(0, Math.min(4, Math.floor((y - 0.15 + 0.05) / 3.8)))
  const boxes = [...solids, ...colliders]
  const blocked = (x: number, y: number, z: number, pad: number) => boxes.some((b) => x > b.min[0] - pad && x < b.max[0] + pad && z > b.min[2] - pad && z < b.max[2] + pad && y > b.min[1] && y < b.max[1])
  const floorAt = (x: number, z: number, y: number) => floors.some((f) => x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && Math.abs(f.y - y) < 0.3)
  const clear = (c: number[], t: number[]) => {
    const d = Math.hypot(t[0]! - c[0]!, t[2]! - c[2]!)
    for (let s = 0.2; s < d - 0.3; s += 0.1) {
      const k = s / d
      if (blocked(c[0]! + (t[0]! - c[0]!) * k, c[1]! + (t[1]! - c[1]!) * k, c[2]! + (t[2]! - c[2]!) * k, 0.02)) return false
    }
    return true
  }
  const pick = (t: number[], dirs: number[][], st: number) => {
    const eye = storeyY(st) + 0.01 + 1.6
    const res: number[][] = []
    for (const [dx, dz] of dirs) {
      const c = [t[0]! + dx! * 1.5, eye, t[2]! + dz! * 1.5]
      if (blocked(c[0]!, c[1]!, c[2]!, 0.3) || !floorAt(c[0]!, c[2]!, storeyY(st) + 0.01) || !clear(c, t)) continue
      res.push(c)
      if (res.length === 2) break
    }
    return res
  }
  const out: any[] = []
  // Doors.
  for (const d of g.__afterhoursDoors.all() as any[]) {
    if (d.slide || String(d.id).endsWith(":b")) continue
    const st = storeyOf(d.hy)
    if (d.hy < -1 || d.hy > 19.5) continue
    if (only >= 0 && st !== only) continue
    const m = (d.xa + d.xb) / 2
    const mx = d.hx + m * Math.cos(d.yaw0)
    const mz = d.hz - m * Math.sin(d.yaw0)
    const nx = Math.sin(d.yaw0)
    const nz = Math.cos(d.yaw0)
    const t = [mx, storeyY(st) + 0.01 + 1.55, mz]
    const dirs: number[][] = []
    for (const s of [1, -1]) for (const a of [0.55, -0.55]) dirs.push([s * (nx * Math.cos(a) - nz * Math.sin(a)), s * (nz * Math.cos(a) + nx * Math.sin(a))])
    const owner = /^s\d:|^interior/.test(d.id) ? "interior" : "facility"
    for (const c of pick(t, dirs, st)) out.push({ kind: "door", id: d.id, owner, storey: st, cam: c, target: t })
  }
  // Wall corners: where two perpendicular wall solids of different assemblies meet.
  const walls = solids.filter((k) => k.max[1] - k.min[1] > 1.5)
  const corners: number[][] = []
  for (let i = 0; i < walls.length; i++)
    for (let j = i + 1; j < walls.length; j++) {
      const A = walls[i]!, B = walls[j]!
      if (A.id === B.id) continue
      const aX = A.max[0] - A.min[0] > A.max[2] - A.min[2]
      const bX = B.max[0] - B.min[0] > B.max[2] - B.min[2]
      if (aX === bX) continue
      if (Math.min(A.max[1], B.max[1]) - Math.max(A.min[1], B.min[1]) < 1.5) continue
      const x0 = Math.max(A.min[0], B.min[0]) - 0.005, x1 = Math.min(A.max[0], B.max[0]) + 0.005
      const z0 = Math.max(A.min[2], B.min[2]) - 0.005, z1 = Math.min(A.max[2], B.max[2]) + 0.005
      if (x1 < x0 || z1 < z0) continue
      const y = Math.max(A.min[1], B.min[1])
      const st = storeyOf(y + 0.3)
      if (only >= 0 && st !== only) continue
      const p = [(x0 + x1) / 2, st, (z0 + z1) / 2]
      if (corners.some((q) => q[1] === st && Math.hypot(q[0]! - p[0]!, q[2]! - p[2]!) < 0.6)) continue
      corners.push(p)
    }
  const diag = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => [a! * Math.SQRT1_2, b! * Math.SQRT1_2])
  for (const [x, st, z] of corners) {
    const t = [x!, storeyY(st!) + 0.01 + 2.3, z!]
    for (const c of pick(t, diag, st!)) out.push({ kind: "corner", id: `corner@${x!.toFixed(2)},${z!.toFixed(2)}`, owner: "interior", storey: st, cam: c, target: t })
  }
  // Floors under the torch: each room and the corridors (rooms' rects; long rooms every 6 m), both ways along the
  // long axis, eye height, the target on the floor 3.5 m ahead.
  if (torch) {
    const seen = new Set<string>()
    // The spine corridors aren't rooms in the registry: add each storey's spine (x −54.6..34.6, z ±1.6) as one.
    const spines = [0, 1, 2, 3, 4].map((st) => ({ id: `spine-${st}`, storey: st, rect: { x0: -54.6, x1: 34.6, z0: -1.6, z1: 1.6 } }))
    for (const r of [...spines, ...(interior.rooms as { id: string; storey: number; rect: { x0: number; x1: number; z0: number; z1: number } }[])]) {
      if (only >= 0 && r.storey !== only) continue
      const { x0, x1, z0, z1 } = r.rect
      const alongX = x1 - x0 >= z1 - z0
      const len = alongX ? x1 - x0 : z1 - z0
      const mid = alongX ? (z0 + z1) / 2 : (x0 + x1) / 2
      const fy = storeyY(r.storey) + 0.01
      const eye = fy + 1.6
      for (let u = (alongX ? x0 : z0) + 1.0; u <= (alongX ? x1 : z1) - 1.0 + 1e-6; u += Math.max(2, Math.min(6, len - 2))) {
        for (const s of [1, -1]) {
          const c = alongX ? [u, eye, mid] : [mid, eye, u]
          const t = alongX ? [u + s * 3.5, fy, mid] : [mid, fy, u + s * 3.5]
          if ((alongX ? t[0]! < x0 || t[0]! > x1 : t[2]! < z0 || t[2]! > z1) || blocked(c[0]!, c[1]!, c[2]!, 0.3) || !floorAt(c[0]!, c[2]!, fy) || !clear(c, [t[0]!, eye - 0.6, t[2]!])) continue
          const key = `${r.storey}:${Math.round(c[0]! * 2)},${Math.round(c[2]! * 2)},${s},${alongX}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ kind: "floor", id: `${r.id} ${alongX ? "x" : "z"}${s > 0 ? "+" : "-"} @${u.toFixed(1)}`, owner: "interior", storey: r.storey, cam: c, target: t })
        }
      }
    }
  }
  return out
}, { only: onlyStorey, torch: !has("no-torch") })
// `--kinds floor` (or door,corner) runs only those view kinds.
const kinds = flag("kinds")?.split(",")
const sweep = views.filter((v) => !kinds || kinds.includes(v.kind)).slice(0, sweepCap)
console.log(`sweep: ${views.length} views (${views.filter((v) => v.kind === "door").length} door, ${views.filter((v) => v.kind === "corner").length} corner, ${views.filter((v) => v.kind === "floor").length} floor/torch)${sweep.length < views.length ? `, capped to ${sweep.length}` : ""}`)

await page.evaluate(() => {
  const g = globalThis as any
  const s = g.__interior.ctx.settings
  s["grade.grain"] = 0
  s["light.flicker"] = 0
  s["forest.wind"] = 0
  // Lightning lights every window for a few frames at random: weather, not geometry.
  s["weather.lightning"] = 0
  // Auto-resolution drops the render scale under headless load at random moments and TAAU then shows its jitter on
  // high-contrast detail: pin full scale so every view is measured the same way.
  s["post.autoRes"] = false
  // The game's camera sees the body (3) and first-person viewmodel (6) layers too; with body=0 nothing is on them, but
  // anything else carrying those layers (a mirror's reflect-only stand-ins once shared 6) must be in the sweep's view.
  g.__afterhoursDebug.camera.layers.enable(3)
  g.__afterhoursDebug.camera.layers.enable(6)
  // Dying lamps flicker by design (their own per-lamp amount): steady them so only geometry can shimmer.
  for (const l of g.__interior.ctx.lamps) if (l.flicker) l.flicker = 0
})
const flickers: Finding[] = []
const t0 = performance.now()
let torchOn = false
for (const [vi, v] of sweep.entries()) {
  // The floor views run with the flashlight on (the doors and corners with it off, as before).
  if ((v.kind === "floor") !== torchOn) {
    torchOn = !torchOn
    await page.evaluate((on) => ((globalThis as any).__afterhoursPlayer.flashlight = on), torchOn)
  }
  const r = await page.evaluate(
    async ({ v, crop }) => {
      const g = globalThis as any
      const p = g.__afterhoursPlayer
      const cam = g.__afterhoursDebug.camera
      p.fly = true
      p.pos.x = v.cam[0]
      p.pos.z = v.cam[2]
      p.pos.y = v.cam[1] - 1.65
      p.vy = 0
      const dx = v.target[0] - v.cam[0]
      const dz = v.target[2] - v.cam[2]
      p.yaw = Math.atan2(-dx, -dz)
      p.pitch = Math.atan2(v.target[1] - v.cam[1], Math.hypot(dx, dz))
      p.base = p.pos.y
      p.resetMotion?.()
      const frame = () => new Promise((res) => requestAnimationFrame(res))
      for (let k = 0; k < 24; k++) await frame()
      const canvas = document.querySelector("#view") as HTMLCanvasElement
      // Floor views: a wide crop over the lit floor (the torch spot), the target in its middle.
      const W = v.kind === "floor" ? 224 : 128
      const sx = Math.round(canvas.width / 2 - W / 2)
      const sy = Math.round(canvas.height / 2 - W / 2)
      const oc = new OffscreenCanvas(W, W)
      const ctx2 = oc.getContext("2d", { willReadFrequently: true })!
      const lo = new Uint8ClampedArray(W * W * 3).fill(255)
      const hi = new Uint8ClampedArray(W * W * 3)
      let first: ImageData | null = null
      for (let f = 0; f < 12; f++) {
        await frame()
        ctx2.drawImage(canvas, sx, sy, W, W, 0, 0, W, W)
        const d = ctx2.getImageData(0, 0, W, W)
        if (!first) first = d
        for (let i = 0; i < W * W; i++)
          for (let c = 0; c < 3; c++) {
            const val = d.data[i * 4 + c]!
            if (val < lo[i * 3 + c]!) lo[i * 3 + c] = val
            if (val > hi[i * 3 + c]!) hi[i * 3 + c] = val
          }
      }
      let over = 0
      const heat = ctx2.createImageData(W, W)
      const range = (i: number) => Math.max(hi[i * 3]! - lo[i * 3]!, hi[i * 3 + 1]! - lo[i * 3 + 1]!, hi[i * 3 + 2]! - lo[i * 3 + 2]!)
      for (let i = 0; i < W * W; i++) {
        const rr = range(i)
        // Z-fighting shimmers in coherent bands; isolated sparkle (TAA on fine detail, specular pinpoints) doesn't
        // count: a pixel needs ≥ 2 flagged 8-neighbours.
        if (rr > 24) {
          const x = i % W
          const y = (i / W) | 0
          let nb = 0
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if ((dx || dy) && x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < W && range(i + dy * W + dx) > 24) nb++
          if (nb >= 2) over++
        }
        heat.data[i * 4] = Math.min(255, rr * 4)
        heat.data[i * 4 + 1] = rr > 24 ? 0 : Math.min(255, rr * 4)
        heat.data[i * 4 + 2] = rr > 24 ? 0 : Math.min(255, rr * 4)
        heat.data[i * 4 + 3] = 255
      }
      let png = ""
      if (crop && over >= crop) {
        const oc2 = new OffscreenCanvas(W * 2, W)
        const c2 = oc2.getContext("2d")!
        c2.putImageData(first!, 0, 0)
        c2.putImageData(heat, W, 0)
        const blob = await oc2.convertToBlob()
        const buf = new Uint8Array(await blob.arrayBuffer())
        let bin = ""
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!)
        png = btoa(bin)
      }
      void cam
      return { over, png }
    },
    { v, crop: FLICKER_PIXELS },
  )
  if (process.env.HYG_DEBUG && v.kind === "floor") console.log(`  ${v.id} cam ${v.cam.map((q) => q.toFixed(1)).join(",")} over ${r.over}`)
  if (r.over >= FLICKER_PIXELS) {
    const name = `flicker-${flickers.length}-${v.kind}-s${v.storey}.png`
    if (r.png) writeFileSync(join(out, name), Buffer.from(r.png, "base64"))
    flickers.push({ cls: "flicker", storey: v.storey, owner: v.owner, at: v.target, what: `${v.kind} ${v.id} from ${v.cam.map((q) => q.toFixed(2)).join(",")} → ${name}`, amount: r.over })
  }
  if (vi % 50 === 49) console.log(`  ${vi + 1}/${sweep.length} views, ${flickers.length} flagged, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
}

// ------------------------------------------------------------------------------------------------ report
// Reviewed, invisible findings (scripts/audit/hygiene-allow.json) are listed but don't fail the gate.
const allow = (JSON.parse(await Bun.file(new URL("./hygiene-allow.json", import.meta.url).pathname).text()) as { allow: { cls: string; storey: number; at: number[] }[] }).allow
const allowed = (f: Finding) => allow.some((a) => a.cls === f.cls && a.storey === f.storey && Math.hypot(a.at[0]! - f.at[0], a.at[1]! - f.at[1], a.at[2]! - f.at[2]) < 0.35)
const all = [...statics, ...flickers].map((f) => (allowed(f) ? { ...f, owner: "allowed" } : f))
const classes = ["coplanar", "slit", "mount", "flicker"] as const
const lines: string[] = []
for (const owner of ["interior", "facility", "allowed"]) {
  lines.push(`== ${owner}`)
  for (const cls of classes) {
    const f = all.filter((x) => x.owner === owner && x.cls === cls)
    const per = [0, 1, 2, 3, 4, 5].map((s) => f.filter((x) => x.storey === s).length)
    lines.push(`${cls.padEnd(9)} total ${String(f.length).padStart(4)}   by storey 0..4,roof: ${per.join(" / ")}`)
  }
}
lines.push("")
for (const f of all.sort((a, b) => (a.owner + a.cls + a.storey).localeCompare(b.owner + b.cls + b.storey) || b.amount - a.amount))
  lines.push(`${f.owner}\t${f.cls}\ts${f.storey}\t${f.amount}\tat ${f.at.join(",")}\t${f.what}`)
writeFileSync(join(out, "report.txt"), lines.join("\n"))
writeFileSync(join(out, "report.json"), JSON.stringify({ findings: all, views: sweep.length, errors }, null, 1))
console.log(lines.slice(0, 12).join("\n"))
console.log(`report: ${join(out, "report.txt")}`)
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`)
await browser.close()
const failing = all.filter((f) => strict || f.owner === "interior")
process.exit(failing.length ? 1 : 0)
